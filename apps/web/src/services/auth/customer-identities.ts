import { randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

import { decryptSecret, encryptSecret, hmac, randomOpaqueToken } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import type { Customer } from '@/payload-types'
import { createSmsProvider } from '@/providers/aliyunsms'
import { createWechatOfficialProvider } from '@/providers/wechatofficial'
import type { CustomerRegistrationInput } from '@/schemas/auth'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { customerNeedsLegacyProfileCompletion } from '@/services/privacy/customer-consents'

import {
  assertCustomerAccountCapability,
  assertCustomerAccountCapabilityFromSnapshot,
  transitionCustomerAccount,
} from './account-state'
import { authTransactionDatabase, inAuthTransaction } from './atomic'
import { clientHashes, maskPhone, normalizeChinesePhone } from './client-facts'
import { issueCustomerSession, revokeAllCustomerSessions } from './customer-sessions'
import { appendConsentAcceptance } from './registration-consents'
import { recordCustomerSecurityEvent } from './security-events'

export type IdentityProvider = 'phone' | 'wechat'
export type RegistrationSource = 'phone' | 'wechat_oauth' | 'wechat_qrcode'

const LEGACY_PHONE_REVIEW_REASONS = [
  'd9a_legacy_phone_normalization_failed',
  'd9a_legacy_phone_duplicate',
] as const

export type IdentityRecord = {
  boundAt: string
  customer: number | Customer
  id: number
  identifierEncrypted: string
  identifierHash: string
  provider: IdentityProvider
  providerInstanceId: string
  status: 'active' | 'unbound'
}

type RegistrationIntentRecord = {
  consumedAt?: string | null
  deviceHash: string
  expiresAt: string
  id: number
  identifierEncrypted: string
  identifierHash: string
  ipHash: string
  phoneMasked?: string | null
  provider: IdentityProvider
  providerInstanceId: string
  source: RegistrationSource
}

export type IdentityAuthenticationResult =
  | {
      customer: { id: number; phoneMasked: string; profileCompletionRequired: boolean }
      expiresAt: string
      kind: 'authenticated'
      token: string
    }
  | {
      expiresAt: string
      kind: 'registration_required'
      provider: IdentityProvider
      registrationToken: string
    }

function identityEncryptionKey(): string {
  const env = getEnv()
  return env.CUSTOMER_IDENTITY_ENCRYPTION_KEY ?? env.TOTP_ENCRYPTION_KEY
}

export function identityProviderInstance(provider: IdentityProvider): string {
  const env = getEnv()
  if (provider === 'phone') return env.CUSTOMER_PHONE_IDENTITY_INSTANCE_ID
  return env.WECHAT_OFFICIAL_APP_ID ?? 'wechat-official-fixture'
}

export function protectedIdentifier(identifier: string): {
  identifierEncrypted: string
  identifierHash: string
} {
  return {
    identifierEncrypted: encryptSecret(identifier, identityEncryptionKey()),
    identifierHash: hmac(identifier, getEnv().SESSION_PEPPER),
  }
}

function customerId(identity: IdentityRecord): number {
  return typeof identity.customer === 'object' ? identity.customer.id : identity.customer
}

function relationshipId(value: number | Customer | null | undefined): number | undefined {
  if (typeof value === 'number') return value
  return value?.id
}

function foldFullWidthAscii(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)
    if (codePoint === 0x3000) return ' '
    if (codePoint !== undefined && codePoint >= 0xff01 && codePoint <= 0xff5e) {
      return String.fromCodePoint(codePoint - 0xfee0)
    }
    return character
  }).join('')
}

function reviewedLegacyPhone(value: string): string | undefined {
  const compact = foldFullWidthAscii(value).replace(/[\s()/\p{Dash_Punctuation}]/gu, '')
  let nationalNumber = compact
  if (compact.startsWith('+86')) {
    nationalNumber = compact.slice(3)
  } else if (compact.startsWith('0086')) {
    nationalNumber = compact.slice(4)
  } else if (compact.startsWith('86')) {
    nationalNumber = compact.slice(2)
  }
  // Some isolated historical rows contain the domestic trunk prefix even though
  // Mainland mobile numbers do not use it. This candidate is only used to block
  // registration for an open review; it never authenticates or binds an identity.
  if (/^01[3-9]\d{9}$/u.test(nationalNumber)) nationalNumber = nationalNumber.slice(1)

  const normalized = `+86${nationalNumber}`
  return /^\+861[3-9]\d{9}$/u.test(normalized) ? normalized : undefined
}

