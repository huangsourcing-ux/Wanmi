import { execFileSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Admin, Customer, Order } from '@/payload-types'
import { mockFailure, mockSuccess } from '@/providers/mock'
import type {
  SmsProvider,
  WestDigitalDomainAsset,
  WestDigitalManagedProvider,
  WestDigitalWriteProvider,
} from '@/providers/types'
import type { VipTierRuleLevelInput } from '@/schemas/vip-tiers'
import { createAdminApprovalRequest, decideAdminApprovalRequest } from '@/services/admin/approvals'
import { executeSupportedAdminOperation } from '@/services/admin/operation-executors'
import { clientHashes, maskPhone } from '@/services/auth/client-facts'
import { identityProviderInstance, protectedIdentifier } from '@/services/auth/customer-identities'
import { transitionOrder } from '@/services/commerce/order-state'
import {
  DOMAIN_CAPABILITY_NAMES,
  type DomainCapabilityDeclaration,
  type DomainCapabilityName,
  WESTDIGITAL_DOMAIN_CAPABILITIES,
  assertDomainCapability,
} from '@/services/domains/capabilities'
import { addCustomerDnsRecord } from '@/services/domains/dns-records'
import {
  modifyDomainManagementPassword,
  revealDomainManagementPassword,
  setCustomerDomainLockStatus,
} from '@/services/domains/domain-management'
import {
  requestCustomerNameserverChange,
  runNameserverChange,
} from '@/services/domains/nameserver-changes'
import { bindCustomerInvitation, generateInvitationCode } from '@/services/invitations/binding'
import { recheckInvitationRewardClaim } from '@/services/invitations/rewards'
import { createInvitationRewardRuleVersion } from '@/services/invitations/rules'
import {
  enqueueTransactionalSecurityNotification,
  runNotificationDeliveries,
} from '@/services/notifications/outbox'
import {
  confirmPendingOrderReward,
  earnPendingOrderReward,
  readBatchRemainingPoints,
  readPointsBalance,
  redeemPointsForToolQuota,
} from '@/services/points/ledger'
import {
  executeWestDigitalWriteOperation,
  type WestDigitalWriteOperationInput,
} from '@/services/providers/westdigital-operations'
import {
  publishVipTierRuleVersion,
  readCustomerVipStatus,
  recordVipSpendForSucceededOrder,
  recordVipSpendReversalForRefundedOrder,
} from '@/services/vip/tiers'
import { createWalletAccount, postWalletCredit, readWalletBalance } from '@/services/wallet/ledger'

import { fulfillmentQuoteSnapshotFixture } from '../fixtures/commerce'
import { realnameTemplateFixture } from '../fixtures/realname'
import { issueStepUpGrantFixture } from '../fixtures/step-up'
import { ensureAnchorSystemAdmin } from '../test-cleanup'

const fixturePrefix = `d9-exit-part-two-${randomUUID()}`
let payload: Payload
let configurationAdmin: Admin
let fundsApprover: Admin
let supportTemplateId: number
let timeline = Date.UTC(2026, 0, 1)

function nextTime(days = 2): Date {
  timeline += days * 86_400_000
  return new Date(timeline)
}

function phone(): string {
  return `+86195${randomInt(10_000_000, 100_000_000)}`
}

function headers(suffix: string): Headers {
  return new Headers({
    'user-agent': `Wanmi-D9-Exit-Part-Two/${suffix}`,
    'x-forwarded-for': `2001:db8:${randomInt(0x1000, 0xffff).toString(16)}::216`,
    'x-request-id': `${fixturePrefix}-${suffix}`,
  })
}

async function requestFor(suffix: string, user?: Admin | Customer): Promise<PayloadRequest> {
  const req = await createLocalReq({ req: { headers: headers(suffix) } }, payload)
  if (user) req.user = { ...user, collection: 'roles' in user ? 'admins' : 'customers' } as never
  return req
}

function customerIdentity(customer: Customer) {
  return { collection: 'customers' as const, id: customer.id, status: customer.status }
}

async function createCustomer(
  suffix: string,
  options: { identity?: boolean; inviteCode?: boolean } = {},
): Promise<Customer> {
  const customerPhone = phone()
  const customer = await payload.create({
    collection: 'customers',
    data: {
      accountType: 'registered',
      capabilityRestrictions: [],
      defaultCustomerProfileType: 'individual',
      inviteCode: options.inviteCode ? generateInvitationCode() : undefined,
      phone: customerPhone,
      phoneMasked: maskPhone(customerPhone),
      registrationSource: 'phone',
      status: 'active',
    },
    overrideAccess: true,
  })
  if (options.identity) {
    await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(customerPhone),
        boundAt: new Date().toISOString(),
        customer: customer.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
  }
  return customer
}

async function createTemplate(customer: Customer, suffix: string) {
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `${fixturePrefix}-${suffix}`.slice(0, 64) }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  await payload.db.pool.query(
    `UPDATE realname_templates
     SET status = 'approved', provider_review_state = 'approved',
         provider_confirmed_at = NOW(), provider_template_id = $2, updated_at = NOW()
     WHERE id = $1`,
    [template.id, String(8_000_000 + Number(template.id))],
  )
  return payload.findByID({
    collection: 'realnameTemplates',
    id: template.id,
    overrideAccess: true,
  })
}

