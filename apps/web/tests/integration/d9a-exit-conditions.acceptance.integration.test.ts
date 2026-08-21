import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { POST as postWechatCallback } from '@/app/api/v1/auth/wechat/callback/route'
import { hmac, randomOpaqueToken } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import type { Admin, Customer } from '@/payload-types'
import { CAPTCHA_FIXTURE_TOKEN, type CaptchaProvider } from '@/providers/aliyuncaptcha'
import type { WechatOfficialProvider } from '@/providers/wechatofficial'
import {
  FixtureWestDigitalWriteTransport,
  type WestDigitalWriteFixtureHandler,
} from '@/providers/westdigital-write-fixtures'
import {
  WestDigitalWriteAdapter,
  type WestDigitalWriteTransportRequest,
} from '@/providers/westdigital-write'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import { executeAccountClosure, requestAccountClosure } from '@/services/auth/account-closure'
import {
  decideAccountRecovery,
  submitAccountRecoveryRequest,
} from '@/services/auth/account-recovery'
import { clientHashes, maskPhone } from '@/services/auth/client-facts'
import {
  authenticateVerifiedPhone,
  bindVerifiedIdentity,
  createRegistrationIntent,
  identityProviderInstance,
  protectedIdentifier,
  unbindCustomerIdentity,
} from '@/services/auth/customer-identities'
import { requestOtp } from '@/services/auth/otp'
import { authorizeStepUpGrant, requestStepUpOtp, verifyStepUpOtp } from '@/services/auth/step-up'
import {
  completeWechatOAuth,
  confirmWechatQr,
  consumeWechatQr,
  createWechatQrScene,
  handleWechatQrEvent,
  pollWechatQr,
  startWechatOAuth,
} from '@/services/auth/wechat'
import { createBalancePayment } from '@/services/commerce/balance-payments'
import { createCustomerOrder } from '@/services/commerce/order-creation'
import { addCustomerDnsRecord, deleteCustomerDnsRecordBatch } from '@/services/domains/dns-records'
import {
  modifyDomainManagementPassword,
  revealDomainManagementPassword,
  setCustomerDomainLockStatus,
  updateDomainContactInformation,
} from '@/services/domains/domain-management'
import { requestCustomerNameserverChange } from '@/services/domains/nameserver-changes'
import { calculateTldPrice } from '@/services/pricing/price-calculation'
import {
  createQuoteIntegrityHash,
  type CustomerQuoteStore,
  type QuoteSnapshotInput,
  type StoredCustomerQuote,
} from '@/services/pricing/customer-quotes'
import { submitRealnameTemplate, syncRealnameTemplateStatus } from '@/services/realname/templates'

import { PRICING_RULE_FIXTURES } from '../fixtures/pricing'
import { approvedRealnameProviderFixture, realnameTemplateFixture } from '../fixtures/realname'
import { issueStepUpGrantFixture } from '../fixtures/step-up'

const fixturePrefix = `d9a-exit-acceptance-${randomUUID()}`
let payload: Payload
let administrator: Admin
let supportCustomer: Customer
let supportTemplateId: number

function phone(): string {
  return `+86199${randomInt(10_000_000, 100_000_000)}`
}

function headers(suffix: string = randomUUID(), forwardedFor?: string): Headers {
  return new Headers({
    'user-agent': `Wanmi-D9A-Exit-Acceptance/${suffix}`,
    'x-forwarded-for': forwardedFor ?? `2001:db8:${randomInt(0x1000, 0xffff).toString(16)}::1`,
    'x-request-id': `${fixturePrefix}-${suffix}`,
  })
}

async function requestFor(
  user?: unknown,
  suffix: string = randomUUID(),
  requestHeaders: Headers = headers(suffix),
): Promise<PayloadRequest> {
  const req = await createLocalReq({ req: { headers: requestHeaders } }, payload)
  if (user) req.user = user as never
  return req
}

function customerUser(customer: Customer) {
  return { ...customer, collection: 'customers' as const }
}

function adminUser() {
  return { ...administrator, collection: 'admins' as const }
}

function customerIdentity(customer: Customer) {
  return { collection: 'customers' as const, id: customer.id, status: customer.status }
}

async function createCustomer(
  suffix: string,
  options: {
    accountType?: 'legacy_unknown' | 'registered'
    identities?: Array<'phone' | 'wechat'>
    registrationSource?: 'legacy_unknown' | 'phone'
    status?: Customer['status']
  } = {},
): Promise<Customer> {
  const customerPhone = phone()
  const accountType = options.accountType ?? 'registered'
  const customer = await payload.create({
    collection: 'customers',
    data: {
      accountType,
      capabilityRestrictions: [],
      consentStateVersion: 0,
      defaultCustomerProfileType: accountType === 'legacy_unknown' ? undefined : 'individual',
      phone: customerPhone,
      phoneMasked: maskPhone(customerPhone),
      registrationSource:
        options.registrationSource ??
        (accountType === 'legacy_unknown' ? 'legacy_unknown' : 'phone'),
      status: options.status ?? 'active',
    },
    overrideAccess: true,
  })
  for (const provider of options.identities ?? []) {
    await createIdentity(
      customer,
      provider,
      provider === 'phone' ? customerPhone : `${fixturePrefix}-${suffix}-openid-${randomUUID()}`,
    )
  }
  return customer
}

async function createIdentity(
  customer: Customer,
  provider: 'phone' | 'wechat',
  identifier: string,
) {
  const now = new Date().toISOString()
  return payload.create({
    collection: 'customerIdentities',
    data: {
      ...protectedIdentifier(identifier),
      boundAt: now,
      customer: customer.id,
      provider,
      providerInstanceId: identityProviderInstance(provider),
      status: 'active',
      verifiedAt: now,
    },
    overrideAccess: true,
  })
}

async function createSession(customer: Customer, suffix: string) {
  const token = randomOpaqueToken()
  return payload.create({
    collection: 'customerSessions',
    data: {
      customer: customer.id,
      deviceHash: hmac(`${fixturePrefix}:${suffix}:device`, getEnv().SESSION_PEPPER),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ipHash: hmac(`${fixturePrefix}:${suffix}:ip`, getEnv().SESSION_PEPPER),
      lastSeenAt: new Date().toISOString(),
      tokenHash: hmac(token, getEnv().SESSION_PEPPER),
    },
    overrideAccess: true,
  })
}

function wechatProvider(input: {
  confirmationUrl?: (value: string) => void
  openid: string
}): WechatOfficialProvider {
  return {
    createTemporaryQr: vi.fn(async ({ expiresSeconds, scene, traceId }) => ({
      expiresSeconds,
      requestId: `${fixturePrefix}-qr-${traceId}`,
      ticket: hmac(scene, getEnv().SESSION_PEPPER),
      url: 'https://fixture.invalid/d9a-exit-acceptance',
    })),
    exchangeOAuthCode: vi.fn(async ({ traceId }) => ({
      openid: input.openid,
      requestId: `${fixturePrefix}-oauth-${traceId}`,
    })),
    sendLoginConfirmation: vi.fn(async ({ confirmationUrl, traceId }) => {
      input.confirmationUrl?.(confirmationUrl)
      return { requestId: `${fixturePrefix}-confirmation-${traceId}` }
    }),
    sendSecurityNotice: vi.fn(async ({ traceId }) => ({
      requestId: `${fixturePrefix}-security-${traceId}`,
    })),
  }
}

