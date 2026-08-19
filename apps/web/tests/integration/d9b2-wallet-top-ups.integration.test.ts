import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest, type Where } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mockFailure, mockSuccess } from '@/providers/mock'
import type { PaymentOrder, PaymentProvider, VerifiedPaymentNotification } from '@/providers/types'
import { createWechatPayFixture, type WechatPayFixture } from '@/providers/wechatpay'
import { processWechatPaymentNotification } from '@/services/commerce/payments'
import { captureWalletHold, holdWalletBalance, readWalletBalance } from '@/services/wallet/ledger'
import {
  createWalletTopUpOrder,
  createWalletTopUpPayment,
  markWalletTopUpOriginalRefunded,
  processWalletTopUpPaymentNotification,
  queryAndConfirmWalletTopUpPayment,
} from '@/services/wallet/top-ups'

const prefix = `d9b2-top-up-${randomUUID()}`
const now = new Date('2026-08-18T03:30:00.000Z')
let payload: Payload
const customerIds: number[] = []

type StartedTopUp = {
  accountId: number
  amountFen: number
  customer: {
    collection: 'customers'
    id: number
    status: string
  }
  orderId: number
  orderNumber: string
  req: PayloadRequest
}

function phone(): string {
  return `+86196${randomInt(10_000_000, 100_000_000)}`
}

function wechatTransactionId(): string {
  return randomUUID()
    .replaceAll('-', '')
    .replace(/[a-f]/gu, (value) => String(value.charCodeAt(0) - 87))
    .slice(0, 32)
}

async function request(suffix: string, customer?: unknown): Promise<PayloadRequest> {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${prefix}-${suffix}` }) } },
    payload,
  )
  if (customer) req.user = customer as never
  return req
}

async function createCustomer(suffix: string) {
  const customerPhone = phone()
  const customer = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: [],
      phone: customerPhone,
      phoneMasked: `***${suffix}`,
      status: 'active',
    },
    overrideAccess: true,
  })
  customerIds.push(customer.id)
  return { ...customer, collection: 'customers' as const, id: Number(customer.id) }
}

async function startedTopUp(
  suffix: string,
  fixture: WechatPayFixture,
  amountFen = 10_000,
): Promise<StartedTopUp> {
  const created = await createdTopUp(suffix, amountFen)
  await createWalletTopUpPayment(
    created.req,
    created.orderNumber,
    { channel: 'native' },
    {
      customer: created.customer,
      now: () => now,
      provider: fixture.provider,
      traceId: `${prefix}-${suffix}-payment`,
    },
  )
  return created
}

async function createdTopUp(suffix: string, amountFen = 10_000): Promise<StartedTopUp> {
  const customer = await createCustomer(suffix)
  const req = await request(`${suffix}-customer`, customer)
  const result = await createWalletTopUpOrder(
    req,
    { amountFen, fundingSource: 'wechat' },
    { customer },
  )
  const orderNumber = result.data.topUpOrderNumber
  const order = await payload.find({
    collection: 'walletTopUpOrders',
    limit: 1,
    overrideAccess: true,
    where: { topUpOrderNumber: { equals: orderNumber } },
  })
  const doc = order.docs[0]
  if (!doc) throw new Error('Top-up fixture missing')
  return {
    accountId: Number(typeof doc.account === 'object' ? doc.account.id : doc.account),
    amountFen,
    customer,
    orderId: doc.id,
    orderNumber,
    req,
  }
}

function setPaid(
  fixture: WechatPayFixture,
  topUp: StartedTopUp,
  input: { amountFen?: number; transactionId?: string } = {},
): { paidAt: string; transactionId: string } {
  const paidAt = new Date(now.getTime() + 60_000).toISOString()
  const transactionId = input.transactionId ?? wechatTransactionId()
  fixture.setOrder({
    amountMinor: input.amountFen ?? topUp.amountFen,
    merchantOrderNumber: topUp.orderNumber,
    paidAt,
    state: 'paid',
    transactionId,
  })
  return { paidAt, transactionId }
}

async function topUpStatus(orderId: number): Promise<string> {
  const order = await payload.findByID({
    collection: 'walletTopUpOrders',
    id: orderId,
    overrideAccess: true,
  })
  return order.status
}

async function countEntries(accountId: number, where: Where = {}): Promise<number> {
  return (
    await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: { and: [{ account: { equals: accountId } }, where] },
    })
  ).totalDocs
}

async function countTopUps(where: Where): Promise<number> {
  return (
    await payload.count({
      collection: 'walletTopUpOrders',
      overrideAccess: true,
      where,
    })
  ).totalDocs
}

async function restrictPurchases(customerId: number): Promise<void> {
  await payload.db.pool.query(
    `UPDATE customers
     SET status = 'restricted',
         capability_restrictions = '["purchase_disabled"]'::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [customerId],
  )
}

