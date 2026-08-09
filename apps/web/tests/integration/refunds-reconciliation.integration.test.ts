import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mockFailure } from '@/providers/mock'
import type { RefundProvider } from '@/providers/types'
import { createWechatPayFixture, paymentPayloadDigest } from '@/providers/wechatpay'
import {
  reconcileWechatFunds,
  reconcileWestdigitalPrepaidBalance,
  recordThreeWayDifference,
} from '@/services/commerce/reconciliation'
import {
  processWechatRefundNotification,
  requestAutomaticRegistrationFailureRefund,
  runWechatRefund,
} from '@/services/commerce/refunds'

import { realnameTemplateFixture } from '../fixtures/realname'

const prefix = `d5-refunds-${randomUUID()}`
const now = new Date('2026-08-08T03:30:00.000Z')
const period = {
  end: '2026-08-08T04:00:00.000Z',
  start: '2026-08-08T03:00:00.000Z',
}
let payload: Payload
const rejectedRefundNotificationIds: Array<number | string> = []

async function request(suffix: string): Promise<PayloadRequest> {
  return createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${prefix}-${suffix}` }) } },
    payload,
  )
}

async function createPaidOrder(
  suffix: string,
  options: { amountMinor?: number; status?: 'paid' | 'succeeded' } = {},
) {
  const amountMinor = options.amountMinor ?? 12_300
  const customer = await payload.create({
    collection: 'customers',
    data: { phone: `${prefix}-${suffix}`, phoneMasked: `***${suffix}`, status: 'active' },
    overrideAccess: true,
  })
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `${prefix}-${suffix}` }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  const quote = await payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: now.toISOString(),
      availabilityRequestId: `${prefix}-availability-${suffix}`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `${prefix}-quote-${suffix}`,
      currency: 'CNY',
      customer: customer.id,
      domainAscii: `${suffix}.example`,
      expiresAt: new Date(now.getTime() + 240_000).toISOString(),
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: now.toISOString(),
      providerProductId: `${prefix}-product-${suffix}`,
      providerRequestId: `${prefix}-price-${suffix}`,
      quotedAt: now.toISOString(),
      quoteIntegrityHash: '1'.repeat(64),
      quoteRef: randomUUID(),
      registrationPriceMinor: amountMinor,
      renewalPriceMinor: amountMinor,
      ruleFixedAmountMinor: 0,
      ruleKey: `${prefix}-rule-${suffix}`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
      roundingMode: 'half_up_to_fen',
      schemaVersion: 1,
      sourceCalculationHash: '2'.repeat(64),
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
  const merchantOrderNumber = `WM${randomUUID().replaceAll('-', '').slice(0, 30)}`
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor,
      currency: 'CNY',
      customer: customer.id,
      domainAscii: `${suffix}.example`,
      merchantOrderNumber,
      orderNumber: `${prefix}-${suffix}`,
      paidAt: now.toISOString(),
      quote: quote.id,
      quoteSnapshot: { expiresAt: new Date(now.getTime() + 240_000).toISOString() },
      realnameTemplate: template.id,
      status: options.status ?? 'paid',
    },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'paymentNotifications',
    data: {
      amountMinor,
      confirmationStatus: 'confirmed',
      currency: 'CNY',
      merchantOrderNumber,
      notificationId: randomUUID(),
      order: order.id,
      paidAt: now.toISOString(),
      payloadDigest: randomUUID().replaceAll('-', '').repeat(2),
      receivedAt: now.toISOString(),
      signatureVerified: true,
      source: 'query',
      wechatTransactionId: `4200${randomUUID().replaceAll('-', '').slice(0, 28)}`,
    },
    overrideAccess: true,
  })
  return { amountMinor, customer, merchantOrderNumber, order, quote, template }
}

beforeAll(async () => {
  payload = await getPayload({ config })
}, 60_000)

afterAll(async () => {
  const refundJobs = await payload.find({
    collection: 'payload-jobs',
    limit: 100,
    overrideAccess: true,
    where: { workflowSlug: { equals: 'wechatRefund' } },
  })
  for (const job of refundJobs.docs) {
    const input = job.input as { traceId?: unknown } | null | undefined
    if (typeof input?.traceId === 'string' && input.traceId.startsWith(prefix)) {
      await payload.delete({ collection: 'payload-jobs', id: job.id, overrideAccess: true })
    }
  }
  for (const id of rejectedRefundNotificationIds) {
    await payload.delete({ collection: 'refundNotifications', id, overrideAccess: true })
  }
  const orders = await payload.find({
    collection: 'orders',
    limit: 100,
    overrideAccess: true,
    where: { orderNumber: { contains: prefix } },
  })
  for (const order of orders.docs) {
    const refunds = await payload.find({
      collection: 'refunds',
      limit: 10,
      overrideAccess: true,
      where: { order: { equals: order.id } },
    })
    for (const refund of refunds.docs) {
      await payload.delete({
        collection: 'refundNotifications',
        overrideAccess: true,
        where: { refund: { equals: refund.id } },
      })
      await payload.delete({ collection: 'refunds', id: refund.id, overrideAccess: true })
    }
    for (const collection of [
      'orderEvents',
      'manualReviews',
      'paymentNotifications',
      'providerOperations',
    ] as const) {
      await payload.delete({
        collection,
        overrideAccess: true,
        where: { order: { equals: order.id } },
      })
    }
    await payload.delete({ collection: 'orders', id: order.id, overrideAccess: true })
  }
  await payload.delete({
    collection: 'reconciliations',
    overrideAccess: true,
    where: { traceId: { contains: prefix } },
  })
  for (const collection of ['quotes', 'realnameTemplates', 'customers'] as const) {
    const field =
      collection === 'quotes'
        ? 'createdTraceId'
        : collection === 'customers'
          ? 'phone'
          : 'displayName'
    await payload.delete({
      collection,
      overrideAccess: true,
      where: { [field]: { contains: prefix } },
    })
  }
  await payload.db.destroy?.()
}, 60_000)

describe('D5-04 Wechat refunds', () => {
  it('queues one full refund, follows refund_pending -> refunding -> refunded and only queries after submission', async () => {
    const setup = await createPaidOrder('success')
    const req = await request('success')
    const requested = await requestAutomaticRegistrationFailureRefund(req, {
      evidence: { providerState: 'registration_failed' },
      note: '西部数码明确返回注册失败。',
      orderId: setup.order.id,
      traceId: `${prefix}-success`,
    })
    const replay = await requestAutomaticRegistrationFailureRefund(req, {
      evidence: { providerState: 'registration_failed' },
      note: '重放',
      orderId: setup.order.id,
      traceId: `${prefix}-success-replay`,
    })
    expect(replay).toMatchObject({ idempotentReplay: true, refundId: requested.refundId })
    const refund = await payload.findByID({
      collection: 'refunds',
      id: requested.refundId,
      overrideAccess: true,
    })
    expect(refund).toMatchObject({
      amountMinor: setup.amountMinor,
      currency: 'CNY',
      status: 'pending',
    })

    const fixture = createWechatPayFixture({ now: () => now })
    let createCalls = 0
    let queryCalls = 0
    const provider: RefundProvider = {
      createRefund: async (input) => {
        createCalls += 1
        return fixture.provider.createRefund(input)
      },
      health: () => fixture.provider.health(),
      queryRefund: async (input) => {
        queryCalls += 1
        return fixture.provider.queryRefund(input)
      },
      verifyRefundNotification: (input) => fixture.provider.verifyRefundNotification(input),
    }
    await runWechatRefund(
      req,
      { refundId: Number(refund.id), traceId: `${prefix}-submit` },
      provider,
    )
    expect(createCalls).toBe(1)
    expect(
      (await payload.findByID({ collection: 'orders', id: setup.order.id, overrideAccess: true }))
        .status,
    ).toBe('refunding')

    fixture.setRefund({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: setup.merchantOrderNumber,
      providerRefundId: '503000000000000000000000000011',
      refundNumber: refund.refundNumber,
      refundedAt: now.toISOString(),
      state: 'succeeded',
    })
    await runWechatRefund(
      req,
      { refundId: Number(refund.id), traceId: `${prefix}-query` },
      provider,
    )
    expect(createCalls).toBe(1)
    expect(queryCalls).toBe(1)
    expect(
      (await payload.findByID({ collection: 'orders', id: setup.order.id, overrideAccess: true }))
        .status,
    ).toBe('refunded')
    expect(
      (await payload.findByID({ collection: 'refunds', id: refund.id, overrideAccess: true }))
        .status,
    ).toBe('succeeded')
  })

  it('rejects succeeded orders before any provider write and enforces refund-number uniqueness in PostgreSQL', async () => {
    const succeeded = await createPaidOrder('succeeded', { status: 'succeeded' })
    await expect(
      requestAutomaticRegistrationFailureRefund(await request('succeeded'), {
        evidence: { providerState: 'failed' },
        note: '不可退款',
        orderId: succeeded.order.id,
        traceId: `${prefix}-succeeded`,
      }),
    ).rejects.toMatchObject({ code: 'SUCCEEDED_ORDER_REFUND_FORBIDDEN' })

    const source = await createPaidOrder('unique')
    const created = await payload.create({
      collection: 'refunds',
      data: {
        amountMinor: source.amountMinor,
        createdTraceId: `${prefix}-unique`,
        currency: 'CNY',
        order: source.order.id,
        refundNumber: `${prefix}-refund-unique`,
        status: 'pending',
      },
      overrideAccess: true,
    })
    const another = await createPaidOrder('unique-other')
    await expect(
      payload.create({
        collection: 'refunds',
        data: {
          amountMinor: another.amountMinor,
          createdTraceId: `${prefix}-unique-other`,
          currency: 'CNY',
          order: another.order.id,
          refundNumber: created.refundNumber,
          status: 'pending',
        },
        overrideAccess: true,
      }),
    ).rejects.toThrow()
  })

  it('moves unknown submission and balance failure to manual review without repeating a refund request', async () => {
    const unknown = await createPaidOrder('unknown')
    const requested = await requestAutomaticRegistrationFailureRefund(await request('unknown'), {
      evidence: { providerState: 'registration_failed' },
      note: '明确失败',
      orderId: unknown.order.id,
      traceId: `${prefix}-unknown`,
    })
    let creates = 0
    let queries = 0
    const provider: RefundProvider = {
      createRefund: async () => {
        creates += 1
        return mockFailure('WECHATPAY_REFUND_TIMEOUT', { retryable: true, statusKnown: false })
      },
      health: async () => ({
        data: { healthy: true },
        observedAt: now.toISOString(),
        ok: true,
        requestId: 'health',
      }),
      queryRefund: async () => {
        queries += 1
        return mockFailure('WECHATPAY_REFUND_QUERY_TIMEOUT', {
          retryable: true,
          statusKnown: false,
        })
      },
      verifyRefundNotification: async () => ({
        reason: 'malformed_headers',
        signatureVerified: false,
        verified: false,
      }),
    }
    await runWechatRefund(
      await request('unknown-run'),
      { refundId: Number(requested.refundId), traceId: `${prefix}-unknown-run` },
      provider,
    )
    await runWechatRefund(
      await request('unknown-query'),
      { refundId: Number(requested.refundId), traceId: `${prefix}-unknown-query` },
      provider,
    )
    expect({ creates, queries }).toEqual({ creates: 1, queries: 1 })
    expect(
      (await payload.findByID({ collection: 'orders', id: unknown.order.id, overrideAccess: true }))
        .status,
    ).toBe('manual_review')

    const balance = await createPaidOrder('balance')
    const balanceRefund = await requestAutomaticRegistrationFailureRefund(
      await request('balance'),
      {
        evidence: { providerState: 'registration_failed' },
        note: '明确失败',
        orderId: balance.order.id,
        traceId: `${prefix}-balance`,
      },
    )
    const balanceProvider: RefundProvider = {
      ...provider,
      createRefund: async () =>
        mockFailure('WECHATPAY_REFUND_BALANCE_INSUFFICIENT', {
          retryable: false,
          statusKnown: true,
        }),
    }
    await runWechatRefund(
      await request('balance-run'),
      { refundId: Number(balanceRefund.refundId), traceId: `${prefix}-balance-run` },
      balanceProvider,
    )
    expect(
      (
        await payload.findByID({
          collection: 'refunds',
          id: balanceRefund.refundId,
          overrideAccess: true,
        })
      ).failureCategory,
    ).toBe('balance_insufficient')
  })

  it('verifies refund notifications, confirms by query and makes notification replay idempotent', async () => {
    const setup = await createPaidOrder('notification')
    const requested = await requestAutomaticRegistrationFailureRefund(await request('notify'), {
      evidence: { providerState: 'registration_failed' },
      note: '明确失败',
      orderId: setup.order.id,
      traceId: `${prefix}-notify`,
    })
    const fixture = createWechatPayFixture({ now: () => now })
    await runWechatRefund(
      await request('notify-submit'),
      { refundId: Number(requested.refundId), traceId: `${prefix}-notify-submit` },
      fixture.provider,
    )
    const providerRefundId = '503000000000000000000000000012'
    fixture.setRefund({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: setup.merchantOrderNumber,
      providerRefundId,
      refundNumber: requested.refundNumber,
      refundedAt: now.toISOString(),
      state: 'succeeded',
    })
    const notification = fixture.refundNotification({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: setup.merchantOrderNumber,
      notificationId: randomUUID(),
      providerRefundId,
      refundNumber: requested.refundNumber,
      refundedAt: now.toISOString(),
    })
    const forged = fixture.refundNotification({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: setup.merchantOrderNumber,
      notificationId: randomUUID(),
      providerRefundId,
      refundNumber: requested.refundNumber,
      refundedAt: now.toISOString(),
    })
    forged.headers.set('wechatpay-signature', 'invalid')
    await expect(
      processWechatRefundNotification(
        await request('notify-forged'),
        { ...forged, traceId: `${prefix}-notify-forged` },
        fixture.provider,
      ),
    ).rejects.toMatchObject({ code: 'WECHATPAY_REFUND_NOTIFICATION_SIGNATURE_INVALID' })
    const rejected = await payload.find({
      collection: 'refundNotifications',
      overrideAccess: true,
      where: { payloadDigest: { equals: paymentPayloadDigest(forged.body) } },
    })
    if (rejected.docs[0]) rejectedRefundNotificationIds.push(rejected.docs[0].id)
    expect(rejected.docs[0]).toMatchObject({
      amountMinor: null,
      confirmationStatus: 'rejected',
      providerRefundId: null,
      refundNumber: null,
      signatureVerified: false,
    })

    const mismatch = fixture.refundNotification({
      amountMinor: setup.amountMinor + 1,
      merchantOrderNumber: setup.merchantOrderNumber,
      notificationId: randomUUID(),
      providerRefundId,
      refundNumber: requested.refundNumber,
      refundedAt: now.toISOString(),
    })
    await processWechatRefundNotification(
      await request('notify-mismatch'),
      { ...mismatch, traceId: `${prefix}-notify-mismatch` },
      fixture.provider,
    )
    expect(
      (await payload.findByID({ collection: 'orders', id: setup.order.id, overrideAccess: true }))
        .status,
    ).toBe('manual_review')

    const first = await processWechatRefundNotification(
      await request('notify-first'),
      { ...notification, traceId: `${prefix}-notify-first` },
      fixture.provider,
    )
    const replay = await processWechatRefundNotification(
      await request('notify-replay'),
      { ...notification, traceId: `${prefix}-notify-replay` },
      fixture.provider,
    )
    expect(first.idempotentReplay).toBe(false)
    expect(replay.idempotentReplay).toBe(true)
    expect(
      (await payload.findByID({ collection: 'orders', id: setup.order.id, overrideAccess: true }))
        .status,
    ).toBe('refunded')
  })
})

describe('D5-04 separated reconciliation ledgers', () => {
  it('keeps Wechat funds and Westdigital prepaid balance separate and records differences without correction', async () => {
    const setup = await createPaidOrder('reconcile', { amountMinor: 10_000 })
    const req = await request('reconcile')
    const [wechatResult] = await reconcileWechatFunds(req, {
      entries: [
        {
          amountMinor: 9_900,
          currency: 'CNY',
          merchantOrderNumber: setup.merchantOrderNumber,
          type: 'payment',
          wechatTransactionId: `${prefix}-transaction`,
        },
      ],
      period,
      traceId: `${prefix}-wechat-reconciliation`,
    })
    const westdigitalResult = await reconcileWestdigitalPrepaidBalance(req, {
      period,
      statement: {
        closingAvailableMinor: 89_000,
        closingFrozenMinor: 100,
        creditsMinor: 0,
        debits: [{ amountMinor: 10_000, operationKey: `${prefix}-register` }],
        openingAvailableMinor: 100_000,
        openingFrozenMinor: 0,
      },
      traceId: `${prefix}-westdigital-reconciliation`,
    })
    expect(wechatResult.record).toMatchObject({
      differenceMinor: -100,
      kind: 'wechat',
      ledger: 'wechat_funds',
      status: 'difference',
    })
    expect(westdigitalResult.record).toMatchObject({
      differenceMinor: -1_000,
      kind: 'westdigital',
      ledger: 'westdigital_prepaid',
      status: 'difference',
    })
    const threeWay = await recordThreeWayDifference(req, {
      orderNumber: setup.order.orderNumber,
      period,
      traceId: `${prefix}-three-way-reconciliation`,
      wechatReconciliationKey: wechatResult.record.reconciliationKey,
      westdigitalReconciliationKey: westdigitalResult.record.reconciliationKey,
    })
    expect(threeWay.record).toMatchObject({
      differenceMinor: 1_100,
      kind: 'three_way',
      ledger: 'internal_orders',
      status: 'difference',
      summary: { correctionApplied: false },
    })
    expect(
      (await payload.findByID({ collection: 'orders', id: setup.order.id, overrideAccess: true }))
        .amountMinor,
    ).toBe(10_000)
    expect(
      await reconcileWestdigitalPrepaidBalance(req, {
        period,
        statement: {
          closingAvailableMinor: 89_000,
          closingFrozenMinor: 100,
          creditsMinor: 0,
          debits: [{ amountMinor: 10_000, operationKey: `${prefix}-register` }],
          openingAvailableMinor: 100_000,
          openingFrozenMinor: 0,
        },
        traceId: `${prefix}-westdigital-replay`,
      }),
    ).toMatchObject({ idempotentReplay: true })
  })
})
