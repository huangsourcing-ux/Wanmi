import { randomBytes, randomInt, randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

import { hmac, safeEqualHex } from '@/lib/crypto'
import { ONE_TIME_STEP_UP_PURPOSES, type StepUpPurpose } from '@/lib/domain'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import type { Customer } from '@/payload-types'
import { createCaptchaProvider, type CaptchaProvider } from '@/providers/aliyuncaptcha'
import { createSmsProvider } from '@/providers/aliyunsms'
import type { SmsProvider } from '@/providers/types'
import type { StepUpRequestInput, StepUpVerifyInput } from '@/schemas/auth'

import { authTransactionDatabase, inAuthTransaction } from './atomic'
import { clientHashes } from './client-facts'
import { smsProviderFailureCategory } from './otp'
import { enforceSmsRateLimits } from './sms-rate-limit'

const oneTimePurposes = new Set<StepUpPurpose>(ONE_TIME_STEP_UP_PURPOSES)

const genericRequestResult = {
  accepted: true as const,
  message: '如果当前账号可用，验证码将很快送达',
}

function invalidChallenge() {
  return new AppError('STEP_UP_CHALLENGE_INVALID', '验证码无效或已过期', 401)
}

function invalidGrant() {
  return new AppError('STEP_UP_GRANT_INVALID', 'step-up 授权无效、已过期或用途不匹配', 403)
}

export function isOneTimeStepUpPurpose(purpose: StepUpPurpose): boolean {
  return oneTimePurposes.has(purpose)
}

export async function requestStepUpOtp(
  req: PayloadRequest,
  customer: Customer,
  input: StepUpRequestInput,
  headers: Headers,
  traceId: string,
  options: { captchaProvider?: CaptchaProvider; smsProvider?: SmsProvider } = {},
) {
  const env = getEnv()
  const captcha = await (options.captchaProvider ?? createCaptchaProvider()).verify({
    captchaVerifyParam: input.captchaVerifyParam,
    purpose: 'sms',
    traceId,
  })
  if (!captcha.ok) throw new AppError('CAPTCHA_REJECTED', '人机校验未通过', 403)

  const { deviceHash, ipHash } = clientHashes(headers, input.deviceId)
  const phoneHash = hmac(customer.phone, env.SESSION_PEPPER)
  await enforceSmsRateLimits(req.payload, { deviceHash, ipHash, phoneHash })

  const challengeId = randomUUID()
  const code =
    env.ALIYUN_SMS_MODE === 'mock'
      ? env.MOCK_SMS_OTP_CODE
      : randomInt(100_000, 1_000_000).toString()
  await req.payload.create({
    collection: 'smsChallenges',
    data: {
      attempts: 0,
      challengeId,
      codeHash: hmac(`${challengeId}:${code}`, env.SESSION_PEPPER),
      customer: customer.id,
      deliveryStatus: 'not_requested',
      deviceHash,
      expiresAt: new Date(Date.now() + env.OTP_TTL_SECONDS * 1_000).toISOString(),
      ipHash,
      phone: customer.phone,
      phoneHash,
      purpose: 'step_up',
      stepUpPurpose: input.purpose,
    },
    overrideAccess: true,
    req,
  })

  const sentAt = new Date().toISOString()
  const result = await (options.smsProvider ?? createSmsProvider()).sendStepUpOtp({
    code,
    phone: customer.phone,
    traceId,
  })
  if (!result.ok) {
    const failureCategory = smsProviderFailureCategory(result.error.code)
    await req.payload.update({
      collection: 'smsChallenges',
      data: {
        consumedAt: sentAt,
        deliveryFailureCategory: failureCategory,
        deliveryProviderCode: result.error.code,
        deliveryStatus: 'failed',
        providerRequestId: result.requestId,
        sentAt,
      },
      overrideAccess: true,
      req,
      where: { challengeId: { equals: challengeId } },
    })
    if (failureCategory === 'rate_limited') {
      throw new AppError('AUTH_RATE_LIMITED', '请求过于频繁，请稍后再试', 429, {
        retryAfterSeconds: 300,
      })
    }
    throw new AppError('SMS_UNAVAILABLE', '短信服务暂时不可用', 503)
  }

  await req.payload.update({
    collection: 'smsChallenges',
    data: {
      deliveryStatus: result.data.deliveryStatus,
      providerMessageId: result.data.providerMessageId,
      providerRequestId: result.requestId,
      receiptCheckedAt: result.data.deliveryStatus === 'delivered' ? sentAt : undefined,
      sentAt,
    },
    overrideAccess: true,
    req,
    where: { challengeId: { equals: challengeId } },
  })
  return { ...genericRequestResult, challengeId }
}

export async function verifyStepUpOtp(
  req: PayloadRequest,
  customer: Customer,
  input: StepUpVerifyInput,
  headers: Headers,
): Promise<{
  expiresAt: string
  oneTime: boolean
  purpose: StepUpPurpose
  stepUpToken: string
}> {
  const env = getEnv()
  const challenges = await req.payload.find({
    collection: 'smsChallenges',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { challengeId: { equals: input.challengeId } },
        { customer: { equals: customer.id } },
        { purpose: { equals: 'step_up' } },
        { stepUpPurpose: { equals: input.purpose } },
      ],
    },
  })
  const challenge = challenges.docs[0]
  if (!challenge || challenge.consumedAt || new Date(challenge.expiresAt).getTime() <= Date.now()) {
    throw invalidChallenge()
  }

  const { deviceHash, ipHash } = clientHashes(headers, input.deviceId)
  if (challenge.deviceHash !== deviceHash) throw invalidChallenge()
  const attempted = await req.payload.db.pool.query<{ code_hash: string }>(
    `UPDATE sms_challenges
     SET attempts = attempts + 1, updated_at = NOW()
     WHERE id = $1
       AND customer_id = $2
       AND purpose = 'step_up'
       AND step_up_purpose = $3
       AND device_hash = $4
       AND consumed_at IS NULL
       AND expires_at > NOW()
       AND attempts < $5
     RETURNING code_hash`,
    [challenge.id, customer.id, input.purpose, deviceHash, env.OTP_MAX_ATTEMPTS],
  )
  const codeHash = attempted.rows[0]?.code_hash
  if (!codeHash) throw invalidChallenge()
  const candidate = hmac(`${input.challengeId}:${input.code}`, env.SESSION_PEPPER)
  if (!safeEqualHex(candidate, codeHash)) throw invalidChallenge()

  return inAuthTransaction(req, async () => {
    const database = await authTransactionDatabase(req)
    const consumedAt = new Date().toISOString()
    const consumed = await database.execute(sql`
      UPDATE sms_challenges
      SET consumed_at = ${consumedAt}, updated_at = NOW()
      WHERE id = ${challenge.id}
        AND customer_id = ${customer.id}
        AND purpose = 'step_up'
        AND step_up_purpose = ${input.purpose}
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING id
    `)
    if (consumed.rows?.[0]?.id === undefined) throw invalidChallenge()

    const stepUpToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + env.STEP_UP_GRANT_TTL_SECONDS * 1_000).toISOString()
    await req.payload.create({
      collection: 'stepUpGrants',
      data: {
        customer: customer.id,
        deviceHash,
        expiresAt,
        ipHash,
        purpose: input.purpose,
        tokenHash: hmac(stepUpToken, env.SESSION_PEPPER),
      },
      overrideAccess: true,
      req,
    })
    return {
      expiresAt,
      oneTime: isOneTimeStepUpPurpose(input.purpose),
      purpose: input.purpose,
      stepUpToken,
    }
  })
}

