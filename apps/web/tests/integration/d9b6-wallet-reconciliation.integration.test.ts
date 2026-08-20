import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest, type Where } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  reconcileWalletLedger,
  reconcileWechatFunds,
  reconcileWestdigitalPrepaidBalance,
  recordThreeWayDifference,
  type WechatStatementEntry,
} from '@/services/commerce/reconciliation'
import {
  captureWalletHold,
  createWalletAccount,
  holdWalletBalance,
  postWalletCredit,
  readWalletBalance,
  recoverWalletBalance,
} from '@/services/wallet/ledger'

import { realnameTemplateFixture } from '../fixtures/realname'

const prefix = `d9b6-wallet-${randomUUID().slice(0, 8)}`
let payload: Payload
let customerIds: number[] = []

type CustomerIdentity = {
  collection: 'customers'
  id: number
  status: string
}

type TopUpFixture = {
  accountId: number
  amountFen: number
  customer: CustomerIdentity
  id: number
  orderNumber: string
  transactionId: string
  transactionKey: string
}

function period(): { end: string; start: string } {
  const center = Date.now()
  return {
    end: new Date(center + 3_600_000).toISOString(),
    start: new Date(center - 3_600_000).toISOString(),
  }
}

async function request(suffix: string): Promise<PayloadRequest> {
  return createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${prefix}-${suffix}` }) } },
    payload,
  )
}

async function customer(): Promise<CustomerIdentity> {
  const created = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: [],
      phone: `+86196${randomInt(10_000_000, 100_000_000)}`,
      phoneMasked: `***${randomInt(1_000, 10_000)}`,
      status: 'active',
    },
    overrideAccess: true,
  })
  customerIds.push(Number(created.id))
  return { collection: 'customers', id: Number(created.id), status: 'active' }
}

async function account(owner: CustomerIdentity, suffix: string): Promise<number> {
  return Number((await createWalletAccount(await request(`${suffix}-account`), owner.id)).accountId)
}

function topUpOrderNumber(): string {
  return `WT${randomUUID().replaceAll('-', '').slice(0, 30)}`
}

async function creditedTopUp(
  suffix: string,
  amountFen: number,
  owner?: { accountId: number; customer: CustomerIdentity },
): Promise<TopUpFixture> {
  const topUpCustomer = owner?.customer ?? (await customer())
  const accountId = owner?.accountId ?? (await account(topUpCustomer, suffix))
  const orderNumber = topUpOrderNumber()
  const transactionKey = `wallet-top-up:${orderNumber}:credit`
  const transactionId = `4200${randomUUID().replaceAll('-', '').slice(0, 28)}`
  await postWalletCredit(await request(`${suffix}-credit`), {
    accountId,
    amountFen,
    transactionKey,
  })
  const now = new Date().toISOString()
  const topUp = await payload.create({
    collection: 'walletTopUpOrders',
    data: {
      account: accountId,
      amountFen,
      creditedAt: now,
      currency: 'CNY',
      customer: topUpCustomer.id,
      fundingSource: 'wechat',
      ledgerTransactionKey: transactionKey,
      paymentChannel: 'native',
      paymentExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      providerConfirmedAt: now,
      providerPaidAt: now,
      status: 'credited',
      topUpOrderNumber: orderNumber,
      wechatTransactionId: transactionId,
    },
    overrideAccess: true,
  })
  return {
    accountId,
    amountFen,
    customer: topUpCustomer,
    id: Number(topUp.id),
    orderNumber,
    transactionId,
    transactionKey,
  }
}

async function commerceRelations(owner: CustomerIdentity, suffix: string, amountMinor: number) {
  const now = new Date().toISOString()
  const domainAscii = `${suffix}-${randomUUID()}.example`
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `${prefix}-${suffix}` }),
      customer: owner.id,
    },
    overrideAccess: true,
  })
  const quote = await payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: now,
      availabilityRequestId: `${prefix}-${suffix}-availability`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `${prefix}-${suffix}-quote`,
      currency: 'CNY',
      customer: owner.id,
      domainAscii,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: now,
      providerProductId: `${prefix}-${suffix}-product`,
      providerRequestId: `${prefix}-${suffix}-price`,
      quoteIntegrityHash: 'a'.repeat(64),
      quoteRef: randomUUID(),
      quotedAt: now,
      registrationPriceMinor: amountMinor,
      renewalPriceMinor: amountMinor,
      roundingMode: 'half_up_to_fen',
      ruleFixedAmountMinor: 0,
      ruleKey: `${prefix}-${suffix}-rule`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
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
  return { domainAscii, quoteId: quote.id, templateId: template.id }
}

async function balanceOrder(
  suffix: string,
  input: { holdAmountFen: number; orderAmountFen: number },
) {
  const owner = await customer()
  const accountId = await account(owner, suffix)
  await postWalletCredit(await request(`${suffix}-fund`), {
    accountId,
    amountFen: Math.max(input.holdAmountFen, input.orderAmountFen) + 1_000,
    transactionKey: `${prefix}:${suffix}:opening-credit`,
  })
  const holdKey = `order-balance-payment-fixture:${randomUUID()}`
  const relations = await commerceRelations(owner, suffix, input.orderAmountFen)
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor: input.orderAmountFen,
      balanceHoldTransactionKey: holdKey,
      currency: 'CNY',
      customer: owner.id,
      domainAscii: relations.domainAscii,
      orderNumber: `${prefix}-${suffix}-${randomUUID()}`,
      paidAt: new Date().toISOString(),
      paymentChannel: 'balance',
      quote: relations.quoteId,
      quoteSnapshot: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
      realnameTemplate: relations.templateId,
      status: 'succeeded',
    },
    overrideAccess: true,
  })
  await holdWalletBalance(await request(`${suffix}-hold`), {
    accountId,
    amountFen: input.holdAmountFen,
    transactionKey: holdKey,
  })
  await captureWalletHold(await request(`${suffix}-capture`), holdKey)
  return { accountId, customer: owner, holdKey, order }
}

async function regularWechatOrder(suffix: string, amountMinor: number) {
  const owner = await customer()
  const relations = await commerceRelations(owner, suffix, amountMinor)
  const merchantOrderNumber = `WM${randomUUID().replaceAll('-', '').slice(0, 30)}`
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor,
      currency: 'CNY',
      customer: owner.id,
      domainAscii: relations.domainAscii,
      merchantOrderNumber,
      orderNumber: `${prefix}-${suffix}-${randomUUID()}`,
      paidAt: new Date().toISOString(),
      paymentChannel: 'native',
      quote: relations.quoteId,
      quoteSnapshot: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
      realnameTemplate: relations.templateId,
      status: 'paid',
    },
    overrideAccess: true,
  })
  return {
    merchantOrderNumber,
    order,
    transactionId: `4200${randomUUID().replaceAll('-', '').slice(0, 28)}`,
  }
}

async function paymentRecovery(suffix: string, amountFen: number) {
  const topUp = await creditedTopUp(suffix, amountFen)
  const recoveryKey = `${prefix}:${suffix}:provider-refund`
  await recoverWalletBalance(await request(`${suffix}-recovery`), {
    accountId: topUp.accountId,
    allowNegativeBalance: true,
    amountFen,
    transactionKey: `wallet-top-up-payment-recovery:${topUp.id}`,
  })
  await payload.db.pool.query(
    `UPDATE wallet_top_up_orders
     SET
       status = 'refunded',
       payment_recovery_key = $2,
       payment_recovery_type = 'provider_refund',
       payment_recovered_at = NOW(),
       refunded_at = NOW(),
       updated_at = NOW()
     WHERE id = $1`,
    [topUp.id, recoveryKey],
  )
  return { recoveryKey, topUp }
}

function topUpPaymentEntry(
  topUp: TopUpFixture,
  amountMinor = topUp.amountFen,
): WechatStatementEntry {
  return {
    amountMinor,
    currency: 'CNY',
    merchantOrderNumber: topUp.orderNumber,
    type: 'payment',
    wechatTransactionId: topUp.transactionId,
  }
}

async function count(collection: 'auditLogs' | 'manualReviews' | 'reconciliations', where: Where) {
  return (await payload.count({ collection, overrideAccess: true, where })).totalDocs
}

async function walletSnapshot(accountId: number) {
  const balance = await readWalletBalance(await request(`snapshot-${randomUUID()}`), accountId)
  return {
    available: balance.availableBalance.toString(),
    held: balance.heldBalance.toString(),
    posted: balance.postedBalance.toString(),
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterEach(async () => {
  if (customerIds.length === 0) return
  await payload.db.pool.query(
    `DELETE FROM manual_reviews
     WHERE customer_id = ANY($1::int[])
       OR reconciliation_id IN (
         SELECT id FROM reconciliations WHERE trace_id LIKE $2
       )`,
    [customerIds, `${prefix}%`],
  )
  await payload.db.pool.query('DELETE FROM audit_logs WHERE trace_id LIKE $1', [`${prefix}%`])
  await payload.db.pool.query('DELETE FROM reconciliations WHERE trace_id LIKE $1', [`${prefix}%`])
  await payload.db.pool.query(
    'DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))',
    [customerIds],
  )
  await payload.db.pool.query('DELETE FROM orders WHERE customer_id = ANY($1::int[])', [
    customerIds,
  ])
  await payload.db.pool.query(
    'DELETE FROM wallet_top_up_orders WHERE customer_id = ANY($1::int[])',
    [customerIds],
  )
  await payload.db.pool.query('DELETE FROM wallet_entries WHERE customer_id = ANY($1::int[])', [
    customerIds,
  ])
  await payload.db.pool.query(
    'DELETE FROM wallet_transactions WHERE customer_id = ANY($1::int[])',
    [customerIds],
  )
  await payload.db.pool.query('DELETE FROM wallet_accounts WHERE customer_id = ANY($1::int[])', [
    customerIds,
  ])
  await payload.db.pool.query('DELETE FROM quotes WHERE customer_id = ANY($1::int[])', [
    customerIds,
  ])
  await payload.db.pool.query('DELETE FROM realname_templates WHERE customer_id = ANY($1::int[])', [
    customerIds,
  ])
  await payload.db.pool.query('DELETE FROM customers WHERE id = ANY($1::int[])', [customerIds])
  customerIds = []
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9-B-6 wallet ledger as the fourth reconciliation ledger', () => {
  it('records all four ledgers as matched without manufacturing differences for unmapped combinations', async () => {
    const runPeriod = period()
    const traceId = `${prefix}-four-ledgers-matched`
    const topUp = await creditedTopUp('four-ledgers-top-up', 10_000)
    await balanceOrder('four-ledgers-balance-order', {
      holdAmountFen: 6_000,
      orderAmountFen: 6_000,
    })
    const heldOwner = await customer()
    const heldAccountId = await account(heldOwner, 'four-ledgers-unmapped-hold')
    await postWalletCredit(await request('four-ledgers-unmapped-hold-credit'), {
      accountId: heldAccountId,
      amountFen: 2_000,
      transactionKey: `${prefix}:four-ledgers-unmapped-hold:credit`,
    })
    await holdWalletBalance(await request('four-ledgers-unmapped-hold'), {
      accountId: heldAccountId,
      amountFen: 500,
      transactionKey: `${prefix}:four-ledgers-unmapped-hold`,
    })
    const regular = await regularWechatOrder('four-ledgers-wechat-order', 8_000)
    const [wechat] = await reconcileWechatFunds(await request('four-ledgers-wechat'), {
      entries: [
        {
          amountMinor: 8_000,
          currency: 'CNY',
          merchantOrderNumber: regular.merchantOrderNumber,
          type: 'payment',
          wechatTransactionId: regular.transactionId,
        },
      ],
      period: runPeriod,
      traceId,
    })
    const westdigital = await reconcileWestdigitalPrepaidBalance(
      await request('four-ledgers-westdigital'),
      {
        period: runPeriod,
        statement: {
          closingAvailableMinor: 92_000,
          closingFrozenMinor: 0,
          creditsMinor: 0,
          debits: [{ amountMinor: 8_000, operationKey: `${prefix}-registration` }],
          openingAvailableMinor: 100_000,
          openingFrozenMinor: 0,
        },
        traceId,
      },
    )
    await recordThreeWayDifference(await request('four-ledgers-internal'), {
      orderNumber: String(regular.order.orderNumber),
      period: runPeriod,
      traceId,
      wechatReconciliationKey: wechat!.record.reconciliationKey,
      westdigitalReconciliationKey: westdigital.record.reconciliationKey,
    })
    await reconcileWalletLedger(await request('four-ledgers-wallet'), {
      loadWechatEntries: async () => [topUpPaymentEntry(topUp)],
      period: runPeriod,
      traceId,
    })

    const records = await payload.find({
      collection: 'reconciliations',
      overrideAccess: true,
      pagination: false,
      where: { traceId: { equals: traceId } },
    })
    expect(new Set(records.docs.map((record) => record.ledger))).toEqual(
      new Set(['internal_orders', 'wallet_balance', 'wechat_funds', 'westdigital_prepaid']),
    )
    expect(records.docs.filter((record) => record.status === 'difference')).toEqual([])
    expect(
      await count('reconciliations', {
        and: [{ ledger: { equals: 'wallet_balance' } }, { traceId: { equals: traceId } }],
      }),
    ).toBe(5)
    expect(
      records.docs
        .filter((record) => record.ledger === 'wallet_balance')
        .every((record) => (record.summary as Record<string, unknown>).correctionApplied === false),
    ).toBe(true)
    expect(
      await count('manualReviews', {
        and: [
          { reasonCode: { contains: 'wallet_reconciliation.' } },
          { customer: { in: customerIds } },
        ],
      }),
    ).toBe(0)
  })

  it('reports a top-up versus WeChat difference, creates one review, and never changes wallet funds', async () => {
    const topUp = await creditedTopUp('top-up-difference', 10_000)
    const runPeriod = period()
    const before = await walletSnapshot(topUp.accountId)
    const result = await reconcileWalletLedger(await request('top-up-difference'), {
      loadWechatEntries: async () => [topUpPaymentEntry(topUp, 9_900)],
      period: runPeriod,
      traceId: `${prefix}-top-up-difference`,
    })
    const walletRecord = result.results.find(
      ({ record }) => record.recordKey === `top-up:${topUp.orderNumber}`,
    )!.record
    expect(walletRecord).toMatchObject({
      differenceMinor: 100,
      kind: 'wallet',
      ledger: 'wallet_balance',
      status: 'difference',
      summary: { correctionApplied: false },
    })
    expect(await walletSnapshot(topUp.accountId)).toEqual(before)
    expect(
      await count('manualReviews', {
        and: [
          { reconciliation: { equals: walletRecord.id } },
          { walletTopUpOrder: { equals: topUp.id } },
          { reasonCode: { equals: 'wallet_reconciliation.top_up_wechat_difference' } },
        ],
      }),
    ).toBe(1)
    expect(
      await count('auditLogs', {
        and: [
          { action: { equals: 'wallet.reconciliation.difference_recorded' } },
          { targetId: { equals: String(walletRecord.id) } },
          { traceId: { equals: `${prefix}-top-up-difference` } },
        ],
      }),
    ).toBe(1)
  })

  it('reports a balance payment versus internal-order difference without changing the order or wallet', async () => {
    const fixture = await balanceOrder('balance-order-difference', {
      holdAmountFen: 10_000,
      orderAmountFen: 9_900,
    })
    const beforeBalance = await walletSnapshot(fixture.accountId)
    const beforeOrder = await payload.findByID({
      collection: 'orders',
      id: fixture.order.id,
      overrideAccess: true,
    })
    const result = await reconcileWalletLedger(await request('balance-order-difference'), {
      loadWechatEntries: async () => [],
      period: period(),
      traceId: `${prefix}-balance-order-difference`,
    })
    const walletRecord = result.results.find(
      ({ record }) => record.recordKey === `balance-payment:${fixture.order.orderNumber}`,
    )!.record
    expect(walletRecord).toMatchObject({ differenceMinor: 100, status: 'difference' })
    expect(await walletSnapshot(fixture.accountId)).toEqual(beforeBalance)
    expect(
      await payload.findByID({ collection: 'orders', id: fixture.order.id, overrideAccess: true }),
    ).toMatchObject({ amountMinor: beforeOrder.amountMinor, status: beforeOrder.status })
    expect(
      await count('manualReviews', {
        and: [
          { reconciliation: { equals: walletRecord.id } },
          { order: { equals: fixture.order.id } },
          {
            reasonCode: {
              equals: 'wallet_reconciliation.balance_payment_order_difference',
            },
          },
        ],
      }),
    ).toBe(1)
  })

  it('reports a payment recovery versus WeChat reversal difference without changing recovery facts', async () => {
    const fixture = await paymentRecovery('recovery-difference', 10_000)
    const beforeBalance = await walletSnapshot(fixture.topUp.accountId)
    const beforeTopUp = await payload.findByID({
      collection: 'walletTopUpOrders',
      id: fixture.topUp.id,
      overrideAccess: true,
    })
    const result = await reconcileWalletLedger(await request('recovery-difference'), {
      loadWechatEntries: async () => [
        topUpPaymentEntry(fixture.topUp),
        {
          amountMinor: 9_900,
          currency: 'CNY',
          recoveryKey: fixture.recoveryKey,
          topUpOrderNumber: fixture.topUp.orderNumber,
          type: 'wallet_recovery',
        },
      ],
      period: period(),
      traceId: `${prefix}-recovery-difference`,
    })
    const walletRecord = result.results.find(
      ({ record }) => record.recordKey === `payment-recovery:${fixture.recoveryKey}`,
    )!.record
    expect(walletRecord).toMatchObject({ differenceMinor: 100, status: 'difference' })
    expect(await walletSnapshot(fixture.topUp.accountId)).toEqual(beforeBalance)
    expect(
      await payload.findByID({
        collection: 'walletTopUpOrders',
        id: fixture.topUp.id,
        overrideAccess: true,
      }),
    ).toMatchObject({
      paymentRecoveryKey: beforeTopUp.paymentRecoveryKey,
      status: beforeTopUp.status,
    })
    expect(
      await count('manualReviews', {
        and: [
          { reconciliation: { equals: walletRecord.id } },
          { walletTopUpOrder: { equals: fixture.topUp.id } },
          {
            reasonCode: {
              equals: 'wallet_reconciliation.payment_recovery_wechat_difference',
            },
          },
        ],
      }),
    ).toBe(1)
  })

  it('derives balances from walletEntries and reports a wallet_accounts cache mismatch without correcting it', async () => {
    const owner = await customer()
    const accountId = await account(owner, 'cache-source')
    await postWalletCredit(await request('cache-source-credit'), {
      accountId,
      amountFen: 10_000,
      transactionKey: `${prefix}:cache-source:credit`,
    })
    await payload.db.pool.query(
      `UPDATE wallet_accounts
       SET posted_balance_cache_fen = 9_900, held_balance_cache_fen = 50
       WHERE id = $1`,
      [accountId],
    )
    const result = await reconcileWalletLedger(await request('cache-source'), {
      loadWechatEntries: async () => [],
      period: period(),
      traceId: `${prefix}-cache-source`,
    })
    const walletRecord = result.results.find(
      ({ record }) => record.recordKey === `balance-cache:${accountId}`,
    )!.record
    expect(walletRecord).toMatchObject({
      differenceMinor: 150,
      status: 'difference',
      summary: {
        heldBalanceCacheFen: '50',
        heldBalanceFromEntriesFen: '0',
        postedBalanceCacheFen: '9900',
        postedBalanceFromEntriesFen: '10000',
        source: 'wallet_entries_aggregate',
      },
    })
    const cache = await payload.db.pool.query<{
      held_balance_cache_fen: string
      posted_balance_cache_fen: string
    }>(
      `SELECT posted_balance_cache_fen, held_balance_cache_fen
       FROM wallet_accounts
       WHERE id = $1`,
      [accountId],
    )
    expect(cache.rows[0]).toEqual({
      held_balance_cache_fen: '50',
      posted_balance_cache_fen: '9900',
    })
    expect(
      await count('manualReviews', {
        and: [
          { reconciliation: { equals: walletRecord.id } },
          { walletAccount: { equals: accountId } },
          { reasonCode: { equals: 'wallet_reconciliation.balance_cache_difference' } },
        ],
      }),
    ).toBe(1)
  })

  it('fails closed for independently de-correlated WeChat identity, payment channel, and recovery-record facts', async () => {
    const runPeriod = period()
    const identityTopUp = await creditedTopUp('identity-mismatch', 4_000)
    const payment = await balanceOrder('channel-mismatch', {
      holdAmountFen: 3_000,
      orderAmountFen: 3_000,
    })
    await payload.db.pool.query(`UPDATE orders SET payment_channel = 'native' WHERE id = $1`, [
      payment.order.id,
    ])
    const recoveryTopUp = await creditedTopUp('missing-recovery-record', 2_000)
    const recoveryKey = `${prefix}:missing-recovery-record`
    await recoverWalletBalance(await request('missing-recovery-entry'), {
      accountId: recoveryTopUp.accountId,
      allowNegativeBalance: true,
      amountFen: 2_000,
      transactionKey: `wallet-top-up-payment-recovery:${recoveryTopUp.id}`,
    })

    const result = await reconcileWalletLedger(await request('de-correlated-facts'), {
      loadWechatEntries: async () => [
        {
          ...topUpPaymentEntry(identityTopUp),
          wechatTransactionId: `4200${randomUUID().replaceAll('-', '').slice(0, 28)}`,
        },
        topUpPaymentEntry(recoveryTopUp),
        {
          amountMinor: 2_000,
          currency: 'CNY',
          recoveryKey,
          topUpOrderNumber: recoveryTopUp.orderNumber,
          type: 'wallet_recovery',
        },
      ],
      period: runPeriod,
      traceId: `${prefix}-de-correlated-facts`,
    })
    const byRecordKey = new Map(result.results.map(({ record }) => [record.recordKey, record]))
    expect(byRecordKey.get(`top-up:${identityTopUp.orderNumber}`)).toMatchObject({
      differenceMinor: 1,
      status: 'difference',
    })
    expect(byRecordKey.get(`balance-payment:${payment.order.orderNumber}`)).toMatchObject({
      differenceMinor: 1,
      status: 'difference',
    })
    expect(
      result.results.find(
        ({ record }) =>
          (record.summary as Record<string, unknown>).mapping ===
          'wallet_payment_recovery_to_wechat_funds_reverse',
      )?.record,
    ).toMatchObject({ differenceMinor: 2_000, status: 'difference' })
  })

  it('replays the same period and business difference with one reconciliation and one review', async () => {
    const topUp = await creditedTopUp('idempotent', 10_000)
    const runPeriod = period()
    const input = {
      loadWechatEntries: async () => [topUpPaymentEntry(topUp, 9_900)],
      period: runPeriod,
      traceId: `${prefix}-idempotent`,
    }
    await reconcileWalletLedger(await request('idempotent-first'), input)
    await reconcileWalletLedger(await request('idempotent-second'), {
      ...input,
      traceId: `${prefix}-idempotent-replay-trace-must-not-change-key`,
    })
    const scopedWhere: Where = {
      and: [
        { ledger: { equals: 'wallet_balance' } },
        { recordKey: { equals: `top-up:${topUp.orderNumber}` } },
        { periodStart: { equals: runPeriod.start } },
        { periodEnd: { equals: runPeriod.end } },
      ],
    }
    expect(await count('reconciliations', scopedWhere)).toBe(1)
    const records = await payload.find({
      collection: 'reconciliations',
      limit: 2,
      overrideAccess: true,
      where: scopedWhere,
    })
    expect(
      await count('manualReviews', {
        and: [
          { reconciliation: { equals: records.docs[0]!.id } },
          { reasonCode: { equals: 'wallet_reconciliation.top_up_wechat_difference' } },
        ],
      }),
    ).toBe(1)
  })

  it('binds reconciliation idempotency independently to both period boundaries', async () => {
    const topUp = await creditedTopUp('period-key', 7_000)
    const first = period()
    const second = { ...first, end: new Date(Date.parse(first.end) + 1).toISOString() }
    const third = { ...first, start: new Date(Date.parse(first.start) - 1).toISOString() }
    for (const [index, runPeriod] of [first, second, third].entries()) {
      await reconcileWalletLedger(await request(`period-key-${index}`), {
        loadWechatEntries: async () => [topUpPaymentEntry(topUp)],
        period: runPeriod,
        traceId: `${prefix}-period-key-${index}`,
      })
    }
    expect(
      await count('reconciliations', {
        and: [
          { ledger: { equals: 'wallet_balance' } },
          { recordKey: { equals: `top-up:${topUp.orderNumber}` } },
          { status: { equals: 'matched' } },
        ],
      }),
    ).toBe(3)
  })

  it('rejects an invalid period and a non-array upstream result before reconciliation writes', async () => {
    const topUp = await creditedTopUp('invalid-inputs', 2_000)
    const invalidPeriod = { end: new Date().toISOString(), start: new Date().toISOString() }
    const invalidPeriodSource = vi.fn(async () => [topUpPaymentEntry(topUp)])
    await expect(
      reconcileWalletLedger(await request('invalid-period'), {
        loadWechatEntries: invalidPeriodSource,
        period: invalidPeriod,
        traceId: `${prefix}-invalid-period`,
      }),
    ).rejects.toMatchObject({ code: 'RECONCILIATION_PERIOD_INVALID' })
    expect(invalidPeriodSource).not.toHaveBeenCalled()
    await expect(
      reconcileWalletLedger(await request('invalid-source'), {
        loadWechatEntries: async () => ({}) as never,
        period: period(),
        traceId: `${prefix}-invalid-source`,
      }),
    ).rejects.toMatchObject({ code: 'RECONCILIATION_SOURCE_INVALID' })
    expect(
      await count('reconciliations', {
        and: [
          { ledger: { equals: 'wallet_balance' } },
          { traceId: { in: [`${prefix}-invalid-period`, `${prefix}-invalid-source`] } },
        ],
      }),
    ).toBe(0)
  })

  it('records and retries an upstream read failure while leaving wallet and order state unchanged', async () => {
    const fixture = await balanceOrder('upstream-failure', {
      holdAmountFen: 5_000,
      orderAmountFen: 5_000,
    })
    const beforeBalance = await walletSnapshot(fixture.accountId)
    const beforeOrder = await payload.findByID({
      collection: 'orders',
      id: fixture.order.id,
      overrideAccess: true,
    })
    const loadWechatEntries = vi
      .fn<() => Promise<WechatStatementEntry[]>>()
      .mockRejectedValue(new Error('fixture upstream unavailable'))
    await expect(
      reconcileWalletLedger(await request('upstream-failure'), {
        loadWechatEntries,
        period: period(),
        traceId: `${prefix}-upstream-failure`,
      }),
    ).rejects.toThrow('fixture upstream unavailable')
    expect(loadWechatEntries).toHaveBeenCalledTimes(2)
    expect(await walletSnapshot(fixture.accountId)).toEqual(beforeBalance)
    expect(
      await payload.findByID({ collection: 'orders', id: fixture.order.id, overrideAccess: true }),
    ).toMatchObject({ amountMinor: beforeOrder.amountMinor, status: beforeOrder.status })
    expect(
      await count('auditLogs', {
        and: [
          { action: { equals: 'wallet.reconciliation.failed' } },
          { traceId: { equals: `${prefix}-upstream-failure` } },
          { targetId: { equals: `${prefix}-upstream-failure` } },
        ],
      }),
    ).toBe(1)
    expect(
      await count('reconciliations', {
        and: [
          { traceId: { equals: `${prefix}-upstream-failure` } },
          { ledger: { equals: 'wallet_balance' } },
        ],
      }),
    ).toBe(0)
  })

  it('serializes concurrent runs for one period into one difference and one manual review', async () => {
    const topUp = await creditedTopUp('concurrent', 10_000)
    const runPeriod = period()
    const input = {
      loadWechatEntries: async () => [topUpPaymentEntry(topUp, 9_900)],
      period: runPeriod,
      traceId: `${prefix}-concurrent`,
    }
    await Promise.all(
      Array.from({ length: 6 }, async (_, index) =>
        reconcileWalletLedger(await request(`concurrent-${index}`), input),
      ),
    )
    const scopedWhere: Where = {
      and: [
        { ledger: { equals: 'wallet_balance' } },
        { recordKey: { equals: `top-up:${topUp.orderNumber}` } },
        { periodStart: { equals: runPeriod.start } },
        { periodEnd: { equals: runPeriod.end } },
        { status: { equals: 'difference' } },
      ],
    }
    expect(await count('reconciliations', scopedWhere)).toBe(1)
    const records = await payload.find({
      collection: 'reconciliations',
      limit: 2,
      overrideAccess: true,
      where: scopedWhere,
    })
    expect(
      await count('manualReviews', {
        and: [
          { reconciliation: { equals: records.docs[0]!.id } },
          { reasonCode: { equals: 'wallet_reconciliation.top_up_wechat_difference' } },
          { walletTopUpOrder: { equals: topUp.id } },
        ],
      }),
    ).toBe(1)
  })
})
