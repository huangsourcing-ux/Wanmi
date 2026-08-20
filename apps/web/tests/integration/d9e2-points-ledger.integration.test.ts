import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest, type Where } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { Customer, Order } from '@/payload-types'
import { maskPhone } from '@/services/auth/client-facts'
import {
  confirmPendingOrderReward,
  consumeToolQuota,
  earnPendingOrderReward,
  readBatchRemainingPoints,
  readPointsBalance,
  readToolQuotaBalance,
  redeemPointsForToolQuota,
  reversePendingOrderReward,
  runPointsExpiration,
} from '@/services/points/ledger'
import { createWalletAccount, postWalletCredit, readWalletBalance } from '@/services/wallet/ledger'

import { fulfillmentQuoteSnapshotFixture } from '../fixtures/commerce'
import { realnameTemplateFixture } from '../fixtures/realname'

const fixturePrefix = `d9e2-points-${randomUUID()}`
const customerIds: number[] = []
let payload: Payload

function phone(): string {
  return `+86195${randomInt(10_000_000, 100_000_000)}`
}

async function systemRequest(suffix: string): Promise<PayloadRequest> {
  return createLocalReq(
    {
      req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) },
    },
    payload,
  )
}

async function customerRequest(customer: Customer, suffix: string): Promise<PayloadRequest> {
  const req = await systemRequest(suffix)
  req.user = { ...customer, collection: 'customers' } as never
  return req
}

async function createCustomer(): Promise<Customer> {
  const customerPhone = phone()
  const customer = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: [],
      phone: customerPhone,
      phoneMasked: maskPhone(customerPhone),
      status: 'active',
    },
    overrideAccess: true,
  })
  customerIds.push(customer.id)
  return customer
}

async function setRestriction(
  customerId: number,
  restriction: 'login_disabled' | 'purchase_disabled',
): Promise<void> {
  await payload.db.pool.query(
    `UPDATE customers
     SET status = 'restricted', capability_restrictions = jsonb_build_array($2::text), updated_at = NOW()
     WHERE id = $1`,
    [customerId, restriction],
  )
}

