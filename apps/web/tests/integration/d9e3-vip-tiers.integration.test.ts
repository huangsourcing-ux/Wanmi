import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest, type Where } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { Admin, Customer, Order } from '@/payload-types'
import type { VipTierRuleLevelInput } from '@/schemas/vip-tiers'
import { createAdminApprovalRequest, decideAdminApprovalRequest } from '@/services/admin/approvals'
import { executeSupportedAdminOperation } from '@/services/admin/operation-executors'
import { maskPhone } from '@/services/auth/client-facts'
import { transitionOrder } from '@/services/commerce/order-state'
import {
  compareVipTierEventsNewestFirst,
  applyApprovedVipTierCorrection,
  promoteCustomerVipTier,
  publishVipTierRuleVersion,
  readCustomerVipStatus,
  recordVipSpendForSucceededOrder,
  recordVipSpendReversalForRefundedOrder,
  recordVipTierCorrectionAppeal,
  VIP_BENEFIT_CHANGE_NOTICE_LEAD_MS,
} from '@/services/vip/tiers'

import { fulfillmentQuoteSnapshotFixture } from '../fixtures/commerce'
import { realnameTemplateFixture } from '../fixtures/realname'
import { ensureAnchorSystemAdmin } from '../test-cleanup'

const fixturePrefix = `d9e3-vip-${randomUUID()}`
const customerIds: number[] = []
const ruleIds: number[] = []
let admin: Admin
let fundsApprover: Admin
let inactiveConfigurationAdmin: Admin
let payload: Payload
let ruleBaselineId = 0
let timeline = Date.UTC(2025, 0, 1)

const tierTemplate = (
  bronzeThreshold = 1_000,
  silverThreshold = 5_000,
): VipTierRuleLevelInput[] => [
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

function nextTime(days = 2): Date {
  timeline += days * 86_400_000
  return new Date(timeline)
}

function phone(): string {
  return `+86197${randomInt(10_000_000, 100_000_000)}`
}

function headers(suffix: string): Headers {
  return new Headers({
    'user-agent': 'Wanmi D9-E-3 VIP integration fixture',
    'x-forwarded-for': '203.0.113.203',
    'x-request-id': `${fixturePrefix}-${suffix}`,
  })
}

async function request(suffix: string, user?: Admin | Customer): Promise<PayloadRequest> {
  const req = await createLocalReq({ req: { headers: headers(suffix) } }, payload)
  if (user) req.user = { ...user, collection: 'roles' in user ? 'admins' : 'customers' } as never
  return req
}

async function createCustomer(suffix: string): Promise<Customer> {
  if (!suffix) throw new Error('D9-E-3 customer fixture suffix is required')
  const customerPhone = phone()
  const customer = await payload.create({
    collection: 'customers',
    data: {
      accountType: 'registered',
      capabilityRestrictions: [],
      defaultCustomerProfileType: 'individual',
      phone: customerPhone,
      phoneMasked: maskPhone(customerPhone),
      registrationSource: 'phone',
      status: 'active',
    },
    overrideAccess: true,
  })
  customerIds.push(customer.id)
  return customer
}

async function createOrder(
  customer: Customer,
  suffix: string,
  options: {
    amountFen?: number
    paymentChannel?: 'balance' | 'h5' | 'native'
    status?:
      | 'cancelled'
      | 'fulfilling'
      | 'manual_review'
      | 'paid'
      | 'pending_payment'
      | 'refund_pending'
      | 'refunded'
      | 'refunding'
      | 'succeeded'
  } = {},
): Promise<Order> {
  const amountFen = options.amountFen ?? 1_200
  const now = new Date()
  const domainAscii = `${suffix}-${randomUUID()}.example`
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `vip-${suffix}`.slice(0, 64) }),
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

async function publish(
  suffix: string,
  effectiveAt: Date,
  tiers = tierTemplate(),
  now = new Date(effectiveAt.getTime() - 48 * 60 * 60 * 1_000),
) {
  const published = await publishVipTierRuleVersion(
    await request(`publish-${suffix}`, admin),
    {
      changeNote: `D9-E-3 ${suffix} versioned VIP rule`,
      effectiveAt: effectiveAt.toISOString(),
      tiers,
    },
    { now: () => now },
  )
  ruleIds.push(Number(published.id))
  return published
}

async function accrue(order: Order, suffix: string, occurredAt: Date) {
  return recordVipSpendForSucceededOrder(await request(`accrue-${suffix}`), {
    eventId: `${fixturePrefix}:${suffix}`,
    occurredAt: occurredAt.toISOString(),
    orderId: order.id,
  })
}

async function count(
  collection:
    | 'auditLogs'
    | 'notificationOutboxEvents'
    | 'vipSpendEntries'
    | 'vipTierAppeals'
    | 'vipTierEvents'
    | 'vipTierRuleVersions',
  where: Where,
): Promise<number> {
  return (await payload.count({ collection, overrideAccess: true, where } as never)).totalDocs
}

async function appendOrderReversal(
  customer: Customer,
  order: Order,
  amountFen: number,
  suffix: string,
  occurredAt: Date,
) {
  return payload.create({
    collection: 'vipSpendEntries',
    data: {
      amountFen,
      customer: customer.id,
      entryKey: `${fixturePrefix}:reversal:${suffix}`,
      entryType: 'order_reversal',
      occurredAt: occurredAt.toISOString(),
      reference: `${fixturePrefix}:ordinary-refund:${suffix}`,
      sourceOrder: order.id,
    },
    overrideAccess: true,
  })
}

async function approveCorrection(
  customer: Customer,
  suffix: string,
  input: {
    correctionSource: 'data_correction' | 'fraud_reversal'
    spendReversalFen: number
    targetTierCode: null | string
  },
) {
  const created = await createAdminApprovalRequest(
    await request(`approval-create-${suffix}`, admin),
    {
      correctionReference: `${fixturePrefix}:correction:${suffix}`,
      customerId: customer.id,
      operationType: 'vip_fraud_correction',
      reasonNote: `D9-E-3 visible correction reason ${suffix}`,
      ...input,
    },
  )
  await decideAdminApprovalRequest(
    await request(`approval-decide-${suffix}`, fundsApprover),
    created.id,
    { decision: 'approve', note: `D9-E-3 independent approval ${suffix}` },
  )
  await payload.db.pool.query(
    `UPDATE admin_approval_requests
     SET created_at = NOW() - (cooldown_seconds + 1) * INTERVAL '1 second'
     WHERE id = $1`,
    [created.id],
  )
  const executed = await executeSupportedAdminOperation(
    await request(`approval-execute-${suffix}`, fundsApprover),
    created.id,
  )
  return { created, executed }
}

beforeAll(async () => {
  payload = await getPayload({ config })
  ruleBaselineId = Number(
    (
      await payload.db.pool.query<{ max_id: string }>(
        'SELECT COALESCE(MAX(id), 0) AS max_id FROM vip_tier_rule_versions',
      )
    ).rows[0]!.max_id,
  )
  admin = await ensureAnchorSystemAdmin(payload)
  fundsApprover = await payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap', suppressAdminAccountAudit: true },
    data: {
      email: `${fixturePrefix}@example.invalid`,
      operationalScopes: ['funds_operations'],
      password: `D9e3!${randomUUID()}aA1`,
      roles: ['system_admin'],
      status: 'active',
    },
    overrideAccess: true,
  })
  inactiveConfigurationAdmin = await payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap', suppressAdminAccountAudit: true },
    data: {
      email: `${fixturePrefix}-inactive@example.invalid`,
      operationalScopes: ['system_configuration'],
      password: `D9e3!${randomUUID()}aA1`,
      roles: ['system_admin'],
      status: 'disabled',
    },
    overrideAccess: true,
  })
  const initialAt = new Date(Date.UTC(2024, 0, 1))
  await publish('initial', initialAt, tierTemplate(), new Date(Date.UTC(2023, 0, 1)))
})