async function assertLegacyPhoneIsNotQuarantined(
  req: PayloadRequest,
  phone: string,
): Promise<void> {
  const reviews = await req.payload.find({
    collection: 'manualReviews',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    select: { customer: true },
    where: {
      and: [
        { status: { equals: 'open' } },
        { reasonCode: { in: [...LEGACY_PHONE_REVIEW_REASONS] } },
      ],
    },
  })
  const customerIds = [
    ...new Set(
      reviews.docs
        .map((review) => relationshipId(review.customer))
        .filter((id): id is number => id !== undefined),
    ),
  ]
  if (customerIds.length === 0) return

  const customers = await req.payload.find({
    collection: 'customers',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    select: { phone: true },
    where: { id: { in: customerIds } },
  })
  if (!customers.docs.some((customer) => reviewedLegacyPhone(customer.phone) === phone)) return

  throw new AppError('CUSTOMER_ACCOUNT_NEEDS_REVIEW', '该手机号关联的历史账号需要人工复核', 403, {
    action: '请联系客服处理历史账号后再登录',
    retryable: false,
    title: '历史账号需要人工复核',
  })
}

async function findIdentity(
  req: PayloadRequest,
  provider: IdentityProvider,
  providerInstanceId: string,
  identifierHash: string,
): Promise<IdentityRecord | undefined> {
  const result = await req.payload.find({
    collection: 'customerIdentities',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { provider: { equals: provider } },
        { providerInstanceId: { equals: providerInstanceId } },
        { identifierHash: { equals: identifierHash } },
      ],
    },
  })
  return result.docs[0] as unknown as IdentityRecord | undefined
}

async function loadActiveCustomer(req: PayloadRequest, id: number): Promise<Customer> {
  const customer = await req.payload.findByID({
    collection: 'customers',
    id,
    overrideAccess: true,
    req,
  })
  assertCustomerAccountCapabilityFromSnapshot(customer, 'login')
  return customer
}

async function loginIdentity(
  req: PayloadRequest,
  identity: IdentityRecord,
  hashes: { deviceHash: string; ipHash: string },
): Promise<IdentityAuthenticationResult> {
  if (identity.status !== 'active') {
    throw new AppError('IDENTITY_UNBOUND', '该登录身份已解绑', 403)
  }
  const customer = await loadActiveCustomer(req, customerId(identity))
  await req.payload.update({
    collection: 'customerIdentities',
    data: { lastUsedAt: new Date().toISOString() },
    id: identity.id,
    overrideAccess: true,
    req,
  })
  const profileCompletionRequired = await customerNeedsLegacyProfileCompletion(req, customer)
  const session = await issueCustomerSession(req, { customer, ...hashes })
  return {
    customer: {
      id: customer.id,
      phoneMasked: customer.phoneMasked,
      profileCompletionRequired,
    },
    expiresAt: session.expiresAt,
    kind: 'authenticated',
    token: session.token,
  }
}

export async function createRegistrationIntent(
  req: PayloadRequest,
  input: {
    deviceHash: string
    identifier: string
    ipHash: string
    phoneMasked?: string
    provider: IdentityProvider
    source: RegistrationSource
  },
): Promise<Extract<IdentityAuthenticationResult, { kind: 'registration_required' }>> {
  const token = randomOpaqueToken()
  const expiresAt = new Date(
    Date.now() + getEnv().CUSTOMER_REGISTRATION_SECONDS * 1_000,
  ).toISOString()
  const protectedValue = protectedIdentifier(input.identifier)
  await req.payload.create({
    collection: 'customerRegistrationIntents',
    data: {
      ...protectedValue,
      deviceHash: input.deviceHash,
      expiresAt,
      ipHash: input.ipHash,
      phoneMasked: input.phoneMasked,
      provider: input.provider,
      providerInstanceId: identityProviderInstance(input.provider),
      source: input.source,
      tokenHash: hmac(token, getEnv().SESSION_PEPPER),
    },
    overrideAccess: true,
    req,
  })
  return {
    expiresAt,
    kind: 'registration_required',
    provider: input.provider,
    registrationToken: token,
  }
}