async function startIdentityRiskCooldown(customerId: number): Promise<void> {
  await payload.db.pool.query(
    `UPDATE customers
     SET identity_risk_cooldown_started_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [customerId],
  )
}

function unusedTopUpOrderNumber(): string {
  return `WT${randomUUID().replaceAll('-', '').slice(0, 30)}`
}

function queryProvider(order: PaymentOrder): PaymentProvider {
  return {
    queryOrder: async () => mockSuccess(order, `${prefix}-custom-query`),
  } as unknown as PaymentProvider
}

type QueryOrderInput = Parameters<PaymentProvider['queryOrder']>[0]

function trackedQueryProvider(provider: Pick<PaymentProvider, 'queryOrder'>): {
  calls: QueryOrderInput[]
  provider: PaymentProvider
} {
  const calls: QueryOrderInput[] = []
  return {
    calls,
    provider: {
      queryOrder: async (input: QueryOrderInput) => {
        calls.push(input)
        return provider.queryOrder(input)
      },
    } as unknown as PaymentProvider,
  }
}

function verifiedPaidTopUpNotification(
  topUp: StartedTopUp,
): Extract<VerifiedPaymentNotification, { verified: true }> {
  return {
    amountMinor: topUp.amountFen,
    currency: 'CNY',
    merchantOrderNumber: topUp.orderNumber,
    notificationId: `EV${randomUUID().replaceAll('-', '')}`,
    paidAt: new Date(now.getTime() + 60_000).toISOString(),
    transactionId: wechatTransactionId(),
    verified: true,
  }
}

async function expectNotificationObservation(
  topUp: StartedTopUp,
  expected: { outcome: string; providerState: string },
): Promise<void> {
  expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
  expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
  expect(
    (
      await payload.count({
        collection: 'manualReviews',
        overrideAccess: true,
        where: { walletTopUpOrder: { equals: topUp.orderId } },
      })
    ).totalDocs,
  ).toBe(0)
  const observations = await payload.find({
    collection: 'auditLogs',
    limit: 1,
    overrideAccess: true,
    where: {
      and: [
        { action: { equals: 'wallet.top_up.payment_observed' } },
        { targetId: { equals: String(topUp.orderId) } },
      ],
    },
  })
  expect(observations.totalDocs).toBe(1)
  expect(observations.docs[0]?.metadata).toMatchObject({
    ...expected,
    source: 'notification',
  })
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  if (customerIds.length > 0) {
    await payload.db.pool.query(
      `DELETE FROM payment_notification_archives
       WHERE wallet_top_up_order_id IN (
         SELECT id FROM wallet_top_up_orders WHERE customer_id = ANY($1::int[])
       )`,
      [customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM manual_reviews
       WHERE wallet_top_up_order_id IN (
         SELECT id FROM wallet_top_up_orders WHERE customer_id = ANY($1::int[])
       )`,
      [customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM audit_logs
       WHERE target_type = 'wallet-top-up-order'
         AND trace_id LIKE $1`,
      [`${prefix}-%`],
    )
    await payload.db.pool.query(
      `DELETE FROM wallet_entries
       WHERE account_id IN (
         SELECT id FROM wallet_accounts WHERE customer_id = ANY($1::int[])
       )`,
      [customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM wallet_transactions
       WHERE account_id IN (
         SELECT id FROM wallet_accounts WHERE customer_id = ANY($1::int[])
       )`,
      [customerIds],
    )
    await payload.db.pool.query(
      'DELETE FROM wallet_top_up_orders WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query('DELETE FROM wallet_accounts WHERE customer_id = ANY($1::int[])', [
      customerIds,
    ])
    await payload.db.pool.query('DELETE FROM customers WHERE id = ANY($1::int[])', [customerIds])
  }
  await payload.db.destroy?.()
})