async function assertIdentityRiskCooldownInactive(
  req: PayloadRequest,
  customerId: number | string,
): Promise<void> {
  const database = await authTransactionDatabase(req)
  const state = await database.execute(sql`
    SELECT identity_risk_cooldown_started_at
    FROM customers
    WHERE id = ${customerId}
    FOR SHARE
  `)
  const startedAt = state.rows?.[0]?.identity_risk_cooldown_started_at
  if (!startedAt) return
  const startedAtMs = new Date(String(startedAt)).getTime()
  const cutoff = Date.now() - getEnv().IDENTITY_RISK_COOLDOWN_SECONDS * 1_000
  if (Number.isFinite(startedAtMs) && startedAtMs > cutoff) {
    throw new AppError(
      'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE',
      '账号刚完成找回或换绑，冷静期内禁止高风险操作',
      403,
    )
  }
}

export async function authorizeStepUpGrant(
  req: PayloadRequest,
  input: {
    customerId: number | string
    deviceId: string
    headers: Headers
    purpose: StepUpPurpose
    stepUpToken: string
  },
): Promise<{ grantId: number | string; oneTime: boolean; purpose: StepUpPurpose }> {
  const tokenHash = hmac(input.stepUpToken, getEnv().SESSION_PEPPER)
  const { deviceHash } = clientHashes(input.headers, input.deviceId)
  return inAuthTransaction(req, async () => {
    await assertIdentityRiskCooldownInactive(req, input.customerId)
    const database = await authTransactionDatabase(req)
    const oneTime = isOneTimeStepUpPurpose(input.purpose)
    const authorized = oneTime
      ? await database.execute(sql`
          UPDATE step_up_grants
          SET consumed_at = NOW(), updated_at = NOW()
          WHERE token_hash = ${tokenHash}
            AND customer_id = ${input.customerId}
            AND purpose = ${input.purpose}
            AND device_hash = ${deviceHash}
            AND consumed_at IS NULL
            AND expires_at > NOW()
          RETURNING id
        `)
      : await database.execute(sql`
          SELECT id
          FROM step_up_grants
          WHERE token_hash = ${tokenHash}
            AND customer_id = ${input.customerId}
            AND purpose = ${input.purpose}
            AND device_hash = ${deviceHash}
            AND consumed_at IS NULL
            AND expires_at > NOW()
        `)
    const grantId = authorized.rows?.[0]?.id
    if (typeof grantId !== 'number' && typeof grantId !== 'string') throw invalidGrant()
    return { grantId, oneTime, purpose: input.purpose }
  })
}