async function createLegacyPhoneIdentity(
  req: PayloadRequest,
  customer: Customer,
  phone: string,
): Promise<IdentityRecord> {
  const now = new Date().toISOString()
  const providerInstanceId = identityProviderInstance('phone')
  const protectedValue = protectedIdentifier(phone)
  try {
    return (await req.payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedValue,
        boundAt: now,
        customer: customer.id,
        lastUsedAt: now,
        provider: 'phone',
        providerInstanceId,
        status: 'active',
        verifiedAt: now,
      },
      overrideAccess: true,
      req,
    })) as unknown as IdentityRecord
  } catch (error) {
    const raced = await findIdentity(
      req,
      'phone',
      providerInstanceId,
      protectedValue.identifierHash,
    )
    if (raced) return raced
    throw error
  }
}

export async function authenticateVerifiedPhone(
  req: PayloadRequest,
  input: { deviceHash: string; ipHash: string; phone: string },
): Promise<IdentityAuthenticationResult> {
  const phone = normalizeChinesePhone(input.phone)
  await assertLegacyPhoneIsNotQuarantined(req, phone)
  const providerInstanceId = identityProviderInstance('phone')
  const identifierHash = hmac(phone, getEnv().SESSION_PEPPER)
  const identity = await findIdentity(req, 'phone', providerInstanceId, identifierHash)
  if (identity) return loginIdentity(req, identity, input)

  const legacy = await req.payload.find({
    collection: 'customers',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { phone: { equals: phone } },
  })
  if (legacy.docs[0]) {
    const legacyIdentity = await createLegacyPhoneIdentity(req, legacy.docs[0], phone)
    return loginIdentity(req, legacyIdentity, input)
  }
  return createRegistrationIntent(req, {
    ...input,
    identifier: phone,
    phoneMasked: maskPhone(phone),
    provider: 'phone',
    source: 'phone',
  })
}

export async function authenticateVerifiedWechat(
  req: PayloadRequest,
  input: {
    deviceHash: string
    ipHash: string
    openid: string
    source: 'wechat_oauth' | 'wechat_qrcode'
  },
): Promise<IdentityAuthenticationResult> {
  const providerInstanceId = identityProviderInstance('wechat')
  const identifierHash = hmac(input.openid, getEnv().SESSION_PEPPER)
  const identity = await findIdentity(req, 'wechat', providerInstanceId, identifierHash)
  if (identity) return loginIdentity(req, identity, input)
  return createRegistrationIntent(req, {
    ...input,
    identifier: input.openid,
    provider: 'wechat',
  })
}

async function claimRegistrationIntent(
  req: PayloadRequest,
  rawToken: string,
): Promise<RegistrationIntentRecord> {
  const database = await authTransactionDatabase(req)
  const now = new Date().toISOString()
  const claimed = await database.execute(sql`
    UPDATE customer_registration_intents
    SET consumed_at = ${now}, updated_at = NOW()
    WHERE token_hash = ${hmac(rawToken, getEnv().SESSION_PEPPER)}
      AND consumed_at IS NULL
      AND expires_at > NOW()
    RETURNING id
  `)
  const id = claimed.rows?.[0]?.id
  if (typeof id !== 'number') {
    throw new AppError('REGISTRATION_TOKEN_INVALID', '注册确认已失效或已使用', 401)
  }
  return (await req.payload.findByID({
    collection: 'customerRegistrationIntents',
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })) as unknown as RegistrationIntentRecord
}

function registrationConsentSource(source: RegistrationSource) {
  if (source === 'phone') return 'phone_registration' as const
  return source === 'wechat_oauth'
    ? ('wechat_oauth_registration' as const)
    : ('wechat_qrcode_registration' as const)
}