describe('D9-B-2 wallet top-up credits', () => {
  it('does not credit from a payment notification alone when the active query is not paid', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('notification-only', fixture)
    const notification = fixture.notification({
      amountMinor: topUp.amountFen,
      merchantOrderNumber: topUp.orderNumber,
      notificationId: `EV${randomUUID().replaceAll('-', '')}`,
      paidAt: new Date(now.getTime() + 60_000).toISOString(),
      transactionId: wechatTransactionId(),
    })

    await processWechatPaymentNotification(
      await request('notification-only-provider'),
      { ...notification, traceId: `${prefix}-notification-only-provider` },
      fixture.provider,
    )

    expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
    expect(
      (
        await payload.count({
          collection: 'paymentNotificationArchives',
          overrideAccess: true,
          where: { walletTopUpOrder: { equals: topUp.orderId } },
        })
      ).totalDocs,
    ).toBe(1)
    const observations = await payload.find({
      collection: 'auditLogs',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.top_up.payment_observed' } },
          { targetId: { equals: String(topUp.orderId) } },
        ],
      },
    })
    expect(observations.totalDocs).toBe(1)
    expect(observations.docs[0]?.metadata).toMatchObject({
      outcome: 'not_paid',
    })
  })

  it('queries WeChat once and rejects a correct paid notification when the active query is not paid', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('notification-query-not-paid', fixture)
    const notification = verifiedPaidTopUpNotification(topUp)
    const query = trackedQueryProvider(
      queryProvider({
        amountMinor: topUp.amountFen,
        currency: 'CNY',
        merchantOrderNumber: topUp.orderNumber,
        paidAt: notification.paidAt,
        state: 'not_paid',
        transactionId: notification.transactionId,
      }),
    )
    const traceId = `${prefix}-notification-query-not-paid`

    await processWalletTopUpPaymentNotification(topUp.req, notification, query.provider, traceId)

    expect(notification.amountMinor).toBe(topUp.amountFen)
    expect(query.calls).toEqual([{ merchantOrderNumber: topUp.orderNumber, traceId }])
    await expectNotificationObservation(topUp, {
      outcome: 'not_paid',
      providerState: 'not_paid',
    })
  })

  it('queries WeChat once and rejects a correct paid notification when the active query is unknown', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('notification-query-unknown', fixture)
    const notification = verifiedPaidTopUpNotification(topUp)
    const query = trackedQueryProvider(
      queryProvider({
        amountMinor: topUp.amountFen,
        currency: 'CNY',
        merchantOrderNumber: topUp.orderNumber,
        paidAt: notification.paidAt,
        state: 'unknown',
        transactionId: notification.transactionId,
      }),
    )
    const traceId = `${prefix}-notification-query-unknown`

    await processWalletTopUpPaymentNotification(topUp.req, notification, query.provider, traceId)

    expect(notification.amountMinor).toBe(topUp.amountFen)
    expect(query.calls).toEqual([{ merchantOrderNumber: topUp.orderNumber, traceId }])
    await expectNotificationObservation(topUp, {
      outcome: 'status_unknown',
      providerState: 'unknown',
    })
  })

  it('queries WeChat once and rejects a correct paid notification when the active query fails', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('notification-query-failure', fixture)
    const notification = verifiedPaidTopUpNotification(topUp)
    const query = trackedQueryProvider({
      queryOrder: async () =>
        mockFailure('WECHATPAY_QUERY_TIMEOUT', { retryable: true, statusKnown: false }),
    })
    const traceId = `${prefix}-notification-query-failure`

    await processWalletTopUpPaymentNotification(topUp.req, notification, query.provider, traceId)

    expect(notification.amountMinor).toBe(topUp.amountFen)
    expect(query.calls).toEqual([{ merchantOrderNumber: topUp.orderNumber, traceId }])
    await expectNotificationObservation(topUp, {
      outcome: 'status_unknown',
      providerState: 'unavailable',
    })
  })

  it('keeps the current state and balance when the active query state is unknown', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('query-unknown', fixture)
    const provider = queryProvider({
      amountMinor: topUp.amountFen,
      merchantOrderNumber: topUp.orderNumber,
      state: 'unknown',
    })

    const result = await queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
      customer: topUp.customer,
      provider,
      traceId: `${prefix}-query-unknown`,
    })

    expect(result.data.status).toBe('payment_pending')
    expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 2,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.top_up.payment_observed' } },
          { targetId: { equals: String(topUp.orderId) } },
          { traceId: { equals: `${prefix}-query-unknown-customer` } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(1)
    expect(audits.docs[0]?.metadata).toMatchObject({
      outcome: 'status_unknown',
      providerState: 'unknown',
      source: 'query',
    })
  })

  it('keeps the current state and records unavailable evidence when active query fails', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('query-failure', fixture)
    const provider = {
      queryOrder: async () =>
        mockFailure('WECHATPAY_QUERY_TIMEOUT', { retryable: true, statusKnown: false }),
    } as unknown as PaymentProvider

    await expect(
      queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
        customer: topUp.customer,
        provider,
        traceId: `${prefix}-query-failure`,
      }),
    ).resolves.toMatchObject({ data: { status: 'payment_pending' } })
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.top_up.payment_observed' } },
          { targetId: { equals: String(topUp.orderId) } },
          { traceId: { equals: `${prefix}-query-failure-customer` } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(1)
    expect(audits.docs[0]?.metadata).toMatchObject({
      outcome: 'status_unknown',
      providerState: 'unavailable',
      source: 'query',
    })
  })

  it('rejects a not-paid query even when it carries success-like fields', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('query-not-paid', fixture)
    const provider = queryProvider({
      amountMinor: topUp.amountFen,
      currency: 'CNY',
      merchantOrderNumber: topUp.orderNumber,
      paidAt: new Date(now.getTime() + 60_000).toISOString(),
      state: 'not_paid',
      transactionId: wechatTransactionId(),
    })

    await expect(
      queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
        customer: topUp.customer,
        provider,
        traceId: `${prefix}-query-not-paid`,
      }),
    ).resolves.toMatchObject({ data: { status: 'payment_pending' } })
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
  })

  it('rejects an active-query amount mismatch and creates one scoped manual review', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('amount-mismatch', fixture)
    setPaid(fixture, topUp, { amountFen: topUp.amountFen + 1 })

    const result = await queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
      customer: topUp.customer,
      provider: fixture.provider,
      traceId: `${prefix}-amount-mismatch`,
    })

    expect(result.data.status).toBe('payment_pending')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
    expect(
      (
        await payload.count({
          collection: 'manualReviews',
          overrideAccess: true,
          where: {
            and: [
              { walletTopUpOrder: { equals: topUp.orderId } },
              { reasonCode: { equals: 'wallet_top_up.payment_amount_mismatch' } },
              { status: { equals: 'open' } },
            ],
          },
        })
      ).totalDocs,
    ).toBe(1)
    const observations = await payload.find({
      collection: 'auditLogs',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.top_up.payment_observed' } },
          { targetId: { equals: String(topUp.orderId) } },
        ],
      },
    })
    expect(observations.totalDocs).toBe(1)
    expect(observations.docs[0]?.metadata).toMatchObject({
      outcome: 'wallet_top_up.payment_amount_mismatch',
    })
  })

  it('does not credit when a verified notification disagrees with the active paid query', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('notification-mismatch', fixture)
    const paid = setPaid(fixture, topUp)
    const notification = fixture.notification({
      amountMinor: topUp.amountFen + 1,
      merchantOrderNumber: topUp.orderNumber,
      notificationId: `EV${randomUUID().replaceAll('-', '')}`,
      paidAt: paid.paidAt,
      transactionId: paid.transactionId,
    })

    const query = trackedQueryProvider(fixture.provider)
    await processWechatPaymentNotification(
      await request('notification-mismatch-provider'),
      { ...notification, traceId: `${prefix}-notification-mismatch-provider` },
      {
        queryOrder: query.provider.queryOrder.bind(query.provider),
        verifyNotification: fixture.provider.verifyNotification.bind(fixture.provider),
      } as PaymentProvider,
    )

    expect(query.calls).toHaveLength(1)
    expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
    expect(
      (
        await payload.count({
          collection: 'manualReviews',
          overrideAccess: true,
          where: {
            and: [
              { walletTopUpOrder: { equals: topUp.orderId } },
              { reasonCode: { equals: 'wallet_top_up.payment_identifier_mismatch' } },
              { status: { equals: 'open' } },
            ],
          },
        })
      ).totalDocs,
    ).toBe(1)
  })

  it.each([
    ['transaction id', { transactionId: undefined }],
    ['paid timestamp', { paidAt: undefined }],
    ['CNY currency', { currency: 'USD' }],
    ['amount present', { amountMinor: undefined }],
    ['safe integer amount', { amountMinor: 10_000.5 }],
    ['positive amount', { amountMinor: 0 }],
  ])('requires every paid-query evidence dimension: %s', async (_dimension, override) => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp(
      `paid-dimension-${String(_dimension).replaceAll(' ', '-')}`,
      fixture,
    )
    const paidAt = new Date(now.getTime() + 60_000).toISOString()
    const provider = queryProvider({
      amountMinor: topUp.amountFen,
      currency: 'CNY',
      merchantOrderNumber: topUp.orderNumber,
      paidAt,
      state: 'paid',
      transactionId: wechatTransactionId(),
      ...override,
    } as PaymentOrder)

    const result = await queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
      customer: topUp.customer,
      provider,
      traceId: `${prefix}-paid-dimension-${String(_dimension)}`,
    })

    expect(result.data.status).toBe('payment_pending')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
    const observations = await payload.find({
      collection: 'auditLogs',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.top_up.payment_observed' } },
          { targetId: { equals: String(topUp.orderId) } },
        ],
      },
    })
    expect(observations.totalDocs).toBe(1)
    expect(observations.docs[0]?.metadata).toMatchObject({ outcome: 'not_paid' })
  })

  it('requires the active-query merchant order number to match the top-up', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('merchant-mismatch', fixture)
    const provider = queryProvider({
      amountMinor: topUp.amountFen,
      currency: 'CNY',
      merchantOrderNumber: unusedTopUpOrderNumber(),
      paidAt: new Date(now.getTime() + 60_000).toISOString(),
      state: 'paid',
      transactionId: wechatTransactionId(),
    })

    await queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
      customer: topUp.customer,
      provider,
      traceId: `${prefix}-merchant-mismatch`,
    })

    expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
    expect(
      (
        await payload.count({
          collection: 'manualReviews',
          overrideAccess: true,
          where: {
            and: [
              { walletTopUpOrder: { equals: topUp.orderId } },
              { reasonCode: { equals: 'wallet_top_up.payment_identifier_mismatch' } },
              { status: { equals: 'open' } },
            ],
          },
        })
      ).totalDocs,
    ).toBe(1)
  })

  it.each([
    ['transaction id', { transactionId: wechatTransactionId() }],
    ['amount', { amountMinor: 10_001 }],
    ['paid timestamp', { paidAt: new Date(now.getTime() + 120_000).toISOString() }],
  ])(
    'rejects each notification/query disagreement independently: %s',
    async (_dimension, override) => {
      const fixture = createWechatPayFixture({ now: () => now })
      const topUp = await startedTopUp(
        `notification-dimension-${String(_dimension).replaceAll(' ', '-')}`,
        fixture,
      )
      const paid = setPaid(fixture, topUp)
      const notification = {
        amountMinor: topUp.amountFen,
        currency: 'CNY' as const,
        merchantOrderNumber: topUp.orderNumber,
        notificationId: `EV${randomUUID().replaceAll('-', '')}`,
        paidAt: paid.paidAt,
        transactionId: paid.transactionId,
        verified: true as const,
        ...override,
      }

      const query = trackedQueryProvider(fixture.provider)
      const result = await processWalletTopUpPaymentNotification(
        await request(`notification-dimension-${String(_dimension)}`),
        notification,
        query.provider,
        `${prefix}-notification-dimension-${String(_dimension)}`,
      )

      expect(query.calls).toHaveLength(1)
      expect(result).toMatchObject({ handled: true, idempotentReplay: true })
      expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
      expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
      expect(
        (
          await payload.count({
            collection: 'manualReviews',
            overrideAccess: true,
            where: {
              and: [
                { walletTopUpOrder: { equals: topUp.orderId } },
                { reasonCode: { equals: 'wallet_top_up.payment_identifier_mismatch' } },
                { status: { equals: 'open' } },
              ],
            },
          })
        ).totalDocs,
      ).toBe(1)
    },
  )

  it('lets the database accept one global WeChat transaction across N different accounts', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUps = await Promise.all(
      Array.from({ length: 6 }, (_, index) => startedTopUp(`global-tx-${index}`, fixture)),
    )
    const sharedTransactionId = wechatTransactionId()
    for (const topUp of topUps) setPaid(fixture, topUp, { transactionId: sharedTransactionId })

    const attempts = await Promise.allSettled(
      topUps.map((topUp, index) =>
        queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
          customer: topUp.customer,
          provider: fixture.provider,
          traceId: `${prefix}-global-tx-${index}`,
        }),
      ),
    )

    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(5)
    for (const rejected of attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    )) {
      expect(rejected.reason).toMatchObject({
        code: 'WALLET_TOP_UP_WECHAT_TRANSACTION_CONFLICT',
      })
    }
    expect(
      await countTopUps({
        and: [
          { id: { in: topUps.map(({ orderId }) => orderId) } },
          { status: { equals: 'credited' } },
          { wechatTransactionId: { equals: sharedTransactionId } },
        ],
      }),
    ).toBe(1)
    const creditCounts = await Promise.all(
      topUps.map(({ accountId }) => countEntries(accountId, { entryType: { equals: 'credit' } })),
    )
    expect(creditCounts.reduce((sum, count) => sum + count, 0)).toBe(1)
  })

  it('makes repeated confirmation of one top-up add exactly one ledger credit', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('idempotent-credit', fixture)
    setPaid(fixture, topUp)

    for (let index = 0; index < 3; index += 1) {
      await queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
        customer: topUp.customer,
        provider: fixture.provider,
        traceId: `${prefix}-idempotent-credit-${index}`,
      })
    }

    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(1)
    expect(
      (
        await payload.count({
          collection: 'auditLogs',
          overrideAccess: true,
          where: {
            and: [
              { action: { equals: 'wallet.top_up.credited' } },
              { targetId: { equals: String(topUp.orderId) } },
            ],
          },
        })
      ).totalDocs,
    ).toBe(1)
    await expect(
      readWalletBalance(await request('idempotent-balance'), topUp.accountId),
    ).resolves.toEqual({
      availableBalance: BigInt(topUp.amountFen),
      heldBalance: 0n,
      postedBalance: BigInt(topUp.amountFen),
    })
  })

  it('records each top-up lifecycle audit callpoint against the top-up', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('lifecycle-audit', fixture)
    setPaid(fixture, topUp)
    await queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
      customer: topUp.customer,
      provider: fixture.provider,
      traceId: `${prefix}-lifecycle-audit-credit`,
    })
    await markWalletTopUpOriginalRefunded(await request('lifecycle-audit-refund'), {
      originalRefundNumber: `WR${randomUUID().replaceAll('-', '')}`,
      refundedAt: new Date(now.getTime() + 120_000).toISOString(),
      topUpOrderNumber: topUp.orderNumber,
    })

    for (const action of [
      'wallet.top_up.created',
      'wallet.top_up.payment_started',
      'wallet.top_up.credited',
      'wallet.top_up.refunded',
    ] as const) {
      expect(
        (
          await payload.count({
            collection: 'auditLogs',
            overrideAccess: true,
            where: {
              and: [
                { action: { equals: action } },
                { targetId: { equals: String(topUp.orderId) } },
              ],
            },
          })
        ).totalDocs,
        action,
      ).toBe(1)
    }
  })

  it('rejects a different WeChat transaction on an already credited top-up', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('credited-transaction-conflict', fixture)
    setPaid(fixture, topUp)
    await queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
      customer: topUp.customer,
      provider: fixture.provider,
      traceId: `${prefix}-credited-transaction-first`,
    })
    setPaid(fixture, topUp, { transactionId: wechatTransactionId() })

    await expect(
      queryAndConfirmWalletTopUpPayment(
        await request('credited-transaction-second', topUp.customer),
        topUp.orderNumber,
        {
          customer: topUp.customer,
          provider: fixture.provider,
          traceId: `${prefix}-credited-transaction-second`,
        },
      ),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_STATE_CONFLICT' })
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(1)
  })

  it('rejects using wallet balance as the funding source before creating an order', async () => {
    const customer = await createCustomer('balance-source')
    const req = await request('balance-source', customer)

    await expect(
      createWalletTopUpOrder(req, { amountFen: 10_000, fundingSource: 'balance' }, { customer }),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_BALANCE_FORBIDDEN' })
    expect(await countTopUps({ customer: { equals: customer.id } })).toBe(0)
  })

  it('rejects every non-positive, fractional, and unsafe top-up amount before writes', async () => {
    const customer = await createCustomer('amount-guards')
    const req = await request('amount-guards', customer)
    for (const amountFen of [0, -1, 1.5, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      await expect(
        createWalletTopUpOrder(req, { amountFen, fundingSource: 'wechat' }, { customer }),
      ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_AMOUNT_INVALID' })
    }
    expect(await countTopUps({ customer: { equals: customer.id } })).toBe(0)
  })

  it('requires an authenticated owner and an existing payment session for active query', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await createdTopUp('query-preconditions')
    const other = await createCustomer('query-preconditions-other')

    await expect(
      queryAndConfirmWalletTopUpPayment(
        await request('query-preconditions-owner', topUp.customer),
        topUp.orderNumber,
        {
          customer: topUp.customer,
          provider: fixture.provider,
          traceId: `${prefix}-query-preconditions-owner`,
        },
      ),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_PAYMENT_NOT_CREATED' })
    await expect(
      queryAndConfirmWalletTopUpPayment(
        await request('query-preconditions-other', other),
        topUp.orderNumber,
        {
          customer: other,
          provider: fixture.provider,
          traceId: `${prefix}-query-preconditions-other`,
        },
      ),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_NOT_FOUND' })
    expect(await topUpStatus(topUp.orderId)).toBe('created')
  })

  it('enforces customer authentication at create, payment, and query callpoints', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const customer = await createCustomer('auth-create')
    await expect(
      createWalletTopUpOrder(
        await request('auth-create'),
        { amountFen: 10_000, fundingSource: 'wechat' },
        { customer },
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })

    const created = await createdTopUp('auth-payment')
    await expect(
      createWalletTopUpPayment(
        await request('auth-payment'),
        created.orderNumber,
        { channel: 'native' },
        {
          customer: created.customer,
          now: () => now,
          provider: fixture.provider,
          traceId: `${prefix}-auth-payment`,
        },
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })

    const started = await startedTopUp('auth-query', fixture)
    await expect(
      queryAndConfirmWalletTopUpPayment(await request('auth-query'), started.orderNumber, {
        customer: started.customer,
        provider: fixture.provider,
        traceId: `${prefix}-auth-query`,
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
    expect(await topUpStatus(created.orderId)).toBe('created')
    expect(await topUpStatus(started.orderId)).toBe('payment_pending')
  })

  it('enforces purchase capability at the create-order callpoint', async () => {
    const customer = await createCustomer('create-capability')
    await restrictPurchases(customer.id)

    await expect(
      createWalletTopUpOrder(
        await request('create-capability', customer),
        { amountFen: 10_000, fundingSource: 'wechat' },
        { customer },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PURCHASE_DISABLED' })
    expect(await countTopUps({ customer: { equals: customer.id } })).toBe(0)
  })

  it('enforces identity-risk cooldown at the create-order callpoint', async () => {
    const customer = await createCustomer('create-cooldown')
    await startIdentityRiskCooldown(customer.id)

    await expect(
      createWalletTopUpOrder(
        await request('create-cooldown', customer),
        { amountFen: 10_000, fundingSource: 'wechat' },
        { customer },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE' })
    expect(await countTopUps({ customer: { equals: customer.id } })).toBe(0)
  })

  it('enforces purchase capability at the payment-create callpoint', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await createdTopUp('payment-capability')
    await restrictPurchases(topUp.customer.id)

    await expect(
      createWalletTopUpPayment(
        await request('payment-capability', topUp.customer),
        topUp.orderNumber,
        { channel: 'native' },
        {
          customer: topUp.customer,
          now: () => now,
          provider: fixture.provider,
          traceId: `${prefix}-payment-capability`,
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PURCHASE_DISABLED' })
    expect(await topUpStatus(topUp.orderId)).toBe('created')
  })

  it('enforces identity-risk cooldown at the payment-create callpoint', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await createdTopUp('payment-cooldown')
    await startIdentityRiskCooldown(topUp.customer.id)

    await expect(
      createWalletTopUpPayment(
        await request('payment-cooldown', topUp.customer),
        topUp.orderNumber,
        { channel: 'native' },
        {
          customer: topUp.customer,
          now: () => now,
          provider: fixture.provider,
          traceId: `${prefix}-payment-cooldown`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE' })
    expect(await topUpStatus(topUp.orderId)).toBe('created')
  })

  it('claims payment creation once from the created state', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await createdTopUp('payment-create-once')

    await createWalletTopUpPayment(
      topUp.req,
      topUp.orderNumber,
      { channel: 'native' },
      {
        customer: topUp.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-payment-create-once-first`,
      },
    )
    await expect(
      createWalletTopUpPayment(
        await request('payment-create-once-second', topUp.customer),
        topUp.orderNumber,
        { channel: 'native' },
        {
          customer: topUp.customer,
          now: () => now,
          provider: fixture.provider,
          traceId: `${prefix}-payment-create-once-second`,
        },
      ),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_PAYMENT_CREATE_CONFLICT' })
    expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
  })

  it('scopes payment creation and known-failure closing to exactly one top-up', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const createTarget = await createdTopUp('payment-create-scope-target')
    const createDecoy = await createdTopUp('payment-create-scope-decoy')

    await createWalletTopUpPayment(
      createTarget.req,
      createTarget.orderNumber,
      { channel: 'native' },
      {
        customer: createTarget.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-payment-create-scope`,
      },
    )
    expect(await topUpStatus(createTarget.orderId)).toBe('payment_pending')
    expect(await topUpStatus(createDecoy.orderId)).toBe('created')

    const closeTarget = await createdTopUp('payment-close-scope-target')
    const closeDecoy = await startedTopUp('payment-close-scope-decoy', fixture)
    const rejectingProvider = {
      createPayment: async () => mockFailure('WECHATPAY_REJECTED', { statusKnown: true }),
    } as unknown as PaymentProvider
    await expect(
      createWalletTopUpPayment(
        closeTarget.req,
        closeTarget.orderNumber,
        { channel: 'native' },
        {
          customer: closeTarget.customer,
          now: () => now,
          provider: rejectingProvider,
          traceId: `${prefix}-payment-close-scope`,
        },
      ),
    ).rejects.toMatchObject({ code: 'WECHATPAY_CREATE_REJECTED' })
    expect(await topUpStatus(closeTarget.orderId)).toBe('closed')
    expect(await topUpStatus(closeDecoy.orderId)).toBe('payment_pending')
  })

  it('does not close a top-up whose state changed during a failed provider create', async () => {
    const topUp = await createdTopUp('payment-close-state-race')
    const rejectingProvider = {
      createPayment: async () => {
        await payload.db.pool.query(
          `UPDATE wallet_top_up_orders SET status = 'closed', updated_at = NOW() WHERE id = $1`,
          [topUp.orderId],
        )
        return mockFailure('WECHATPAY_REJECTED', { statusKnown: true })
      },
    } as unknown as PaymentProvider

    await expect(
      createWalletTopUpPayment(
        topUp.req,
        topUp.orderNumber,
        { channel: 'native' },
        {
          customer: topUp.customer,
          now: () => now,
          provider: rejectingProvider,
          traceId: `${prefix}-payment-close-state-race`,
        },
      ),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_STATE_CONFLICT' })
    expect(await topUpStatus(topUp.orderId)).toBe('closed')
  })

  it('enforces purchase capability at the provider-confirmation callpoint', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('confirmation-capability', fixture)
    setPaid(fixture, topUp)
    await restrictPurchases(topUp.customer.id)

    await expect(
      queryAndConfirmWalletTopUpPayment(
        await request('confirmation-capability', topUp.customer),
        topUp.orderNumber,
        {
          customer: topUp.customer,
          provider: fixture.provider,
          traceId: `${prefix}-confirmation-capability`,
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PURCHASE_DISABLED' })
    expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
  })

  it('enforces identity-risk cooldown at the provider-confirmation callpoint', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('confirmation-cooldown', fixture)
    setPaid(fixture, topUp)
    await startIdentityRiskCooldown(topUp.customer.id)

    await expect(
      queryAndConfirmWalletTopUpPayment(
        await request('confirmation-cooldown', topUp.customer),
        topUp.orderNumber,
        {
          customer: topUp.customer,
          provider: fixture.provider,
          traceId: `${prefix}-confirmation-cooldown`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE' })
    expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
  })

  it('enforces the platform top-up order number unique index independently', async () => {
    const topUp = await createdTopUp('platform-order-unique')

    await expect(
      payload.db.pool.query(
        `INSERT INTO wallet_top_up_orders (
           top_up_order_number,
           customer_id,
           account_id,
           amount_fen,
           currency,
           funding_source,
           status,
           ledger_transaction_key,
           updated_at,
           created_at
         )
         SELECT
           top_up_order_number,
           customer_id,
           account_id,
           amount_fen,
           currency,
           funding_source,
           'created',
           $2,
           NOW(),
           NOW()
         FROM wallet_top_up_orders
         WHERE id = $1`,
        [topUp.orderId, `${prefix}-independent-ledger-key`],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'wallet_top_up_orders_top_up_order_number_idx',
    })
  })

  it('enforces the ledger idempotency key unique index independently', async () => {
    const topUp = await createdTopUp('ledger-key-unique')

    await expect(
      payload.db.pool.query(
        `INSERT INTO wallet_top_up_orders (
           top_up_order_number,
           customer_id,
           account_id,
           amount_fen,
           currency,
           funding_source,
           status,
           ledger_transaction_key,
           updated_at,
           created_at
         )
         SELECT
           $2,
           customer_id,
           account_id,
           amount_fen,
           currency,
           funding_source,
           'created',
           ledger_transaction_key,
           NOW(),
           NOW()
         FROM wallet_top_up_orders
         WHERE id = $1`,
        [topUp.orderId, unusedTopUpOrderNumber()],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'wallet_top_up_orders_ledger_transaction_key_idx',
    })
  })

  it('enforces one original refund number across different top-up orders', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const first = await startedTopUp('refund-number-first', fixture)
    const second = await startedTopUp('refund-number-second', fixture)
    const originalRefundNumber = `WR${randomUUID().replaceAll('-', '')}`
    await markWalletTopUpOriginalRefunded(await request('refund-number-first'), {
      originalRefundNumber,
      refundedAt: new Date(now.getTime() + 120_000).toISOString(),
      topUpOrderNumber: first.orderNumber,
    })

    await expect(
      markWalletTopUpOriginalRefunded(await request('refund-number-second'), {
        originalRefundNumber,
        refundedAt: new Date(now.getTime() + 120_000).toISOString(),
        topUpOrderNumber: second.orderNumber,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_REFUND_NUMBER_CONFLICT' })
    expect(await topUpStatus(first.orderId)).toBe('refunded')
    expect(await topUpStatus(second.orderId)).toBe('payment_pending')
  })

  it('rejects unauthorized, malformed, missing, and invalid-state refund markers', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const created = await createdTopUp('refund-input-created')
    const started = await startedTopUp('refund-input-started', fixture)
    const validInput = {
      originalRefundNumber: `WR${randomUUID().replaceAll('-', '')}`,
      refundedAt: new Date(now.getTime() + 120_000).toISOString(),
      topUpOrderNumber: started.orderNumber,
    }

    await expect(markWalletTopUpOriginalRefunded(started.req, validInput)).rejects.toMatchObject({
      code: 'WALLET_TOP_UP_REFUND_SYSTEM_ONLY',
    })
    await expect(
      markWalletTopUpOriginalRefunded(await request('refund-input-empty'), {
        ...validInput,
        originalRefundNumber: '   ',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_REFUND_NUMBER_INVALID' })
    await expect(
      markWalletTopUpOriginalRefunded(await request('refund-input-long'), {
        ...validInput,
        originalRefundNumber: 'R'.repeat(65),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_REFUND_NUMBER_INVALID' })
    await expect(
      markWalletTopUpOriginalRefunded(await request('refund-input-date'), {
        ...validInput,
        refundedAt: 'not-a-date',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_REFUNDED_AT_INVALID' })
    await expect(
      markWalletTopUpOriginalRefunded(await request('refund-input-missing'), {
        ...validInput,
        topUpOrderNumber: unusedTopUpOrderNumber(),
      }),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_NOT_FOUND' })
    await expect(
      markWalletTopUpOriginalRefunded(await request('refund-input-state'), {
        ...validInput,
        topUpOrderNumber: created.orderNumber,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_REFUND_STATE_INVALID' })
    expect(await topUpStatus(created.orderId)).toBe('created')
    expect(await topUpStatus(started.orderId)).toBe('payment_pending')
  })

  it('makes one original refund number idempotent and rejects a conflicting number', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('refund-idempotency', fixture)
    const refundedAt = new Date(now.getTime() + 120_000).toISOString()
    const originalRefundNumber = `WR${randomUUID().replaceAll('-', '')}`

    await expect(
      markWalletTopUpOriginalRefunded(await request('refund-idempotency-first'), {
        originalRefundNumber,
        refundedAt,
        topUpOrderNumber: topUp.orderNumber,
      }),
    ).resolves.toEqual({ applied: true, status: 'refunded' })
    await expect(
      markWalletTopUpOriginalRefunded(await request('refund-idempotency-replay'), {
        originalRefundNumber,
        refundedAt,
        topUpOrderNumber: topUp.orderNumber,
      }),
    ).resolves.toEqual({ applied: false, status: 'refunded' })
    await expect(
      markWalletTopUpOriginalRefunded(await request('refund-idempotency-conflict'), {
        originalRefundNumber: `WR${randomUUID().replaceAll('-', '')}`,
        refundedAt,
        topUpOrderNumber: topUp.orderNumber,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_REFUND_CONFLICT' })
    expect(await topUpStatus(topUp.orderId)).toBe('refunded')
    expect(await countEntries(topUp.accountId, {})).toBe(0)
  })

  it('rolls back the ledger credit when the credited-state update fails', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('atomic-credit-state', fixture)
    setPaid(fixture, topUp)
    const constraint = `test_reject_credited_${randomUUID().replaceAll('-', '')}`
    await payload.db.pool.query(
      `ALTER TABLE wallet_top_up_orders
       ADD CONSTRAINT ${constraint}
       CHECK (NOT (id = ${topUp.orderId} AND status = 'credited'))`,
    )
    try {
      await expect(
        queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
          customer: topUp.customer,
          provider: fixture.provider,
          traceId: `${prefix}-atomic-credit-state`,
        }),
      ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_UNAVAILABLE' })
    } finally {
      await payload.db.pool.query(`ALTER TABLE wallet_top_up_orders DROP CONSTRAINT ${constraint}`)
    }

    expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
    await expect(
      readWalletBalance(await request('atomic-credit-state-balance'), topUp.accountId),
    ).resolves.toEqual({
      availableBalance: 0n,
      heldBalance: 0n,
      postedBalance: 0n,
    })
  })

  it('rejects stale order-number and amount snapshots at the confirmation CAS', async () => {
    for (const dimension of ['order-number', 'amount'] as const) {
      const fixture = createWechatPayFixture({ now: () => now })
      const topUp = await startedTopUp(`confirmation-stale-${dimension}`, fixture)
      const paidAt = new Date(now.getTime() + 60_000).toISOString()
      const transactionId = wechatTransactionId()
      const provider = {
        queryOrder: async () => {
          if (dimension === 'order-number') {
            await payload.db.pool.query(
              `UPDATE wallet_top_up_orders
               SET top_up_order_number = $2, updated_at = NOW()
               WHERE id = $1`,
              [topUp.orderId, unusedTopUpOrderNumber()],
            )
          } else {
            await payload.db.pool.query(
              `UPDATE wallet_top_up_orders SET amount_fen = amount_fen + 1, updated_at = NOW()
               WHERE id = $1`,
              [topUp.orderId],
            )
          }
          return mockSuccess(
            {
              amountMinor: topUp.amountFen,
              currency: 'CNY' as const,
              merchantOrderNumber: topUp.orderNumber,
              paidAt,
              state: 'paid' as const,
              transactionId,
            },
            `${prefix}-confirmation-stale-${dimension}`,
          )
        },
      } as unknown as PaymentProvider

      await expect(
        queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
          customer: topUp.customer,
          provider,
          traceId: `${prefix}-confirmation-stale-${dimension}`,
        }),
      ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_STATE_CONFLICT' })
      expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
      expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
    }
  })

  it('scopes the credited-state commit to the claimed top-up', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const target = await startedTopUp('credited-commit-target', fixture)
    const decoy = await startedTopUp('credited-commit-decoy', fixture)
    const decoyTransactionId = wechatTransactionId()
    await payload.db.pool.query(
      `UPDATE wallet_top_up_orders
       SET status = 'provider_confirmed',
           wechat_transaction_id = $2,
           provider_paid_at = NOW(),
           provider_confirmed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [decoy.orderId, decoyTransactionId],
    )
    setPaid(fixture, target)

    await queryAndConfirmWalletTopUpPayment(target.req, target.orderNumber, {
      customer: target.customer,
      provider: fixture.provider,
      traceId: `${prefix}-credited-commit-target`,
    })

    expect(await topUpStatus(target.orderId)).toBe('credited')
    expect(await topUpStatus(decoy.orderId)).toBe('provider_confirmed')
  })

  it('rolls back credit if the claimed state changes before the credited-state CAS', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('credited-state-cas', fixture)
    setPaid(fixture, topUp)
    const suffix = randomUUID().replaceAll('-', '')
    const functionName = `test_d9b2_credit_state_${suffix}`
    const triggerName = `test_d9b2_credit_state_trigger_${suffix}`
    await payload.db.pool.query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.account_id = ${topUp.accountId} AND NEW.entry_type = 'credit' THEN
          UPDATE wallet_top_up_orders
          SET status = 'credited', credited_at = NOW(), updated_at = NOW()
          WHERE id = ${topUp.orderId};
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ${triggerName}
      AFTER INSERT ON wallet_entries
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `)
    try {
      await expect(
        queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
          customer: topUp.customer,
          provider: fixture.provider,
          traceId: `${prefix}-credited-state-cas`,
        }),
      ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_UNAVAILABLE' })
    } finally {
      await payload.db.pool.query(`DROP TRIGGER ${triggerName} ON wallet_entries`)
      await payload.db.pool.query(`DROP FUNCTION ${functionName}()`)
    }
    expect(await topUpStatus(topUp.orderId)).toBe('payment_pending')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(0)
  })

  it('removes an unconsumed credited top-up when an original refund is confirmed', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('original-refund', fixture)
    setPaid(fixture, topUp)
    await queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
      customer: topUp.customer,
      provider: fixture.provider,
      traceId: `${prefix}-original-refund-credit`,
    })

    await markWalletTopUpOriginalRefunded(await request('original-refund-system'), {
      originalRefundNumber: `WR${randomUUID().replaceAll('-', '')}`,
      refundedAt: new Date(now.getTime() + 120_000).toISOString(),
      topUpOrderNumber: topUp.orderNumber,
    })

    expect(await topUpStatus(topUp.orderId)).toBe('refunded')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(1)
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'hold' } })).toBe(1)
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'capture' } })).toBe(1)
    await expect(
      readWalletBalance(await request('original-refund-balance'), topUp.accountId),
    ).resolves.toEqual({
      availableBalance: 0n,
      heldBalance: 0n,
      postedBalance: 0n,
    })
  })

  it('scopes refund claim and finalization to exactly one top-up', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const target = await startedTopUp('refund-scope-target', fixture)
    const claimDecoy = await startedTopUp('refund-claim-scope-decoy', fixture)
    const finalDecoy = await startedTopUp('refund-final-scope-decoy', fixture)
    await payload.db.pool.query(
      `UPDATE wallet_top_up_orders
       SET status = 'refund_pending', original_refund_number = $2,
           refunded_amount_fen = amount_fen, updated_at = NOW()
       WHERE id = $1`,
      [finalDecoy.orderId, `WR${randomUUID().replaceAll('-', '')}`],
    )

    await markWalletTopUpOriginalRefunded(await request('refund-scope-target'), {
      originalRefundNumber: `WR${randomUUID().replaceAll('-', '')}`,
      refundedAt: new Date(now.getTime() + 120_000).toISOString(),
      topUpOrderNumber: target.orderNumber,
    })

    expect(await topUpStatus(target.orderId)).toBe('refunded')
    expect(await topUpStatus(claimDecoy.orderId)).toBe('payment_pending')
    expect(await topUpStatus(finalDecoy.orderId)).toBe('refund_pending')
  })

  it('rolls back a refund if the claimed state changes before finalization', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('refund-final-state-cas', fixture)
    setPaid(fixture, topUp)
    await queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
      customer: topUp.customer,
      provider: fixture.provider,
      traceId: `${prefix}-refund-final-state-credit`,
    })
    const suffix = randomUUID().replaceAll('-', '')
    const functionName = `test_d9b2_refund_state_${suffix}`
    const triggerName = `test_d9b2_refund_state_trigger_${suffix}`
    await payload.db.pool.query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.account_id = ${topUp.accountId} AND NEW.entry_type = 'capture' THEN
          UPDATE wallet_top_up_orders
          SET status = 'refunded', refunded_at = NOW(), updated_at = NOW()
          WHERE id = ${topUp.orderId};
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ${triggerName}
      AFTER INSERT ON wallet_entries
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `)
    try {
      await expect(
        markWalletTopUpOriginalRefunded(await request('refund-final-state-cas'), {
          originalRefundNumber: `WR${randomUUID().replaceAll('-', '')}`,
          refundedAt: new Date(now.getTime() + 120_000).toISOString(),
          topUpOrderNumber: topUp.orderNumber,
        }),
      ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_UNAVAILABLE' })
    } finally {
      await payload.db.pool.query(`DROP TRIGGER ${triggerName} ON wallet_entries`)
      await payload.db.pool.query(`DROP FUNCTION ${functionName}()`)
    }
    expect(await topUpStatus(topUp.orderId)).toBe('credited')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'capture' } })).toBe(0)
    await expect(
      readWalletBalance(await request('refund-final-state-balance'), topUp.accountId),
    ).resolves.toEqual({
      availableBalance: BigInt(topUp.amountFen),
      heldBalance: 0n,
      postedBalance: BigInt(topUp.amountFen),
    })
  })

  it('rejects an unconditional original refund after the credited balance was consumed', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('consumed-refund', fixture, 10_000)
    setPaid(fixture, topUp)
    await queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
      customer: topUp.customer,
      provider: fixture.provider,
      traceId: `${prefix}-consumed-refund-credit`,
    })
    const spendKey = `${prefix}-consumed-refund-spend`
    await holdWalletBalance(await request('consumed-refund-hold'), {
      accountId: topUp.accountId,
      amountFen: 4_000,
      transactionKey: spendKey,
    })
    await captureWalletHold(await request('consumed-refund-capture'), spendKey)

    await expect(
      markWalletTopUpOriginalRefunded(await request('consumed-refund-system'), {
        originalRefundNumber: `WR${randomUUID().replaceAll('-', '')}`,
        refundedAt: new Date(now.getTime() + 120_000).toISOString(),
        topUpOrderNumber: topUp.orderNumber,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_REFUND_BALANCE_CONSUMED' })

    expect(await topUpStatus(topUp.orderId)).toBe('credited')
    await expect(
      readWalletBalance(await request('consumed-refund-balance'), topUp.accountId),
    ).resolves.toEqual({
      availableBalance: 6_000n,
      heldBalance: 0n,
      postedBalance: 6_000n,
    })
  })

  it('credits exactly once under N concurrent confirmations of one top-up', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('concurrent-credit', fixture)
    setPaid(fixture, topUp)

    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, async (_, index) =>
        queryAndConfirmWalletTopUpPayment(
          await request(`concurrent-credit-${index}`, topUp.customer),
          topUp.orderNumber,
          {
            customer: topUp.customer,
            provider: fixture.provider,
            traceId: `${prefix}-concurrent-credit-${index}`,
          },
        ),
      ),
    )

    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(12)
    expect(await topUpStatus(topUp.orderId)).toBe('credited')
    expect(await countEntries(topUp.accountId, { entryType: { equals: 'credit' } })).toBe(1)
    await expect(
      readWalletBalance(await request('concurrent-credit-balance'), topUp.accountId),
    ).resolves.toEqual({
      availableBalance: BigInt(topUp.amountFen),
      heldBalance: 0n,
      postedBalance: BigInt(topUp.amountFen),
    })
  })

  it('serializes credit and original-refund marking to one refunded nonnegative result', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const topUp = await startedTopUp('credit-refund-race', fixture)
    setPaid(fixture, topUp)

    const attempts = await Promise.allSettled([
      queryAndConfirmWalletTopUpPayment(topUp.req, topUp.orderNumber, {
        customer: topUp.customer,
        provider: fixture.provider,
        traceId: `${prefix}-credit-refund-race-credit`,
      }),
      markWalletTopUpOriginalRefunded(await request('credit-refund-race-refund'), {
        originalRefundNumber: `WR${randomUUID().replaceAll('-', '')}`,
        refundedAt: new Date(now.getTime() + 120_000).toISOString(),
        topUpOrderNumber: topUp.orderNumber,
      }),
    ])

    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(2)
    expect(await topUpStatus(topUp.orderId)).toBe('refunded')
    const balance = await readWalletBalance(
      await request('credit-refund-race-balance'),
      topUp.accountId,
    )
    expect(balance).toEqual({ availableBalance: 0n, heldBalance: 0n, postedBalance: 0n })
    expect(balance.availableBalance >= 0n).toBe(true)
  })
})