async function createQrFixture(input: { customer?: Customer; openid: string; suffix: string }) {
  const requestHeaders = headers(input.suffix)
  const flowToken = randomOpaqueToken()
  let confirmationUrl = ''
  const provider = wechatProvider({
    confirmationUrl: (value) => {
      confirmationUrl = value
    },
    openid: input.openid,
  })
  const req = await requestFor(
    input.customer ? customerUser(input.customer) : undefined,
    input.suffix,
    requestHeaders,
  )
  const created = await createWechatQrScene(
    req,
    {
      captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
      deviceId: `${fixturePrefix}-${input.suffix}-device`,
      flowToken,
      headers: requestHeaders,
      purpose: 'login',
      traceId: `${fixturePrefix}-${input.suffix}`,
    },
    { provider },
  )
  return {
    confirmationToken: () =>
      new URLSearchParams(new URL(confirmationUrl).hash.slice(1)).get('token'),
    created,
    flowToken,
    provider,
    req,
    requestHeaders,
  }
}

async function scanQr(
  qr: Awaited<ReturnType<typeof createQrFixture>>,
  openid: string,
  suffix: string,
) {
  await handleWechatQrEvent(
    qr.req,
    { event: 'SCAN', eventKey: qr.created.scene, fromUserName: openid },
    `${fixturePrefix}-${suffix}`,
    { provider: qr.provider },
  )
}

async function consumeQr(qr: Awaited<ReturnType<typeof createQrFixture>>, suffix: string) {
  return consumeWechatQr(qr.req, {
    deviceId: `${fixturePrefix}-${suffix}-consume-device`,
    flowToken: qr.flowToken,
    headers: qr.requestHeaders,
    scene: qr.created.scene,
    traceId: `${fixturePrefix}-${suffix}-consume`,
  })
}

function ownedAssetResponse(input: WestDigitalWriteTransportRequest) {
  return {
    body: {
      clientid: `${fixturePrefix}-${input.requestId}`,
      data: {
        dns1: 'ns1.before.example',
        dns2: 'ns2.before.example',
        dns3: '',
        dns4: '',
        dns5: '',
        dns6: '',
        domain: input.body.domain,
        expdate: '2028-08-20 12:00:00',
        id: '44169980',
        regdate: '2026-08-20 12:00:00',
        registrars: 'west',
      },
      result: 200,
    },
    status: 200,
  }
}

function managedProvider(handler?: WestDigitalWriteFixtureHandler) {
  const transport = new FixtureWestDigitalWriteTransport(
    handler ??
      ((input) => {
        if (input.operation === 'asset_query') return ownedAssetResponse(input)
        if (input.operation === 'domain_management_password_get') {
          return {
            body: {
              clientid: `${fixturePrefix}-${input.requestId}`,
              data: { domainpwd: 'SafeSecret12' },
              result: 200,
            },
            status: 200,
          }
        }
        if (
          input.operation === 'domain_management_password_modify' ||
          input.operation === 'domain_contact_update' ||
          input.operation === 'domain_lock'
        ) {
          return {
            body: { clientid: `${fixturePrefix}-${input.requestId}`, data: {}, result: 200 },
            status: 200,
          }
        }
        throw new Error(`Unexpected acceptance provider operation: ${input.operation}`)
      }),
  )
  return { provider: new WestDigitalWriteAdapter({ transport }), transport }
}

async function createTemplate(customer: Customer, suffix: string, approved = false) {
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `D9A acceptance ${suffix}`.slice(0, 64) }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  if (!approved) return template
  const providerTemplateId = String(3_000_000 + Number(template.id))
  const provider = approvedRealnameProviderFixture(providerTemplateId)
  await submitRealnameTemplate(
    await requestFor(customerUser(customer), `${suffix}-submit`),
    template.id,
    provider,
  )
  return syncRealnameTemplateStatus(
    await requestFor(undefined, `${suffix}-sync`),
    template.id,
    provider,
  )
}

async function createAsset(
  customer: Customer,
  suffix: string,
  options: {
    domainLockStatus?: 'locked' | 'unlocked' | 'unknown'
    templateId?: number | string
  } = {},
) {
  const templateId = options.templateId ?? (await createTemplate(customer, `${suffix}-template`)).id
  return payload.create({
    collection: 'domainAssets',
    data: {
      customer: customer.id,
      domainAscii: `${suffix}-${randomUUID().slice(0, 8)}.example`,
      domainLockStatus: options.domainLockStatus ?? 'unknown',
      expiresAt: '2028-08-20T04:00:00.000Z',
      lastSyncedAt: '2026-08-20T04:00:00.000Z',
      nameservers: ['ns1.before.example', 'ns2.before.example'],
      realnameTemplate: Number(templateId),
      registeredAt: '2026-08-20T04:00:00.000Z',
      registrar: 'west',
      status: 'active',
      syncReviewStatus: 'none',
      syncVersion: 0,
      upstreamOwnershipStatus: 'unknown',
    },
    overrideAccess: true,
  })
}

function defaultDnsProvider() {
  const transport = new FixtureWestDigitalWriteTransport()
  return { provider: new WestDigitalWriteAdapter({ transport }), transport }
}

function ordinaryDnsRecord(host = 'www') {
  return {
    host,
    idempotencyKey: randomUUID(),
    line: '默认' as const,
    priority: 10,
    ttl: 600,
    type: 'A' as const,
    value: '192.0.2.10',
  }
}

async function activeSessionCount(customer: Customer) {
  return payload.count({
    collection: 'customerSessions',
    overrideAccess: true,
    where: {
      and: [{ customer: { equals: customer.id } }, { revokedAt: { exists: false } }],
    },
  })
}

async function replacementFixture(provider: 'phone' | 'wechat', suffix: string) {
  const customer = await createCustomer(suffix)
  const oldIdentifier = provider === 'phone' ? customer.phone : `${fixturePrefix}-${suffix}-old`
  await createIdentity(customer, provider, oldIdentifier)
  if (provider === 'wechat') await createIdentity(customer, 'phone', customer.phone)
  else await createIdentity(customer, 'wechat', `${fixturePrefix}-${suffix}-wechat`)
  await Promise.all([
    createSession(customer, `${suffix}-1`),
    createSession(customer, `${suffix}-2`),
  ])
  const requestHeaders = headers(`${suffix}-replacement`)
  const nextIdentifier = provider === 'phone' ? phone() : `${fixturePrefix}-${suffix}-next`
  const hashes = clientHashes(requestHeaders, `${fixturePrefix}-${suffix}-replacement-device`)
  const intent = await createRegistrationIntent(await requestFor(), {
    ...hashes,
    identifier: nextIdentifier,
    ...(provider === 'phone' ? { phoneMasked: maskPhone(nextIdentifier) } : {}),
    provider,
    source: provider === 'phone' ? 'phone' : 'wechat_oauth',
  })
  await bindVerifiedIdentity(
    await requestFor(customerUser(customer), `${suffix}-bind`, requestHeaders),
    customer,
    intent.registrationToken,
    `${fixturePrefix}-${suffix}-bind`,
  )
  return { customer, nextIdentifier }
}