async function createAsset(
  customer: Customer,
  suffix: string,
  options: { locked?: boolean; templateId?: number } = {},
) {
  return payload.create({
    collection: 'domainAssets',
    data: {
      customer: customer.id,
      domainAscii: `${suffix}-${randomUUID().slice(0, 8)}.example`,
      domainLockStatus: options.locked ? 'locked' : 'unknown',
      expiresAt: '2028-08-20T04:00:00.000Z',
      lastSyncedAt: '2026-08-20T04:00:00.000Z',
      nameservers: ['ns1.before.example', 'ns2.before.example'],
      realnameTemplate: options.templateId ?? supportTemplateId,
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

async function createOrder(
  customer: Customer,
  suffix: string,
  options: {
    amountFen?: number
    paymentChannel?: 'balance' | 'h5' | 'native'
    status?: Order['status']
  } = {},
): Promise<Order> {
  const amountFen = options.amountFen ?? 1_200
  const now = new Date()
  const domainAscii = `${suffix}-${randomUUID()}.example`
  const template = await createTemplate(customer, `order-${suffix}`)
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
      domainAscii,
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: now.toISOString(),
      providerProductId: `${fixturePrefix}-${suffix}-product`,
      providerRequestId: `${fixturePrefix}-${suffix}-price`,
      quotedAt: now.toISOString(),
      quoteIntegrityHash: 'a'.repeat(64),
      quoteRef: randomUUID(),
      registrationPriceMinor: amountFen,
      renewalPriceMinor: amountFen,
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
      upstreamCostMinor: amountFen,
      upstreamRegistrationPriceMinor: amountFen,
      upstreamRenewalPriceMinor: amountFen,
      userPriceMinor: amountFen,
      years: 1,
    },
    overrideAccess: true,
  })
  return payload.create({
    collection: 'orders',
    data: {
      amountMinor: amountFen,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      orderNumber: `${fixturePrefix}-${suffix}-${randomUUID()}`,
      paymentChannel: options.paymentChannel ?? 'native',
      quote: quote.id,
      quoteSnapshot: fulfillmentQuoteSnapshotFixture({
        amountMinor: amountFen,
        customerId: customer.id,
        domainAscii,
        quoteId: quote.id,
      }),
      realnameTemplate: template.id,
      status: options.status ?? 'succeeded',
    },
    overrideAccess: true,
  })
}

function ownedDomain(
  domainAscii: string,
  nameservers = ['ns1.before.example', 'ns2.before.example'],
) {
  return mockSuccess<WestDigitalDomainAsset>({
    domainAscii,
    expiresAt: '2028-08-20T04:00:00.000Z',
    nameservers,
    providerAssetId: 'd9-exit-provider-asset',
    registeredAt: '2026-08-20T04:00:00.000Z',
    registrarCode: 'west',
    status: 'active',
  })
}

function managedProvider(ownership: 'not_owned' | 'owned' = 'owned') {
  let writeCount = 0
  const write = async () => {
    writeCount += 1
    return mockSuccess({ providerClientId: `${fixturePrefix}-write`, state: 'succeeded' as const })
  }
  const provider = {
    addDnsRecord: write,
    changeNameservers: write,
    createRealname: write,
    deleteDnsRecord: write,
    getDomainCertificate: async () => mockSuccess({ certificateBase64: 'Y2VydGlmaWNhdGU=' }),
    getDomainManagementPassword: async () => mockSuccess({ managementPassword: 'Secret12' }),
    modifyDnsRecord: write,
    modifyDomainManagementPassword: write,
    queryAsset: async ({ domainAscii }: { domainAscii: string }) =>
      ownership === 'owned'
        ? ownedDomain(domainAscii)
        : mockFailure('WESTDIGITAL_ASSET_NOT_IN_ACCOUNT', {
            retryable: false,
            statusKnown: true,
          }),
    queryDnsRecords: async () =>
      mockSuccess({ items: [], limit: 100, page: 1, pageCount: 1, total: 0 }),
    queryDomainInformation: async ({ domainAscii }: { domainAscii: string }) =>
      mockSuccess({ domainAscii, providerTemplateId: '8000001' }),
    queryOfflineDnsRecordDelete: async () =>
      mockSuccess({ providerTaskKey: 'task', recordState: 2, state: 'succeeded', taskState: 2 }),
    queryRealname: async () =>
      mockSuccess({ providerClientId: 'query', reviewState: 'approved', state: 'succeeded' }),
    queryRenewalEligibility: async ({ domainAscii }: { domainAscii: string }) =>
      mockSuccess({ domainAscii, state: 'eligible', statusCodes: [] }),
    register: write,
    renew: write,
    setDnsRecordPaused: write,
    setDomainLock: write,
    submitOfflineDnsRecordDelete: write,
    transferDomainToTemplate: write,
    updateDomainContact: write,
  } as unknown as WestDigitalManagedProvider
  return { provider, writeCount: () => writeCount }
}

function withoutCapability(name: DomainCapabilityName): DomainCapabilityDeclaration {
  return {
    ...WESTDIGITAL_DOMAIN_CAPABILITIES,
    [name]: { ...WESTDIGITAL_DOMAIN_CAPABILITIES[name], supported: false },
  }
}

async function settle<T>(work: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await work() }
  } catch (reason) {
    return { reason, status: 'rejected' }
  }
}

const tiers = (bronzeThreshold = 1_000, silverThreshold = 5_000): VipTierRuleLevelInput[] => [
  {
    displayName: '青铜会员',
    quotaBenefits: { advancedWhois: 10 },
    serviceContent: '基础会员服务',
    thresholdFen: bronzeThreshold,
    tierCode: 'bronze',
    tierRank: 1,
  },
  {
    displayName: '白银会员',
    quotaBenefits: { advancedWhois: 30 },
    serviceContent: '进阶会员服务',
    thresholdFen: silverThreshold,
    tierCode: 'silver',
    tierRank: 2,
  },
]

async function publishVipRule(suffix: string, effectiveAt: Date, levels = tiers()) {
  return publishVipTierRuleVersion(
    await requestFor(`vip-publish-${suffix}`, configurationAdmin),
    {
      changeNote: `${fixturePrefix} ${suffix} versioned VIP rule`,
      effectiveAt: effectiveAt.toISOString(),
      tiers: levels,
    },
    { now: () => new Date(effectiveAt.getTime() - 48 * 60 * 60_000) },
  )
}