function invitationCode(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
}

async function findInviter(
  req: PayloadRequest,
  code: string | undefined,
): Promise<number | undefined> {
  if (!code) return undefined
  const result = await req.payload.find({
    collection: 'customers',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { inviteCode: { equals: code } },
  })
  const inviter = result.docs[0]
  if (!inviter) throw new AppError('INVITATION_CODE_INVALID', '邀请码无效', 400)
  return inviter.id
}

async function createIdentityFromIntent(
  req: PayloadRequest,
  customer: Customer,
  intent: RegistrationIntentRecord,
  now: string,
): Promise<IdentityRecord> {
  return (await req.payload.create({
    collection: 'customerIdentities',
    data: {
      boundAt: now,
      customer: customer.id,
      identifierEncrypted: intent.identifierEncrypted,
      identifierHash: intent.identifierHash,
      lastUsedAt: now,
      provider: intent.provider,
      providerInstanceId: intent.providerInstanceId,
      status: 'active',
      verifiedAt: now,
    },
    overrideAccess: true,
    req,
  })) as unknown as IdentityRecord
}

async function createRegistrationConsents(
  req: PayloadRequest,
  customerId: number,
  source: RegistrationSource,
  headers: Headers,
  acceptedAt: string,
) {
  const consentTypes = ['service_terms', 'privacy_policy', 'device_identifier_notice'] as const
  for (const consentType of consentTypes) {
    await appendConsentAcceptance(req, {
      acceptedAt,
      consentType,
      customerId,
      headers,
      source: registrationConsentSource(source),
    })
  }
}

async function racedRegistrationLogin(
  req: PayloadRequest,
  primary: RegistrationIntentRecord,
  phone: string,
  hashes: { deviceHash: string; ipHash: string },
): Promise<IdentityAuthenticationResult | undefined> {
  const primaryIdentity = await findIdentity(
    req,
    primary.provider,
    primary.providerInstanceId,
    primary.identifierHash,
  )
  if (primaryIdentity?.status === 'active') return loginIdentity(req, primaryIdentity, hashes)
  const phoneCustomer = await req.payload.find({
    collection: 'customers',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { phone: { equals: phone } },
  })
  const customer = phoneCustomer.docs[0]
  if (!customer) return undefined
  const identity = await createLegacyPhoneIdentity(req, customer, phone)
  return loginIdentity(req, identity, hashes)
}

