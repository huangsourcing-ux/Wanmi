import { randomInt, randomUUID } from 'node:crypto'
import {
  commitTransaction,
  initTransaction,
  killTransaction,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { hmac, randomOpaqueToken, safeEqualHex } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { createSmsProvider } from '@/providers/aliyunsms'
import type { SmsRequestInput, SmsVerifyInput } from '@/schemas/auth'

import { clientHashes, maskPhone, normalizeChinesePhone } from './client-facts'

const genericRequestResult = {
  accepted: true as const,
  message: '如果手机号可用，验证码将很快送达',
}

async function rateCount(
  payload: Payload,
  field: 'deviceHash' | 'ipHash' | 'phoneHash',
  value: string,
) {
  const result = await payload.count({
    collection: 'smsChallenges',
    overrideAccess: true,
    where: {
      and: [
        { [field]: { equals: value } },
        { createdAt: { greater_than: new Date(Date.now() - 3_600_000).toISOString() } },
      ],
    },
  })
  return result.totalDocs
}

export async function requestOtp(
  payload: Payload,
  input: SmsRequestInput,
  headers: Headers,
  traceId: string,
) {
  const env = getEnv()
  let phone: string
  try {
    phone = normalizeChinesePhone(input.phone)
  } catch {
    throw new AppError('INVALID_PHONE', '请输入有效的中国大陆手机号', 400)
  }
  const { deviceHash, ipHash } = clientHashes(headers, input.deviceId)
  const phoneHash = hmac(phone, env.SESSION_PEPPER)
  const since = new Date(Date.now() - 3_600_000).toISOString()
  const [phoneCount, ipCount, deviceCount, global] = await Promise.all([
    rateCount(payload, 'phoneHash', phoneHash),
    rateCount(payload, 'ipHash', ipHash),
    rateCount(payload, 'deviceHash', deviceHash),
    payload.count({
      collection: 'smsChallenges',
      overrideAccess: true,
      where: { createdAt: { greater_than: since } },
    }),
  ])
  if (
    phoneCount >= env.OTP_PHONE_LIMIT_PER_HOUR ||
    ipCount >= env.OTP_IP_LIMIT_PER_HOUR ||
    deviceCount >= env.OTP_DEVICE_LIMIT_PER_HOUR ||
    global.totalDocs >= env.OTP_GLOBAL_LIMIT_PER_HOUR
  ) {
    throw new AppError('AUTH_RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  }

  const challengeId = randomUUID()
  const code =
    env.ALIYUN_SMS_MODE === 'mock'
      ? env.MOCK_SMS_OTP_CODE
      : randomInt(100_000, 1_000_000).toString()
  await payload.create({
    collection: 'smsChallenges',
    data: {
      attempts: 0,
      challengeId,
      codeHash: hmac(`${challengeId}:${code}`, env.SESSION_PEPPER),
      deviceHash,
      expiresAt: new Date(Date.now() + env.OTP_TTL_SECONDS * 1_000).toISOString(),
      ipHash,
      phone,
      phoneHash,
    },
    overrideAccess: true,
  })
  const result = await createSmsProvider().sendOtp({ code, phone, traceId })
  if (!result.ok) throw new AppError('SMS_UNAVAILABLE', '短信服务暂时不可用', 503)
  return { ...genericRequestResult, challengeId }
}

export async function verifyOtp(
  req: PayloadRequest,
  input: SmsVerifyInput,
  headers: Headers,
): Promise<{
  customer: { id: number | string; phoneMasked: string }
  expiresAt: string
  token: string
}> {
  const payload = req.payload
  const env = getEnv()
  const challenges = await payload.find({
    collection: 'smsChallenges',
    limit: 1,
    overrideAccess: true,
    where: { challengeId: { equals: input.challengeId } },
  })
  const challenge = challenges.docs[0]
  const invalid = () => new AppError('AUTH_INVALID_CHALLENGE', '验证码无效或已过期', 401)
  if (!challenge || challenge.consumedAt || new Date(challenge.expiresAt).getTime() <= Date.now())
    throw invalid()
  if (challenge.attempts >= env.OTP_MAX_ATTEMPTS) throw invalid()

  const { deviceHash, ipHash } = clientHashes(headers, input.deviceId)
  if (challenge.deviceHash !== deviceHash) throw invalid()
  const candidate = hmac(`${input.challengeId}:${input.code}`, env.SESSION_PEPPER)
  const attemptClaim = await payload.update({
    collection: 'smsChallenges',
    data: { attempts: challenge.attempts + 1 },
    overrideAccess: true,
    where: {
      and: [
        { id: { equals: challenge.id } },
        { attempts: { equals: challenge.attempts } },
        { consumedAt: { exists: false } },
      ],
    },
  })
  // Compare-and-swap on `attempts`: only the request that observes the current
  // count wins the write. Concurrent guesses against the same challenge cannot
  // race past OTP_MAX_ATTEMPTS by all reading the same stale attempts value.
  if (!attemptClaim.docs.length) throw invalid()
  if (!safeEqualHex(candidate, challenge.codeHash)) throw invalid()

  const now = new Date()
  const startedTransaction = await initTransaction(req)
  try {
    const consumed = await payload.update({
      collection: 'smsChallenges',
      data: { consumedAt: now.toISOString() },
      overrideAccess: true,
      req,
      where: {
        and: [
          { id: { equals: challenge.id } },
          { consumedAt: { exists: false } },
          { expiresAt: { greater_than: now.toISOString() } },
        ],
      },
    })
    if (!consumed.docs.length) throw invalid()

    const existing = await payload.find({
      collection: 'customers',
      limit: 1,
      overrideAccess: true,
      req,
      where: { phone: { equals: challenge.phone } },
    })
    const customer =
      existing.docs[0] ??
      (await payload.create({
        collection: 'customers',
        data: {
          phone: challenge.phone,
          phoneMasked: maskPhone(challenge.phone),
          status: 'active',
        },
        overrideAccess: true,
        req,
      }))
    if (customer.status !== 'active') throw new AppError('AUTH_DISABLED', '账号当前不可登录', 403)

    const expiresAt = new Date(now.getTime() + env.CUSTOMER_SESSION_SECONDS * 1_000).toISOString()
    const token = randomOpaqueToken()
    await payload.update({
      collection: 'customerSessions',
      data: { revokedAt: now.toISOString() },
      overrideAccess: true,
      req,
      where: {
        and: [
          { customer: { equals: customer.id } },
          { deviceHash: { equals: deviceHash } },
          { revokedAt: { exists: false } },
        ],
      },
    })
    await payload.create({
      collection: 'customerSessions',
      data: {
        customer: customer.id,
        deviceHash,
        expiresAt,
        ipHash,
        lastSeenAt: now.toISOString(),
        tokenHash: hmac(token, env.SESSION_PEPPER),
      },
      overrideAccess: true,
      req,
    })
    if (startedTransaction) await commitTransaction(req)
    return { customer: { id: customer.id, phoneMasked: customer.phoneMasked }, expiresAt, token }
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    throw error
  }
}

export async function revokeSessions(
  payload: Payload,
  rawToken: string | null,
  scope: 'all' | 'current',
) {
  if (!rawToken) return
  const env = getEnv()
  const sessions = await payload.find({
    collection: 'customerSessions',
    limit: 1,
    overrideAccess: true,
    where: { tokenHash: { equals: hmac(rawToken, env.SESSION_PEPPER) } },
  })
  const session = sessions.docs[0]
  if (!session) return
  const customerId = typeof session.customer === 'object' ? session.customer.id : session.customer
  await payload.update({
    collection: 'customerSessions',
    data: { revokedAt: new Date().toISOString() },
    overrideAccess: true,
    where:
      scope === 'all'
        ? { and: [{ customer: { equals: customerId } }, { revokedAt: { exists: false } }] }
        : { id: { equals: session.id } },
  })
}

export function customerCookie(token: string, expiresAt: string): string {
  const env = getEnv()
  return `${env.CUSTOMER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Lax`
}

export function clearCustomerCookie(): string {
  return `${getEnv().CUSTOMER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

export function rawCustomerToken(headers: Headers): string | null {
  const name = getEnv().CUSTOMER_SESSION_COOKIE
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return null
}