async function createRecoveryFixture(suffix: string) {
  const now = new Date()
  const customer = await createCustomer(`${suffix}-customer`, {
    identities: ['phone', 'wechat'],
    status: 'suspended',
  })
  const fullNameChinese = `李验收${randomUUID().slice(0, 4)}`
  const identityDocumentNumber = `EXIT${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ fullNameChinese, identityDocumentNumber }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  const quote = await payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: now.toISOString(),
      availabilityRequestId: `${fixturePrefix}-${suffix}-availability`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `${fixturePrefix}-${suffix}-quote`,
      currency: 'CNY',
      customer: customer.id,
      domainAscii: `${suffix}-${randomUUID()}.example`,
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: now.toISOString(),
      providerProductId: `${fixturePrefix}-${suffix}-product`,
      providerRequestId: `${fixturePrefix}-${suffix}-provider`,
      quotedAt: now.toISOString(),
      quoteIntegrityHash: 'a'.repeat(64),
      quoteRef: randomUUID(),
      registrationPriceMinor: 2_500,
      renewalPriceMinor: 2_500,
      ruleFixedAmountMinor: 0,
      ruleKey: `${fixturePrefix}-${suffix}-rule`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
      roundingMode: 'half_up_to_fen',
      schemaVersion: 1,
      sourceCalculationHash: 'b'.repeat(64),
      sourcePriceSnapshotRef: randomUUID(),
      tld: 'example',
      upstreamCostMinor: 2_500,
      upstreamRegistrationPriceMinor: 2_500,
      upstreamRenewalPriceMinor: 2_500,
      userPriceMinor: 2_500,
      years: 1,
    },
    overrideAccess: true,
  })
  const orderNumber = `${fixturePrefix}-${suffix}-order-${randomUUID()}`
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor: 2_500,
      currency: 'CNY',
      customer: customer.id,
      domainAscii: `${suffix}-${randomUUID()}.example`,
      orderNumber,
      paidAt: now.toISOString(),
      quote: quote.id,
      quoteSnapshot: { expiresAt: new Date(now.getTime() + 300_000).toISOString() },
      realnameTemplate: template.id,
      status: 'succeeded',
    },
    overrideAccess: true,
  })
  const paymentTransactionId = `${fixturePrefix}-${suffix}-wechat-${randomUUID()}`
  await payload.create({
    collection: 'paymentNotifications',
    data: {
      amountMinor: 2_500,
      confirmationStatus: 'confirmed',
      currency: 'CNY',
      notificationId: `${fixturePrefix}-${suffix}-notification`,
      order: order.id,
      paidAt: now.toISOString(),
      payloadDigest: 'c'.repeat(64),
      receivedAt: now.toISOString(),
      signatureVerified: true,
      source: 'notification',
      wechatTransactionId: paymentTransactionId,
    },
    overrideAccess: true,
  })
  const submitted = await submitAccountRecoveryRequest(await requestFor(), {
    fullNameChinese,
    historicalOrderNumber: orderNumber,
    identityDocumentNumber,
    paymentTransactionId,
    phone: customer.phone,
    phoneUnavailable: true,
    wechatUnavailable: true,
  })
  const reviews = await payload.find({
    collection: 'manualReviews',
    limit: 1,
    overrideAccess: true,
    sort: '-id',
    where: {
      and: [
        { customer: { equals: customer.id } },
        { reasonCode: { equals: 'customer_account_recovery' } },
      ],
    },
  })
  const review = reviews.docs[0]
  if (!review) throw new Error('Recovery acceptance fixture did not create a review')
  const req = await requestFor(adminUser(), `${suffix}-decision`)
  req.context.adminApprovalExecution = `account_recovery:${review.id}`
  const decision = await decideAccountRecovery(req, {
    decision: {
      conclusion: 'approved',
      note: `D9-A exit acceptance ${submitted.recoveryRequestId}`,
    },
    reviewId: Number(review.id),
    reviewerId: administrator.id,
    traceId: `${fixturePrefix}-${suffix}-decision`,
  })
  return {
    customer: await payload.findByID({
      collection: 'customers',
      id: customer.id,
      overrideAccess: true,
    }),
    decision,
  }
}

function renewalQuote(customerId: number): {
  quote: StoredCustomerQuote
  store: CustomerQuoteStore
} {
  const now = new Date().toISOString()
  const rule = PRICING_RULE_FIXTURES.com!
  const calculation = calculateTldPrice({
    registrationPriceFen: 2_500,
    renewalPriceFen: 2_750,
    rule,
  })
  const input: QuoteSnapshotInput = {
    assetExpiresAt: '2028-08-20T00:00:00.000Z',
    availabilityObservedAt: now,
    availabilityRequestId: randomUUID(),
    calculation,
    customerId,
    domainAscii: `${randomUUID()}.com`,
    domainAssetId: 2_147_000_000,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    operation: 'renewal',
    providerCacheStatus: 'miss',
    providerObservedAt: now,
    providerProductId: 'domcom',
    providerRequestId: randomUUID(),
    quotedAt: now,
    sourceCalculationHash: 'd'.repeat(64),
    sourcePriceSnapshotRef: randomUUID(),
    tld: 'com',
    traceId: `${fixturePrefix}-legacy-renewal`,
    upstreamCostMinor: calculation.upstreamRenewalPriceFen,
    userPriceMinor: calculation.renewalPriceFen,
    years: 1,
  }
  const quote: StoredCustomerQuote = {
    ...input,
    quoteId: randomInt(1, 1_000_000),
    quoteIntegrityHash: createQuoteIntegrityHash(input),
    quoteRef: randomUUID(),
  }
  return {
    quote,
    store: {
      findOwnedByRef: async (quoteRef) => (quoteRef === quote.quoteRef ? quote : undefined),
      record: async () => {
        throw new Error('Acceptance quote store is read-only')
      },
    },
  }
}

async function createSupportQuote(label: string) {
  const now = new Date().toISOString()
  return payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: now,
      availabilityRequestId: `${fixturePrefix}-${label}-availability`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `${fixturePrefix}-${label}-quote`,
      currency: 'CNY',
      customer: supportCustomer.id,
      domainAscii: `${label}-${randomUUID()}.example`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: now,
      providerProductId: `${fixturePrefix}-${label}-product`,
      providerRequestId: `${fixturePrefix}-${label}-provider`,
      quotedAt: now,
      quoteIntegrityHash: 'e'.repeat(64),
      quoteRef: randomUUID(),
      registrationPriceMinor: 100,
      renewalPriceMinor: 100,
      ruleFixedAmountMinor: 0,
      ruleKey: `${fixturePrefix}-${label}-rule`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
      roundingMode: 'half_up_to_fen',
      schemaVersion: 1,
      sourceCalculationHash: 'f'.repeat(64),
      sourcePriceSnapshotRef: randomUUID(),
      tld: 'example',
      upstreamCostMinor: 100,
      upstreamRegistrationPriceMinor: 100,
      upstreamRenewalPriceMinor: 100,
      userPriceMinor: 100,
      years: 1,
    },
    overrideAccess: true,
  })
}

async function createOrder(
  owner: Customer,
  label: string,
  status: 'pending_payment' | 'succeeded',
) {
  const quote = await createSupportQuote(label)
  return payload.create({
    collection: 'orders',
    data: {
      amountMinor: 100,
      currency: 'CNY',
      customer: owner.id,
      domainAscii: `${label}-${randomUUID()}.example`,
      orderNumber: `${fixturePrefix}-${label}-${randomUUID()}`,
      quote: quote.id,
      quoteSnapshot: { fixture: true },
      realnameTemplate: supportTemplateId,
      status,
    },
    overrideAccess: true,
  })
}

async function requestClosure(customer: Customer, suffix: string) {
  const req = await requestFor(customerUser(customer), suffix)
  const grant = await issueStepUpGrantFixture(payload, req, Number(customer.id), 'account_deletion')
  return requestAccountClosure(req, customer, { ...grant, reason: `验收注销阻断：${suffix}` })
}

async function expireClosureCooldown(requestId: string) {
  await payload.db.pool.query(
    `UPDATE account_closure_requests
     SET cooldown_ends_at = NOW() - INTERVAL '1 second'
     WHERE request_key = $1 AND event_type = 'requested'`,
    [requestId],
  )
}

beforeAll(async () => {
  payload = await getPayload({ config })
  supportCustomer = await createCustomer('support')
  supportTemplateId = Number((await createTemplate(supportCustomer, 'support-template')).id)
  administrator = await payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap' },
    data: {
      email: `${fixturePrefix}@example.test`,
      operationalScopes: ['funds_operations', 'system_configuration'],
      password: `D9A-Exit-Acceptance-${randomUUID()}`,
      roles: ['system_admin'],
      status: 'active',
    },
    overrideAccess: true,
  })
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9-A 16.14 身份、会话、同意与注销退出条件验收', () => {
  it('同一微信 openid 从网页授权与 PC 扫码解析为同一账号，不产生重复账号', async () => {
    const openid = `${fixturePrefix}-same-openid-${randomUUID()}`
    const customer = await createCustomer('same-openid')
    await createIdentity(customer, 'wechat', openid)

    const oauthHeaders = headers('same-openid-oauth')
    const oauthFlow = randomOpaqueToken()
    const provider = wechatProvider({ openid })
    const started = await startWechatOAuth(await requestFor(), {
      flowToken: oauthFlow,
      purpose: 'login',
    })
    const oauth = await completeWechatOAuth(
      await requestFor(undefined, 'same-openid-oauth-complete', oauthHeaders),
      {
        code: randomOpaqueToken(),
        flowToken: oauthFlow,
        headers: oauthHeaders,
        state: new URL(started.authorizationUrl).searchParams.get('state')!,
        traceId: `${fixturePrefix}-same-openid-oauth`,
      },
      { provider },
    )

    const qr = await createQrFixture({ openid, suffix: 'same-openid-qr' })
    await scanQr(qr, openid, 'same-openid-qr-scan')
    await confirmWechatQr(qr.req, qr.confirmationToken()!)
    const scanned = await consumeQr(qr, 'same-openid-qr')

    expect(oauth).toMatchObject({ customer: { id: customer.id }, kind: 'authenticated' })
    expect(scanned).toMatchObject({ customer: { id: customer.id }, kind: 'authenticated' })
    await expect(
      payload.count({
        collection: 'customerIdentities',
        overrideAccess: true,
        where: {
          and: [
            { provider: { equals: 'wechat' } },
            { providerInstanceId: { equals: identityProviderInstance('wechat') } },
            { identifierHash: { equals: hmac(openid, getEnv().SESSION_PEPPER) } },
          ],
        },
      }),
    ).resolves.toEqual({ totalDocs: 1 })
  })

  it('扫码后未点击确认不得建立浏览器会话；scene 一次性、过期失效、跨会话不可复用；未验签的服务号事件不得建立会话', async () => {
    const openid = `${fixturePrefix}-qr-gates-${randomUUID()}`
    const customer = await createCustomer('qr-gates')
    await createIdentity(customer, 'wechat', openid)
    const qr = await createQrFixture({ openid, suffix: 'qr-gates' })
    const before = await activeSessionCount(customer)

    const invalidCallback = await postWechatCallback(
      new Request(
        `http://127.0.0.1/api/v1/auth/wechat/callback?timestamp=1700000000&nonce=exit&signature=invalid`,
        {
          body: `<xml><ToUserName><![CDATA[wanmi]]></ToUserName><FromUserName><![CDATA[${openid}]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[SCAN]]></Event><EventKey><![CDATA[${qr.created.scene}]]></EventKey></xml>`,
          headers: { 'content-type': 'application/xml' },
          method: 'POST',
        },
      ),
    )
    expect(invalidCallback.status).toBe(401)
    await expect(activeSessionCount(customer)).resolves.toEqual(before)
    await expect(pollWechatQr(qr.req, qr.created.scene, qr.flowToken)).resolves.toMatchObject({
      status: 'created',
    })

    await scanQr(qr, openid, 'qr-gates-scan')
    await expect(consumeQr(qr, 'qr-gates-unconfirmed')).rejects.toMatchObject({
      code: 'WECHAT_QR_ALREADY_CONSUMED',
    })
    await expect(activeSessionCount(customer)).resolves.toEqual(before)
    await expect(pollWechatQr(qr.req, qr.created.scene, randomOpaqueToken())).rejects.toMatchObject(
      { code: 'WECHAT_QR_SCENE_INVALID' },
    )

    await confirmWechatQr(qr.req, qr.confirmationToken()!)
    await expect(consumeQr(qr, 'qr-gates-confirmed')).resolves.toMatchObject({
      customer: { id: customer.id },
      kind: 'authenticated',
    })
    await expect(consumeQr(qr, 'qr-gates-replay')).rejects.toMatchObject({
      code: 'WECHAT_QR_ALREADY_CONSUMED',
    })

    const expired = await createQrFixture({ openid, suffix: 'qr-expired' })
    await payload.update({
      collection: 'wechatLoginScenes',
      data: { expiresAt: new Date(Date.now() - 1_000).toISOString() },
      overrideAccess: true,
      where: { sceneHash: { equals: hmac(expired.created.scene, getEnv().SESSION_PEPPER) } },
    })
    await expect(
      pollWechatQr(expired.req, expired.created.scene, expired.flowToken),
    ).resolves.toMatchObject({ status: 'expired' })
    await expect(consumeQr(expired, 'qr-expired')).rejects.toMatchObject({
      code: 'WECHAT_QR_ALREADY_CONSUMED',
    })
  })

  it('网页授权 state 重放、授权码复用、跨站请求均 fail-closed', async () => {
    const openid = `${fixturePrefix}-oauth-gates-${randomUUID()}`
    const provider = wechatProvider({ openid })
    const requestHeaders = headers('oauth-gates')
    const flowToken = randomOpaqueToken()
    const first = await startWechatOAuth(await requestFor(), { flowToken, purpose: 'login' })
    const firstState = new URL(first.authorizationUrl).searchParams.get('state')!
    const code = randomOpaqueToken()
    await expect(
      completeWechatOAuth(
        await requestFor(undefined, 'oauth-gates-first', requestHeaders),
        {
          code,
          flowToken,
          headers: requestHeaders,
          state: firstState,
          traceId: `${fixturePrefix}-oauth-gates-first`,
        },
        { provider },
      ),
    ).resolves.toMatchObject({ kind: 'registration_required' })
    await expect(
      completeWechatOAuth(
        await requestFor(undefined, 'oauth-gates-state-replay', requestHeaders),
        {
          code: randomOpaqueToken(),
          flowToken,
          headers: requestHeaders,
          state: firstState,
          traceId: `${fixturePrefix}-oauth-gates-state-replay`,
        },
        { provider },
      ),
    ).rejects.toMatchObject({ code: 'WECHAT_OAUTH_STATE_INVALID' })

    const second = await startWechatOAuth(await requestFor(), { flowToken, purpose: 'login' })
    await expect(
      completeWechatOAuth(
        await requestFor(undefined, 'oauth-gates-code-replay', requestHeaders),
        {
          code,
          flowToken,
          headers: requestHeaders,
          state: new URL(second.authorizationUrl).searchParams.get('state')!,
          traceId: `${fixturePrefix}-oauth-gates-code-replay`,
        },
        { provider },
      ),
    ).rejects.toMatchObject({ code: 'WECHAT_OAUTH_CODE_REPLAYED' })

    const third = await startWechatOAuth(await requestFor(), { flowToken, purpose: 'login' })
    await expect(
      completeWechatOAuth(
        await requestFor(undefined, 'oauth-gates-cross-site', requestHeaders),
        {
          code: randomOpaqueToken(),
          flowToken: randomOpaqueToken(),
          headers: requestHeaders,
          state: new URL(third.authorizationUrl).searchParams.get('state')!,
          traceId: `${fixturePrefix}-oauth-gates-cross-site`,
        },
        { provider },
      ),
    ).rejects.toMatchObject({ code: 'WECHAT_OAUTH_STATE_INVALID' })
  })

  it('验证码只在短信发送与二维码创建/刷新时校验，轮询不重复校验；校验失败 fail-closed；与四维限频叠加后短信轰炸测试通过', async () => {
    const verify = vi.fn<CaptchaProvider['verify']>(async ({ traceId }) => ({
      ok: true,
      requestId: `${fixturePrefix}-captcha-${traceId}`,
      verifyCode: 'T001',
    }))
    const captchaProvider: CaptchaProvider = { verify }
    const rejectedCaptcha: CaptchaProvider = {
      verify: vi.fn(async () => ({ code: 'REJECTED', ok: false as const })),
    }
    const smsPhone = phone()
    const smsHeaders = headers('captcha-sms')
    await requestOtp(
      payload,
      {
        captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
        deviceId: `${fixturePrefix}-captcha-sms-device`,
        phone: smsPhone,
      },
      smsHeaders,
      `${fixturePrefix}-captcha-sms`,
      { captchaProvider },
    )

    const openid = `${fixturePrefix}-captcha-qr-${randomUUID()}`
    const provider = wechatProvider({ openid })
    const flowToken = randomOpaqueToken()
    const qrHeaders = headers('captcha-qr')
    const firstQr = await createWechatQrScene(
      await requestFor(undefined, 'captcha-qr', qrHeaders),
      {
        captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
        deviceId: `${fixturePrefix}-captcha-qr-device`,
        flowToken,
        headers: qrHeaders,
        purpose: 'login',
        traceId: `${fixturePrefix}-captcha-qr`,
      },
      { captchaProvider, provider },
    )
    await createWechatQrScene(
      await requestFor(undefined, 'captcha-refresh', qrHeaders),
      {
        captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
        deviceId: `${fixturePrefix}-captcha-refresh-device`,
        flowToken,
        headers: qrHeaders,
        purpose: 'login',
        traceId: `${fixturePrefix}-captcha-refresh`,
      },
      { captchaProvider, provider },
    )
    expect(verify).toHaveBeenCalledTimes(3)
    await pollWechatQr(
      await requestFor(undefined, 'captcha-poll', qrHeaders),
      firstQr.scene,
      flowToken,
    )
    expect(verify).toHaveBeenCalledTimes(3)

    const rejectedPhone = phone()
    await expect(
      requestOtp(
        payload,
        {
          captchaVerifyParam: 'rejected',
          deviceId: `${fixturePrefix}-captcha-rejected-device`,
          phone: rejectedPhone,
        },
        headers('captcha-rejected-sms'),
        `${fixturePrefix}-captcha-rejected-sms`,
        { captchaProvider: rejectedCaptcha },
      ),
    ).rejects.toMatchObject({ code: 'CAPTCHA_REJECTED' })
    await expect(
      createWechatQrScene(
        await requestFor(),
        {
          captchaVerifyParam: 'rejected',
          deviceId: `${fixturePrefix}-captcha-rejected-qr-device`,
          flowToken: randomOpaqueToken(),
          headers: headers('captcha-rejected-qr'),
          purpose: 'login',
          traceId: `${fixturePrefix}-captcha-rejected-qr`,
        },
        { captchaProvider: rejectedCaptcha, provider },
      ),
    ).rejects.toMatchObject({ code: 'CAPTCHA_REJECTED' })

    const floodPhone = phone()
    const floodDevice = `${fixturePrefix}-captcha-flood-device-${randomUUID()}`
    const floodHeaders = headers('captcha-flood')
    for (let index = 0; index < getEnv().OTP_PHONE_LIMIT_PER_HOUR; index += 1) {
      await expect(
        requestOtp(
          payload,
          { captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN, deviceId: floodDevice, phone: floodPhone },
          floodHeaders,
          `${fixturePrefix}-captcha-flood-${index}`,
        ),
      ).resolves.toMatchObject({ accepted: true })
    }
    await expect(
      requestOtp(
        payload,
        { captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN, deviceId: floodDevice, phone: floodPhone },
        floodHeaders,
        `${fixturePrefix}-captcha-flood-rejected`,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_RATE_LIMITED' })
    const hashes = clientHashes(floodHeaders, floodDevice)
    const bucketHashes = {
      device: hashes.deviceHash,
      global: hmac('sms-rate-limit:global', getEnv().SESSION_PEPPER),
      ip: hashes.ipHash,
      phone: hmac(floodPhone, getEnv().SESSION_PEPPER),
    }
    for (const [dimension, identityHash] of Object.entries(bucketHashes)) {
      await expect(
        payload.count({
          collection: 'smsRateLimits',
          overrideAccess: true,
          where: {
            and: [{ dimension: { equals: dimension } }, { identityHash: { equals: identityHash } }],
          },
        }),
      ).resolves.toEqual({ totalDocs: 1 })
    }
  })

  it('解绑最后一个可登录身份被拒绝；手机号或微信换绑后全部旧会话失效', async () => {
    const single = await createCustomer('last-identity')
    const singleIdentity = await createIdentity(single, 'phone', single.phone)
    await expect(
      unbindCustomerIdentity(
        await requestFor(customerUser(single), 'last-identity'),
        single,
        singleIdentity.id,
        `${fixturePrefix}-last-identity`,
      ),
    ).rejects.toMatchObject({ code: 'LAST_LOGIN_IDENTITY_REQUIRED' })

    const phoneReplacement = await replacementFixture('phone', 'phone-replacement')
    const wechatReplacement = await replacementFixture('wechat', 'wechat-replacement')
    for (const replacement of [phoneReplacement, wechatReplacement]) {
      await expect(activeSessionCount(replacement.customer)).resolves.toEqual({ totalDocs: 0 })
      await expect(
        payload.count({
          collection: 'customerSessions',
          overrideAccess: true,
          where: {
            and: [
              { customer: { equals: replacement.customer.id } },
              { revokedAt: { exists: true } },
            ],
          },
        }),
      ).resolves.toEqual({ totalDocs: 2 })
    }
  })

  it('账户找回成功后高风险域名操作进入冷静期且被拒绝', async () => {
    const recovery = await createRecoveryFixture('recovery-cooldown')
    expect(recovery.decision).toMatchObject({
      conclusion: 'approved',
      cooldownStartedAt: expect.any(String),
    })
    const asset = await createAsset(recovery.customer, 'recovery-cooldown-asset')
    const req = await requestFor(customerUser(recovery.customer), 'recovery-cooldown-domain')
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(recovery.customer.id),
      'nameserver_change',
    )
    await expect(
      requestCustomerNameserverChange(
        req,
        asset.id,
        {
          ...grant,
          confirmed: true,
          nameservers: ['ns1.after.example', 'ns2.after.example'],
        },
        {
          customer: customerIdentity(recovery.customer),
          traceId: `${fixturePrefix}-recovery-cooldown-domain`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE' })
  })

  it('历史账号不得生成伪造的条款同意时间；未补条款的历史用户仍可处理到期域名', async () => {
    const account = await createCustomer('legacy-renewal', {
      accountType: 'legacy_unknown',
      registrationSource: 'legacy_unknown',
    })
    const authHeaders = headers('legacy-login')
    const authenticated = await authenticateVerifiedPhone(await requestFor(), {
      ...clientHashes(authHeaders, `${fixturePrefix}-legacy-login-device`),
      phone: account.phone,
    })
    expect(authenticated).toMatchObject({
      customer: { id: account.id, profileCompletionRequired: true },
      kind: 'authenticated',
    })
    await expect(
      payload.count({
        collection: 'consentRecords',
        overrideAccess: true,
        where: { customer: { equals: account.id } },
      }),
    ).resolves.toEqual({ totalDocs: 0 })

    const renewal = renewalQuote(Number(account.id))
    await expect(
      createCustomerOrder(
        await requestFor(customerUser(account), 'legacy-renewal-order'),
        { quoteRef: renewal.quote.quoteRef },
        {
          customer: customerUser(account),
          provider: new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() }),
          quoteStore: renewal.store,
          rules: PRICING_RULE_FIXTURES,
          traceId: `${fixturePrefix}-legacy-renewal-order`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND', status: 404 })
  })

  it('持有域名、处理中订单或资金差异时不能完成注销', async () => {
    const cases = [
      { blocker: 'domains_held' as const, customer: await createCustomer('closure-domain') },
      { blocker: 'unfinished_orders' as const, customer: await createCustomer('closure-order') },
      {
        blocker: 'refund_or_reconciliation_issue' as const,
        customer: await createCustomer('closure-funds'),
      },
    ]
    await createAsset(cases[0]!.customer, 'closure-domain-asset', {
      templateId: supportTemplateId,
    })
    await createOrder(cases[1]!.customer, 'closure-order-pending', 'pending_payment')
    const reconciliationOrder = await createOrder(
      cases[2]!.customer,
      'closure-funds-order',
      'succeeded',
    )
    await payload.create({
      collection: 'reconciliations',
      data: {
        currency: 'CNY',
        differenceMinor: 1,
        kind: 'three_way',
        ledger: 'internal_orders',
        periodEnd: '2026-08-20T00:00:00.000Z',
        periodStart: '2026-08-19T00:00:00.000Z',
        reconciliationKey: `${fixturePrefix}-closure-funds-${randomUUID()}`,
        recordKey: `order:${reconciliationOrder.orderNumber}`,
        status: 'difference',
        summary: { orderNumber: reconciliationOrder.orderNumber },
        traceId: `${fixturePrefix}-closure-funds`,
      },
      overrideAccess: true,
    })

    for (const fixture of cases) {
      const requested = await requestClosure(fixture.customer, `closure-${fixture.blocker}`)
      await expireClosureCooldown(requested.requestId)
      await expect(
        executeAccountClosure(await requestFor(adminUser(), `execute-${fixture.blocker}`), {
          actorId: administrator.id,
          note: `16.14 验收：${fixture.blocker}`,
          requestId: requested.requestId,
        }),
      ).resolves.toEqual({
        blockers: [fixture.blocker],
        requestId: requested.requestId,
        status: 'blocked',
      })
      await expect(
        payload.findByID({
          collection: 'customers',
          id: fixture.customer.id,
          overrideAccess: true,
        }),
      ).resolves.toMatchObject({ status: 'active' })
    }
  })
})

describe('step-up 未完成时风险分级表中的动作全部 fail-closed；step-up 短信验证码发送频控与连续失败次数限制生效', () => {
  it('A4 第 1 行：添加普通子域解析仅需当前会话并记录审计，不错误要求 step-up', async () => {
    const customer = await createCustomer('a4-row-1')
    const asset = await createAsset(customer, 'a4-row-1-asset')
    const req = await requestFor(customerUser(customer), 'a4-row-1')
    const provider = defaultDnsProvider()
    await expect(
      addCustomerDnsRecord(req, asset.id, ordinaryDnsRecord('www'), {
        customer: customerIdentity(customer),
        provider: provider.provider,
        traceId: `${fixturePrefix}-a4-row-1`,
      }),
    ).resolves.toMatchObject({ data: { status: 'succeeded' }, state: 'ready' })
    expect(provider.transport.writeCount).toBe(1)
    await expect(
      payload.count({
        collection: 'auditLogs',
        overrideAccess: true,
        where: {
          and: [
            { action: { equals: 'domain.dns_record.change_recorded' } },
            { actorId: { equals: String(customer.id) } },
            { traceId: { equals: `${fixturePrefix}-a4-row-1` } },
          ],
        },
      }),
    ).resolves.toEqual({ totalDocs: 2 })
  })

  it('A4 第 2 行：修改根域 A/CNAME/AAAA、全部主机 MX/TXT、NS 缺少 step-up 时逐项 fail-closed，且二次确认独立生效', async () => {
    const customer = await createCustomer('a4-row-2')
    const asset = await createAsset(customer, 'a4-row-2-asset')
    const req = await requestFor(customerUser(customer), 'a4-row-2')
    const provider = defaultDnsProvider()
    const records = [
      { host: '@', type: 'A', value: '192.0.2.20' },
      { host: '@', type: 'CNAME', value: 'target.example' },
      { host: '@', type: 'AAAA', value: '2001:db8::20' },
      { host: 'mail', type: 'MX', value: 'mx.example' },
      { host: '_acme-challenge', type: 'TXT', value: 'dns-proof' },
    ] as const
    for (const [index, record] of records.entries()) {
      await expect(
        addCustomerDnsRecord(
          req,
          asset.id,
          {
            confirmed: true,
            host: record.host,
            idempotencyKey: randomUUID(),
            line: '默认',
            priority: 10,
            ttl: 600,
            type: record.type,
            value: record.value,
          },
          {
            customer: customerIdentity(customer),
            provider: provider.provider,
            traceId: `${fixturePrefix}-a4-row-2-${index}`,
          },
        ),
      ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_REQUIRED' })
    }
    await expect(
      requestCustomerNameserverChange(
        req,
        asset.id,
        {
          confirmed: true,
          deviceId: `${fixturePrefix}-a4-row-2-device`,
          nameservers: ['ns1.after.example', 'ns2.after.example'],
          stepUpToken: 'x'.repeat(43),
        },
        { customer: customerIdentity(customer), traceId: `${fixturePrefix}-a4-row-2-ns` },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID' })
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'dns_record_change',
    )
    await expect(
      addCustomerDnsRecord(
        req,
        asset.id,
        { ...ordinaryDnsRecord('@'), ...grant },
        {
          customer: customerIdentity(customer),
          provider: provider.provider,
          traceId: `${fixturePrefix}-a4-row-2-confirmation`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_CONFIRMATION_REQUIRED' })
    expect(provider.transport.writeCount).toBe(0)
  })

  it('A4 第 3 行：批量删除解析缺少 step-up 或绑定变更预览时 fail-closed', async () => {
    const customer = await createCustomer('a4-row-3')
    const asset = await createAsset(customer, 'a4-row-3-asset')
    const req = await requestFor(customerUser(customer), 'a4-row-3')
    const provider = defaultDnsProvider()
    await expect(
      deleteCustomerDnsRecordBatch(
        req,
        asset.id,
        {
          idempotencyKey: randomUUID(),
          previewToken: 'invalid-preview',
          recordIds: ['900001'],
        } as never,
        {
          customer: customerIdentity(customer),
          provider: provider.provider,
          traceId: `${fixturePrefix}-a4-row-3-step-up`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_REQUIRED' })
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'dns_bulk_delete',
    )
    await expect(
      deleteCustomerDnsRecordBatch(
        req,
        asset.id,
        {
          ...grant,
          previewToken: 'invalid-preview',
          recordIds: ['900001'],
        },
        {
          customer: customerIdentity(customer),
          provider: provider.provider,
          traceId: `${fixturePrefix}-a4-row-3-preview`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_PREVIEW_INVALID' })
    expect(provider.transport.writeCount).toBe(0)
  })

  it('A4 第 4 行：关闭域名锁缺少 step-up 时 fail-closed，成功后向 active 渠道通知', async () => {
    const customer = await createCustomer('a4-row-4', { identities: ['phone', 'wechat'] })
    const asset = await createAsset(customer, 'a4-row-4-asset', { domainLockStatus: 'locked' })
    const req = await requestFor(customerUser(customer), 'a4-row-4')
    const managed = managedProvider()
    await expect(
      setCustomerDomainLockStatus(
        req,
        asset.id,
        {
          deviceId: `${fixturePrefix}-a4-row-4-invalid-device`,
          idempotencyKey: randomUUID(),
          locked: false,
          stepUpToken: 'x'.repeat(43),
        },
        {
          customer: customerIdentity(customer),
          provider: managed.provider,
          traceId: `${fixturePrefix}-a4-row-4-invalid`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID' })
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'domain_lock_change',
    )
    await expect(
      setCustomerDomainLockStatus(
        req,
        asset.id,
        { ...grant, idempotencyKey: randomUUID(), locked: false },
        {
          customer: customerIdentity(customer),
          provider: managed.provider,
          traceId: `${fixturePrefix}-a4-row-4-success`,
        },
      ),
    ).resolves.toMatchObject({ data: { locked: false, status: 'succeeded' } })
    const notifications = await payload.find({
      collection: 'customerSecurityEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: customer.id } },
          { event: { equals: 'identity_change_notification' } },
        ],
      },
    })
    expect(
      notifications.docs.map((event) => (event.safeMetadata as { provider?: string }).provider),
    ).toEqual(expect.arrayContaining(['phone', 'wechat']))
  })

  it('A4 第 5 行：修改实名信息缺少 step-up 或二次确认时 fail-closed', async () => {
    const customer = await createCustomer('a4-row-5')
    const current = await createTemplate(customer, 'a4-row-5-current', true)
    const target = await createTemplate(customer, 'a4-row-5-target', true)
    const asset = await createAsset(customer, 'a4-row-5-asset', { templateId: current.id })
    const req = await requestFor(customerUser(customer), 'a4-row-5')
    const managed = managedProvider()
    await expect(
      updateDomainContactInformation(
        req,
        asset.id,
        {
          confirmed: true,
          contactType: 'dom_id',
          deviceId: `${fixturePrefix}-a4-row-5-invalid-device`,
          idempotencyKey: randomUUID(),
          stepUpToken: 'x'.repeat(43),
          templateId: Number(target.id),
        },
        {
          customer: customerIdentity(customer),
          provider: managed.provider,
          traceId: `${fixturePrefix}-a4-row-5-invalid`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID' })
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'realname_change',
    )
    await expect(
      updateDomainContactInformation(
        req,
        asset.id,
        {
          ...grant,
          confirmed: false as true,
          contactType: 'dom_id',
          idempotencyKey: randomUUID(),
          templateId: Number(target.id),
        },
        {
          customer: customerIdentity(customer),
          provider: managed.provider,
          traceId: `${fixturePrefix}-a4-row-5-confirmation`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_REALNAME_CONFIRMATION_REQUIRED' })
    expect(managed.transport.writeCount).toBe(0)
  })

  it('A4 第 6 行：获取或修改域名管理密码要求 purpose-bound step-up、active 渠道，并在成功后逐 provider 告知', async () => {
    const withChannels = await createCustomer('a4-row-6-channels', {
      identities: ['phone', 'wechat'],
    })
    const withoutChannels = await createCustomer('a4-row-6-no-channel')
    const withChannelsAsset = await createAsset(withChannels, 'a4-row-6-channels-asset')
    const withoutChannelsAsset = await createAsset(withoutChannels, 'a4-row-6-no-channel-asset')
    const withChannelsReq = await requestFor(customerUser(withChannels), 'a4-row-6-channels')
    const withoutChannelsReq = await requestFor(
      customerUser(withoutChannels),
      'a4-row-6-no-channel',
    )
    const managed = managedProvider()
    await expect(
      revealDomainManagementPassword(
        withChannelsReq,
        withChannelsAsset.id,
        { deviceId: `${fixturePrefix}-a4-row-6-invalid-device`, stepUpToken: 'x'.repeat(43) },
        {
          customer: customerIdentity(withChannels),
          provider: managed.provider,
          traceId: `${fixturePrefix}-a4-row-6-invalid`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID' })
    const noChannelGrant = await issueStepUpGrantFixture(
      payload,
      withoutChannelsReq,
      Number(withoutChannels.id),
      'domain_management_password',
    )
    await expect(
      revealDomainManagementPassword(withoutChannelsReq, withoutChannelsAsset.id, noChannelGrant, {
        customer: customerIdentity(withoutChannels),
        provider: managed.provider,
        traceId: `${fixturePrefix}-a4-row-6-no-channel`,
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_BOUND_CHANNEL_CONFIRMATION_REQUIRED' })

    const readGrant = await issueStepUpGrantFixture(
      payload,
      withChannelsReq,
      Number(withChannels.id),
      'domain_management_password',
    )
    await expect(
      revealDomainManagementPassword(withChannelsReq, withChannelsAsset.id, readGrant, {
        customer: customerIdentity(withChannels),
        provider: managed.provider,
        traceId: `${fixturePrefix}-a4-row-6-read`,
      }),
    ).resolves.toMatchObject({ data: { managementPassword: 'SafeSecret12' } })
    const writeGrant = await issueStepUpGrantFixture(
      payload,
      withChannelsReq,
      Number(withChannels.id),
      'domain_management_password',
    )
    await expect(
      modifyDomainManagementPassword(
        withChannelsReq,
        withChannelsAsset.id,
        {
          ...writeGrant,
          idempotencyKey: randomUUID(),
          managementPassword: 'ChangedSecret12',
        },
        {
          customer: customerIdentity(withChannels),
          provider: managed.provider,
          traceId: `${fixturePrefix}-a4-row-6-write`,
        },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' } })
    const notifications = await payload.find({
      collection: 'customerSecurityEvents',
      limit: 20,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: withChannels.id } },
          { event: { equals: 'identity_change_notification' } },
        ],
      },
    })
    const outcomes = notifications.docs.map(
      (event) => event.safeMetadata as Record<string, unknown>,
    )
    for (const provider of ['phone', 'wechat']) {
      expect(outcomes.filter((outcome) => outcome.provider === provider)).toHaveLength(2)
      expect(outcomes.every((outcome) => outcome.outcome === 'sent')).toBe(true)
    }
  })

  it('A4 第 7 行：交互式余额消费缺少 balance_spend step-up 时 fail-closed', async () => {
    const customer = await createCustomer('a4-row-7')
    await expect(
      createBalancePayment(
        await requestFor(customerUser(customer), 'a4-row-7'),
        `${fixturePrefix}-missing-order`,
        {
          customer: customerIdentity(customer),
          deviceId: `${fixturePrefix}-a4-row-7-device`,
          stepUpToken: 'x'.repeat(43),
          traceId: `${fixturePrefix}-a4-row-7`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID' })
  })

  it('A4 第 8 行：注销申请缺少 account_deletion step-up 时 fail-closed，授权后仍受注销冷静期约束', async () => {
    const customer = await createCustomer('a4-row-8')
    const req = await requestFor(customerUser(customer), 'a4-row-8')
    const wrongPurposeGrant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'balance_spend',
    )
    await expect(
      requestAccountClosure(req, customer, {
        ...wrongPurposeGrant,
        reason: '缺少 account_deletion step-up 的注销申请',
      }),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID' })
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'account_deletion',
    )
    const requested = await requestAccountClosure(req, customer, {
      ...grant,
      reason: '具备 step-up 的注销申请',
    })
    await expect(
      executeAccountClosure(await requestFor(adminUser(), 'a4-row-8-execute'), {
        actorId: administrator.id,
        note: '注销冷静期尚未结束',
        requestId: requested.requestId,
      }),
    ).resolves.toEqual({
      blockers: ['closure_cooldown_active'],
      requestId: requested.requestId,
      status: 'blocked',
    })
  })

  it('A4 第 9 行：账号刚完成找回或换绑时，冷静期内禁止上述全部高风险操作', async () => {
    const customer = await createCustomer('a4-row-9')
    const req = await requestFor(customerUser(customer), 'a4-row-9')
    const purposes = [
      'dns_record_change',
      'mx_record_change',
      'nameserver_change',
      'dns_bulk_delete',
      'domain_lock_change',
      'realname_change',
      'domain_management_password',
      'balance_spend',
      'account_deletion',
    ] as const
    const grants = await Promise.all(
      purposes.map(async (purpose) => ({
        purpose,
        ...(await issueStepUpGrantFixture(payload, req, Number(customer.id), purpose)),
      })),
    )
    await payload.update({
      collection: 'customers',
      data: { identityRiskCooldownStartedAt: new Date().toISOString() },
      id: customer.id,
      overrideAccess: true,
    })
    for (const grant of grants) {
      await expect(
        authorizeStepUpGrant(req, {
          customerId: customer.id,
          deviceId: grant.deviceId,
          headers: req.headers,
          purpose: grant.purpose,
          stepUpToken: grant.stepUpToken,
        }),
      ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE' })
    }
  })

  it('step-up 未完成时风险分级表中的动作全部 fail-closed；step-up 短信验证码发送频控与连续失败次数限制生效', async () => {
    const customer = await createCustomer('step-up-sms-controls')
    const deviceId = `${fixturePrefix}-step-up-sms-device-${randomUUID()}`
    const requestHeaders = headers('step-up-sms-controls')
    let challengeId = ''
    for (let index = 0; index < getEnv().OTP_PHONE_LIMIT_PER_HOUR; index += 1) {
      const requested = await requestStepUpOtp(
        await requestFor(customerUser(customer), `step-up-sms-${index}`, requestHeaders),
        customer,
        {
          captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
          deviceId,
          purpose: 'balance_spend',
        },
        requestHeaders,
        `${fixturePrefix}-step-up-sms-${index}`,
      )
      challengeId = requested.challengeId
    }
    await expect(
      requestStepUpOtp(
        await requestFor(customerUser(customer), 'step-up-sms-rate-rejected', requestHeaders),
        customer,
        {
          captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
          deviceId,
          purpose: 'balance_spend',
        },
        requestHeaders,
        `${fixturePrefix}-step-up-sms-rate-rejected`,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_RATE_LIMITED' })

    for (let attempt = 0; attempt < getEnv().OTP_MAX_ATTEMPTS; attempt += 1) {
      await expect(
        verifyStepUpOtp(
          await requestFor(customerUser(customer), `step-up-failure-${attempt}`, requestHeaders),
          customer,
          {
            challengeId,
            code: '000000',
            deviceId,
            purpose: 'balance_spend',
          },
          requestHeaders,
        ),
      ).rejects.toMatchObject({ code: 'STEP_UP_CHALLENGE_INVALID' })
    }
    await expect(
      verifyStepUpOtp(
        await requestFor(customerUser(customer), 'step-up-after-failures', requestHeaders),
        customer,
        {
          challengeId,
          code: getEnv().MOCK_SMS_OTP_CODE,
          deviceId,
          purpose: 'balance_spend',
        },
        requestHeaders,
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_CHALLENGE_INVALID' })
  })
})