async function approveVipCorrection(customer: Customer, suffix: string, targetTierCode: string) {
  const created = await createAdminApprovalRequest(
    await requestFor(`vip-correction-create-${suffix}`, configurationAdmin),
    {
      correctionReference: `${fixturePrefix}:vip-correction:${suffix}`,
      correctionSource: 'data_correction',
      customerId: customer.id,
      operationType: 'vip_fraud_correction',
      reasonNote: `D9 exit acceptance correction ${suffix}`,
      spendReversalFen: 0,
      targetTierCode,
    },
  )
  await decideAdminApprovalRequest(
    await requestFor(`vip-correction-decide-${suffix}`, fundsApprover),
    created.id,
    { decision: 'approve', note: `D9 exit acceptance approves ${suffix}` },
  )
  await payload.db.pool.query(
    `UPDATE admin_approval_requests
     SET created_at = NOW() - (cooldown_seconds + 1) * INTERVAL '1 second'
     WHERE id = $1`,
    [created.id],
  )
  return executeSupportedAdminOperation(
    await requestFor(`vip-correction-execute-${suffix}`, fundsApprover),
    created.id,
  )
}

async function bindInvitation(inviter: Customer, invitee: Customer, suffix: string) {
  const reqHeaders = headers(`invite-bind-${suffix}`)
  const req = await createLocalReq({ req: { headers: reqHeaders } }, payload)
  req.user = { ...invitee, collection: 'customers' } as never
  const deviceId = `${fixturePrefix}-invite-device-${suffix}`
  const relationship = await bindCustomerInvitation(req, {
    code: inviter.inviteCode!,
    deviceId,
    headers: reqHeaders,
  })
  return { deviceHash: clientHashes(reqHeaders, deviceId).deviceHash, relationship }
}

async function invitationClaimId(invitee: Customer): Promise<number> {
  const found = await payload.find({
    collection: 'invitationRewardClaims',
    limit: 1,
    overrideAccess: true,
    where: { inviteeCustomer: { equals: invitee.id } },
  })
  if (!found.docs[0]) throw new Error('Expected invitation reward claim')
  return Number(found.docs[0].id)
}