afterEach(async () => {
  if (customerIds.length === 0) return
  const ids = [...customerIds]
  await payload.db.pool.query(
    `DELETE FROM notification_deliveries WHERE customer_id = ANY($1::int[])`,
    [ids],
  )
  await payload.db.pool.query(
    `DELETE FROM notification_outbox_events WHERE customer_id = ANY($1::int[])`,
    [ids],
  )
  await payload.db.pool.query('DELETE FROM vip_tier_appeals WHERE customer_id = ANY($1::int[])', [
    ids,
  ])
  await payload.db.pool.query('DELETE FROM vip_tier_events WHERE customer_id = ANY($1::int[])', [
    ids,
  ])
  await payload.db.pool.query('DELETE FROM vip_spend_entries WHERE customer_id = ANY($1::int[])', [
    ids,
  ])
  await payload.db.pool.query(
    `DELETE FROM admin_access_events
     WHERE approval_request_id IN (
       SELECT id FROM admin_approval_requests WHERE customer_id = ANY($1::int[])
     )`,
    [ids],
  )
  await payload.db.pool.query(
    'DELETE FROM admin_approval_requests WHERE customer_id = ANY($1::int[])',
    [ids],
  )
  await payload.db.pool.query(
    `DELETE FROM audit_logs
     WHERE trace_id LIKE $1
        OR (actor_id = ANY($2::text[]) AND action LIKE 'vip.%')`,
    [`${fixturePrefix}-%`, ids.map(String)],
  )
  for (const table of ['order_events', 'orders', 'quotes', 'realname_templates']) {
    await payload.db.pool.query(`DELETE FROM ${table} WHERE customer_id = ANY($1::int[])`, [ids])
  }
  await payload.db.pool.query(
    'DELETE FROM wallet_top_up_orders WHERE customer_id = ANY($1::int[])',
    [ids],
  )
  await payload.db.pool.query('DELETE FROM wallet_accounts WHERE customer_id = ANY($1::int[])', [
    ids,
  ])
  await payload.db.pool.query('DELETE FROM customers WHERE id = ANY($1::int[])', [ids])
  customerIds.length = 0
})

afterAll(async () => {
  await payload.db.pool.query(
    `DELETE FROM vip_tier_rule_levels
     WHERE rule_version_id IN (SELECT id FROM vip_tier_rule_versions WHERE id > $1)`,
    [ruleBaselineId],
  )
  await payload.db.pool.query('DELETE FROM vip_tier_rule_versions WHERE id > $1', [ruleBaselineId])
  await payload.db.pool.query('DELETE FROM admins WHERE id = $1', [fundsApprover.id])
  if (inactiveConfigurationAdmin) {
    await payload.db.pool.query('DELETE FROM admins WHERE id = $1', [inactiveConfigurationAdmin.id])
  }
  await payload.db.destroy?.()
})