export async function registerCustomer(
  req: PayloadRequest,
  input: CustomerRegistrationInput,
  headers: Headers,
  authFlowToken: string | null,
): Promise<Extract<IdentityAuthenticationResult, { kind: 'authenticated' }>> {
  const hashes = clientHashes(headers, input.deviceId)
  let claimedPrimary: RegistrationIntentRecord | undefined
  let claimedPhone: RegistrationIntentRecord | undefined
  try {
    return await inAuthTransaction(req, async () => {
      const primary = await claimRegistrationIntent(req, input.registrationToken)
      claimedPrimary = primary
      if (primary.provider === 'phone' && primary.deviceHash !== hashes.deviceHash) {
        throw new AppError('REGISTRATION_DEVICE_MISMATCH', '注册确认与当前设备不匹配', 403)
      }
      if (primary.provider === 'wechat') {
        const flowHash = authFlowToken ? hmac(authFlowToken, getEnv().SESSION_PEPPER) : undefined
        if (!flowHash || primary.deviceHash !== flowHash) {
          throw new AppError('REGISTRATION_BROWSER_MISMATCH', '注册确认与当前浏览器会话不匹配', 403)
        }
        if (!input.phoneRegistrationToken) {
          throw new AppError('PHONE_VERIFICATION_REQUIRED', '微信注册还需完成手机号验证', 400)
        }
        claimedPhone = await claimRegistrationIntent(req, input.phoneRegistrationToken)
        if (claimedPhone.provider !== 'phone' || claimedPhone.deviceHash !== hashes.deviceHash) {
          throw new AppError('PHONE_VERIFICATION_INVALID', '手机号验证凭证无效', 403)
        }
      } else {
        claimedPhone = primary
      }

      const phoneIntent = claimedPhone
      if (!phoneIntent) throw new AppError('PHONE_VERIFICATION_REQUIRED', '需要手机号验证', 400)
      const phone = normalizeChinesePhone(
        decryptSecret(phoneIntent.identifierEncrypted, identityEncryptionKey()),
      )
      await assertLegacyPhoneIsNotQuarantined(req, phone)
      const inviterId = await findInviter(req, input.invitationCode)
      const now = new Date().toISOString()
      const customer = await req.payload.create({
        collection: 'customers',
        data: {
          accountType: 'registered',
          defaultCustomerProfileType: input.defaultCustomerProfileType,
          inviteCode: invitationCode(),
          invitedByCustomer: inviterId,
          phone,
          phoneMasked: maskPhone(phone),
          registrationSource: primary.source,
          capabilityRestrictions: [],
          status: 'pending_registration',
        },
        overrideAccess: true,
        req,
      })
      await createIdentityFromIntent(req, customer, phoneIntent, now)
      if (primary.provider === 'wechat') await createIdentityFromIntent(req, customer, primary, now)
      await createRegistrationConsents(req, customer.id, primary.source, headers, now)
      if (input.invitationCode) {
        await appendConsentAcceptance(req, {
          acceptedAt: now,
          consentType: 'invitation_attribution',
          customerId: customer.id,
          headers,
          source: registrationConsentSource(primary.source),
        })
      }
      if (input.commercialSmsOptIn) {
        await appendConsentAcceptance(req, {
          acceptedAt: now,
          consentType: 'commercial_sms',
          customerId: customer.id,
          headers,
          source: registrationConsentSource(primary.source),
        })
      }
      const activated = await transitionCustomerAccount(req, {
        actor: { type: 'system' },
        changedAt: now,
        customerId: customer.id,
        evidence: {
          observedAt: now,
          reference: `registration-intent:${primary.id}`,
          source: 'registration',
        },
        expectedRestrictions: [],
        expectedStatus: 'pending_registration',
        reason: 'explicit_registration_completed',
        restrictions: [],
        status: 'active',
      })
      await recordCustomerSecurityEvent(req, customer.id, 'registration_completed', {
        defaultCustomerProfileType: input.defaultCustomerProfileType,
        eligibilityDeclaration: 'adult_or_authorized_representative',
        registrationSource: primary.source,
      })
      await recordAuditEvent(req, {
        action: 'customer.registered',
        actor: { id: customer.id, type: 'customer' },
        metadata: {
          defaultCustomerProfileType: input.defaultCustomerProfileType,
          eligibilityDeclaration: 'adult_or_authorized_representative',
          registrationSource: primary.source,
        },
        targetId: customer.id,
      })
      const session = await issueCustomerSession(req, {
        customer: {
          ...customer,
          capabilityRestrictions: activated.capabilityRestrictions,
          status: activated.status,
        },
        ...hashes,
      })
      return {
        customer: {
          id: customer.id,
          phoneMasked: customer.phoneMasked,
          profileCompletionRequired: false,
        },
        expiresAt: session.expiresAt,
        kind: 'authenticated' as const,
        token: session.token,
      }
    })
  } catch (error) {
    if (error instanceof AppError && error.code === 'CUSTOMER_ACCOUNT_NEEDS_REVIEW') throw error
    if (!claimedPrimary || !claimedPhone) throw error
    const phone = normalizeChinesePhone(
      decryptSecret(claimedPhone.identifierEncrypted, identityEncryptionKey()),
    )
    const raced = await racedRegistrationLogin(req, claimedPrimary, phone, hashes)
    if (raced?.kind === 'authenticated') return raced
    throw error
  }
}

async function createIdentityCollisionReview(
  req: PayloadRequest,
  customer: Customer,
  existing: IdentityRecord,
): Promise<void> {
  await req.payload.create({
    collection: 'manualReviews',
    data: {
      customer: customer.id,
      customerIdentity: existing.id,
      evidence: { provider: existing.provider, providerInstanceId: existing.providerInstanceId },
      reasonCode: 'customer_identity_collision',
      status: 'open',
    },
    overrideAccess: true,
    req,
  })
  await recordCustomerSecurityEvent(req, customer.id, 'identity_collision', {
    provider: existing.provider,
  })
}

