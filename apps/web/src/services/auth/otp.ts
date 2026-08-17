import { randomInt, randomUUID } from 'node:crypto'
import {
  commitTransaction,
  createLocalReq,
  initTransaction,
  killTransaction,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { hmac, safeEqualHex } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { createSmsProvider } from '@/providers/aliyunsms'
import { createCaptchaProvider, type CaptchaProvider } from '@/providers/aliyuncaptcha'
import type { SmsRequestInput, SmsVerifyInput } from '@/schemas/auth'
import type { Customer } from '@/payload-types'

import { assertCustomerAccountCapabilityFromSnapshot } from './account-state'
import { requestAccountClosure } from './account-closure'
import { clientHashes, normalizeChinesePhone } from './client-facts'
import { authenticateVerifiedPhone, type IdentityAuthenticationResult } from './customer-identities'
import { revokeAllCustomerSessions } from './customer-sessions'
import { recordCustomerSecurityEvent } from './security-events'
import { enforceSmsRateLimits } from './sms-rate-limit'

const genericRequestResult = {
  accepted: true as const,
  message: '如果手机号可用，验证码将很快送达',
}

type CustomerIdentity = Customer

type CustomerSessionRecord = {
  customer: number | CustomerIdentity
  id: number | string
}

export function smsProviderFailureCategory(code: string) {
  const category = code.replace(/^SMS_/, '').toLowerCase()
  return ['balance_insufficient', 'invalid_number', 'rate_limited', 'template_unapproved'].includes(
    category,
  )
    ? (category as
        | 'balance_insufficient'
        | 'invalid_number'
        | 'rate_limited'
        | 'template_unapproved')
    : 'unknown'
}

export async function requestOtp(
  payload: Payload,
  input: SmsRequestInput,
  headers: Headers,
  traceId: string,
  options: { captchaProvider?: CaptchaProvider } = {},
) {
  const env = getEnv()
  let phone: string
  try {
    phone = normalizeChinesePhone(input.phone)
  } catch {
    throw new AppError('INVALID_PHONE', '请输入有效的中国大陆手机号', 400)
  }
  const captcha = await (options.captchaProvider ?? createCaptchaProvider()).verify({
    captchaVerifyParam: input.captchaVerifyParam,
    purpose: 'sms',
    traceId,
  })
  if (!captcha.ok) {
    throw new AppError('CAPTCHA_REJECTED', '人机校验未通过', 403)
  }
  const { deviceHash, ipHash } = clientHashes(headers, input.deviceId)
  const phoneHash = hmac(phone, env.SESSION_PEPPER)
  await enforceSmsRateLimits(payload, { deviceHash, ipHash, phoneHash })

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
      purpose: 'login',
      deliveryStatus: 'not_requested',
    },
    overrideAccess: true,
  })
  const sentAt = new Date().toISOString()
  const result = await createSmsProvider().sendOtp({ code, phone, traceId })
  if (!result.ok) {
    const failureCategory = smsProviderFailureCategory(result.error.code)
    await payload.update({
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
      where: { challengeId: { equals: challengeId } },
    })
    if (failureCategory === 'rate_limited') {
      throw new AppError('AUTH_RATE_LIMITED', '请求过于频繁，请稍后再试', 429, {
        retryAfterSeconds: 300,
      })
    }
    throw new AppError('SMS_UNAVAILABLE', '短信服务暂时不可用', 503)
  }
  await payload.update({
    collection: 'smsChallenges',
    data: {
      deliveryStatus: result.data.deliveryStatus,
      providerMessageId: result.data.providerMessageId,
      providerRequestId: result.requestId,
      receiptCheckedAt: result.data.deliveryStatus === 'delivered' ? sentAt : undefined,
      sentAt,
    },
    overrideAccess: true,
    where: { challengeId: { equals: challengeId } },
  })
  return { ...genericRequestResult, challengeId }
}

export async function verifyOtp(
  req: PayloadRequest,
  input: SmsVerifyInput,
  headers: Headers,
): Promise<IdentityAuthenticationResult> {
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
  if (
    !challenge ||
    challenge.purpose !== 'login' ||
    challenge.consumedAt ||
    new Date(challenge.expiresAt).getTime() <= Date.now()
  )
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

    const result = await authenticateVerifiedPhone(req, {
      deviceHash,
      ipHash,
      phone: challenge.phone,
    })
    if (startedTransaction) await commitTransaction(req)
    return result
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    throw error
  }
}

async function findActiveSession(req: PayloadRequest, rawToken: string | null) {
  if (!rawToken) return null
  const env = getEnv()
  const sessions = await req.payload.find({
    collection: 'customerSessions',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { tokenHash: { equals: hmac(rawToken, env.SESSION_PEPPER) } },
        { expiresAt: { greater_than: new Date().toISOString() } },
        { revokedAt: { exists: false } },
      ],
    },
  })
  return (sessions.docs[0] as CustomerSessionRecord | undefined) ?? null
}

export async function revokeSessions(
  req: PayloadRequest,
  rawToken: string | null,
  scope: 'all' | 'current',
) {
  const session = await findActiveSession(req, rawToken)
  if (!session) return
  const customerId = typeof session.customer === 'object' ? session.customer.id : session.customer
  if (scope === 'all') {
    await revokeAllCustomerSessions(req, customerId, 'customer_logout_all')
    return
  }
  const revoked = await req.payload.update({
    collection: 'customerSessions',
    data: { revokedAt: new Date().toISOString() },
    overrideAccess: true,
    req,
    where: { id: { equals: session.id } },
  })
  await recordCustomerSecurityEvent(req, customerId, 'sessions_revoked', {
    revokedCount: revoked.docs.length,
    scope,
  })
}

export async function authenticatedCustomerRequest(
  payload: Payload,
  request: Request,
): Promise<{ req: PayloadRequest; user: CustomerIdentity }> {
  const req = await createCustomerReq(payload, request.headers)
  const session = await findActiveSession(req, rawCustomerToken(request.headers))
  if (!session) throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  const customerId = typeof session.customer === 'object' ? session.customer.id : session.customer
  const customer = (await payload.findByID({
    collection: 'customers',
    id: customerId,
    overrideAccess: true,
    req,
  })) as CustomerIdentity
  assertCustomerAccountCapabilityFromSnapshot(customer, 'login')
  const user = { ...customer, collection: 'customers' as const }
  req.user = user
  return { req, user }
}

async function createCustomerReq(payload: Payload, headers: Headers): Promise<PayloadRequest> {
  return createLocalReq({ req: { headers } }, payload)
}

export async function requestCustomerDeletion(
  req: PayloadRequest,
  customer: CustomerIdentity,
  input: { deviceId: string; reason?: string; stepUpToken: string },
) {
  return requestAccountClosure(req, customer, {
    ...input,
    reason: input.reason ?? 'customer_requested_account_closure',
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