describe('D9-E-3 permanent VIP tiers', () => {
  it('keeps the achieved historical high-water tier after an ordinary refund reversal', async () => {
    const customer = await createCustomer('refund-high-water')
    const at = nextTime()
    await publish('refund-high-water', at, tierTemplate(1_000, 5_000))
    const order = await createOrder(customer, 'refund-high-water', { amountFen: 1_200 })
    await accrue(order, 'refund-high-water', at)
    const before = await readCustomerVipStatus(
      await request('refund-high-water-before', customer),
      {
        now: () => at,
      },
    )
    expect(before.tier).toMatchObject({ tierCode: 'bronze', tierRank: 1 })

    await appendOrderReversal(
      customer,
      order,
      1_200,
      'refund-high-water',
      new Date(at.getTime() + 1),
    )
    const after = await readCustomerVipStatus(await request('refund-high-water-after', customer), {
      now: () => new Date(at.getTime() + 2),
    })
    expect(after.cumulativeSpendFen).toBe(0)
    expect(after.tier).toEqual(before.tier)
  })

  it('keeps an achieved tier after a later rule raises its threshold', async () => {
    const customer = await createCustomer('threshold-raised')
    const achievedAt = nextTime()
    await publish('threshold-low', achievedAt, tierTemplate(1_000, 5_000))
    const order = await createOrder(customer, 'threshold-raised', { amountFen: 1_200 })
    await accrue(order, 'threshold-raised', achievedAt)
    const raisedAt = nextTime()
    const raised = tierTemplate(10_000, 50_000)
    await publish('threshold-high', raisedAt, raised)

    const status = await readCustomerVipStatus(await request('threshold-raised-read', customer), {
      now: () => raisedAt,
    })
    expect(status.cumulativeSpendFen).toBe(1_200)
    expect(status.tier).toMatchObject({ tierCode: 'bronze', tierRank: 1 })
  })

  it('scopes cumulative spend and tier history to the authenticated customer', async () => {
    const first = await createCustomer('customer-scope-first')
    const second = await createCustomer('customer-scope-second')
    const at = nextTime()
    await publish('customer-scope', at, tierTemplate(1_000, 5_000))
    const firstOrder = await createOrder(first, 'customer-scope-first', { amountFen: 1_200 })
    const secondOrder = await createOrder(second, 'customer-scope-second', { amountFen: 6_000 })
    await accrue(firstOrder, 'customer-scope-first', at)
    await accrue(secondOrder, 'customer-scope-second', at)
    const status = await readCustomerVipStatus(await request('customer-scope-read', first), {
      now: () => new Date(at.getTime() + 1),
    })
    expect(status.cumulativeSpendFen).toBe(1_200)
    expect(status.history.every((event) => event.tierRank === 1)).toBe(true)
    expect(status.tier).toMatchObject({ tierCode: 'bronze', tierRank: 1 })
  })

  it('serializes concurrent rule publications into unique audited versions', async () => {
    const effectiveAt = nextTime()
    await publish('concurrent-baseline', effectiveAt, tierTemplate(1_000, 5_000))
    const publication = Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const req = await request(`concurrent-publish-${index}`, admin)
        return publishVipTierRuleVersion(
          req,
          {
            changeNote: `D9-E-3 concurrent version publication ${index}`,
            effectiveAt: effectiveAt.toISOString(),
            tiers: tierTemplate(1_000, 5_000),
          },
          { now: () => new Date(effectiveAt.getTime() - 48 * 60 * 60 * 1_000) },
        )
      }),
    )
    await expect(publication).resolves.toHaveLength(8)
    const published = await publication
    const ids = published.map(({ id }) => Number(id))
    ruleIds.push(...ids)
    expect(new Set(published.map(({ version }) => version)).size).toBe(8)
    await expect(count('vipTierRuleVersions', { id: { in: ids } })).resolves.toBe(8)
    await expect(
      count('auditLogs', {
        and: [
          { action: { equals: 'vip.tier_rule.published' } },
          { traceId: { like: `${fixturePrefix}-concurrent-publish-` } },
        ],
      }),
    ).resolves.toBe(8)
  })

  it('rejects rule publication without the system-configuration scope', async () => {
    await expect(
      publishVipTierRuleVersion(await request('publish-scope-rejected', fundsApprover), {
        changeNote: 'D9-E-3 rejected unauthorized rule publication',
        effectiveAt: nextTime().toISOString(),
        tiers: tierTemplate(),
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED' })
  })

  it('rejects an inactive system-configuration administrator', async () => {
    await expect(
      publishVipTierRuleVersion(
        await request('publish-inactive-rejected', inactiveConfigurationAdmin),
        {
          changeNote: 'D9-E-3 rejected inactive rule publication',
          effectiveAt: nextTime().toISOString(),
          tiers: tierTemplate(),
        },
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED' })
  })

  it('rejects operational promotion without the system-configuration scope', async () => {
    const customer = await createCustomer('promotion-scope-rejected')
    await expect(
      promoteCustomerVipTier(await request('promotion-scope-rejected', fundsApprover), {
        customerId: customer.id,
        reasonNote: 'D9-E-3 rejected unauthorized operational promotion',
        tierCode: 'bronze',
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED' })
  })

  it('rejects anonymous or admin reads at the customer VIP status callpoint', async () => {
    await expect(
      readCustomerVipStatus(await request('anonymous-read-rejected')),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
    await expect(
      readCustomerVipStatus(await request('admin-read-rejected', admin)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
  })

  it('rejects a correction appeal at the non-customer callpoint', async () => {
    await expect(
      recordVipTierCorrectionAppeal(await request('admin-appeal-rejected', admin), {
        statement: 'This must not create a customer appeal.',
        tierEventId: 1,
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
  })

  it('validates publish, promotion, and appeal input again inside each business service', async () => {
    const customer = await createCustomer('service-schema-validation')
    await expect(
      publishVipTierRuleVersion(await request('publish-schema-rejected', admin), {
        changeNote: 'short',
        effectiveAt: nextTime().toISOString(),
        tiers: tierTemplate(),
      }),
    ).rejects.toMatchObject({ name: 'ZodError' })
    await expect(
      promoteCustomerVipTier(await request('promotion-schema-rejected', admin), {
        customerId: customer.id,
        reasonNote: 'short',
        tierCode: 'bronze',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' })
    await expect(
      recordVipTierCorrectionAppeal(await request('appeal-schema-rejected', customer), {
        statement: 'short',
        tierEventId: 1,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('rejects a rule version whose effective time is before the publication clock', async () => {
    const now = nextTime()
    await expect(
      publishVipTierRuleVersion(
        await request('past-effective-rejected', admin),
        {
          changeNote: 'D9-E-3 past effective time rejection',
          effectiveAt: new Date(now.getTime() - 1).toISOString(),
          tiers: tierTemplate(),
        },
        { now: () => now },
      ),
    ).rejects.toMatchObject({ code: 'VIP_TIER_RULE_INVALID' })
  })

  it('canonicalizes reversed input tiers before validating and publishing ranks', async () => {
    const effectiveAt = nextTime()
    await expect(
      publish('reversed-input-tiers', effectiveAt, [...tierTemplate()].reverse()),
    ).resolves.toMatchObject({ version: expect.any(Number) })
  })

  it('rejects a non-contiguous tier rank independently', async () => {
    const base = tierTemplate()
    const effectiveAt = nextTime()
    await expect(
      publishVipTierRuleVersion(
        await request('invalid-rule-non-contiguous', admin),
        {
          changeNote: 'D9-E-3 invalid tier rule non-contiguous',
          effectiveAt: effectiveAt.toISOString(),
          tiers: [base[0]!, { ...base[1]!, tierRank: 3 }],
        },
        { now: () => new Date(effectiveAt.getTime() - 48 * 60 * 60 * 1_000) },
      ),
    ).rejects.toMatchObject({ code: 'VIP_TIER_RULE_INVALID' })
  })

  it('rejects a duplicate tier code independently', async () => {
    const base = tierTemplate()
    const effectiveAt = nextTime()
    await expect(
      publishVipTierRuleVersion(
        await request('invalid-rule-duplicate-code', admin),
        {
          changeNote: 'D9-E-3 invalid tier rule duplicate-code',
          effectiveAt: effectiveAt.toISOString(),
          tiers: [base[0]!, { ...base[1]!, tierCode: base[0]!.tierCode }],
        },
        { now: () => new Date(effectiveAt.getTime() - 48 * 60 * 60 * 1_000) },
      ),
    ).rejects.toMatchObject({ code: 'VIP_TIER_RULE_INVALID' })
  })

  it('rejects a non-increasing tier threshold independently', async () => {
    const base = tierTemplate()
    const effectiveAt = nextTime()
    await expect(
      publishVipTierRuleVersion(
        await request('invalid-rule-non-increasing', admin),
        {
          changeNote: 'D9-E-3 invalid tier rule non-increasing',
          effectiveAt: effectiveAt.toISOString(),
          tiers: [base[0]!, { ...base[1]!, thresholdFen: base[0]!.thresholdFen }],
        },
        { now: () => new Date(effectiveAt.getTime() - 48 * 60 * 60 * 1_000) },
      ),
    ).rejects.toMatchObject({ code: 'VIP_TIER_RULE_INVALID' })
  })

  it('rejects deleting an existing tier identity in a later rule version', async () => {
    const effectiveAt = nextTime()
    await publish('delete-tier-baseline', effectiveAt, tierTemplate())
    const nextEffectiveAt = nextTime()
    await expect(
      publishVipTierRuleVersion(
        await request('identity-delete-tier', admin),
        {
          changeNote: 'D9-E-3 invalid identity deletion',
          effectiveAt: nextEffectiveAt.toISOString(),
          tiers: [tierTemplate()[0]!],
        },
        { now: () => new Date(nextEffectiveAt.getTime() - 48 * 60 * 60 * 1_000) },
      ),
    ).rejects.toMatchObject({ code: 'VIP_TIER_RULE_IDENTITY_INVALID' })
  })

  it('rejects reusing an existing tier rank with another code', async () => {
    const effectiveAt = nextTime()
    await publish('reuse-rank-baseline', effectiveAt, tierTemplate())
    const nextEffectiveAt = nextTime()
    await expect(
      publishVipTierRuleVersion(
        await request('identity-reuse-rank', admin),
        {
          changeNote: 'D9-E-3 invalid identity rank reuse',
          effectiveAt: nextEffectiveAt.toISOString(),
          tiers: [{ ...tierTemplate()[0]!, tierCode: 'renamed_bronze' }, tierTemplate()[1]!],
        },
        { now: () => new Date(nextEffectiveAt.getTime() - 48 * 60 * 60 * 1_000) },
      ),
    ).rejects.toMatchObject({ code: 'VIP_TIER_RULE_IDENTITY_INVALID' })
  })

  it('excludes a wallet top-up itself from cumulative VIP spend', async () => {
    const customer = await createCustomer('top-up-excluded')
    const account = await payload.create({
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
    const topUp = await payload.create({
      collection: 'walletTopUpOrders',
      data: {
        account: account.id,
        amountFen: 99_999,
        currency: 'CNY',
        customer: customer.id,
        fundingSource: 'wechat',
        ledgerTransactionKey: `${fixturePrefix}:top-up-ledger`,
        status: 'created',
        topUpOrderNumber: `WT${randomUUID().replaceAll('-', '').slice(0, 30)}`,
      },
      overrideAccess: true,
    })
    await expect(
      recordVipSpendForSucceededOrder(await request('top-up-excluded'), {
        eventId: `${fixturePrefix}:top-up`,
        orderId: topUp.id,
      }),
    ).rejects.toMatchObject({ code: 'VIP_ORDER_NOT_FOUND' })
    await expect(count('vipSpendEntries', { customer: { equals: customer.id } })).resolves.toBe(0)
  })

  it('excludes a cancelled order from cumulative VIP spend', async () => {
    const customer = await createCustomer('cancelled-excluded')
    const order = await createOrder(customer, 'cancelled-excluded', {
      amountFen: 99_999,
      status: 'cancelled',
    })
    await expect(accrue(order, 'cancelled-excluded', nextTime())).resolves.toMatchObject({
      counted: false,
    })
    await expect(count('vipSpendEntries', { customer: { equals: customer.id } })).resolves.toBe(0)
  })

  it('excludes a failed and refunded order from cumulative VIP spend', async () => {
    const customer = await createCustomer('failed-excluded')
    const order = await createOrder(customer, 'failed-excluded', {
      amountFen: 99_999,
      status: 'refunded',
    })
    await expect(accrue(order, 'failed-excluded', nextTime())).resolves.toMatchObject({
      counted: false,
    })
    await expect(count('vipSpendEntries', { customer: { equals: customer.id } })).resolves.toBe(0)
  })

  it('excludes a succeeded row whose authoritative payment channel is absent', async () => {
    const customer = await createCustomer('missing-payment-channel')
    const order = await createOrder(customer, 'missing-payment-channel', { amountFen: 99_999 })
    await payload.db.pool.query('UPDATE orders SET payment_channel = NULL WHERE id = $1', [
      order.id,
    ])
    await expect(accrue(order, 'missing-payment-channel', nextTime())).resolves.toMatchObject({
      counted: false,
    })
    await expect(count('vipSpendEntries', { customer: { equals: customer.id } })).resolves.toBe(0)
  })

  it('counts a successful order but creates no achievement before the first effective rule', async () => {
    const customer = await createCustomer('before-first-rule')
    const order = await createOrder(customer, 'before-first-rule', { amountFen: 99_999 })
    const operation = accrue(order, 'before-first-rule', new Date(Date.UTC(2023, 0, 1)))
    await expect(operation).resolves.toMatchObject({ achievementCount: 0, counted: true })
    const result = await operation
    expect(result).toEqual({ achievementCount: 0, counted: true, cumulativeSpendFen: 99_999 })
    await expect(count('vipTierEvents', { customer: { equals: customer.id } })).resolves.toBe(0)
  })

  it('subtracts an independently recorded reversal before evaluating a later achievement', async () => {
    const customer = await createCustomer('reversal-excluded')
    const at = nextTime()
    await publish('reversal-threshold', at, tierTemplate(1_000, 5_000))
    const first = await createOrder(customer, 'reversal-first', { amountFen: 900 })
    await accrue(first, 'reversal-first', at)
    await appendOrderReversal(customer, first, 900, 'reversal-first', new Date(at.getTime() + 1))
    const second = await createOrder(customer, 'reversal-second', { amountFen: 200 })
    await accrue(second, 'reversal-second', new Date(at.getTime() + 2))
    const status = await readCustomerVipStatus(await request('reversal-excluded-read', customer), {
      now: () => new Date(at.getTime() + 3),
    })
    expect(status.cumulativeSpendFen).toBe(200)
    expect(status.tier).toBeNull()
  })

  it('records a refunded-order reversal once while preserving the achieved tier', async () => {
    const customer = await createCustomer('refund-transition')
    const at = nextTime()
    const order = await createOrder(customer, 'refund-transition', { amountFen: 1_200 })
    await accrue(order, 'refund-transition', at)
    await payload.db.pool.query(`UPDATE orders SET status = 'refunding' WHERE id = $1`, [order.id])
    await transitionOrder(await request('refund-transition'), order.id, 'refunded', {
      actorType: 'system',
      evidence: { traceId: `${fixturePrefix}:refund-transition` },
      reasonCode: 'fixture.vip_refund_confirmed',
    })
    const replayOperation = recordVipSpendReversalForRefundedOrder(
      await request('refund-transition-replay'),
      { eventId: `${fixturePrefix}:refund-transition-replay`, orderId: order.id },
    )
    await expect(replayOperation).resolves.toMatchObject({ reversed: false })
    const replay = await replayOperation
    const status = await readCustomerVipStatus(await request('refund-transition-read', customer), {
      now: () => new Date(at.getTime() + 1),
    })
    expect(replay).toMatchObject({ cumulativeSpendFen: 0, reversed: false })
    expect(status.cumulativeSpendFen).toBe(0)
    expect(status.tier).toMatchObject({ tierCode: 'bronze', tierRank: 1 })
    await expect(
      count('vipSpendEntries', {
        and: [
          { customer: { equals: customer.id } },
          { sourceOrder: { equals: order.id } },
          { entryType: { equals: 'order_reversal' } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('does not reverse a VIP spend fact before the order is actually refunded', async () => {
    const customer = await createCustomer('reversal-before-refund')
    const at = nextTime()
    const order = await createOrder(customer, 'reversal-before-refund', { amountFen: 1_200 })
    await accrue(order, 'reversal-before-refund', at)
    await expect(
      recordVipSpendReversalForRefundedOrder(await request('reversal-before-refund'), {
        eventId: `${fixturePrefix}:reversal-before-refund`,
        orderId: order.id,
      }),
    ).resolves.toEqual({ cumulativeSpendFen: 0, reversed: false })
    const status = await readCustomerVipStatus(
      await request('reversal-before-refund-read', customer),
    )
    expect(status.cumulativeSpendFen).toBe(1_200)
  })

  it.each([
    'pending_payment',
    'paid',
    'fulfilling',
    'refund_pending',
    'refunding',
    'refunded',
    'manual_review',
    'cancelled',
  ] as const)(
    'counts only succeeded orders and independently excludes status %s',
    async (status) => {
      const customer = await createCustomer(`status-${status}`)
      const order = await createOrder(customer, `status-${status}`, { amountFen: 99_999, status })
      await expect(accrue(order, `status-${status}`, nextTime())).resolves.toMatchObject({
        counted: false,
      })
      await expect(count('vipSpendEntries', { customer: { equals: customer.id } })).resolves.toBe(0)
    },
  )

  it.each(['native', 'h5', 'balance'] as const)(
    'counts the frozen payable amount for successful %s orders',
    async (paymentChannel) => {
      const customer = await createCustomer(`channel-${paymentChannel}`)
      const at = nextTime()
      const order = await createOrder(customer, `channel-${paymentChannel}`, {
        amountFen: 1_337,
        paymentChannel,
      })
      await expect(accrue(order, `channel-${paymentChannel}`, at)).resolves.toMatchObject({
        counted: true,
        cumulativeSpendFen: 1_337,
      })
      const entry = await payload.find({
        collection: 'vipSpendEntries',
        limit: 1,
        overrideAccess: true,
        where: {
          and: [
            { customer: { equals: customer.id } },
            { sourceOrder: { equals: order.id } },
            { entryType: { equals: 'succeeded_order' } },
          ],
        },
      })
      expect(entry.docs[0]).toMatchObject({ amountFen: 1_337, paymentChannel })
    },
  )

  it('records exactly one achievement when the same customer triggers it concurrently', async () => {
    const customer = await createCustomer('concurrent-achievement')
    const at = nextTime()
    await publish('concurrent-achievement', at, tierTemplate(1_000, 9_999))
    const order = await createOrder(customer, 'concurrent-achievement', { amountFen: 1_200 })
    const concurrency = Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        accrue(order, `concurrent-achievement-${index}`, new Date(at.getTime() + index)),
      ),
    )
    await expect(concurrency).resolves.toHaveLength(12)
    const outcomes = await concurrency
    expect(outcomes.filter((outcome) => outcome.achievementCount === 1)).toHaveLength(1)
    await expect(
      count('vipTierEvents', {
        and: [
          { customer: { equals: customer.id } },
          { eventType: { equals: 'tier_achievement' } },
          { tierCode: { equals: 'bronze' } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('serializes different succeeded orders so one customer reaches each rank exactly once', async () => {
    const customer = await createCustomer('concurrent-orders-one-rank')
    const at = nextTime()
    await publish('concurrent-orders-one-rank', at, tierTemplate(1_000, 99_999))
    const orders = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createOrder(customer, `concurrent-orders-one-rank-${index}`, { amountFen: 1_000 }),
      ),
    )
    await Promise.all(
      orders.map((order, index) =>
        accrue(order, `concurrent-orders-one-rank-${index}`, new Date(at.getTime() + index)),
      ),
    )
    await expect(
      count('vipTierEvents', {
        and: [
          { customer: { equals: customer.id } },
          { eventType: { equals: 'tier_achievement' } },
          { tierCode: { equals: 'bronze' } },
        ],
      }),
    ).resolves.toBe(1)
    const status = await readCustomerVipStatus(
      await request('concurrent-orders-one-rank-read', customer),
    )
    expect(status.cumulativeSpendFen).toBe(12_000)
  })

  it('waits for an in-flight order-state write before deciding succeeded eligibility', async () => {
    const customer = await createCustomer('order-share-lock')
    const order = await createOrder(customer, 'order-share-lock', { amountFen: 1_200 })
    const client = await payload.db.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id])
      let settled = false
      const operation = accrue(order, 'order-share-lock', nextTime()).finally(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(settled).toBe(false)
      await client.query('COMMIT')
      await expect(operation).resolves.toMatchObject({ counted: false })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('does not append a second achievement for a rank already reached by another order', async () => {
    const customer = await createCustomer('already-reached-rank')
    const at = nextTime()
    await publish('already-reached-rank', at, tierTemplate(1_000, 5_000))
    const first = await createOrder(customer, 'already-reached-rank-first', { amountFen: 1_200 })
    await accrue(first, 'already-reached-rank-first', at)
    const second = await createOrder(customer, 'already-reached-rank-second', { amountFen: 1_200 })
    const operation = accrue(second, 'already-reached-rank-second', new Date(at.getTime() + 1))
    await expect(operation).resolves.toMatchObject({ achievementCount: 0, counted: true })
    const replay = await operation
    expect(replay).toMatchObject({ achievementCount: 0, counted: true })
    await expect(
      count('vipTierEvents', {
        and: [
          { customer: { equals: customer.id } },
          { eventType: { equals: 'tier_achievement' } },
          { tierCode: { equals: 'bronze' } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('requires B-5 request, approval, cooldown and execution for a corrective downgrade', async () => {
    const customer = await createCustomer('approval-required')
    const at = nextTime()
    await publish('approval-required', at, tierTemplate(1_000, 2_000))
    const order = await createOrder(customer, 'approval-required', { amountFen: 2_500 })
    await accrue(order, 'approval-required', at)
    await expect(
      applyApprovedVipTierCorrection(await request('direct-correction', admin), {
        approvalRequestId: 999_999,
        correctionReference: `${fixturePrefix}:direct`,
        customerId: customer.id,
        reasonNote: 'Direct tier correction must be rejected',
        source: 'data_correction',
        spendReversalFen: 500,
        targetTierCode: 'bronze',
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_REQUIRED' })

    const created = await createAdminApprovalRequest(
      await request('approval-required-create', admin),
      {
        correctionReference: `${fixturePrefix}:correction:approval-required`,
        correctionSource: 'data_correction',
        customerId: customer.id,
        operationType: 'vip_fraud_correction',
        reasonNote: 'D9-E-3 visible correction reason approval-required',
        spendReversalFen: 500,
        targetTierCode: 'bronze',
      },
    )
    await expect(
      executeSupportedAdminOperation(
        await request('approval-required-pending-execute', fundsApprover),
        created.id,
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_REQUIRED' })
    await decideAdminApprovalRequest(
      await request('approval-required-decide', fundsApprover),
      created.id,
      { decision: 'approve', note: 'D9-E-3 independent correction approval' },
    )
    await expect(
      executeSupportedAdminOperation(
        await request('approval-required-cooldown-execute', fundsApprover),
        created.id,
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_COOLDOWN_ACTIVE' })
    await payload.db.pool.query(
      `UPDATE admin_approval_requests
       SET created_at = NOW() - (cooldown_seconds + 1) * INTERVAL '1 second'
       WHERE id = $1`,
      [created.id],
    )
    const execution = executeSupportedAdminOperation(
      await request('approval-required-execute', fundsApprover),
      created.id,
    )
    await expect(execution).resolves.toMatchObject({ status: 'executed' })
    const corrected = await execution
    expect(corrected).toMatchObject({ status: 'executed' })
    await expect(
      count('vipTierEvents', {
        and: [
          { customer: { equals: customer.id } },
          { approvalRequest: { equals: created.id } },
          { eventType: { equals: 'tier_correction' } },
        ],
      }),
    ).resolves.toBe(1)
    const status = await readCustomerVipStatus(await request('approval-required-read', customer), {
      now: () => new Date(),
    })
    expect(status.tier).toMatchObject({ tierCode: 'bronze', tierRank: 1 })
  })

  it('never modifies the original achievement when a correction is appended', async () => {
    const customer = await createCustomer('history-immutable')
    const at = nextTime()
    await publish('history-immutable', at, tierTemplate(1_000, 2_000))
    const order = await createOrder(customer, 'history-immutable', { amountFen: 2_500 })
    await accrue(order, 'history-immutable', at)
    const achievement = await payload.find({
      collection: 'vipTierEvents',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: customer.id } },
          { source: { equals: 'natural_achievement' } },
          { tierCode: { equals: 'silver' } },
        ],
      },
    })
    const exactBefore = JSON.stringify(achievement.docs[0])
    await approveCorrection(customer, 'history-immutable', {
      correctionSource: 'data_correction',
      spendReversalFen: 500,
      targetTierCode: 'bronze',
    })
    const exactAfter = await payload.findByID({
      collection: 'vipTierEvents',
      id: achievement.docs[0]!.id,
      overrideAccess: true,
    })
    expect(JSON.stringify(exactAfter)).toBe(exactBefore)
    await expect(
      count('vipTierEvents', {
        and: [{ customer: { equals: customer.id } }, { eventType: { equals: 'tier_correction' } }],
      }),
    ).resolves.toBe(1)
  })

  it('allows an approved rule/data correction to lower a tier without inventing a spend debit', async () => {
    const customer = await createCustomer('zero-spend-correction')
    const at = nextTime()
    await publish('zero-spend-correction', at, tierTemplate(1_000, 5_000))
    const order = await createOrder(customer, 'zero-spend-correction', { amountFen: 7_000 })
    await accrue(order, 'zero-spend-correction', at)
    await expect(
      approveCorrection(customer, 'zero-spend-correction', {
        correctionSource: 'data_correction',
        spendReversalFen: 0,
        targetTierCode: 'bronze',
      }),
    ).resolves.toMatchObject({ executed: { status: 'executed' } })
    const status = await readCustomerVipStatus(
      await request('zero-spend-correction-read', customer),
    )
    expect(status.cumulativeSpendFen).toBe(7_000)
    expect(status.tier).toMatchObject({ tierCode: 'bronze', tierRank: 1 })
    await expect(
      count('vipSpendEntries', {
        and: [{ customer: { equals: customer.id } }, { entryType: { equals: 'data_correction' } }],
      }),
    ).resolves.toBe(0)
  })

  it('rejects a correction with an independently invalid source', async () => {
    const req = await request('correction-invalid-source', admin)
    req.context.adminApprovalExecution = 'vip_fraud_correction:999999'
    await expect(
      applyApprovedVipTierCorrection(req, {
        approvalRequestId: 999_999,
        correctionReference: `${fixturePrefix}:invalid:source`,
        customerId: 999_999,
        reasonNote: 'D9-E-3 invalid correction source',
        source: 'operational_promotion' as 'data_correction',
        spendReversalFen: 0,
        targetTierCode: null,
      }),
    ).rejects.toMatchObject({ code: 'VIP_CORRECTION_SOURCE_INVALID' })
  })

  it('rejects a correction with an independently unsafe non-integer amount', async () => {
    const req = await request('correction-unsafe-amount', admin)
    req.context.adminApprovalExecution = 'vip_fraud_correction:999999'
    await expect(
      applyApprovedVipTierCorrection(req, {
        approvalRequestId: 999_999,
        correctionReference: `${fixturePrefix}:invalid:unsafe-amount`,
        customerId: 999_999,
        reasonNote: 'D9-E-3 invalid correction unsafe amount',
        source: 'data_correction',
        spendReversalFen: 1.5,
        targetTierCode: null,
      }),
    ).rejects.toMatchObject({ code: 'VIP_CORRECTION_AMOUNT_INVALID' })
  })

  it('rejects a correction with an independently negative amount', async () => {
    const req = await request('correction-negative-amount', admin)
    req.context.adminApprovalExecution = 'vip_fraud_correction:999999'
    await expect(
      applyApprovedVipTierCorrection(req, {
        approvalRequestId: 999_999,
        correctionReference: `${fixturePrefix}:invalid:negative-amount`,
        customerId: 999_999,
        reasonNote: 'D9-E-3 invalid correction negative amount',
        source: 'data_correction',
        spendReversalFen: -1,
        targetTierCode: null,
      }),
    ).rejects.toMatchObject({ code: 'VIP_CORRECTION_AMOUNT_INVALID' })
  })

  it('rejects correction when the customer has no achieved tier', async () => {
    const customer = await createCustomer('correction-no-tier')
    const req = await request('correction-no-tier', admin)
    req.context.adminApprovalExecution = 'vip_fraud_correction:999998'
    await expect(
      applyApprovedVipTierCorrection(req, {
        approvalRequestId: 999_998,
        correctionReference: `${fixturePrefix}:correction-no-tier`,
        customerId: customer.id,
        reasonNote: 'D9-E-3 no tier correction rejected',
        source: 'data_correction',
        spendReversalFen: 0,
        targetTierCode: null,
      }),
    ).rejects.toMatchObject({ code: 'VIP_CORRECTION_TIER_UNAVAILABLE' })
  })

  it('rejects same-tier, higher-tier, missing-tier, and excessive-spend corrections independently', async () => {
    const customer = await createCustomer('correction-bounds')
    const at = nextTime()
    await publish('correction-bounds', at, tierTemplate(1_000, 5_000))
    const order = await createOrder(customer, 'correction-bounds', { amountFen: 1_200 })
    await accrue(order, 'correction-bounds', at)
    const cases = [
      ['same-tier', 'bronze', 0, 'VIP_CORRECTION_MUST_LOWER_TIER'],
      ['higher-tier', 'silver', 0, 'VIP_CORRECTION_MUST_LOWER_TIER'],
      ['missing-tier', 'diamond', 0, 'VIP_TIER_NOT_FOUND'],
      ['excessive-spend', null, 1_201, 'VIP_CORRECTION_AMOUNT_EXCEEDS_SPEND'],
    ] as const
    for (const [suffix, targetTierCode, spendReversalFen, code] of cases) {
      const req = await request(`correction-bounds-${suffix}`, admin)
      req.context.adminApprovalExecution = `vip_fraud_correction:${900_000 + spendReversalFen}`
      await expect(
        applyApprovedVipTierCorrection(req, {
          approvalRequestId: 900_000 + spendReversalFen,
          correctionReference: `${fixturePrefix}:correction-bounds:${suffix}`,
          customerId: customer.id,
          reasonNote: `D9-E-3 correction bound ${suffix}`,
          source: 'data_correction',
          spendReversalFen,
          targetTierCode,
        }),
      ).rejects.toMatchObject({ code })
    }
  })

  it('rejects operational promotion that does not raise the current tier', async () => {
    const customer = await createCustomer('promotion-must-raise')
    const at = nextTime()
    await promoteCustomerVipTier(
      await request('promotion-must-raise-first', admin),
      { customerId: customer.id, reasonNote: 'D9-E-3 first bronze promotion', tierCode: 'bronze' },
      { now: () => at },
    )
    await expect(
      promoteCustomerVipTier(
        await request('promotion-must-raise-repeat', admin),
        {
          customerId: customer.id,
          reasonNote: 'D9-E-3 repeated bronze promotion rejected',
          tierCode: 'bronze',
        },
        { now: () => at },
      ),
    ).rejects.toMatchObject({ code: 'VIP_PROMOTION_MUST_RAISE_TIER' })
  })

  it('records natural achievement as an append-only event and matching audit fact', async () => {
    const customer = await createCustomer('source-natural')
    const at = nextTime()
    const order = await createOrder(customer, 'source-natural', { amountFen: 1_200 })
    await accrue(order, 'source-natural', at)
    await expect(
      count('vipTierEvents', {
        and: [{ customer: { equals: customer.id } }, { source: { equals: 'natural_achievement' } }],
      }),
    ).resolves.toBeGreaterThanOrEqual(1)
    await expect(
      count('auditLogs', {
        and: [
          { action: { equals: 'vip.tier.achievement_recorded' } },
          { traceId: { equals: `${fixturePrefix}-accrue-source-natural` } },
        ],
      }),
    ).resolves.toBeGreaterThanOrEqual(1)
  })

  it('records operational promotion as an append-only event and matching audit fact', async () => {
    const customer = await createCustomer('source-promotion')
    const at = nextTime()
    await promoteCustomerVipTier(
      await request('source-promotion', admin),
      {
        customerId: customer.id,
        reasonNote: 'Approved customer care promotion',
        tierCode: 'silver',
      },
      { now: () => at },
    )
    await expect(
      count('vipTierEvents', {
        and: [
          { customer: { equals: customer.id } },
          { source: { equals: 'operational_promotion' } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('auditLogs', {
        and: [
          { action: { equals: 'vip.tier.achievement_recorded' } },
          { traceId: { equals: `${fixturePrefix}-source-promotion` } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('records data correction as an approved append-only event and matching audit fact', async () => {
    const customer = await createCustomer('source-data-correction')
    const at = nextTime()
    const order = await createOrder(customer, 'source-data-correction', { amountFen: 7_000 })
    await accrue(order, 'source-data-correction', at)
    await approveCorrection(customer, 'source-data-correction', {
      correctionSource: 'data_correction',
      spendReversalFen: 500,
      targetTierCode: 'bronze',
    })
    const status = await readCustomerVipStatus(
      await request('source-data-correction-read', customer),
    )
    expect(status.cumulativeSpendFen).toBe(6_500)
    await expect(
      count('vipTierEvents', {
        and: [{ customer: { equals: customer.id } }, { source: { equals: 'data_correction' } }],
      }),
    ).resolves.toBe(1)
    await expect(
      count('auditLogs', {
        and: [
          { action: { equals: 'vip.tier.correction_recorded' } },
          { traceId: { equals: `${fixturePrefix}-approval-execute-source-data-correction` } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('records fraud reversal as an approved append-only event and matching audit fact', async () => {
    const customer = await createCustomer('source-fraud-reversal')
    const at = nextTime()
    const order = await createOrder(customer, 'source-fraud-reversal', { amountFen: 2_500 })
    await accrue(order, 'source-fraud-reversal', at)
    await approveCorrection(customer, 'source-fraud-reversal', {
      correctionSource: 'fraud_reversal',
      spendReversalFen: 2_500,
      targetTierCode: null,
    })
    const status = await readCustomerVipStatus(
      await request('source-fraud-reversal-read', customer),
    )
    expect(status.cumulativeSpendFen).toBe(0)
    await expect(
      count('vipTierEvents', {
        and: [{ customer: { equals: customer.id } }, { source: { equals: 'fraud_reversal' } }],
      }),
    ).resolves.toBe(1)
    await expect(
      count('auditLogs', {
        and: [
          { action: { equals: 'vip.tier.correction_recorded' } },
          { traceId: { equals: `${fixturePrefix}-approval-execute-source-fraud-reversal` } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('publishes versioned rules, enforces advance notice timing, and exposes current adjustable benefits', async () => {
    const customer = await createCustomer('benefit-notice')
    const achievedAt = nextTime()
    const order = await createOrder(customer, 'benefit-notice', { amountFen: 1_200 })
    await accrue(order, 'benefit-notice', achievedAt)
    const changed = tierTemplate()
    changed[0] = {
      ...changed[0]!,
      displayName: '青铜伙伴',
      quotaBenefits: { advancedWhois: 20 },
      serviceContent: '调整后的基础会员服务',
    }
    const publishNow = nextTime()
    await expect(
      publishVipTierRuleVersion(
        await request('benefit-notice-too-late', admin),
        {
          changeNote: 'D9-E-3 benefit change without enough notice',
          effectiveAt: new Date(
            publishNow.getTime() + VIP_BENEFIT_CHANGE_NOTICE_LEAD_MS - 1,
          ).toISOString(),
          tiers: changed,
        },
        { now: () => publishNow },
      ),
    ).rejects.toMatchObject({ code: 'VIP_TIER_NOTICE_LEAD_REQUIRED' })

    const effectiveAt = new Date(publishNow.getTime() + VIP_BENEFIT_CHANGE_NOTICE_LEAD_MS)
    const published = await publish('benefit-notice', effectiveAt, changed, publishNow)
    expect(published.noticeCount).toBeGreaterThanOrEqual(1)
    await expect(
      count('notificationOutboxEvents', {
        and: [
          { customer: { equals: customer.id } },
          { notificationType: { equals: 'vip_benefit_change_advance' } },
          {
            eventKey: {
              equals: `vip-tier-rule:${published.version}:advance-notice:${customer.id}`,
            },
          },
        ],
      }),
    ).resolves.toBe(1)
    const after = await readCustomerVipStatus(await request('benefit-notice-after', customer), {
      now: () => effectiveAt,
    })
    expect(after.tier).toMatchObject({
      displayName: '青铜伙伴',
      quotaBenefits: { advancedWhois: 20 },
      serviceContent: '调整后的基础会员服务',
      tierRank: 1,
    })
  })

  it.each([
    [
      'display name',
      (tiers: ReturnType<typeof tierTemplate>) => [
        { ...tiers[0]!, displayName: '独立名称调整' },
        tiers[1]!,
      ],
    ],
    [
      'quota benefits',
      (tiers: ReturnType<typeof tierTemplate>) => [
        { ...tiers[0]!, quotaBenefits: { advancedWhois: 999 } },
        tiers[1]!,
      ],
    ],
    [
      'service content',
      (tiers: ReturnType<typeof tierTemplate>) => [
        { ...tiers[0]!, serviceContent: '独立服务内容调整' },
        tiers[1]!,
      ],
    ],
  ])('requires the advance-notice lead independently for a %s change', async (suffix, mutate) => {
    const baselineAt = nextTime()
    const base = tierTemplate(1_000, 5_000)
    await publish(`notice-${suffix}-baseline`, baselineAt, base)
    const effectiveAt = nextTime()
    await expect(
      publishVipTierRuleVersion(
        await request(`notice-${suffix}-rejected`, admin),
        {
          changeNote: `D9-E-3 independent ${suffix} notification guard`,
          effectiveAt: effectiveAt.toISOString(),
          tiers: mutate(base),
        },
        { now: () => new Date(effectiveAt.getTime() - 60 * 60 * 1_000) },
      ),
    ).rejects.toMatchObject({ code: 'VIP_TIER_NOTICE_LEAD_REQUIRED' })
  })

  it('allows an immediate threshold-only change without a user-benefit notification', async () => {
    const baselineAt = nextTime()
    await publish('threshold-only-baseline', baselineAt, tierTemplate(1_000, 5_000))
    const effectiveAt = nextTime()
    const published = await publishVipTierRuleVersion(
      await request('threshold-only-change', admin),
      {
        changeNote: 'D9-E-3 threshold-only immediate publication',
        effectiveAt: effectiveAt.toISOString(),
        tiers: tierTemplate(2_000, 6_000),
      },
      { now: () => effectiveAt },
    )
    ruleIds.push(Number(published.id))
    expect(published.noticeCount).toBe(0)
    await expect(
      count('notificationOutboxEvents', {
        eventKey: { like: `vip-tier-rule:${published.version}:advance-notice:` },
      }),
    ).resolves.toBe(0)
  })

  it('notifies current holders in deterministic ascending customer order', async () => {
    const first = await createCustomer('notice-order-first')
    const second = await createCustomer('notice-order-second')
    const achievedAt = nextTime()
    for (const [customer, suffix] of [
      [second, 'second'],
      [first, 'first'],
    ] as const) {
      const order = await createOrder(customer, `notice-order-${suffix}`, { amountFen: 7_000 })
      await accrue(order, `notice-order-${suffix}`, achievedAt)
    }
    await payload.db.pool.query(
      `INSERT INTO vip_tier_events (
         event_key, customer_id, event_type, source, rule_version_id,
         rule_version_number, tier_code, tier_rank, tier_name_snapshot,
         quota_benefits_snapshot, service_content_snapshot,
         cumulative_spend_fen_snapshot, previous_tier_rank, reason,
         occurred_at, updated_at, created_at
       ) VALUES ($1, NULL, 'tier_achievement', 'natural_achievement', NULL,
         1, 'historical', 1, '已匿名历史等级', '{}', '历史权益快照',
         1000, 0, 'customer and rule relationships were cleared after retention',
         $2, $2, $2)`,
      [`${fixturePrefix}:anonymous-history`, achievedAt],
    )
    const changed = tierTemplate()
    changed[0] = { ...changed[0]!, displayName: '确定性通知顺序' }
    const publishNow = nextTime()
    const publication = publish(
      'notice-order',
      new Date(publishNow.getTime() + VIP_BENEFIT_CHANGE_NOTICE_LEAD_MS),
      changed,
      publishNow,
    )
    await expect(publication).resolves.toMatchObject({ noticeCount: expect.any(Number) })
    const published = await publication
    const delivered = await payload.db.pool.query<{ customer_id: number }>(
      `SELECT customer_id
       FROM notification_outbox_events
       WHERE event_key LIKE $1
       ORDER BY id ASC`,
      [`vip-tier-rule:${published.version}:advance-notice:%`],
    )
    const deliveredCustomerIds = delivered.rows.map(({ customer_id }) => customer_id)
    expect(deliveredCustomerIds).toEqual(
      [...deliveredCustomerIds].sort((left, right) => left - right),
    )
    expect(deliveredCustomerIds).toEqual(expect.arrayContaining([first.id, second.id]))
  })

  it('canonicalizes quota-benefit key order without producing a false change notification', async () => {
    const baselineAt = nextTime()
    const baseline = tierTemplate()
    baseline[0] = {
      ...baseline[0]!,
      quotaBenefits: { bulkQuery: 2, advancedWhois: 10 },
    }
    await publish('quota-key-order-baseline', baselineAt, baseline)
    const effectiveAt = nextTime()
    const reordered = tierTemplate()
    reordered[0] = {
      ...reordered[0]!,
      quotaBenefits: { advancedWhois: 10, bulkQuery: 2 },
    }
    const publication = publishVipTierRuleVersion(
      await request('quota-key-order-change', admin),
      {
        changeNote: 'D9-E-3 quota key order canonicalization',
        effectiveAt: effectiveAt.toISOString(),
        tiers: reordered,
      },
      { now: () => effectiveAt },
    )
    await expect(publication).resolves.toMatchObject({ noticeCount: 0 })
    const published = await publication
    ruleIds.push(Number(published.id))
    expect(published.noticeCount).toBe(0)
  })

  it('does not notify a corrected-to-zero former holder when event timestamps tie', async () => {
    const customer = await createCustomer('notice-current-holder')
    const achievedAt = nextTime()
    const order = await createOrder(customer, 'notice-current-holder', { amountFen: 1_200 })
    await accrue(order, 'notice-current-holder', achievedAt)
    await approveCorrection(customer, 'notice-current-holder', {
      correctionSource: 'fraud_reversal',
      spendReversalFen: 1_200,
      targetTierCode: null,
    })
    await payload.db.pool.query(
      'UPDATE vip_tier_events SET occurred_at = $1 WHERE customer_id = $2',
      [achievedAt.toISOString(), customer.id],
    )
    const publishNow = nextTime()
    const changed = tierTemplate()
    changed[0] = { ...changed[0]!, displayName: '纠错后不再通知' }
    const published = await publish(
      'notice-current-holder',
      new Date(publishNow.getTime() + VIP_BENEFIT_CHANGE_NOTICE_LEAD_MS),
      changed,
      publishNow,
    )
    await expect(
      count('notificationOutboxEvents', {
        and: [
          { customer: { equals: customer.id } },
          {
            eventKey: {
              equals: `vip-tier-rule:${published.version}:advance-notice:${customer.id}`,
            },
          },
        ],
      }),
    ).resolves.toBe(0)
  })

  it('shows a correction reason and records one customer appeal without a workflow', async () => {
    const customer = await createCustomer('appeal')
    const at = nextTime()
    const order = await createOrder(customer, 'appeal', { amountFen: 6_000 })
    await accrue(order, 'appeal', at)
    const corrected = await approveCorrection(customer, 'appeal', {
      correctionSource: 'data_correction',
      spendReversalFen: 500,
      targetTierCode: 'bronze',
    })
    const correctionEventId = (corrected.executed.result as { eventId: number | string }).eventId
    const status = await readCustomerVipStatus(await request('appeal-read', customer))
    expect(status.history[0]).toMatchObject({
      eventType: 'tier_correction',
      id: correctionEventId,
      reason: 'D9-E-3 visible correction reason appeal',
      source: 'data_correction',
    })
    await expect(
      recordVipTierCorrectionAppeal(await request('appeal-create', customer), {
        statement: 'I request a review of this correction evidence.',
        tierEventId: correctionEventId,
      }),
    ).resolves.toMatchObject({ appealId: expect.anything() })
    await expect(
      count('vipTierAppeals', {
        and: [{ customer: { equals: customer.id } }, { tierEvent: { equals: correctionEventId } }],
      }),
    ).resolves.toBe(1)
  })

  it('rejects an appeal against an achievement rather than a correction', async () => {
    const customer = await createCustomer('appeal-achievement')
    const at = nextTime()
    const order = await createOrder(customer, 'appeal-achievement', { amountFen: 1_200 })
    await accrue(order, 'appeal-achievement', at)
    const achievement = await payload.find({
      collection: 'vipTierEvents',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ customer: { equals: customer.id } }, { eventType: { equals: 'tier_achievement' } }],
      },
    })
    await expect(
      recordVipTierCorrectionAppeal(await request('appeal-achievement', customer), {
        statement: 'An achievement must not be accepted as a correction appeal.',
        tierEventId: achievement.docs[0]!.id,
      }),
    ).rejects.toMatchObject({ code: 'VIP_TIER_APPEAL_FORBIDDEN' })
  })

  it('rejects an appeal for another customer correction record', async () => {
    const owner = await createCustomer('appeal-owner')
    const outsider = await createCustomer('appeal-outsider')
    const at = nextTime()
    await publish('appeal-owner', at, tierTemplate(1_000, 5_000))
    const order = await createOrder(owner, 'appeal-owner', { amountFen: 6_000 })
    await accrue(order, 'appeal-owner', at)
    const corrected = await approveCorrection(owner, 'appeal-owner', {
      correctionSource: 'data_correction',
      spendReversalFen: 500,
      targetTierCode: 'bronze',
    })
    const correctionEventId = (corrected.executed.result as { eventId: number | string }).eventId
    await expect(
      recordVipTierCorrectionAppeal(await request('appeal-outsider', outsider), {
        statement: 'I must not appeal another customer correction.',
        tierEventId: correctionEventId,
      }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      count('vipTierAppeals', {
        and: [{ customer: { equals: outsider.id } }, { tierEvent: { equals: correctionEventId } }],
      }),
    ).resolves.toBe(0)
  })

  it('selects the highest version when two rules have the same effective time', async () => {
    const effectiveAt = nextTime()
    await publish('same-time-low', effectiveAt, tierTemplate(1_000, 5_000))
    await publish('same-time-high', effectiveAt, tierTemplate(2_000, 6_000))
    const customer = await createCustomer('same-time-version')
    const order = await createOrder(customer, 'same-time-version', { amountFen: 1_500 })
    await accrue(order, 'same-time-version', effectiveAt)
    const status = await readCustomerVipStatus(await request('same-time-version-read', customer), {
      now: () => effectiveAt,
    })
    expect(status.cumulativeSpendFen).toBe(1_500)
    expect(status.tier).toBeNull()
  })

  it('fails closed when a rule level carries another version number', async () => {
    const effectiveAt = nextTime()
    const published = await publish('level-version-binding', effectiveAt, tierTemplate())
    await payload.db.pool.query(
      'UPDATE vip_tier_rule_levels SET version_number = version_number + 100 WHERE rule_version_id = $1',
      [published.id],
    )
    const customer = await createCustomer('level-version-binding')
    const order = await createOrder(customer, 'level-version-binding', { amountFen: 99_999 })
    const result = await accrue(order, 'level-version-binding', effectiveAt)
    expect(result).toMatchObject({ achievementCount: 0, counted: true })
    const status = await readCustomerVipStatus(
      await request('level-version-binding-read', customer),
      { now: () => effectiveAt },
    )
    expect(status.tier).toBeNull()
  })

  it('iterates physically reversed rule rows by rank and records every crossed tier', async () => {
    const effectiveAt = nextTime()
    const versionResult = await payload.db.pool.query<{ id: number; version: string }>(
      `INSERT INTO vip_tier_rule_versions
         (version, schema_version, effective_at, changed_by, change_note, updated_at, created_at)
       SELECT COALESCE(MAX(version), 0) + 1, 1, $1, $2, $3, NOW(), NOW()
       FROM vip_tier_rule_versions
       RETURNING id, version`,
      [effectiveAt.toISOString(), String(admin.id), 'D9-E-3 reversed physical order fixture'],
    )
    const rule = versionResult.rows[0]!
    ruleIds.push(rule.id)
    for (const tier of [...tierTemplate(1_000, 2_000)].reverse()) {
      await payload.db.pool.query(
        `INSERT INTO vip_tier_rule_levels
           (rule_version_id, version_number, tier_code, tier_rank, display_name,
            threshold_fen, quota_benefits, service_content, updated_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())`,
        [
          rule.id,
          Number(rule.version),
          tier.tierCode,
          tier.tierRank,
          tier.displayName,
          tier.thresholdFen,
          JSON.stringify(tier.quotaBenefits),
          tier.serviceContent,
        ],
      )
    }
    const customer = await createCustomer('rank-order')
    const order = await createOrder(customer, 'rank-order', { amountFen: 2_500 })
    const operation = accrue(order, 'rank-order', effectiveAt)
    await expect(operation).resolves.toMatchObject({ achievementCount: 2 })
    const result = await operation
    const status = await readCustomerVipStatus(await request('rank-order-read', customer), {
      now: () => effectiveAt,
    })
    expect(result.achievementCount).toBe(2)
    expect(status.history.map((event) => event.tierRank)).toEqual([2, 1])
    expect(status.tier).toMatchObject({ tierCode: 'silver', tierRank: 2 })
  })

  it('uses the higher event id when tier events share the exact same timestamp', async () => {
    const effectiveAt = nextTime()
    await publish('same-event-time', effectiveAt, tierTemplate(1_000, 5_000))
    const customer = await createCustomer('same-event-time')
    await promoteCustomerVipTier(
      await request('same-event-time-bronze', admin),
      {
        customerId: customer.id,
        reasonNote: 'D9-E-3 same time bronze promotion',
        tierCode: 'bronze',
      },
      { now: () => effectiveAt },
    )
    await promoteCustomerVipTier(
      await request('same-event-time-silver', admin),
      {
        customerId: customer.id,
        reasonNote: 'D9-E-3 same time silver promotion',
        tierCode: 'silver',
      },
      { now: () => effectiveAt },
    )
    const status = await readCustomerVipStatus(await request('same-event-time-read', customer), {
      now: () => effectiveAt,
    })
    expect(status.history.map((event) => event.tierRank)).toEqual([2, 1])
    expect(status.history.map((event) => Number(event.id))).toEqual(
      [...status.history.map((event) => Number(event.id))].sort((left, right) => right - left),
    )
    expect(
      [...status.history]
        .reverse()
        .sort(compareVipTierEventsNewestFirst)
        .map((event) => event.id),
    ).toEqual(status.history.map((event) => event.id))
    expect(status.tier).toMatchObject({ tierCode: 'silver', tierRank: 2 })
  })

  it('orders current tier by event time before using the id tie-breaker', async () => {
    const effectiveAt = nextTime()
    await publish('event-time-before-id', effectiveAt, tierTemplate())
    const customer = await createCustomer('event-time-before-id')
    const later = new Date(effectiveAt.getTime() + 2)
    const earlier = new Date(effectiveAt.getTime() + 1)
    await promoteCustomerVipTier(
      await request('event-time-before-id-bronze', admin),
      { customerId: customer.id, reasonNote: 'D9-E-3 later bronze event', tierCode: 'bronze' },
      { now: () => later },
    )
    await promoteCustomerVipTier(
      await request('event-time-before-id-silver', admin),
      { customerId: customer.id, reasonNote: 'D9-E-3 earlier silver event', tierCode: 'silver' },
      { now: () => earlier },
    )
    const status = await readCustomerVipStatus(
      await request('event-time-before-id-read', customer),
      { now: () => later },
    )
    expect(status.history.map(({ tierRank }) => tierRank)).toEqual([1, 2])
    expect(
      [...status.history]
        .reverse()
        .sort(compareVipTierEventsNewestFirst)
        .map(({ tierRank }) => tierRank),
    ).toEqual([1, 2])
    expect(status.tier).toMatchObject({ tierCode: 'bronze', tierRank: 1 })
  })

  it('couples the succeeded order transition to one VIP spend entry', async () => {
    const customer = await createCustomer('transition-coupling')
    const order = await createOrder(customer, 'transition-coupling', {
      amountFen: 1_200,
      status: 'fulfilling',
    })
    await transitionOrder(await request('transition-coupling'), order.id, 'succeeded', {
      actorType: 'system',
      evidence: { traceId: `${fixturePrefix}:transition-coupling` },
      reasonCode: 'fixture.vip_success',
    })
    await expect(
      count('vipSpendEntries', {
        and: [
          { customer: { equals: customer.id } },
          { sourceOrder: { equals: order.id } },
          { entryType: { equals: 'succeeded_order' } },
        ],
      }),
    ).resolves.toBe(1)
  })
})