export async function activeCustomerIdentities(
  req: PayloadRequest,
  customerId: number,
): Promise<IdentityRecord[]> {
  const result = await req.payload.find({
    collection: 'customerIdentities',
    depth: 0,
    limit: 20,
    overrideAccess: true,
    req,
    where: {
      and: [{ customer: { equals: customerId } }, { status: { equals: 'active' } }],
    },
  })
  return result.docs as unknown as IdentityRecord[]
}

export async function notifyFormerCustomerIdentities(
  req: PayloadRequest,
  customerId: number,
  identities: IdentityRecord[],
  traceId: string,
): Promise<void> {
  for (const identity of identities) {
    let outcome: 'failed' | 'sent' = 'failed'
    let requestId: string | undefined
    try {
      const identifier = decryptSecret(identity.identifierEncrypted, identityEncryptionKey())
      if (identity.provider === 'phone') {
        const sms = createSmsProvider()
        if (!sms.sendIdentityChanged) throw new Error('SMS_SECURITY_NOTICE_UNAVAILABLE')
        const result = await sms.sendIdentityChanged({ phone: identifier, traceId })
        outcome = result.ok ? 'sent' : 'failed'
        requestId = result.requestId
      } else {
        const result = await createWechatOfficialProvider().sendSecurityNotice({
          openid: identifier,
          traceId,
        })
        outcome = 'sent'
        requestId = result.requestId
      }
    } catch {
      outcome = 'failed'
    }
    await recordCustomerSecurityEvent(req, customerId, 'identity_change_notification', {
      outcome,
      provider: identity.provider,
      requestId,
    })
  }
}

export async function bindVerifiedIdentity(
  req: PayloadRequest,
  customer: Customer,
  rawToken: string,
  traceId: string,
): Promise<{ identityId: number; status: 'bound' }> {
  const result = await inAuthTransaction(req, async () => {
    await assertCustomerAccountCapability(req, customer.id, 'identity_change')
    const intent = await claimRegistrationIntent(req, rawToken)
    let existing = await findIdentity(
      req,
      intent.provider,
      intent.providerInstanceId,
      intent.identifierHash,
    )
    let replacementPhone: string | undefined
    if (intent.provider === 'phone') {
      replacementPhone = normalizeChinesePhone(
        decryptSecret(intent.identifierEncrypted, identityEncryptionKey()),
      )
      if (!existing) {
        const legacy = await req.payload.find({
          collection: 'customers',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          req,
          where: { phone: { equals: replacementPhone } },
        })
        if (legacy.docs[0]) {
          existing = await createLegacyPhoneIdentity(req, legacy.docs[0], replacementPhone)
        }
      }
    }
    if (existing && customerId(existing) !== customer.id) {
      await createIdentityCollisionReview(req, customer, existing)
      return { collision: true as const }
    }
    const old = await activeCustomerIdentities(req, customer.id)
    const sameProvider = old.find(
      (identity) =>
        identity.provider === intent.provider && identity.identifierHash !== intent.identifierHash,
    )
    const now = new Date().toISOString()
    if (sameProvider) {
      await req.payload.update({
        collection: 'customerIdentities',
        data: { status: 'unbound', unboundAt: now },
        id: sameProvider.id,
        overrideAccess: true,
        req,
      })
    }
    const identity = existing
      ? ((await req.payload.update({
          collection: 'customerIdentities',
          data: { boundAt: now, lastUsedAt: now, status: 'active', unboundAt: null },
          id: existing.id,
          overrideAccess: true,
          req,
        })) as unknown as IdentityRecord)
      : await createIdentityFromIntent(req, customer, intent, now)
    const highRiskReplacement = Boolean(sameProvider)
    if (highRiskReplacement) {
      await req.payload.update({
        collection: 'customers',
        data: {
          identityRiskCooldownStartedAt: now,
          phone: replacementPhone,
          phoneMasked: replacementPhone ? maskPhone(replacementPhone) : undefined,
        },
        id: customer.id,
        overrideAccess: true,
        req,
      })
      await revokeAllCustomerSessions(req, customer.id, 'identity_replaced')
    }
    await recordCustomerSecurityEvent(req, customer.id, 'identity_bound', {
      highRiskReplacement,
      provider: intent.provider,
    })
    await recordAuditEvent(req, {
      action: 'customer.identity.bound',
      actor: { id: customer.id, type: 'customer' },
      metadata: { highRiskReplacement, provider: intent.provider },
      targetId: identity.id,
    })
    return { collision: false as const, highRiskReplacement, identity, old }
  })
  if (result.collision) {
    throw new AppError(
      'IDENTITY_COLLISION_REVIEW_REQUIRED',
      '该身份已绑定其他账号，已进入人工复核',
      409,
    )
  }
  if (result.highRiskReplacement) {
    await notifyFormerCustomerIdentities(req, customer.id, result.old, traceId)
  }
  return { identityId: result.identity.id, status: 'bound' }
}