async function createOrder(
  customer: Customer,
  suffix: string,
  options: { amountMinor?: number; status?: 'refunded' | 'succeeded' } = {},
): Promise<Order> {
  const amountMinor = options.amountMinor ?? 3_517
  const now = new Date()
  const domainAscii = `${suffix}-${randomUUID()}.example`
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `points-${suffix}`.slice(0, 64) }),
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
      registrationPriceMinor: amountMinor,
      renewalPriceMinor: amountMinor,
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
      upstreamCostMinor: amountMinor,
      upstreamRegistrationPriceMinor: amountMinor,
      upstreamRenewalPriceMinor: amountMinor,
      userPriceMinor: amountMinor,
      years: 1,
    },
    overrideAccess: true,
  })
  return payload.create({
    collection: 'orders',
    data: {
      amountMinor,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      orderNumber: `${fixturePrefix}-${suffix}-${randomUUID()}`,
      quote: quote.id,
      quoteSnapshot: fulfillmentQuoteSnapshotFixture({
        amountMinor,
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

async function earn(
  customer: Customer,
  order: Order,
  suffix: string,
  points: number,
  expiresAt: string,
) {
  const earningKey = `${fixturePrefix}:earn:${suffix}`
  const result = await earnPendingOrderReward(await systemRequest(`earn-${suffix}`), {
    customerId: customer.id,
    earningKey,
    expiresAt,
    orderId: order.id,
    points,
  })
  return { earningKey, ...result }
}

async function earnAvailable(
  customer: Customer,
  suffix: string,
  points: number,
  expiresAt: string,
) {
  const order = await createOrder(customer, suffix)
  const pending = await earn(customer, order, suffix, points, expiresAt)
  await confirmPendingOrderReward(await systemRequest(`confirm-${suffix}`), pending.earningKey)
  return { ...pending, order }
}

async function count(
  collection:
    | 'pointsAccounts'
    | 'pointsBatches'
    | 'pointsConsumptionAllocations'
    | 'pointsLedger'
    | 'pointsRedemptions'
    | 'toolQuotaLedger',
  customerId: number,
  where: Where,
): Promise<number> {
  const result = await payload.count({
    collection,
    overrideAccess: true,
    where: { and: [{ customer: { equals: customerId } }, where] },
  })
  return result.totalDocs
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterEach(async () => {
  if (customerIds.length === 0) return
  const ids = [...customerIds]
  await payload.db.pool.query(
    `DELETE FROM audit_logs WHERE trace_id LIKE $1 AND action LIKE 'points.%'`,
    [`${fixturePrefix}-%`],
  )
  for (const table of [
    'tool_quota_ledger',
    'points_consumption_allocations',
    'points_ledger',
    'points_redemptions',
    'points_batches',
    'points_accounts',
    'wallet_entries',
    'wallet_transactions',
    'wallet_accounts',
    'orders',
    'quotes',
    'realname_templates',
  ]) {
    await payload.db.pool.query(`DELETE FROM ${table} WHERE customer_id = ANY($1::int[])`, [ids])
  }
  await payload.db.pool.query(`DELETE FROM customers WHERE id = ANY($1::int[])`, [ids])
  customerIds.length = 0
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9-E-2 points ledger, expiry allocation, and tool quotas', () => {
  it('keeps a succeeded-order reward pending and unavailable until confirmation', async () => {
    const customer = await createCustomer()
    const order = await createOrder(customer, 'pending-first')
    const pendingPromise = earn(
      customer,
      order,
      'pending-first',
      80,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await expect(pendingPromise).resolves.toMatchObject({ applied: true })
    const pending = await pendingPromise

    expect(pending.balance).toEqual({
      available: 0n,
      consumed: 0n,
      expired: 0n,
      held: 0n,
      pending: 80n,
      reversed: 0n,
    })
    await expect(
      redeemPointsForToolQuota(await customerRequest(customer, 'pending-redeem'), {
        customerId: customer.id,
        pointsCost: 1,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:pending-redeem`,
        target: 'advanced_whois',
      }),
    ).rejects.toMatchObject({ code: 'POINTS_BALANCE_INSUFFICIENT' })
    await expect(
      count('pointsLedger', customer.id, { entryType: { equals: 'pending' } }),
    ).resolves.toBe(1)
    await expect(
      count('pointsLedger', customer.id, { entryType: { equals: 'available' } }),
    ).resolves.toBe(0)

    const confirmed = await confirmPendingOrderReward(
      await systemRequest('pending-confirm'),
      pending.earningKey,
    )
    expect(confirmed.balance).toMatchObject({ available: 80n, pending: 0n })
  })

  it('concurrently earns one pending entry for one earning idempotency key', async () => {
    const customer = await createCustomer()
    const order = await createOrder(customer, 'earn-concurrency')
    const earningKey = `${fixturePrefix}:earn:concurrency`
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    const attemptsPromise = Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        earnPendingOrderReward(await systemRequest(`earn-concurrency-${index}`), {
          customerId: customer.id,
          earningKey,
          expiresAt,
          orderId: order.id,
          points: 75,
        }),
      ),
    )
    await expect(attemptsPromise).resolves.toHaveLength(8)
    const attempts = await attemptsPromise

    expect(attempts.filter(({ applied }) => applied)).toHaveLength(1)
    expect(new Set(attempts.map(({ batchId }) => String(batchId))).size).toBe(1)
    await expect(
      count('pointsBatches', customer.id, { earningKey: { equals: earningKey } }),
    ).resolves.toBe(1)
    await expect(
      count('pointsLedger', customer.id, {
        and: [
          { entryKey: { equals: `${earningKey}:pending` } },
          { entryType: { equals: 'pending' } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('rejects every earning idempotency dimension mismatch without another entry', async () => {
    const owner = await createCustomer()
    const other = await createCustomer()
    const order = await createOrder(owner, 'earning-dimensions')
    const otherOrder = await createOrder(owner, 'earning-dimensions-other-order')
    const key = `${fixturePrefix}:earning-dimensions`
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    await earnPendingOrderReward(await systemRequest('earning-dimensions-base'), {
      customerId: owner.id,
      earningKey: key,
      expiresAt,
      orderId: order.id,
      points: 90,
    })

    for (const changed of [
      { customerId: owner.id, expiresAt, orderId: order.id, points: 91 },
      { customerId: owner.id, expiresAt, orderId: otherOrder.id, points: 90 },
      {
        customerId: owner.id,
        expiresAt: new Date(Date.now() + 172_800_000).toISOString(),
        orderId: order.id,
        points: 90,
      },
    ]) {
      await expect(
        earnPendingOrderReward(await systemRequest(`earning-mismatch-${randomUUID()}`), {
          ...changed,
          earningKey: key,
        }),
      ).rejects.toMatchObject({ code: 'POINTS_IDEMPOTENCY_CONFLICT' })
    }
    await expect(
      earnPendingOrderReward(await systemRequest('earning-mismatch-customer'), {
        customerId: other.id,
        earningKey: key,
        expiresAt,
        orderId: order.id,
        points: 90,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_SOURCE_ORDER_OWNER_MISMATCH' })

    const otherOwnedOrder = await createOrder(other, 'earning-dimensions-other-account')
    await earnPendingOrderReward(await systemRequest('earning-dimensions-other-account'), {
      customerId: other.id,
      earningKey: `${fixturePrefix}:earning-dimensions-other-account`,
      expiresAt,
      orderId: otherOwnedOrder.id,
      points: 90,
    })
    const accounts = await payload.db.pool.query<{ customer_id: number; id: number }>(
      `SELECT id, customer_id FROM points_accounts WHERE customer_id = ANY($1::int[])`,
      [[owner.id, other.id]],
    )
    const ownerAccount = accounts.rows.find((account) => account.customer_id === owner.id)!.id
    const otherAccount = accounts.rows.find((account) => account.customer_id === other.id)!.id
    await payload.db.pool.query(
      `UPDATE points_batches SET account_id = $2 WHERE earning_key = $1`,
      [key, otherAccount],
    )
    await expect(
      earnPendingOrderReward(await systemRequest('earning-mismatch-account'), {
        customerId: owner.id,
        earningKey: key,
        expiresAt,
        orderId: order.id,
        points: 90,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_IDEMPOTENCY_CONFLICT' })
    await payload.db.pool.query(
      `UPDATE points_batches SET account_id = $2 WHERE earning_key = $1`,
      [key, ownerAccount],
    )
    await expect(
      count('pointsLedger', owner.id, { entryType: { equals: 'pending' } }),
    ).resolves.toBe(1)
  })

  it('reads order owner and status independently and applies A3 before earning', async () => {
    const owner = await createCustomer()
    const other = await createCustomer()
    const refunded = await createOrder(owner, 'refunded-source', { status: 'refunded' })
    const succeeded = await createOrder(owner, 'foreign-source')
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()

    await expect(
      earnPendingOrderReward(await systemRequest('missing-source'), {
        customerId: owner.id,
        earningKey: `${fixturePrefix}:missing-source`,
        expiresAt,
        orderId: 2_147_483_647,
        points: 10,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_SOURCE_ORDER_NOT_FOUND' })

    await expect(
      earnPendingOrderReward(await systemRequest('refunded-source'), {
        customerId: owner.id,
        earningKey: `${fixturePrefix}:refunded-source`,
        expiresAt,
        orderId: refunded.id,
        points: 10,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_SOURCE_ORDER_STATE_INVALID' })
    await expect(
      earnPendingOrderReward(await systemRequest('foreign-source'), {
        customerId: other.id,
        earningKey: `${fixturePrefix}:foreign-source`,
        expiresAt,
        orderId: succeeded.id,
        points: 10,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_SOURCE_ORDER_OWNER_MISMATCH' })

    await setRestriction(owner.id, 'purchase_disabled')
    await expect(
      earnPendingOrderReward(await systemRequest('restricted-source'), {
        customerId: owner.id,
        earningKey: `${fixturePrefix}:restricted-source`,
        expiresAt,
        orderId: succeeded.id,
        points: 10,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PURCHASE_DISABLED' })
    await expect(
      count('pointsBatches', owner.id, { earningKey: { contains: fixturePrefix } }),
    ).resolves.toBe(0)
  })

  it('reverses a refunded pending reward without ever creating available points', async () => {
    const customer = await createCustomer()
    const order = await createOrder(customer, 'pending-refund')
    const pending = await earn(
      customer,
      order,
      'pending-refund',
      65,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await payload.db.pool.query(
      `UPDATE orders SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
      [order.id],
    )

    await expect(
      confirmPendingOrderReward(await systemRequest('refund-confirm-rejected'), pending.earningKey),
    ).rejects.toMatchObject({ code: 'POINTS_SOURCE_ORDER_STATE_INVALID' })
    const reversed = await reversePendingOrderReward(
      await systemRequest('refund-reverse'),
      pending.earningKey,
    )
    expect(reversed.balance).toEqual({
      available: 0n,
      consumed: 0n,
      expired: 0n,
      held: 0n,
      pending: 0n,
      reversed: 65n,
    })
    await expect(
      count('pointsLedger', customer.id, { entryType: { equals: 'available' } }),
    ).resolves.toBe(0)
    await expect(
      count('pointsLedger', customer.id, { entryType: { equals: 'reversed' } }),
    ).resolves.toBe(1)
  })

  it('lets exactly one of N concurrent confirmations append the available transition', async () => {
    const customer = await createCustomer()
    const order = await createOrder(customer, 'confirm-concurrency')
    const reward = await earn(
      customer,
      order,
      'confirm-concurrency',
      55,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    const attemptsPromise = Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        confirmPendingOrderReward(
          await systemRequest(`confirm-concurrency-${index}`),
          reward.earningKey,
        ),
      ),
    )
    await expect(attemptsPromise).resolves.toHaveLength(8)
    const attempts = await attemptsPromise
    expect(attempts.filter(({ applied }) => applied)).toHaveLength(1)
    await expect(
      count('pointsLedger', customer.id, {
        and: [{ batch: { equals: reward.batchId } }, { entryType: { equals: 'available' } }],
      }),
    ).resolves.toBe(1)
    await expect(
      readPointsBalance(await systemRequest('confirm-concurrency-read'), customer.id),
    ).resolves.toMatchObject({ available: 55n, pending: 0n })
  })

  it('allocates deterministically by earliest expiry and then ascending batch id on replay', async () => {
    const customer = await createCustomer()
    const tieExpiry = new Date(Date.now() + 10 * 86_400_000).toISOString()
    const late = await earnAvailable(
      customer,
      'deterministic-late',
      40,
      new Date(Date.now() + 20 * 86_400_000).toISOString(),
    )
    const tieFirst = await earnAvailable(customer, 'deterministic-tie-first', 30, tieExpiry)
    const tieSecond = await earnAvailable(customer, 'deterministic-tie-second', 30, tieExpiry)
    expect(Number(tieFirst.batchId)).toBeLessThan(Number(tieSecond.batchId))
    expect(Number(late.batchId)).toBeLessThan(Number(tieFirst.batchId))

    const input = {
      customerId: customer.id,
      pointsCost: 50,
      quotaUnits: 2,
      redemptionKey: `${fixturePrefix}:deterministic-redemption`,
      target: 'bulk_query',
    }
    const firstPromise = redeemPointsForToolQuota(
      await customerRequest(customer, 'deterministic-first'),
      input,
    )
    await expect(firstPromise).resolves.toMatchObject({ applied: true })
    const first = await firstPromise
    const replayPromise = redeemPointsForToolQuota(
      await customerRequest(customer, 'deterministic-replay'),
      input,
    )
    await expect(replayPromise).resolves.toMatchObject({ applied: false })
    const replay = await replayPromise
    const expected = [
      { batchId: tieFirst.batchId, expiresAt: tieExpiry, points: 30n },
      { batchId: tieSecond.batchId, expiresAt: tieExpiry, points: 20n },
    ]
    expect(first.allocations).toEqual(expected)
    expect(replay.allocations).toEqual(expected)
    expect(replay.allocations).toEqual(first.allocations)
    expect(replay.applied).toBe(false)
  })

  it('recomputes remaining expirable points from cross-batch allocations', async () => {
    const customer = await createCustomer()
    const first = await earnAvailable(
      customer,
      'remaining-first',
      30,
      new Date(Date.now() + 5 * 86_400_000).toISOString(),
    )
    const second = await earnAvailable(
      customer,
      'remaining-second',
      40,
      new Date(Date.now() + 6 * 86_400_000).toISOString(),
    )
    const redemptionPromise = redeemPointsForToolQuota(
      await customerRequest(customer, 'remaining-redemption'),
      {
        customerId: customer.id,
        pointsCost: 50,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:remaining-redemption`,
        target: 'advanced_whois',
      },
    )
    await expect(redemptionPromise).resolves.toMatchObject({ applied: true })
    const redemption = await redemptionPromise

    expect(redemption.allocations.map(({ batchId, points }) => ({ batchId, points }))).toEqual([
      { batchId: first.batchId, points: 30n },
      { batchId: second.batchId, points: 20n },
    ])
    await expect(
      readBatchRemainingPoints(await systemRequest('remaining-first-read'), {
        batchId: first.batchId,
        customerId: customer.id,
      }),
    ).resolves.toBe(0n)
    await expect(
      readBatchRemainingPoints(await systemRequest('remaining-second-read'), {
        batchId: second.batchId,
        customerId: customer.id,
      }),
    ).resolves.toBe(20n)
    await expect(
      count('pointsConsumptionAllocations', customer.id, {
        redemption: { equals: redemption.redemptionId },
      }),
    ).resolves.toBe(2)
  })

  it('uses allocations rather than correlated consumed entries as the remaining-batch source', async () => {
    const customer = await createCustomer()
    const reward = await earnAvailable(
      customer,
      'allocation-source',
      50,
      new Date(Date.now() + 5 * 86_400_000).toISOString(),
    )
    const redemption = await redeemPointsForToolQuota(
      await customerRequest(customer, 'allocation-source-redemption'),
      {
        customerId: customer.id,
        pointsCost: 20,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:allocation-source-redemption`,
        target: 'advanced_whois',
      },
    )
    const account = await payload.db.pool.query<{ id: number; ledger_version: string }>(
      `UPDATE points_accounts
       SET ledger_version = ledger_version + 1
       WHERE customer_id = $1
       RETURNING id, ledger_version`,
      [customer.id],
    )
    await payload.db.pool.query(
      `INSERT INTO points_ledger (
         entry_key, customer_id, account_id, batch_id, redemption_id, entry_type,
         points, ledger_sequence, updated_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'consumed', 7, $6, NOW(), NOW())`,
      [
        `${fixturePrefix}:allocation-source-decoy`,
        customer.id,
        account.rows[0]!.id,
        reward.batchId,
        redemption.redemptionId,
        account.rows[0]!.ledger_version,
      ],
    )

    await expect(
      readBatchRemainingPoints(await systemRequest('allocation-source-read'), {
        batchId: reward.batchId,
        customerId: customer.id,
      }),
    ).resolves.toBe(30n)
  })

  it('fails closed for every independently corruptible points-balance invariant', async () => {
    const customer = await createCustomer()
    const other = await createCustomer()
    const rewardPromise = earnAvailable(
      customer,
      'points-invariants',
      50,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await expect(rewardPromise).resolves.toBeDefined()
    const reward = await rewardPromise
    const redemption = await redeemPointsForToolQuota(
      await customerRequest(customer, 'points-invariants-redemption'),
      {
        customerId: customer.id,
        pointsCost: 20,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:points-invariants-redemption`,
        target: 'advanced_whois',
      },
    )
    const account = await payload.db.pool.query<{ id: number; ledger_version: string }>(
      `SELECT id, ledger_version FROM points_accounts WHERE customer_id = $1`,
      [customer.id],
    )
    const accountId = account.rows[0]!.id
    const originalVersion = account.rows[0]!.ledger_version
    const entries = await payload.db.pool.query<{ entry_type: string; id: number }>(
      `SELECT id, entry_type FROM points_ledger
       WHERE account_id = $1 ORDER BY ledger_sequence ASC`,
      [accountId],
    )
    const entryId = (type: string) => entries.rows.find((entry) => entry.entry_type === type)!.id
    const expectUnavailable = async (suffix: string) =>
      expect(
        readPointsBalance(await systemRequest(`points-invariant-${suffix}`), customer.id),
      ).rejects.toMatchObject({ code: 'POINTS_LEDGER_UNAVAILABLE' })

    await payload.db.pool.query(
      `UPDATE points_accounts SET ledger_version = ledger_version + 1 WHERE id = $1`,
      [accountId],
    )
    await expectUnavailable('account-version')
    await payload.db.pool.query(`UPDATE points_accounts SET ledger_version = $2 WHERE id = $1`, [
      accountId,
      originalVersion,
    ])

    const lastEntry = entries.rows.at(-1)!
    await payload.db.pool.query(
      `UPDATE points_ledger SET ledger_sequence = ledger_sequence + 1 WHERE id = $1`,
      [lastEntry.id],
    )
    await payload.db.pool.query(
      `UPDATE points_accounts SET ledger_version = ledger_version + 1 WHERE id = $1`,
      [accountId],
    )
    await expectUnavailable('contiguous-sequence')
    await payload.db.pool.query(
      `UPDATE points_ledger SET ledger_sequence = ledger_sequence - 1 WHERE id = $1`,
      [lastEntry.id],
    )
    await payload.db.pool.query(`UPDATE points_accounts SET ledger_version = $2 WHERE id = $1`, [
      accountId,
      originalVersion,
    ])

    await payload.db.pool.query(`UPDATE points_ledger SET points = 21 WHERE id = $1`, [
      entryId('held'),
    ])
    await expectUnavailable('held-allocation')
    await payload.db.pool.query(`UPDATE points_ledger SET points = 20 WHERE id = $1`, [
      entryId('held'),
    ])

    await payload.db.pool.query(`UPDATE points_ledger SET points = 21 WHERE id = $1`, [
      entryId('consumed'),
    ])
    await expectUnavailable('consumed-allocation')
    await payload.db.pool.query(`UPDATE points_ledger SET points = 20 WHERE id = $1`, [
      entryId('consumed'),
    ])

    await payload.db.pool.query(
      `UPDATE points_consumption_allocations SET points = 19 WHERE redemption_id = $1`,
      [redemption.redemptionId],
    )
    await expectUnavailable('allocation-source')
    await payload.db.pool.query(
      `UPDATE points_consumption_allocations SET points = 20 WHERE redemption_id = $1`,
      [redemption.redemptionId],
    )

    await payload.db.pool.query(`UPDATE points_ledger SET points = 29 WHERE id = $1`, [
      entryId('available'),
    ])
    await expectUnavailable('negative-available')
    await payload.db.pool.query(`UPDATE points_ledger SET points = 50 WHERE id = $1`, [
      entryId('available'),
    ])

    await payload.db.pool.query(`UPDATE points_ledger SET points = 49 WHERE id = $1`, [
      entryId('pending'),
    ])
    await expectUnavailable('negative-pending')
    await payload.db.pool.query(`UPDATE points_ledger SET points = 50 WHERE id = $1`, [
      entryId('pending'),
    ])

    await payload.db.pool.query(
      `UPDATE points_accounts SET ledger_version = ledger_version + 1 WHERE id = $1`,
      [accountId],
    )
    await payload.db.pool.query(
      `INSERT INTO points_ledger (
         entry_key, customer_id, account_id, batch_id, redemption_id, entry_type,
         points, ledger_sequence, updated_at, created_at
       ) VALUES ($1, $2, $3, $4, NULL, 'reversed', 50, 5, NOW(), NOW())`,
      [`${fixturePrefix}:terminal-exclusive`, customer.id, accountId, reward.batchId],
    )
    await expectUnavailable('terminal-exclusive')
    await payload.db.pool.query(`DELETE FROM points_ledger WHERE entry_key = $1`, [
      `${fixturePrefix}:terminal-exclusive`,
    ])
    await payload.db.pool.query(`UPDATE points_accounts SET ledger_version = $2 WHERE id = $1`, [
      accountId,
      originalVersion,
    ])

    const foreignOrder = await createOrder(other, 'points-invariants-foreign-order')
    await payload.db.pool.query(`UPDATE points_batches SET source_order_id = $2 WHERE id = $1`, [
      reward.batchId,
      foreignOrder.id,
    ])
    await expectUnavailable('batch-order-owner')
    await payload.db.pool.query(`UPDATE points_batches SET source_order_id = $2 WHERE id = $1`, [
      reward.batchId,
      reward.order.id,
    ])

    await payload.db.pool.query(`UPDATE points_ledger SET customer_id = $2 WHERE id = $1`, [
      entryId('available'),
      other.id,
    ])
    await expectUnavailable('ledger-link')
    await payload.db.pool.query(`UPDATE points_ledger SET customer_id = $2 WHERE id = $1`, [
      entryId('available'),
      customer.id,
    ])

    await payload.db.pool.query(
      `UPDATE points_consumption_allocations SET customer_id = $2 WHERE redemption_id = $1`,
      [redemption.redemptionId, other.id],
    )
    await expectUnavailable('allocation-link')
    await payload.db.pool.query(
      `UPDATE points_consumption_allocations SET customer_id = $2 WHERE redemption_id = $1`,
      [redemption.redemptionId, customer.id],
    )
  })

  it('fails closed for each quota-ledger invariant and scopes balance to the requested target', async () => {
    const customer = await createCustomer()
    const other = await createCustomer()
    await earnAvailable(
      customer,
      'quota-invariants',
      20,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    const redemption = await redeemPointsForToolQuota(
      await customerRequest(customer, 'quota-invariants-redemption'),
      {
        customerId: customer.id,
        pointsCost: 10,
        quotaUnits: 2,
        redemptionKey: `${fixturePrefix}:quota-invariants-redemption`,
        target: 'advanced_whois',
      },
    )
    const account = await payload.db.pool.query<{ id: number; quota_ledger_version: string }>(
      `SELECT id, quota_ledger_version FROM points_accounts WHERE customer_id = $1`,
      [customer.id],
    )
    const accountId = account.rows[0]!.id
    const originalVersion = account.rows[0]!.quota_ledger_version
    const grant = await payload.db.pool.query<{ id: number }>(
      `SELECT id FROM tool_quota_ledger WHERE redemption_id = $1`,
      [redemption.redemptionId],
    )
    const expectUnavailable = async (suffix: string) =>
      expect(
        readToolQuotaBalance(await systemRequest(`quota-invariant-${suffix}`), {
          customerId: customer.id,
          target: 'advanced_whois',
        }),
      ).rejects.toMatchObject({ code: 'POINTS_LEDGER_UNAVAILABLE' })

    await payload.db.pool.query(
      `UPDATE points_accounts SET quota_ledger_version = quota_ledger_version + 1 WHERE id = $1`,
      [accountId],
    )
    await expectUnavailable('account-version')
    await payload.db.pool.query(
      `UPDATE points_accounts SET quota_ledger_version = $2 WHERE id = $1`,
      [accountId, originalVersion],
    )

    await payload.db.pool.query(`UPDATE tool_quota_ledger SET ledger_sequence = 2 WHERE id = $1`, [
      grant.rows[0]!.id,
    ])
    await payload.db.pool.query(
      `UPDATE points_accounts SET quota_ledger_version = 2 WHERE id = $1`,
      [accountId],
    )
    await expectUnavailable('contiguous-sequence')
    await payload.db.pool.query(`UPDATE tool_quota_ledger SET ledger_sequence = 1 WHERE id = $1`, [
      grant.rows[0]!.id,
    ])
    await payload.db.pool.query(
      `UPDATE points_accounts SET quota_ledger_version = $2 WHERE id = $1`,
      [accountId, originalVersion],
    )

    await payload.db.pool.query(`UPDATE tool_quota_ledger SET customer_id = $2 WHERE id = $1`, [
      grant.rows[0]!.id,
      other.id,
    ])
    await expectUnavailable('customer-link')
    await payload.db.pool.query(`UPDATE tool_quota_ledger SET customer_id = $2 WHERE id = $1`, [
      grant.rows[0]!.id,
      customer.id,
    ])

    await payload.db.pool.query(
      `INSERT INTO tool_quota_ledger (
         entry_key, customer_id, account_id, redemption_id, target, entry_type,
         quota_units, ledger_sequence, updated_at, created_at
       ) VALUES ($1, $2, $3, NULL, 'advanced_whois', 'consume', 3, 2, NOW(), NOW())`,
      [`${fixturePrefix}:quota-negative`, customer.id, accountId],
    )
    await payload.db.pool.query(
      `UPDATE points_accounts SET quota_ledger_version = 2 WHERE id = $1`,
      [accountId],
    )
    await expectUnavailable('negative-balance')
    await payload.db.pool.query(`DELETE FROM tool_quota_ledger WHERE entry_key = $1`, [
      `${fixturePrefix}:quota-negative`,
    ])
    await payload.db.pool.query(
      `UPDATE points_accounts SET quota_ledger_version = $2 WHERE id = $1`,
      [accountId, originalVersion],
    )

    await payload.db.pool.query(
      `INSERT INTO tool_quota_ledger (
         entry_key, customer_id, account_id, redemption_id, target, entry_type,
         quota_units, ledger_sequence, updated_at, created_at
       ) VALUES ($1, $2, $3, NULL, 'bulk_query', 'consume', 1, 2, NOW(), NOW())`,
      [`${fixturePrefix}:quota-other-target`, customer.id, accountId],
    )
    await payload.db.pool.query(
      `UPDATE points_accounts SET quota_ledger_version = 2 WHERE id = $1`,
      [accountId],
    )
    await expect(
      readToolQuotaBalance(await systemRequest('quota-invariant-target-scope'), {
        customerId: customer.id,
        target: 'advanced_whois',
      }),
    ).resolves.toBe(2n)
    const targetScopedConsumption = consumeToolQuota(
      await customerRequest(customer, 'quota-invariant-target-consume'),
      {
        customerId: customer.id,
        quotaUnits: 2,
        target: 'advanced_whois',
        usageKey: `${fixturePrefix}:quota-invariant-target-consume`,
      },
    )
    await expect(targetScopedConsumption).resolves.toMatchObject({ quotaBalance: 0n })
  })

  it('fails closed for independently corrupted batch lifecycle and ownership links', async () => {
    const customer = await createCustomer()
    const other = await createCustomer()
    const reward = await earnAvailable(
      customer,
      'batch-invariants',
      40,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    const redemption = await redeemPointsForToolQuota(
      await customerRequest(customer, 'batch-invariants-redemption'),
      {
        customerId: customer.id,
        pointsCost: 10,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:batch-invariants-redemption`,
        target: 'advanced_whois',
      },
    )
    const persistedBatch = await payload.findByID({
      collection: 'pointsBatches',
      id: reward.batchId,
      overrideAccess: true,
    })
    const replay = async (suffix: string) =>
      earnPendingOrderReward(await systemRequest(`batch-invariant-${suffix}`), {
        customerId: customer.id,
        earningKey: reward.earningKey,
        expiresAt: persistedBatch.expiresAt,
        orderId: reward.order.id,
        points: 40,
      })
    const expectUnavailable = async (suffix: string) =>
      expect(replay(suffix)).rejects.toMatchObject({ code: 'POINTS_LEDGER_UNAVAILABLE' })
    const entries = await payload.db.pool.query<{ entry_type: string; id: number }>(
      `SELECT id, entry_type FROM points_ledger WHERE batch_id = $1`,
      [reward.batchId],
    )
    const entryId = (type: string) => entries.rows.find((entry) => entry.entry_type === type)!.id

    await payload.db.pool.query(`UPDATE points_ledger SET points = 39 WHERE id = $1`, [
      entryId('pending'),
    ])
    await expectUnavailable('pending-total')
    await payload.db.pool.query(`UPDATE points_ledger SET points = 40 WHERE id = $1`, [
      entryId('pending'),
    ])

    await payload.db.pool.query(`UPDATE points_ledger SET points = 39 WHERE id = $1`, [
      entryId('available'),
    ])
    await expectUnavailable('available-terminal')
    await payload.db.pool.query(`UPDATE points_ledger SET points = 40 WHERE id = $1`, [
      entryId('available'),
    ])

    await payload.db.pool.query(`UPDATE points_ledger SET customer_id = $2 WHERE id = $1`, [
      entryId('held'),
      other.id,
    ])
    await expectUnavailable('ledger-link')
    await payload.db.pool.query(`UPDATE points_ledger SET customer_id = $2 WHERE id = $1`, [
      entryId('held'),
      customer.id,
    ])

    await payload.db.pool.query(
      `UPDATE points_consumption_allocations SET customer_id = $2 WHERE redemption_id = $1`,
      [redemption.redemptionId, other.id],
    )
    await expectUnavailable('allocation-link')
    await payload.db.pool.query(
      `UPDATE points_consumption_allocations SET customer_id = $2 WHERE redemption_id = $1`,
      [redemption.redemptionId, customer.id],
    )

    const account = await payload.db.pool.query<{ id: number; ledger_version: string }>(
      `UPDATE points_accounts SET ledger_version = ledger_version + 1
       WHERE customer_id = $1 RETURNING id, ledger_version`,
      [customer.id],
    )
    await payload.db.pool.query(
      `INSERT INTO points_ledger (
         entry_key, customer_id, account_id, batch_id, redemption_id, entry_type,
         points, ledger_sequence, updated_at, created_at
       ) VALUES ($1, $2, $3, $4, NULL, 'expired', 31, $5, NOW(), NOW())`,
      [
        `${fixturePrefix}:batch-invariant-expired`,
        customer.id,
        account.rows[0]!.id,
        reward.batchId,
        account.rows[0]!.ledger_version,
      ],
    )
    await expectUnavailable('consumed-plus-expired')
  })

  it('rejects global earning and redemption key reuse across otherwise valid customer facts', async () => {
    const first = await createCustomer()
    const second = await createCustomer()
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    const firstOrder = await createOrder(first, 'global-key-first')
    const secondOrder = await createOrder(second, 'global-key-second')
    const earningKey = `${fixturePrefix}:global-earning-key`
    await earnPendingOrderReward(await systemRequest('global-key-first'), {
      customerId: first.id,
      earningKey,
      expiresAt,
      orderId: firstOrder.id,
      points: 20,
    })
    await expect(
      earnPendingOrderReward(await systemRequest('global-key-second'), {
        customerId: second.id,
        earningKey,
        expiresAt,
        orderId: secondOrder.id,
        points: 20,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_IDEMPOTENCY_CONFLICT' })

    const firstReward = await earnAvailable(first, 'global-redemption-first', 20, expiresAt)
    const secondReward = await earnAvailable(second, 'global-redemption-second', 20, expiresAt)
    expect(firstReward.batchId).not.toBe(secondReward.batchId)
    const redemptionKey = `${fixturePrefix}:global-redemption-key`
    await redeemPointsForToolQuota(await customerRequest(first, 'global-redemption-first'), {
      customerId: first.id,
      pointsCost: 10,
      quotaUnits: 1,
      redemptionKey,
      target: 'advanced_whois',
    })
    await expect(
      redeemPointsForToolQuota(await customerRequest(second, 'global-redemption-second'), {
        customerId: second.id,
        pointsCost: 10,
        quotaUnits: 1,
        redemptionKey,
        target: 'advanced_whois',
      }),
    ).rejects.toMatchObject({ code: 'POINTS_IDEMPOTENCY_CONFLICT' })

    const usageKey = `${fixturePrefix}:global-quota-usage-key`
    await consumeToolQuota(await customerRequest(first, 'global-quota-first'), {
      customerId: first.id,
      quotaUnits: 1,
      target: 'advanced_whois',
      usageKey,
    })
    await redeemPointsForToolQuota(await customerRequest(second, 'global-quota-second-grant'), {
      customerId: second.id,
      pointsCost: 10,
      quotaUnits: 1,
      redemptionKey: `${fixturePrefix}:global-quota-second-grant`,
      target: 'advanced_whois',
    })
    await expect(
      consumeToolQuota(await customerRequest(second, 'global-quota-second'), {
        customerId: second.id,
        quotaUnits: 1,
        target: 'advanced_whois',
        usageKey,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_IDEMPOTENCY_CONFLICT' })
  })

  it('rejects every redemption and quota-use idempotency dimension mismatch', async () => {
    const customer = await createCustomer()
    await earnAvailable(
      customer,
      'redemption-idempotency',
      60,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    const redemptionKey = `${fixturePrefix}:redemption-idempotency`
    await redeemPointsForToolQuota(await customerRequest(customer, 'redemption-idempotency-base'), {
      customerId: customer.id,
      pointsCost: 20,
      quotaUnits: 2,
      redemptionKey,
      target: 'advanced_whois',
    })
    for (const changed of [
      { pointsCost: 21, quotaUnits: 2, target: 'advanced_whois' },
      { pointsCost: 20, quotaUnits: 3, target: 'advanced_whois' },
      { pointsCost: 20, quotaUnits: 2, target: 'bulk_query' },
    ]) {
      await expect(
        redeemPointsForToolQuota(
          await customerRequest(customer, `redemption-idempotency-${randomUUID()}`),
          { customerId: customer.id, redemptionKey, ...changed },
        ),
      ).rejects.toMatchObject({ code: 'POINTS_IDEMPOTENCY_CONFLICT' })
    }

    const usageKey = `${fixturePrefix}:quota-use-idempotency`
    const firstPromise = consumeToolQuota(
      await customerRequest(customer, 'quota-use-idempotency-base'),
      {
        customerId: customer.id,
        quotaUnits: 1,
        target: 'advanced_whois',
        usageKey,
      },
    )
    await expect(firstPromise).resolves.toMatchObject({ applied: true })
    const first = await firstPromise
    const replayPromise = consumeToolQuota(
      await customerRequest(customer, 'quota-use-idempotency-replay'),
      {
        customerId: customer.id,
        quotaUnits: 1,
        target: 'advanced_whois',
        usageKey,
      },
    )
    await expect(replayPromise).resolves.toMatchObject({ applied: false })
    const replay = await replayPromise
    expect(first.applied).toBe(true)
    expect(replay).toEqual({ applied: false, quotaBalance: 1n })
    await expect(
      consumeToolQuota(await customerRequest(customer, 'quota-use-idempotency-units'), {
        customerId: customer.id,
        quotaUnits: 2,
        target: 'advanced_whois',
        usageKey,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_IDEMPOTENCY_CONFLICT' })
    await expect(
      consumeToolQuota(await customerRequest(customer, 'quota-use-idempotency-target'), {
        customerId: customer.id,
        quotaUnits: 1,
        target: 'bulk_query',
        usageKey,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_IDEMPOTENCY_CONFLICT' })
  })

  it('fails closed when a redemption replay lacks exact held, consumed, or quota evidence', async () => {
    const customer = await createCustomer()
    await earnAvailable(
      customer,
      'replay-evidence',
      60,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    const base = {
      customerId: customer.id,
      pointsCost: 10,
      target: 'advanced_whois',
    } as const
    const firstInput = {
      ...base,
      quotaUnits: 1,
      redemptionKey: `${fixturePrefix}:replay-evidence-first`,
    }
    const secondInput = {
      ...base,
      quotaUnits: 2,
      redemptionKey: `${fixturePrefix}:replay-evidence-second`,
    }
    const first = await redeemPointsForToolQuota(
      await customerRequest(customer, 'replay-evidence-first'),
      firstInput,
    )
    const second = await redeemPointsForToolQuota(
      await customerRequest(customer, 'replay-evidence-second'),
      secondInput,
    )
    const replayFirst = async (suffix: string) =>
      redeemPointsForToolQuota(
        await customerRequest(customer, `replay-evidence-${suffix}`),
        firstInput,
      )
    const firstFacts = await payload.db.pool.query<{ entry_type: string; id: number }>(
      `SELECT id, entry_type FROM points_ledger WHERE redemption_id = $1`,
      [first.redemptionId],
    )
    const firstFactId = (type: string) =>
      firstFacts.rows.find((entry) => entry.entry_type === type)!.id

    await payload.db.pool.query(
      `UPDATE points_ledger SET redemption_id = $2
       WHERE id = $1`,
      [firstFactId('held'), second.redemptionId],
    )
    await expect(replayFirst('missing-held')).rejects.toMatchObject({
      code: 'POINTS_LEDGER_UNAVAILABLE',
    })
    await payload.db.pool.query(
      `UPDATE points_ledger SET redemption_id = $2
       WHERE id = $1`,
      [firstFactId('held'), first.redemptionId],
    )

    await payload.db.pool.query(
      `UPDATE points_ledger SET redemption_id = $2
       WHERE id = $1`,
      [firstFactId('consumed'), second.redemptionId],
    )
    await expect(replayFirst('missing-consumed')).rejects.toMatchObject({
      code: 'POINTS_LEDGER_UNAVAILABLE',
    })
    await payload.db.pool.query(
      `UPDATE points_ledger SET redemption_id = $2
       WHERE id = $1`,
      [firstFactId('consumed'), first.redemptionId],
    )

    await payload.db.pool.query(
      `UPDATE tool_quota_ledger SET redemption_id = $2 WHERE redemption_id = $1`,
      [second.redemptionId, first.redemptionId],
    )
    await expect(replayFirst('duplicate-quota')).rejects.toMatchObject({
      code: 'POINTS_LEDGER_UNAVAILABLE',
    })
    await payload.db.pool.query(
      `UPDATE tool_quota_ledger SET redemption_id = $2
       WHERE redemption_id = $1 AND quota_units = 2`,
      [first.redemptionId, second.redemptionId],
    )

    await payload.db.pool.query(
      `UPDATE tool_quota_ledger SET quota_units = 9 WHERE redemption_id = $1`,
      [first.redemptionId],
    )
    await expect(replayFirst('quota-units')).rejects.toMatchObject({
      code: 'POINTS_LEDGER_UNAVAILABLE',
    })
    await payload.db.pool.query(
      `UPDATE tool_quota_ledger SET quota_units = 1 WHERE redemption_id = $1`,
      [first.redemptionId],
    )
  })

  it('fails closed when replay facts are reassigned across otherwise valid equal-cost batches', async () => {
    const customer = await createCustomer()
    await earnAvailable(
      customer,
      'replay-link-first',
      10,
      new Date(Date.now() + 2 * 86_400_000).toISOString(),
    )
    await earnAvailable(
      customer,
      'replay-link-second',
      20,
      new Date(Date.now() + 3 * 86_400_000).toISOString(),
    )
    const firstInput = {
      customerId: customer.id,
      pointsCost: 10,
      quotaUnits: 1,
      redemptionKey: `${fixturePrefix}:replay-link-first`,
      target: 'advanced_whois',
    }
    const secondInput = {
      ...firstInput,
      pointsCost: 20,
      redemptionKey: `${fixturePrefix}:replay-link-second`,
    }
    const first = await redeemPointsForToolQuota(
      await customerRequest(customer, 'replay-link-first'),
      firstInput,
    )
    const second = await redeemPointsForToolQuota(
      await customerRequest(customer, 'replay-link-second'),
      secondInput,
    )
    expect(first.allocations[0]!.batchId).not.toBe(second.allocations[0]!.batchId)

    const swapFacts = () =>
      payload.db.pool.query(
        `UPDATE points_ledger
         SET redemption_id = CASE
           WHEN redemption_id = $1 THEN $2
           WHEN redemption_id = $2 THEN $1
         END
         WHERE redemption_id IN ($1, $2)`,
        [first.redemptionId, second.redemptionId],
      )
    await swapFacts()
    await expect(
      redeemPointsForToolQuota(await customerRequest(customer, 'replay-link-corrupt'), firstInput),
    ).rejects.toMatchObject({ code: 'POINTS_LEDGER_UNAVAILABLE' })
    await swapFacts()

    const swapAllocations = () =>
      payload.db.pool.query(
        `UPDATE points_consumption_allocations
         SET redemption_id = CASE
           WHEN redemption_id = $1 THEN $2
           WHEN redemption_id = $2 THEN $1
         END
         WHERE redemption_id IN ($1, $2)`,
        [first.redemptionId, second.redemptionId],
      )
    await swapFacts()
    await swapAllocations()
    await expect(
      redeemPointsForToolQuota(
        await customerRequest(customer, 'replay-link-allocation-total'),
        firstInput,
      ),
    ).rejects.toMatchObject({ code: 'POINTS_LEDGER_UNAVAILABLE' })
    await swapAllocations()
    await swapFacts()
  })

  it('scopes locks, balances, allocations, and batch reads to one customer account', async () => {
    const decoy = await createCustomer()
    const owner = await createCustomer()
    const decoyRewardPromise = earnAvailable(
      decoy,
      'scope-decoy',
      90,
      new Date(Date.now() + 2 * 86_400_000).toISOString(),
    )
    await expect(decoyRewardPromise).resolves.toBeDefined()
    const decoyReward = await decoyRewardPromise
    const ownerRewardPromise = earnAvailable(
      owner,
      'scope-owner',
      30,
      new Date(Date.now() + 5 * 86_400_000).toISOString(),
    )
    await expect(ownerRewardPromise).resolves.toBeDefined()
    const ownerReward = await ownerRewardPromise
    const decoyRedemptionPromise = redeemPointsForToolQuota(
      await customerRequest(decoy, 'scope-decoy-redemption'),
      {
        customerId: decoy.id,
        pointsCost: 10,
        quotaUnits: 3,
        redemptionKey: `${fixturePrefix}:scope-decoy-redemption`,
        target: 'bulk_query',
      },
    )
    await expect(decoyRedemptionPromise).resolves.toMatchObject({ applied: true })

    await expect(
      readPointsBalance(await systemRequest('scope-owner-balance'), owner.id),
    ).resolves.toMatchObject({ available: 30n, pending: 0n })
    const redemptionPromise = redeemPointsForToolQuota(
      await customerRequest(owner, 'scope-owner-redemption'),
      {
        customerId: owner.id,
        pointsCost: 20,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:scope-owner-redemption`,
        target: 'bulk_query',
      },
    )
    await expect(redemptionPromise).resolves.toMatchObject({ applied: true })
    const redemption = await redemptionPromise
    expect(redemption.allocations).toEqual([
      {
        batchId: ownerReward.batchId,
        expiresAt: expect.any(String),
        points: 20n,
      },
    ])
    await expect(
      readBatchRemainingPoints(await systemRequest('scope-foreign-batch'), {
        batchId: decoyReward.batchId,
        customerId: owner.id,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_BATCH_NOT_FOUND' })
    await expect(
      readBatchRemainingPoints(await systemRequest('scope-owner-batch'), {
        batchId: ownerReward.batchId,
        customerId: owner.id,
      }),
    ).resolves.toBe(10n)
    await expect(
      readPointsBalance(await systemRequest('scope-owner-final-balance'), owner.id),
    ).resolves.toMatchObject({ available: 10n, consumed: 20n })
    await expect(
      readPointsBalance(await systemRequest('scope-decoy-final-balance'), decoy.id),
    ).resolves.toMatchObject({ available: 80n, consumed: 10n })
    await expect(
      readToolQuotaBalance(await systemRequest('scope-owner-quota'), {
        customerId: owner.id,
        target: 'bulk_query',
      }),
    ).resolves.toBe(1n)
    await expect(
      readToolQuotaBalance(await systemRequest('scope-decoy-quota'), {
        customerId: decoy.id,
        target: 'bulk_query',
      }),
    ).resolves.toBe(3n)
    await expect(
      consumeToolQuota(await customerRequest(owner, 'scope-owner-insufficient-quota'), {
        customerId: owner.id,
        quotaUnits: 2,
        target: 'bulk_query',
        usageKey: `${fixturePrefix}:scope-owner-insufficient-quota`,
      }),
    ).rejects.toMatchObject({ code: 'TOOL_QUOTA_INSUFFICIENT' })
  })

  it('scopes every points and quota CAS update to the exact account at equal versions', async () => {
    const first = await createCustomer()
    const second = await createCustomer()
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    const firstOrder = await createOrder(first, 'cas-first-pending')
    const secondOrder = await createOrder(second, 'cas-second-pending')
    const firstPending = await earn(first, firstOrder, 'cas-first-pending', 10, expiresAt)
    const secondPending = await earn(second, secondOrder, 'cas-second-pending', 10, expiresAt)

    const firstConfirmation = confirmPendingOrderReward(
      await systemRequest('cas-first-confirm'),
      firstPending.earningKey,
    )
    await expect(firstConfirmation).resolves.toMatchObject({ applied: true })
    await expect(
      readPointsBalance(await systemRequest('cas-second-still-pending'), second.id),
    ).resolves.toMatchObject({ available: 0n, pending: 10n })
    await expect(
      confirmPendingOrderReward(
        await systemRequest('cas-second-confirm'),
        secondPending.earningKey,
      ),
    ).resolves.toMatchObject({ applied: true })

    const extraOrder = await createOrder(first, 'cas-first-extra')
    const extraPending = earn(first, extraOrder, 'cas-first-extra', 5, expiresAt)
    await expect(extraPending).resolves.toMatchObject({ applied: true })
    const extra = await extraPending
    await expect(
      readPointsBalance(await systemRequest('cas-second-after-extra-earn'), second.id),
    ).resolves.toMatchObject({ available: 10n, pending: 0n })
    await expect(
      confirmPendingOrderReward(await systemRequest('cas-first-extra-confirm'), extra.earningKey),
    ).resolves.toMatchObject({ applied: true })

    const firstGrant = redeemPointsForToolQuota(await customerRequest(first, 'cas-first-grant'), {
      customerId: first.id,
      pointsCost: 5,
      quotaUnits: 2,
      redemptionKey: `${fixturePrefix}:cas-first-grant`,
      target: 'advanced_whois',
    })
    await expect(firstGrant).resolves.toMatchObject({ applied: true })
    await expect(
      readToolQuotaBalance(await systemRequest('cas-second-before-grant'), {
        customerId: second.id,
        target: 'advanced_whois',
      }),
    ).resolves.toBe(0n)
    await expect(
      redeemPointsForToolQuota(await customerRequest(second, 'cas-second-grant'), {
        customerId: second.id,
        pointsCost: 5,
        quotaUnits: 2,
        redemptionKey: `${fixturePrefix}:cas-second-grant`,
        target: 'advanced_whois',
      }),
    ).resolves.toMatchObject({ applied: true })

    await expect(
      redeemPointsForToolQuota(await customerRequest(first, 'cas-first-second-grant'), {
        customerId: first.id,
        pointsCost: 1,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:cas-first-second-grant`,
        target: 'advanced_whois',
      }),
    ).resolves.toMatchObject({ applied: true })
    await expect(
      readToolQuotaBalance(await systemRequest('cas-second-before-second-grant'), {
        customerId: second.id,
        target: 'advanced_whois',
      }),
    ).resolves.toBe(2n)
    await expect(
      redeemPointsForToolQuota(await customerRequest(second, 'cas-second-second-grant'), {
        customerId: second.id,
        pointsCost: 1,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:cas-second-second-grant`,
        target: 'advanced_whois',
      }),
    ).resolves.toMatchObject({ applied: true })
    await expect(
      consumeToolQuota(await customerRequest(first, 'cas-first-consume'), {
        customerId: first.id,
        quotaUnits: 1,
        target: 'advanced_whois',
        usageKey: `${fixturePrefix}:cas-first-consume`,
      }),
    ).resolves.toMatchObject({ applied: true })
    await expect(
      readToolQuotaBalance(await systemRequest('cas-second-after-consume'), {
        customerId: second.id,
        target: 'advanced_whois',
      }),
    ).resolves.toBe(3n)

    const expiringFirst = await createCustomer()
    const expiringSecond = await createCustomer()
    const expiry = new Date(Date.now() + 1_000)
    await earnAvailable(expiringFirst, 'cas-expiry-first', 7, expiry.toISOString())
    await earnAvailable(expiringSecond, 'cas-expiry-second', 9, expiry.toISOString())
    const expiration = runPointsExpiration(await systemRequest('cas-expiration'), {
      cutoff: new Date(expiry.getTime() + 1_000),
      maxBatches: 1,
    })
    await expect(expiration).resolves.toEqual({ expiredBatches: 1, expiredPoints: 7n })
    await expect(
      readPointsBalance(await systemRequest('cas-expiry-second-unchanged'), expiringSecond.id),
    ).resolves.toMatchObject({ available: 9n, expired: 0n })
  })

  it('atomically consumes to the exact boundary under N concurrent redemptions without overdraft', async () => {
    const customer = await createCustomer()
    await earnAvailable(
      customer,
      'consume-boundary',
      100,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        redeemPointsForToolQuota(await customerRequest(customer, `consume-boundary-${index}`), {
          customerId: customer.id,
          pointsCost: 25,
          quotaUnits: 1,
          redemptionKey: `${fixturePrefix}:consume-boundary:${index}`,
          target: 'advanced_whois',
        }),
      ),
    )
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(4)
    expect(
      attempts
        .filter((attempt) => attempt.status === 'rejected')
        .every(
          (attempt) => (attempt.reason as { code?: string }).code === 'POINTS_BALANCE_INSUFFICIENT',
        ),
    ).toBe(true)
    await expect(
      readPointsBalance(await systemRequest('consume-boundary-read'), customer.id),
    ).resolves.toMatchObject({
      available: 0n,
      consumed: 100n,
      held: 0n,
    })
    await expect(
      count('pointsConsumptionAllocations', customer.id, { points: { equals: 25 } }),
    ).resolves.toBe(4)
  })

  it('expires only by appending an expired entry and leaves every historical row unchanged', async () => {
    const customer = await createCustomer()
    const expiresAt = new Date(Date.now() + 1_000)
    await earnAvailable(customer, 'append-only-expiry', 45, expiresAt.toISOString())
    const before = await payload.find({
      collection: 'pointsLedger',
      limit: 20,
      overrideAccess: true,
      sort: 'ledgerSequence',
      where: { customer: { equals: customer.id } },
    })
    const result = await runPointsExpiration(await systemRequest('append-only-expiry-job'), {
      cutoff: new Date(expiresAt.getTime() + 1_000),
    })
    const after = await payload.find({
      collection: 'pointsLedger',
      limit: 20,
      overrideAccess: true,
      sort: 'ledgerSequence',
      where: { customer: { equals: customer.id } },
    })

    expect(result).toEqual({ expiredBatches: 1, expiredPoints: 45n })
    expect(after.docs).toHaveLength(before.docs.length + 1)
    expect(
      after.docs
        .slice(0, before.docs.length)
        .map(({ id, entryType, points, createdAt, updatedAt }) => ({
          id,
          entryType,
          points,
          createdAt,
          updatedAt,
        })),
    ).toEqual(
      before.docs.map(({ id, entryType, points, createdAt, updatedAt }) => ({
        id,
        entryType,
        points,
        createdAt,
        updatedAt,
      })),
    )
    expect(after.docs.at(-1)).toMatchObject({ entryType: 'expired', points: 45 })
  })

  it('expires only the allocation-derived remainder after a partial batch consumption', async () => {
    const customer = await createCustomer()
    const expiresAt = new Date(Date.now() + 1_000)
    const reward = await earnAvailable(customer, 'partial-expiry', 60, expiresAt.toISOString())
    await redeemPointsForToolQuota(await customerRequest(customer, 'partial-expiry-spend'), {
      customerId: customer.id,
      pointsCost: 40,
      quotaUnits: 1,
      redemptionKey: `${fixturePrefix}:partial-expiry-spend`,
      target: 'bulk_query',
    })
    const expirationPromise = runPointsExpiration(await systemRequest('partial-expiry-job'), {
      cutoff: new Date(expiresAt.getTime() + 1_000),
    })
    await expect(expirationPromise).resolves.toMatchObject({ expiredBatches: 1 })
    const expired = await expirationPromise
    expect(expired).toEqual({ expiredBatches: 1, expiredPoints: 20n })
    await expect(
      readBatchRemainingPoints(await systemRequest('partial-expiry-read'), {
        batchId: reward.batchId,
        customerId: customer.id,
      }),
    ).resolves.toBe(0n)
    await expect(
      count('pointsLedger', customer.id, {
        and: [{ entryType: { equals: 'expired' } }, { points: { equals: 20 } }],
      }),
    ).resolves.toBe(1)
  })

  it('expires equal-time batches by ascending id and honors the exact batch limit', async () => {
    const customer = await createCustomer()
    const expiresAt = new Date(Date.now() + 1_000)
    const first = await earnAvailable(customer, 'expiry-order-first', 11, expiresAt.toISOString())
    const second = await earnAvailable(customer, 'expiry-order-second', 13, expiresAt.toISOString())
    const later = await earnAvailable(
      customer,
      'expiry-order-later',
      17,
      new Date(expiresAt.getTime() + 500).toISOString(),
    )
    expect(Number(first.batchId)).toBeLessThan(Number(second.batchId))
    expect(Number(second.batchId)).toBeLessThan(Number(later.batchId))
    const cutoff = new Date(expiresAt.getTime() + 1_000)

    await expect(
      runPointsExpiration(await systemRequest('expiry-order-one'), { cutoff, maxBatches: 1 }),
    ).resolves.toEqual({ expiredBatches: 1, expiredPoints: 11n })
    await expect(
      count('pointsLedger', customer.id, {
        and: [{ batch: { equals: first.batchId } }, { entryType: { equals: 'expired' } }],
      }),
    ).resolves.toBe(1)
    await expect(
      count('pointsLedger', customer.id, {
        and: [{ batch: { equals: second.batchId } }, { entryType: { equals: 'expired' } }],
      }),
    ).resolves.toBe(0)
    await expect(
      runPointsExpiration(await systemRequest('expiry-order-two'), { cutoff, maxBatches: 1 }),
    ).resolves.toEqual({ expiredBatches: 1, expiredPoints: 13n })
  })

  it('never allocates an expired batch and consumes only a later live batch', async () => {
    const customer = await createCustomer()
    const expiresAt = new Date(Date.now() + 1_000)
    const expired = await earnAvailable(
      customer,
      'expired-not-spendable',
      25,
      expiresAt.toISOString(),
    )
    const live = await earnAvailable(
      customer,
      'expired-not-spendable-live',
      25,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await runPointsExpiration(await systemRequest('expired-not-spendable-job'), {
      cutoff: new Date(expiresAt.getTime() + 1_000),
    })
    const redemption = await redeemPointsForToolQuota(
      await customerRequest(customer, 'expired-not-spendable-redemption'),
      {
        customerId: customer.id,
        pointsCost: 25,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:expired-not-spendable-redemption`,
        target: 'advanced_whois',
      },
    )
    expect(redemption.allocations).toEqual([
      { batchId: live.batchId, expiresAt: expect.any(String), points: 25n },
    ])
    await expect(
      count('pointsConsumptionAllocations', customer.id, {
        batch: { equals: expired.batchId },
      }),
    ).resolves.toBe(0)
  })

  it('excludes elapsed but unswept batches in both allocation and atomic reservation', async () => {
    const customer = await createCustomer()
    const expiresAt = new Date(Date.now() + 200)
    const elapsed = await earnAvailable(customer, 'elapsed-unswept', 25, expiresAt.toISOString())
    const live = await earnAvailable(
      customer,
      'elapsed-unswept-live',
      25,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    const redemption = await redeemPointsForToolQuota(
      await customerRequest(customer, 'elapsed-unswept-redemption'),
      {
        customerId: customer.id,
        pointsCost: 25,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:elapsed-unswept-redemption`,
        target: 'advanced_whois',
      },
    )
    expect(redemption.allocations).toEqual([
      { batchId: live.batchId, expiresAt: expect.any(String), points: 25n },
    ])
    await expect(
      count('pointsConsumptionAllocations', customer.id, {
        batch: { equals: elapsed.batchId },
      }),
    ).resolves.toBe(0)
  })

  it('makes N concurrent consumers and expiration runners deterministic without overdraft', async () => {
    const customer = await createCustomer()
    const expiringAt = new Date(Date.now() + 250)
    await earnAvailable(customer, 'race-expiring', 60, expiringAt.toISOString())
    const future = await earnAvailable(
      customer,
      'race-future',
      100,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    const cutoff = new Date()
    const expirationAttempts = Array.from({ length: 4 }, async (_, index) =>
      runPointsExpiration(await systemRequest(`race-expiration-${index}`), { cutoff }),
    )
    const consumptionAttempts = Array.from({ length: 4 }, async (_, index) =>
      redeemPointsForToolQuota(await customerRequest(customer, `race-consume-${index}`), {
        customerId: customer.id,
        pointsCost: 25,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:race-consume:${index}`,
        target: 'ai_domain_analysis',
      }),
    )
    const [expirations, consumptions] = await Promise.all([
      Promise.all(expirationAttempts),
      Promise.all(consumptionAttempts),
    ])

    expect(expirations.reduce((total, result) => total + result.expiredBatches, 0)).toBe(1)
    expect(expirations.reduce((total, result) => total + result.expiredPoints, 0n)).toBe(60n)
    expect(
      consumptions.every(({ allocations }) => allocations[0]?.batchId === future.batchId),
    ).toBe(true)
    await expect(
      readPointsBalance(await systemRequest('race-read'), customer.id),
    ).resolves.toMatchObject({
      available: 0n,
      consumed: 100n,
      expired: 60n,
      held: 0n,
    })
  })

  it('grants only approved tool quotas and atomically prevents quota over-consumption', async () => {
    const customer = await createCustomer()
    await earnAvailable(
      customer,
      'quota-targets',
      300,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    for (const target of ['advanced_whois', 'bulk_query', 'ai_domain_analysis'] as const) {
      const grantPromise = redeemPointsForToolQuota(
        await customerRequest(customer, `quota-grant-${target}`),
        {
          customerId: customer.id,
          pointsCost: 100,
          quotaUnits: 2,
          redemptionKey: `${fixturePrefix}:quota-grant:${target}`,
          target,
        },
      )
      await expect(grantPromise).resolves.toMatchObject({ applied: true })
      await expect(
        readToolQuotaBalance(await systemRequest(`quota-read-${target}`), {
          customerId: customer.id,
          target,
        }),
      ).resolves.toBe(2n)
    }
    await expect(
      redeemPointsForToolQuota(await customerRequest(customer, 'quota-tier-rejected'), {
        customerId: customer.id,
        pointsCost: 1,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:quota-tier-rejected`,
        target: 'tier_acceleration',
      }),
    ).rejects.toMatchObject({ code: 'POINTS_REDEMPTION_TARGET_INVALID' })

    const usages = await Promise.allSettled(
      Array.from({ length: 5 }, async (_, index) =>
        consumeToolQuota(await customerRequest(customer, `quota-use-${index}`), {
          customerId: customer.id,
          quotaUnits: 1,
          target: 'advanced_whois',
          usageKey: `${fixturePrefix}:quota-use:${index}`,
        }),
      ),
    )
    expect(usages.filter(({ status }) => status === 'fulfilled')).toHaveLength(2)
    await expect(
      readToolQuotaBalance(await systemRequest('quota-final-read'), {
        customerId: customer.id,
        target: 'advanced_whois',
      }),
    ).resolves.toBe(0n)
  })

  it('applies A3 independently at points redemption and tool-quota consumption callpoints', async () => {
    const pointsRestricted = await createCustomer()
    await earnAvailable(
      pointsRestricted,
      'points-a3',
      20,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await setRestriction(pointsRestricted.id, 'purchase_disabled')
    await expect(
      redeemPointsForToolQuota(await customerRequest(pointsRestricted, 'points-a3-redeem'), {
        customerId: pointsRestricted.id,
        pointsCost: 10,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:points-a3-redeem`,
        target: 'advanced_whois',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PURCHASE_DISABLED' })

    const loginRestricted = await createCustomer()
    await earnAvailable(
      loginRestricted,
      'quota-a3',
      20,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await redeemPointsForToolQuota(await customerRequest(loginRestricted, 'quota-a3-grant'), {
      customerId: loginRestricted.id,
      pointsCost: 10,
      quotaUnits: 1,
      redemptionKey: `${fixturePrefix}:quota-a3-grant`,
      target: 'advanced_whois',
    })
    await setRestriction(loginRestricted.id, 'login_disabled')
    await expect(
      consumeToolQuota(await customerRequest(loginRestricted, 'quota-a3-consume'), {
        customerId: loginRestricted.id,
        quotaUnits: 1,
        target: 'advanced_whois',
        usageKey: `${fixturePrefix}:quota-a3-consume`,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_LOGIN_DISABLED' })
  })

  it('applies A3 independently before a pending reward can become available', async () => {
    const customer = await createCustomer()
    const order = await createOrder(customer, 'confirm-a3')
    const reward = await earn(
      customer,
      order,
      'confirm-a3',
      25,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await setRestriction(customer.id, 'purchase_disabled')

    await expect(
      confirmPendingOrderReward(await systemRequest('confirm-a3-rejected'), reward.earningKey),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PURCHASE_DISABLED' })
    await expect(
      count('pointsLedger', customer.id, { entryType: { equals: 'available' } }),
    ).resolves.toBe(0)
    await expect(
      readPointsBalance(await systemRequest('confirm-a3-read'), customer.id),
    ).resolves.toMatchObject({
      available: 0n,
      pending: 25n,
    })
  })

  it('enforces system, customer-owner, and read ownership at every service callpoint', async () => {
    const owner = await createCustomer()
    const other = await createCustomer()
    const order = await createOrder(owner, 'actor-callpoints')
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    const earningKey = `${fixturePrefix}:actor-callpoints`
    await expect(
      earnPendingOrderReward(await customerRequest(owner, 'actor-earn'), {
        customerId: owner.id,
        earningKey,
        expiresAt,
        orderId: order.id,
        points: 20,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_SYSTEM_OPERATION_FORBIDDEN' })
    const pending = await earn(owner, order, 'actor-callpoints', 20, expiresAt)
    await expect(
      confirmPendingOrderReward(await customerRequest(owner, 'actor-confirm'), pending.earningKey),
    ).rejects.toMatchObject({ code: 'POINTS_SYSTEM_OPERATION_FORBIDDEN' })
    await confirmPendingOrderReward(await systemRequest('actor-confirm-system'), pending.earningKey)
    const redemption = await redeemPointsForToolQuota(
      await customerRequest(owner, 'actor-redemption-owner'),
      {
        customerId: owner.id,
        pointsCost: 10,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:actor-redemption-owner`,
        target: 'advanced_whois',
      },
    )
    await expect(
      redeemPointsForToolQuota(await customerRequest(other, 'actor-redemption-other'), {
        customerId: owner.id,
        pointsCost: 1,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:actor-redemption-other`,
        target: 'advanced_whois',
      }),
    ).rejects.toMatchObject({ code: 'POINTS_CUSTOMER_OPERATION_FORBIDDEN' })
    await expect(
      consumeToolQuota(await customerRequest(other, 'actor-quota-other'), {
        customerId: owner.id,
        quotaUnits: 1,
        target: 'advanced_whois',
        usageKey: `${fixturePrefix}:actor-quota-other`,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_CUSTOMER_OPERATION_FORBIDDEN' })
    await expect(
      readPointsBalance(await customerRequest(other, 'actor-balance-read'), owner.id),
    ).rejects.toMatchObject({ code: 'POINTS_CUSTOMER_OPERATION_FORBIDDEN' })
    await expect(
      readBatchRemainingPoints(await customerRequest(other, 'actor-batch-read'), {
        batchId: pending.batchId,
        customerId: owner.id,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_CUSTOMER_OPERATION_FORBIDDEN' })
    await expect(
      readToolQuotaBalance(await customerRequest(other, 'actor-quota-read'), {
        customerId: owner.id,
        target: 'advanced_whois',
      }),
    ).rejects.toMatchObject({ code: 'POINTS_CUSTOMER_OPERATION_FORBIDDEN' })
    await expect(
      runPointsExpiration(await customerRequest(owner, 'actor-expiration')),
    ).rejects.toMatchObject({ code: 'POINTS_SYSTEM_OPERATION_FORBIDDEN' })

    await payload.db.pool.query(
      `UPDATE orders SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
      [order.id],
    )
    await expect(
      reversePendingOrderReward(await customerRequest(owner, 'actor-reverse'), pending.earningKey),
    ).rejects.toMatchObject({ code: 'POINTS_SYSTEM_OPERATION_FORBIDDEN' })
    expect(redemption.quotaBalance).toBe(1n)
  })

  it('rejects invalid integer, key, expiry, and expiration-job boundaries before writes', async () => {
    const customer = await createCustomer()
    const order = await createOrder(customer, 'input-boundaries')
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const base = {
      customerId: customer.id,
      earningKey: `${fixturePrefix}:input-boundaries`,
      expiresAt: future,
      orderId: order.id,
      points: 10,
    }
    for (const input of [
      { ...base, points: 0 },
      { ...base, points: 1.5 },
      { ...base, points: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, points: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    ]) {
      await expect(
        earnPendingOrderReward(await systemRequest(`invalid-points-${randomUUID()}`), input),
      ).rejects.toMatchObject({ code: 'POINTS_AMOUNT_INVALID' })
    }
    await expect(
      earnPendingOrderReward(await systemRequest('invalid-key-blank'), {
        ...base,
        earningKey: '   ',
      }),
    ).rejects.toMatchObject({ code: 'POINTS_IDEMPOTENCY_KEY_INVALID' })
    await expect(
      earnPendingOrderReward(await systemRequest('invalid-key-long'), {
        ...base,
        earningKey: 'x'.repeat(121),
      }),
    ).rejects.toMatchObject({ code: 'POINTS_IDEMPOTENCY_KEY_INVALID' })
    await expect(
      earnPendingOrderReward(await systemRequest('invalid-expiry-format'), {
        ...base,
        expiresAt: 'invalid',
      }),
    ).rejects.toMatchObject({ code: 'POINTS_EXPIRATION_INVALID' })
    await expect(
      earnPendingOrderReward(await systemRequest('invalid-expiry-past'), {
        ...base,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'POINTS_EXPIRATION_INVALID' })
    await expect(
      runPointsExpiration(await systemRequest('invalid-cutoff'), { cutoff: new Date('invalid') }),
    ).rejects.toMatchObject({ code: 'POINTS_EXPIRATION_INVALID' })
    await expect(
      runPointsExpiration(await systemRequest('invalid-limit-zero'), { maxBatches: 0 }),
    ).rejects.toMatchObject({ code: 'POINTS_EXPIRATION_LIMIT_INVALID' })
    await expect(
      runPointsExpiration(await systemRequest('invalid-limit-fractional'), { maxBatches: 1.5 }),
    ).rejects.toMatchObject({ code: 'POINTS_EXPIRATION_LIMIT_INVALID' })
    await expect(
      runPointsExpiration(await systemRequest('invalid-limit-max'), { maxBatches: 501 }),
    ).rejects.toMatchObject({ code: 'POINTS_EXPIRATION_LIMIT_INVALID' })
    await expect(
      count('pointsBatches', customer.id, { earningKey: { contains: fixturePrefix } }),
    ).resolves.toBe(0)
  })

  it('records audit evidence at every points mutation callpoint', async () => {
    const customer = await createCustomer()
    const order = await createOrder(customer, 'audit-main')
    const main = await earn(
      customer,
      order,
      'audit-main',
      30,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await confirmPendingOrderReward(await systemRequest('audit-confirm'), main.earningKey)
    const redemption = await redeemPointsForToolQuota(
      await customerRequest(customer, 'audit-redeem'),
      {
        customerId: customer.id,
        pointsCost: 10,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:audit-redeem`,
        target: 'advanced_whois',
      },
    )
    await consumeToolQuota(await customerRequest(customer, 'audit-quota-consume'), {
      customerId: customer.id,
      quotaUnits: 1,
      target: 'advanced_whois',
      usageKey: `${fixturePrefix}:audit-quota-consume`,
    })
    const account = await payload.find({
      collection: 'pointsAccounts',
      limit: 1,
      overrideAccess: true,
      where: { customer: { equals: customer.id } },
    })
    const refundOrder = await createOrder(customer, 'audit-reverse')
    const reversed = await earn(
      customer,
      refundOrder,
      'audit-reverse',
      5,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await payload.db.pool.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [
      refundOrder.id,
    ])
    await reversePendingOrderReward(await systemRequest('audit-reverse'), reversed.earningKey)
    const expiresAt = new Date(Date.now() + 1_000)
    const expiring = await earnAvailable(customer, 'audit-expiry', 7, expiresAt.toISOString())
    await runPointsExpiration(await systemRequest('audit-expiry-job'), {
      cutoff: new Date(expiresAt.getTime() + 1_000),
    })

    const expected = [
      ['points.reward.pending', main.batchId],
      ['points.reward.available', main.batchId],
      ['points.redeemed', redemption.redemptionId],
      ['points.tool_quota.consumed', account.docs[0]!.id],
      ['points.reward.reversed', reversed.batchId],
      ['points.expired', expiring.batchId],
    ] as const
    for (const [action, targetId] of expected) {
      const evidence = await payload.count({
        collection: 'auditLogs',
        overrideAccess: true,
        where: {
          and: [{ action: { equals: action } }, { targetId: { equals: String(targetId) } }],
        },
      })
      expect(evidence.totalDocs).toBe(1)
    }
  })

  it('has no points-wallet conversion path in either direction', async () => {
    const customer = await createCustomer()
    const order = await createOrder(customer, 'wallet-isolation')
    const walletAccount = await createWalletAccount(
      await systemRequest('wallet-isolation-account'),
      customer.id,
    )
    await postWalletCredit(await systemRequest('wallet-isolation-credit'), {
      accountId: walletAccount.accountId,
      amountFen: 500,
      transactionKey: `${fixturePrefix}:wallet-isolation-credit`,
    })
    const pending = await earn(
      customer,
      order,
      'wallet-isolation',
      20,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await expect(
      redeemPointsForToolQuota(await customerRequest(customer, 'wallet-cannot-fund-points'), {
        customerId: customer.id,
        pointsCost: 21,
        quotaUnits: 1,
        redemptionKey: `${fixturePrefix}:wallet-cannot-fund-points`,
        target: 'advanced_whois',
      }),
    ).rejects.toMatchObject({ code: 'POINTS_BALANCE_INSUFFICIENT' })

    await confirmPendingOrderReward(
      await systemRequest('wallet-isolation-confirm'),
      pending.earningKey,
    )
    await redeemPointsForToolQuota(await customerRequest(customer, 'points-cannot-change-wallet'), {
      customerId: customer.id,
      pointsCost: 20,
      quotaUnits: 1,
      redemptionKey: `${fixturePrefix}:points-cannot-change-wallet`,
      target: 'advanced_whois',
    })
    await expect(
      readWalletBalance(await systemRequest('wallet-isolation-read'), walletAccount.accountId),
    ).resolves.toEqual({ availableBalance: 500n, heldBalance: 0n, postedBalance: 500n })
    await expect(
      readPointsBalance(await systemRequest('points-isolation-read'), customer.id),
    ).resolves.toMatchObject({
      available: 0n,
      consumed: 20n,
    })
  })

  it('does not change an order payable amount when points are redeemed', async () => {
    const customer = await createCustomer()
    const order = await createOrder(customer, 'order-amount-isolation', { amountMinor: 4_321 })
    const reward = await earn(
      customer,
      order,
      'order-amount-isolation',
      100,
      new Date(Date.now() + 86_400_000).toISOString(),
    )
    await confirmPendingOrderReward(
      await systemRequest('order-amount-isolation-confirm'),
      reward.earningKey,
    )
    await redeemPointsForToolQuota(await customerRequest(customer, 'order-amount-redemption'), {
      customerId: customer.id,
      pointsCost: 40,
      quotaUnits: 2,
      redemptionKey: `${fixturePrefix}:order-amount-redemption`,
      target: 'ai_domain_analysis',
    })

    const persisted = await payload.findByID({
      collection: 'orders',
      id: order.id,
      overrideAccess: true,
    })
    expect(persisted).toMatchObject({ amountMinor: 4_321, status: 'succeeded' })
    await expect(
      count('pointsRedemptions', customer.id, {
        redemptionKey: { equals: `${fixturePrefix}:order-amount-redemption` },
      }),
    ).resolves.toBe(1)
  })
})