beforeAll(async () => {
  payload = await getPayload({ config })
  configurationAdmin = await ensureAnchorSystemAdmin(payload)
  fundsApprover = await payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap', suppressAdminAccountAudit: true },
    data: {
      email: `${fixturePrefix}@example.invalid`,
      operationalScopes: ['funds_operations'],
      password: `D9Exit!${randomUUID()}aA1`,
      roles: ['system_admin'],
      status: 'active',
    },
    overrideAccess: true,
  })
  const supportCustomer = await createCustomer('support')
  supportTemplateId = Number((await createTemplate(supportCustomer, 'support')).id)
  await createInvitationRewardRuleVersion(await requestFor('invitation-rule', configurationAdmin), {
    bindingWindowHours: 72,
    changeNote: `${fixturePrefix} invitation acceptance rule`,
    effectiveAt: new Date(Date.now() - 60_000).toISOString(),
    enabled: true,
    rewardExpiryDays: 365,
    rewardPoints: 88,
  })
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9 16.14 钱包、域名、增长与横向能力退出条件验收（二）', () => {
  it('NS、MX、解锁、管理密码操作未完成 step-up 时 fail-closed', async () => {
    const customer = await createCustomer('step-up', { identity: true })
    const asset = await createAsset(customer, 'step-up', { locked: true })
    const req = await requestFor('step-up', customer)
    const managed = managedProvider()
    const invalidGrant = {
      deviceId: `${fixturePrefix}-missing-device`,
      stepUpToken: 'A'.repeat(43),
    }
    const attempts = [
      await settle(() =>
        requestCustomerNameserverChange(
          req,
          asset.id,
          {
            ...invalidGrant,
            confirmed: true,
            nameservers: ['ns1.after.example', 'ns2.after.example'],
          },
          { customer: customerIdentity(customer), traceId: `${fixturePrefix}-step-up-ns` },
        ),
      ),
      await settle(() =>
        addCustomerDnsRecord(
          req,
          asset.id,
          {
            ...invalidGrant,
            confirmed: true,
            host: '@',
            idempotencyKey: randomUUID(),
            line: '默认',
            priority: 10,
            ttl: 600,
            type: 'MX',
            value: 'mail.example.test',
          },
          {
            customer: customerIdentity(customer),
            provider: managed.provider,
            traceId: `${fixturePrefix}-step-up-mx`,
          },
        ),
      ),
      await settle(() =>
        setCustomerDomainLockStatus(
          req,
          asset.id,
          { ...invalidGrant, idempotencyKey: randomUUID(), locked: false },
          {
            customer: customerIdentity(customer),
            provider: managed.provider,
            traceId: `${fixturePrefix}-step-up-unlock`,
          },
        ),
      ),
      await settle(() =>
        revealDomainManagementPassword(req, asset.id, invalidGrant, {
          customer: customerIdentity(customer),
          provider: managed.provider,
          traceId: `${fixturePrefix}-step-up-password-read`,
        }),
      ),
      await settle(() =>
        modifyDomainManagementPassword(
          req,
          asset.id,
          {
            ...invalidGrant,
            idempotencyKey: randomUUID(),
            managementPassword: 'BlockedSecret12',
          },
          {
            customer: customerIdentity(customer),
            provider: managed.provider,
            traceId: `${fixturePrefix}-step-up-password-write`,
          },
        ),
      ),
    ]
    expect(
      attempts.map((result) =>
        result.status === 'rejected' ? (result.reason as { code?: string }).code : 'fulfilled',
      ),
    ).toEqual(Array.from({ length: 5 }, () => 'STEP_UP_GRANT_INVALID'))
    expect(managed.writeCount()).toBe(0)
  })

  it('注册商不支持某能力时返回明确 capability 错误而非通用失败', () => {
    const errors = DOMAIN_CAPABILITY_NAMES.map((name) => {
      try {
        assertDomainCapability(name, withoutCapability(name))
        return { code: 'fulfilled', message: '', status: 0 }
      } catch (error) {
        return error as { code: string; message: string; status: number }
      }
    })
    expect(errors.map(({ code }) => code)).toEqual(
      DOMAIN_CAPABILITY_NAMES.map((name) => WESTDIGITAL_DOMAIN_CAPABILITIES[name].unsupportedCode),
    )
    expect(
      errors.every(
        ({ message, status }) => message === '当前注册商不支持该域名能力' && status === 409,
      ),
    ).toBe(true)
  })

  it('域名已不属于当前上游账户时自动阻止操作', async () => {
    const customer = await createCustomer('ownership', { identity: true })
    const template = await createTemplate(customer, 'ownership-target')
    const asset = await createAsset(customer, 'ownership', {
      locked: true,
      templateId: Number(template.id),
    })
    const req = await requestFor('ownership', customer)
    const managed = managedProvider('not_owned')
    const passwordRead = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'domain_management_password',
    )
    const passwordWrite = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'domain_management_password',
    )
    const unlock = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'domain_lock_change',
    )
    const attempts = [
      await settle(() =>
        addCustomerDnsRecord(
          req,
          asset.id,
          {
            host: 'www',
            idempotencyKey: randomUUID(),
            line: '默认',
            priority: 10,
            ttl: 600,
            type: 'A',
            value: '192.0.2.216',
          },
          {
            customer: customerIdentity(customer),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-dns`,
          },
        ),
      ),
      await settle(() =>
        setCustomerDomainLockStatus(
          req,
          asset.id,
          { ...unlock, idempotencyKey: randomUUID(), locked: false },
          {
            customer: customerIdentity(customer),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-unlock`,
          },
        ),
      ),
      await settle(() =>
        revealDomainManagementPassword(req, asset.id, passwordRead, {
          customer: customerIdentity(customer),
          provider: managed.provider,
          traceId: `${fixturePrefix}-ownership-password-read`,
        }),
      ),
      await settle(() =>
        modifyDomainManagementPassword(
          req,
          asset.id,
          {
            ...passwordWrite,
            idempotencyKey: randomUUID(),
            managementPassword: 'BlockedSecret12',
          },
          {
            customer: customerIdentity(customer),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-password-write`,
          },
        ),
      ),
    ]
    expect(
      attempts.every(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: string }).code === 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED',
      ),
    ).toBe(true)
    expect(managed.writeCount()).toBe(0)
  })

  it('米币赚取幂等；跨批次消费按最早过期优先且分配可重算；米币与余额不可互换', async () => {
    const customer = await createCustomer('points')
    const firstOrder = await createOrder(customer, 'points-first')
    const firstKey = `${fixturePrefix}:points:first`
    const firstExpiry = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const earned = await Promise.all(
      Array.from({ length: 6 }, async (_, index) =>
        earnPendingOrderReward(await requestFor(`points-first-${index}`), {
          customerId: customer.id,
          earningKey: firstKey,
          expiresAt: firstExpiry,
          orderId: firstOrder.id,
          points: 30,
        }),
      ),
    )
    expect(earned.filter(({ applied }) => applied)).toHaveLength(1)
    expect(new Set(earned.map(({ batchId }) => String(batchId))).size).toBe(1)
    await confirmPendingOrderReward(await requestFor('points-first-confirm'), firstKey)

    const secondOrder = await createOrder(customer, 'points-second')
    const secondKey = `${fixturePrefix}:points:second`
    const second = await earnPendingOrderReward(await requestFor('points-second-earn'), {
      customerId: customer.id,
      earningKey: secondKey,
      expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      orderId: secondOrder.id,
      points: 40,
    })
    await confirmPendingOrderReward(await requestFor('points-second-confirm'), secondKey)

    const wallet = await createWalletAccount(await requestFor('points-wallet-account'), customer.id)
    await postWalletCredit(await requestFor('points-wallet-credit'), {
      accountId: wallet.accountId,
      amountFen: 500,
      transactionKey: `${fixturePrefix}:points-wallet-credit`,
    })
    const redemption = await redeemPointsForToolQuota(
      await requestFor('points-redemption', customer),
      {
        customerId: customer.id,
        pointsCost: 50,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:points-redemption`,
        target: 'advanced_whois',
      },
    )
    expect(redemption.allocations.map(({ batchId, points }) => ({ batchId, points }))).toEqual([
      { batchId: earned[0]!.batchId, points: 30n },
      { batchId: second.batchId, points: 20n },
    ])
    await expect(
      readBatchRemainingPoints(await requestFor('points-first-remaining'), {
        batchId: earned[0]!.batchId,
        customerId: customer.id,
      }),
    ).resolves.toBe(0n)
    await expect(
      readBatchRemainingPoints(await requestFor('points-second-remaining'), {
        batchId: second.batchId,
        customerId: customer.id,
      }),
    ).resolves.toBe(20n)
    await expect(
      readWalletBalance(await requestFor('points-wallet-read'), wallet.accountId),
    ).resolves.toEqual({
      availableBalance: 500n,
      heldBalance: 0n,
      postedBalance: 500n,
    })
  })

  it('VIP 为历史最高水位：重算结果一致；普通退款不降级；经审批的数据纠错可降级', async () => {
    const customer = await createCustomer('vip-high-water')
    const achievedAt = nextTime()
    await publishVipRule('vip-high-water', achievedAt, tiers(1_000, 2_000))
    const order = await createOrder(customer, 'vip-high-water', { amountFen: 2_500 })
    await recordVipSpendForSucceededOrder(await requestFor('vip-high-water-accrue'), {
      eventId: `${fixturePrefix}:vip-high-water:accrue`,
      occurredAt: achievedAt.toISOString(),
      orderId: order.id,
    })
    const achieved = await readCustomerVipStatus(
      await requestFor('vip-high-water-achieved', customer),
      { now: () => achievedAt },
    )
    expect(achieved.tier).toMatchObject({ tierCode: 'silver', tierRank: 2 })

    await payload.db.pool.query(
      `UPDATE orders SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
      [order.id],
    )
    await recordVipSpendReversalForRefundedOrder(await requestFor('vip-high-water-refund'), {
      eventId: `${fixturePrefix}:vip-high-water:refund`,
      occurredAt: new Date(achievedAt.getTime() + 1).toISOString(),
      orderId: order.id,
    })
    const refunded = await readCustomerVipStatus(
      await requestFor('vip-high-water-refunded', customer),
      { now: () => new Date(achievedAt.getTime() + 2) },
    )
    expect(refunded.cumulativeSpendFen).toBe(0)
    expect(refunded.tier).toEqual(achieved.tier)

    await expect(approveVipCorrection(customer, 'vip-high-water', 'bronze')).resolves.toMatchObject(
      {
        status: 'executed',
      },
    )
    const corrected = await readCustomerVipStatus(
      await requestFor('vip-high-water-corrected', customer),
      { now: () => new Date(achievedAt.getTime() + 3) },
    )
    const recomputed = await readCustomerVipStatus(
      await requestFor('vip-high-water-recomputed', customer),
      { now: () => new Date(achievedAt.getTime() + 3) },
    )
    expect(corrected.tier).toMatchObject({ tierCode: 'bronze', tierRank: 1 })
    expect(recomputed).toEqual(corrected)
  })

  it('提高门槛后已达成用户保留原等级；充值本身不计入累计消费', async () => {
    const customer = await createCustomer('vip-threshold')
    const achievedAt = nextTime()
    await publishVipRule('vip-threshold-low', achievedAt, tiers(1_000, 5_000))
    const order = await createOrder(customer, 'vip-threshold', { amountFen: 1_200 })
    await recordVipSpendForSucceededOrder(await requestFor('vip-threshold-accrue'), {
      eventId: `${fixturePrefix}:vip-threshold:accrue`,
      occurredAt: achievedAt.toISOString(),
      orderId: order.id,
    })
    const raisedAt = nextTime()
    await publishVipRule('vip-threshold-high', raisedAt, tiers(10_000, 50_000))

    const wallet = await payload.create({
      collection: 'walletAccounts',
      data: {
        customer: customer.id,
        currency: 'CNY',
        heldBalanceCacheFen: 0,
        ledgerVersion: 0,
        postedBalanceCacheFen: 0,
      },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'walletTopUpOrders',
      data: {
        account: wallet.id,
        amountFen: 99_999,
        currency: 'CNY',
        customer: customer.id,
        fundingSource: 'wechat',
        ledgerTransactionKey: `${fixturePrefix}:vip-threshold-top-up`,
        status: 'created',
        topUpOrderNumber: `WT${randomUUID().replaceAll('-', '').slice(0, 30)}`,
      },
      overrideAccess: true,
    })
    const status = await readCustomerVipStatus(await requestFor('vip-threshold-read', customer), {
      now: () => raisedAt,
    })
    expect(status.cumulativeSpendFen).toBe(1_200)
    expect(status.tier).toMatchObject({ tierCode: 'bronze', tierRank: 1 })
  })

  it('邀请奖励只在不可退成功订单后发放；自邀与刷量被拦截并告警，且不自动扣回已发放奖励', async () => {
    const inviter = await createCustomer('invite-inviter', { inviteCode: true })
    const invitee = await createCustomer('invite-invitee', { inviteCode: true })
    const binding = await bindInvitation(inviter, invitee, 'acceptance')
    await expect(
      bindCustomerInvitation(await requestFor('invite-self', inviter), {
        code: inviter.inviteCode!,
        deviceId: `${fixturePrefix}-self-device`,
        headers: headers('invite-self'),
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_SELF_BIND_FORBIDDEN' })

    const order = await createOrder(invitee, 'invite-reward', { status: 'pending_payment' })
    const paid = await transitionOrder(await requestFor('invite-paid'), order.id, 'paid', {
      actorType: 'system',
      evidence: { traceId: `${fixturePrefix}-invite-paid` },
      reasonCode: 'fixture.payment_confirmed',
    })
    expect(paid.order.status).toBe('paid')
    await expect(
      readPointsBalance(await requestFor('invite-paid-balance'), inviter.id),
    ).resolves.toMatchObject({
      available: 0n,
      pending: 88n,
    })

    await transitionOrder(await requestFor('invite-fulfilling'), order.id, 'fulfilling', {
      actorType: 'system',
      evidence: { traceId: `${fixturePrefix}-invite-fulfilling` },
      reasonCode: 'fixture.fulfillment_started',
    })
    await transitionOrder(await requestFor('invite-succeeded'), order.id, 'succeeded', {
      actorType: 'system',
      evidence: { traceId: `${fixturePrefix}-invite-succeeded` },
      reasonCode: 'fixture.fulfillment_succeeded',
    })
    const claimId = await invitationClaimId(invitee)
    const releasedBalance = await readPointsBalance(
      await requestFor('invite-released-balance'),
      inviter.id,
    )
    expect(releasedBalance).toMatchObject({ available: 88n, pending: 0n })

    await payload.create({
      collection: 'customerSessions',
      data: {
        customer: inviter.id,
        deviceHash: binding.deviceHash,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        ipHash: protectedIdentifier(`${fixturePrefix}-invite-ip`).identifierHash,
        lastSeenAt: new Date().toISOString(),
        tokenHash: protectedIdentifier(`${fixturePrefix}-invite-token`).identifierHash,
      },
      overrideAccess: true,
    })
    await expect(
      recheckInvitationRewardClaim(await requestFor('invite-abuse-recheck'), {
        claimId,
        traceId: `${fixturePrefix}-invite-abuse-recheck`,
      }),
    ).resolves.toEqual({ flagged: true })
    await expect(
      readPointsBalance(await requestFor('invite-after-alert'), inviter.id),
    ).resolves.toEqual(releasedBalance)
    const [review, alert] = await Promise.all([
      payload.count({
        collection: 'manualReviews',
        overrideAccess: true,
        where: { invitationRewardClaim: { equals: claimId } },
      }),
      payload.count({
        collection: 'notificationOutboxEvents',
        overrideAccess: true,
        where: {
          and: [
            { customer: { equals: inviter.id } },
            { notificationType: { equals: 'invitation_reward_withheld' } },
          ],
        },
      }),
    ])
    expect(review.totalDocs).toBe(1)
    expect(alert.totalDocs).toBe(1)
  })

  it('通知重复消费同一 outbox 事件只能发送一次', async () => {
    const customer = await createCustomer('outbox', { identity: true })
    await enqueueTransactionalSecurityNotification(await requestFor('outbox-enqueue'), {
      body: 'D9 横向验收：同一 outbox 事件只能投递一次。',
      customerId: Number(customer.id),
      domainEventType: 'd9.exit.outbox_once',
      eventKey: `${fixturePrefix}:outbox-once`,
      notificationType: 'admin_high_risk_operation_submitted',
      subject: 'D9 通知幂等验收',
      templateKey: 'd9-exit-outbox-once',
      templateVersion: 1,
      traceId: `${fixturePrefix}-outbox-once`,
    })
    const sendIdentityChanged = vi.fn(async () =>
      mockSuccess({ deliveryStatus: 'delivered' as const, providerMessageId: 'd9-outbox-message' }),
    )
    const smsProvider = {
      sendIdentityChanged,
    } as unknown as SmsProvider
    const now = new Date()
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        runNotificationDeliveries(await requestFor(`outbox-worker-${index}`), {
          now: () => now,
          smsProvider,
        }),
      ),
    )
    expect(sendIdentityChanged).toHaveBeenCalledTimes(1)
    const target = await payload.find({
      collection: 'notificationDeliveries',
      limit: 2,
      overrideAccess: true,
      where: { deliveryKey: { contains: `${fixturePrefix}:outbox-once` } },
    })
    expect(target.docs).toHaveLength(1)
    expect(target.docs[0]?.status).toBe('delivered')
  })

  it('数据库备份恢复后，余额、积分、等级与域名任务状态可重新对账', async () => {
    const customer = await createCustomer('restore')
    const wallet = await createWalletAccount(
      await requestFor('restore-wallet-account'),
      customer.id,
    )
    await postWalletCredit(await requestFor('restore-wallet-credit'), {
      accountId: wallet.accountId,
      amountFen: 800,
      transactionKey: `${fixturePrefix}:restore-wallet-credit`,
    })
    const walletEntry = await payload.db.pool.query<{ created_at: Date }>(
      `SELECT created_at FROM wallet_entries WHERE account_id = $1 ORDER BY id DESC LIMIT 1`,
      [wallet.accountId],
    )
    const walletCreatedAt = walletEntry.rows[0]!.created_at
    await payload.db.pool.query(
      `UPDATE wallet_accounts SET posted_balance_cache_fen = 900, updated_at = NOW() WHERE id = $1`,
      [wallet.accountId],
    )

    const pointsOrder = await createOrder(customer, 'restore-points')
    const pointsKey = `${fixturePrefix}:restore-points`
    await earnPendingOrderReward(await requestFor('restore-points-earn'), {
      customerId: customer.id,
      earningKey: pointsKey,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      orderId: pointsOrder.id,
      points: 60,
    })
    await confirmPendingOrderReward(await requestFor('restore-points-confirm'), pointsKey)

    const vipAt = nextTime()
    await publishVipRule('restore', vipAt, tiers(1_000, 5_000))
    const vipOrder = await createOrder(customer, 'restore-vip', { amountFen: 1_200 })
    await recordVipSpendForSucceededOrder(await requestFor('restore-vip-accrue'), {
      eventId: `${fixturePrefix}:restore-vip`,
      occurredAt: vipAt.toISOString(),
      orderId: vipOrder.id,
    })

    const domainCustomer = await createCustomer('restore-domain', { identity: true })
    const domainAsset = await createAsset(domainCustomer, 'restore-domain')
    const domainReq = await requestFor('restore-domain', domainCustomer)
    const domainGrant = await issueStepUpGrantFixture(
      payload,
      domainReq,
      Number(domainCustomer.id),
      'nameserver_change',
    )
    const requestedNameservers = ['ns1.restored.example', 'ns2.restored.example']
    const requested = await requestCustomerNameserverChange(
      domainReq,
      domainAsset.id,
      { ...domainGrant, confirmed: true, nameservers: requestedNameservers },
      {
        customer: customerIdentity(domainCustomer),
        traceId: `${fixturePrefix}-restore-domain-request`,
      },
    )
    if (!('data' in requested)) throw new Error('Expected a queued nameserver change')
    const changeId = Number(requested.data.id)
    let initialDomainWriteCount = 0
    const unknownProvider = {
      changeNameservers: async () => {
        initialDomainWriteCount += 1
        return mockFailure('WESTDIGITAL_TIMEOUT_AFTER_SUBMISSION', {
          retryable: true,
          statusKnown: false,
        })
      },
      queryAsset: async ({ domainAscii }: { domainAscii: string }) => ownedDomain(domainAscii),
    } as unknown as WestDigitalWriteProvider
    const unknownDomain = await runNameserverChange(
      await requestFor('restore-domain-unknown'),
      {
        assetId: Number(domainAsset.id),
        changeId,
        operationKey: `nameserver-change:${changeId}`,
        traceId: `${fixturePrefix}-restore-domain-unknown`,
      },
      unknownProvider,
    )
    expect(initialDomainWriteCount).toBe(1)
    expect(unknownDomain.status).toBe('manual_review')

    const sourceDatabaseUrl = process.env.DATABASE_URL
    if (!sourceDatabaseUrl) throw new Error('DATABASE_URL is required for the restore exercise')
    const targetDatabase = `wanmi_d9_exit_restore_${randomUUID().replaceAll('-', '')}`
    if (!/^wanmi_d9_exit_restore_[a-f0-9]{32}$/u.test(targetDatabase)) {
      throw new Error('Unsafe restore target database name')
    }
    const targetUrl = new URL(sourceDatabaseUrl)
    targetUrl.pathname = `/${targetDatabase}`
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'wanmi-d9-exit-restore-'))
    const dumpPath = join(temporaryDirectory, 'wanmi-d9-exit.dump')
    let targetCreated = false
    try {
      execFileSync('createdb', ['--maintenance-db', sourceDatabaseUrl, targetDatabase], {
        stdio: 'pipe',
      })
      targetCreated = true
      const postgresContainer = execFileSync(
        'docker',
        [
          'ps',
          '--filter',
          'label=com.docker.compose.project=wanmi-d0',
          '--filter',
          'label=com.docker.compose.service=postgres',
          '--format',
          '{{.ID}}',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim()
      if (!/^[a-f0-9]{12,64}$/u.test(postgresContainer)) {
        throw new Error('Expected exactly one Wanmi PostgreSQL container')
      }
      const containerSourceUrl = new URL(sourceDatabaseUrl)
      containerSourceUrl.hostname = '127.0.0.1'
      containerSourceUrl.port = '5432'
      const containerTargetUrl = new URL(targetUrl)
      containerTargetUrl.hostname = '127.0.0.1'
      containerTargetUrl.port = '5432'
      const dump = execFileSync(
        'docker',
        [
          'exec',
          postgresContainer,
          'pg_dump',
          '--format=custom',
          '--dbname',
          containerSourceUrl.toString(),
        ],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      writeFileSync(dumpPath, dump)
      execFileSync(
        'docker',
        [
          'exec',
          '-i',
          postgresContainer,
          'pg_restore',
          '--no-owner',
          '--no-privileges',
          '--dbname',
          containerTargetUrl.toString(),
        ],
        { input: dump, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      const restoreInput = Buffer.from(
        JSON.stringify({
          domain: {
            assetId: Number(domainAsset.id),
            changeId,
            customerId: Number(domainCustomer.id),
            domainAscii: domainAsset.domainAscii,
            nameservers: requestedNameservers,
          },
          pointsCustomerId: Number(customer.id),
          period: {
            end: new Date(walletCreatedAt.getTime() + 1_000).toISOString(),
            start: new Date(walletCreatedAt.getTime() - 1_000).toISOString(),
          },
          vipCustomerId: Number(customer.id),
          vipReadAt: new Date(vipAt.getTime() + 1).toISOString(),
          walletAccountId: Number(wallet.accountId),
        }),
      ).toString('base64url')
      const output = execFileSync(
        'pnpm',
        ['exec', 'tsx', 'scripts/verify-d9-exit-restore.ts', restoreInput],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: targetUrl.toString() },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      const marker = output.split('\n').find((line) => line.startsWith('D9_EXIT_RESTORE_RESULT '))
      if (!marker) throw new Error(`Restore verifier did not return a result: ${output}`)
      const restored = JSON.parse(marker.slice('D9_EXIT_RESTORE_RESULT '.length)) as {
        domain: { queryCount: number; status: string; writeCount: number }
        points: { available: string; consumed: string; pending: string }
        vip: { cumulativeSpendFen: number; tierRank: number | null }
        wallet: { differenceMinor: number; status: string }
      }
      expect(restored).toEqual({
        domain: { queryCount: 2, status: 'succeeded', writeCount: 0 },
        points: { available: '60', consumed: '0', pending: '0' },
        vip: { cumulativeSpendFen: 1_200, tierRank: 1 },
        wallet: { differenceMinor: 100, status: 'difference' },
      })
    } finally {
      if (targetCreated) {
        execFileSync(
          'dropdb',
          ['--if-exists', '--force', '--maintenance-db', sourceDatabaseUrl, targetDatabase],
          { stdio: 'pipe' },
        )
      }
      try {
        unlinkSync(dumpPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      rmdirSync(temporaryDirectory)
    }
  }, 90_000)

  it('外部 provider 超时或返回未知状态时不得盲目重复写操作', async () => {
    const record = {
      host: 'www',
      lineCode: '' as const,
      priority: 10,
      ttl: 600,
      type: 'A' as const,
      value: '192.0.2.216',
    }
    const profile = {
      addressChinese: '一环路北一段99号环球广场',
      addressEnglish: '99 First Ring Road North Chengdu Sichuan',
      applicableScopes: ['cg'] as ('cg' | 'gswl' | 'hk')[],
      cityChinese: '成都市',
      cityEnglish: 'Chengdu',
      contactFirstNameChinese: '小明',
      contactFirstNameEnglish: 'Xiaoming',
      contactLastNameChinese: '李',
      contactLastNameEnglish: 'Li',
      countryCode: 'CN',
      districtChinese: '金牛区',
      email: 'd9-exit-provider@example.invalid',
      fullNameChinese: '李小明',
      identityDocumentNumber: '11010519491231002X',
      identityDocumentType: 'SFZ',
      phone: '13812345678',
      phoneCountryCode: '+86',
      phoneType: 'mobile' as const,
      postalCode: '610031',
      provinceChinese: '四川省',
      provinceEnglish: 'Sichuan',
      type: 'individual' as const,
    }
    const shared = (operation: string) => ({
      actor: { id: fixturePrefix, type: 'system' as const },
      domainAscii: `${operation.replaceAll('_', '-')}-${randomUUID().slice(0, 8)}.example`,
      targetId: `${fixturePrefix}:${operation}:${randomUUID()}`,
      traceId: `${fixturePrefix}:provider:${operation}`,
    })
    const operations: WestDigitalWriteOperationInput[] = [
      { ...shared('realname'), operation: 'realname', profile, targetId: supportTemplateId },
      {
        ...shared('register'),
        clientPriceFen: 1_200,
        nameservers: ['ns1.example.test', 'ns2.example.test'],
        operation: 'register',
        premium: false,
        providerTemplateId: '8000001',
        years: 1,
      },
      {
        ...shared('renew'),
        clientPriceFen: 1_200,
        currentExpiresOn: '2028-08-20',
        operation: 'renew',
        premium: false,
        years: 1,
      },
      {
        ...shared('nameserver'),
        nameservers: ['ns1.after.example', 'ns2.after.example'],
        operation: 'nameserver',
      },
      {
        ...shared('domain_lock'),
        businessKey: randomUUID(),
        locked: false,
        operation: 'domain_lock',
      },
      {
        ...shared('domain_management_password'),
        businessKey: randomUUID(),
        managementPassword: 'UnknownSecret12',
        operation: 'domain_management_password',
      },
      {
        ...shared('domain_contact_update'),
        businessKey: randomUUID(),
        contactType: 'dom_id',
        operation: 'domain_contact_update',
        profile,
      },
      {
        ...shared('domain_template_transfer'),
        businessKey: randomUUID(),
        operation: 'domain_template_transfer',
        providerTemplateId: '8000002',
      },
      { ...shared('dns_record_add'), operation: 'dns_record_add', record },
      {
        ...shared('dns_record_modify'),
        operation: 'dns_record_modify',
        providerRecordId: '216',
        record,
      },
      {
        ...shared('dns_record_delete'),
        operation: 'dns_record_delete',
        providerRecordId: '216',
        record,
      },
      {
        ...shared('dns_record_pause'),
        operation: 'dns_record_pause',
        paused: true,
        providerRecordId: '216',
        record,
      },
      {
        ...shared('dns_record_batch_delete'),
        operation: 'dns_record_batch_delete',
        providerRecordId: '216',
        record,
      },
    ]
    expect(operations.map(({ operation }) => operation)).toEqual([
      'realname',
      'register',
      'renew',
      'nameserver',
      'domain_lock',
      'domain_management_password',
      'domain_contact_update',
      'domain_template_transfer',
      'dns_record_add',
      'dns_record_modify',
      'dns_record_delete',
      'dns_record_pause',
      'dns_record_batch_delete',
    ])

    for (const operation of operations) {
      let writes = 0
      let assetQueries = 0
      const unknownWrite = async () => {
        writes += 1
        return mockFailure('WESTDIGITAL_TIMEOUT_AFTER_SUBMISSION', {
          retryable: true,
          statusKnown: false,
        })
      }
      const provider = {
        addDnsRecord: unknownWrite,
        changeNameservers: unknownWrite,
        createRealname: unknownWrite,
        deleteDnsRecord: unknownWrite,
        getDomainManagementPassword: async () =>
          mockFailure('WESTDIGITAL_STATUS_UNKNOWN', { statusKnown: false }),
        modifyDnsRecord: unknownWrite,
        modifyDomainManagementPassword: unknownWrite,
        queryAsset: async ({ domainAscii }: { domainAscii: string }) => {
          assetQueries += 1
          return assetQueries === 1
            ? ownedDomain(domainAscii)
            : mockFailure('WESTDIGITAL_STATUS_UNKNOWN', { statusKnown: false })
        },
        queryDnsRecords: async () =>
          mockFailure('WESTDIGITAL_STATUS_UNKNOWN', { statusKnown: false }),
        queryDomainInformation: async () =>
          mockFailure('WESTDIGITAL_STATUS_UNKNOWN', { statusKnown: false }),
        queryOfflineDnsRecordDelete: async () =>
          mockFailure('WESTDIGITAL_STATUS_UNKNOWN', { statusKnown: false }),
        queryRealname: async () =>
          mockFailure('WESTDIGITAL_STATUS_UNKNOWN', { statusKnown: false }),
        queryRenewalEligibility: async () =>
          mockFailure('WESTDIGITAL_STATUS_UNKNOWN', { statusKnown: false }),
        register: unknownWrite,
        renew: unknownWrite,
        setDnsRecordPaused: unknownWrite,
        setDomainLock: unknownWrite,
        submitOfflineDnsRecordDelete: unknownWrite,
        transferDomainToTemplate: unknownWrite,
        updateDomainContact: unknownWrite,
      } as unknown as WestDigitalManagedProvider
      const first = await executeWestDigitalWriteOperation(
        await requestFor(`provider-first-${operation.operation}`),
        operation,
        provider,
      )
      const replay = await executeWestDigitalWriteOperation(
        await requestFor(`provider-replay-${operation.operation}`),
        operation,
        provider,
      )
      expect(first, operation.operation).toMatchObject({
        data: { status: 'unknown' },
        state: 'degraded',
      })
      expect(replay, operation.operation).toMatchObject({ data: { idempotentReplay: true } })
      expect(writes, operation.operation).toBe(1)
    }

    const directCallpointContracts = [
      ['src/services/auth/otp.ts', '.sendOtp(', 'if (!result.ok)'],
      ['src/services/auth/step-up.ts', '.sendStepUpOtp(', 'if (!result.ok)'],
      ['src/services/auth/wechat.ts', '.createTemporaryQr(', 'await req.payload.create({'],
      ['src/services/auth/wechat.ts', '.sendLoginConfirmation(', 'catch {'],
      ['src/services/auth/customer-identities.ts', '.sendIdentityChanged(', 'outcome = result.ok'],
      ['src/services/auth/customer-identities.ts', '.sendSecurityNotice(', "outcome = 'sent'"],
      ['src/services/commerce/payments.ts', '.createPayment(', 'if (!result.error.statusKnown)'],
      ['src/services/commerce/payments.ts', '.closeOrder(', '-confirm-close'],
      ['src/services/commerce/refunds.ts', '.createRefund(', "['submitted', 'unknown']"],
      ['src/services/wallet/top-ups.ts', '.createPayment(', 'if (!result.error.statusKnown)'],
      [
        'src/services/notifications/outbox.ts',
        '.sendIdentityChanged(',
        "outcome: sent.error.statusKnown ? 'failed' : 'unknown'",
      ],
      ['src/services/notifications/outbox.ts', '.sendSecurityNotice(', "outcome: 'unknown'"],
      [
        'src/services/domains/expiry-reminders.ts',
        '.sendDomainExpiry(',
        "const status = result.data.deliveryStatus === 'delivered' ? 'delivered' : 'unknown'",
      ],
      ['src/services/realname/documents.ts', '.upload(', "storageState: 'upload_failed'"],
      ['src/services/realname/documents.ts', '.deleteObject(', "storageState: 'active'", 2],
      [
        'src/services/realname/lifecycle.ts',
        '.deleteObject(',
        "'REALNAME_CLEANUP_STORAGE_UNAVAILABLE'",
        2,
      ],
      ['src/services/realname/templates.ts', '.createTemplate(', "providerReviewState: 'unknown'"],
    ] as const
    for (const [
      file,
      callpoint,
      unknownContract,
      expectedOccurrences = 1,
    ] of directCallpointContracts) {
      const source = readFileSync(file, 'utf8')
      expect(
        source.split(callpoint).length - 1,
        `${file} must contain exactly ${expectedOccurrences} reviewed ${callpoint} callpoint(s)`,
      ).toBe(expectedOccurrences)
      expect(
        source,
        `${file} must persist or surface unknown/timeout without a blind loop`,
      ).toContain(unknownContract)
    }
  })
})