export async function unbindCustomerIdentity(
  req: PayloadRequest,
  customer: Customer,
  identityId: number,
  traceId: string,
): Promise<{ identityId: number; status: 'unbound' }> {
  const result = await inAuthTransaction(req, async () => {
    await assertCustomerAccountCapability(req, customer.id, 'identity_change')
    const database = await authTransactionDatabase(req)
    const locked = await database.execute(sql`
      SELECT id
      FROM customer_identities
      WHERE customer_id = ${customer.id} AND status = 'active'
      ORDER BY id
      FOR UPDATE
    `)
    const activeIds = (locked.rows ?? [])
      .map((row) => row.id)
      .filter((id) => typeof id === 'number')
    if (!activeIds.includes(identityId)) {
      throw new AppError('IDENTITY_NOT_FOUND', '未找到可解绑的登录身份', 404)
    }
    if (activeIds.length <= 1) {
      throw new AppError('LAST_LOGIN_IDENTITY_REQUIRED', '不能解绑最后一个可登录身份', 409)
    }
    const old = await activeCustomerIdentities(req, customer.id)
    const now = new Date().toISOString()
    const updated = await database.execute(sql`
      UPDATE customer_identities
      SET status = 'unbound', unbound_at = ${now}, updated_at = NOW()
      WHERE id = ${identityId} AND customer_id = ${customer.id} AND status = 'active'
      RETURNING id
    `)
    if (updated.rows?.[0]?.id !== identityId) {
      throw new AppError('IDENTITY_NOT_FOUND', '未找到可解绑的登录身份', 404)
    }
    await revokeAllCustomerSessions(req, customer.id, 'identity_unbound')
    await recordCustomerSecurityEvent(req, customer.id, 'identity_unbound', {
      identityId,
    })
    await recordAuditEvent(req, {
      action: 'customer.identity.unbound',
      actor: { id: customer.id, type: 'customer' },
      targetId: identityId,
    })
    return { old }
  })
  await notifyFormerCustomerIdentities(req, customer.id, result.old, traceId)
  return { identityId, status: 'unbound' }
}

export async function changeDefaultCustomerProfileType(
  req: PayloadRequest,
  customer: Customer,
  defaultCustomerProfileType: 'individual' | 'organization',
): Promise<{ defaultCustomerProfileType: 'individual' | 'organization' }> {
  if (customer.defaultCustomerProfileType === defaultCustomerProfileType) {
    return { defaultCustomerProfileType }
  }
  await inAuthTransaction(req, async () => {
    await req.payload.update({
      collection: 'customers',
      data: { defaultCustomerProfileType },
      id: customer.id,
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(req, {
      action: 'customer.default_profile_type.changed',
      actor: { id: customer.id, type: 'customer' },
      metadata: {
        from: customer.defaultCustomerProfileType ?? 'unset',
        to: defaultCustomerProfileType,
      },
      targetId: customer.id,
    })
  })
  return { defaultCustomerProfileType }
}
