import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mockFailure } from '@/providers/mock'
import type { PaymentProvider } from '@/providers/types'
import { createWechatPayFixture, paymentPayloadDigest } from '@/providers/wechatpay'
import {
  createWechatPayment,
  processWechatPaymentNotification,
  queryAndConfirmWechatPayment,
  reconcileWechatPaymentByOrder,
  replayArchivedWechatPaymentNotification,
  runPaymentTimeoutClose,
} from '@/services/commerce/payments'
import { recordManualOrderAction } from '@/services/commerce/manual-actions'

import { realnameTemplateFixture } from '../fixtures/realname'
import { ensureAnchorSystemAdmin, ignorePayloadNotFound } from '../test-cleanup'

const prefix = `d5-payments-${randomUUID()}`
const now = new Date('2026-08-08T02:00:00.000Z')
let payload: Payload
const rejectedNotificationIds: Array<number | string> = []

function notificationId(): string {
  return `EV${randomUUID().replaceAll('-', '')}`
}

async function customerRequest(customer: unknown, suffix: string): Promise<PayloadRequest> {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${prefix}-${suffix}` }) } },
    payload,
  )
  req.user = customer as never
  return req
}

async function systemAdminRequest(suffix: string): Promise<PayloadRequest> {
  const admin = await ensureAnchorSystemAdmin(payload)
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${prefix}-${suffix}` }) } },
    payload,
  )
  req.user = { ...admin, collection: 'admins' } as never
  return req
}

const evidence = {
  observedAt: now.toISOString(),
  reference: 'WECHAT-CONSOLE-D5-07',
  source: 'provider_query' as const,
}

async function createPendingOrder(suffix: string, amountMinor = 12_300) {
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
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor,
      currency: 'CNY',
      customer: customer.id,
      domainAscii: `${suffix}.example`,
      orderNumber: `${prefix}-${suffix}`,
      quote: quote.id,
      quoteSnapshot: { expiresAt: new Date(now.getTime() + 240_000).toISOString() },
      realnameTemplate: template.id,
      status: 'pending_payment',
    },
    overrideAccess: true,
  })
  return {
    amountMinor,
    customer: { ...customer, collection: 'customers' as const, id: Number(customer.id) },
    order,
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  const orders = await payload.find({
    collection: 'orders',
    limit: 500,
    overrideAccess: true,
    where: { orderNumber: { contains: prefix } },
  })
  const orderIds = orders.docs.map((order) => order.id)
  if (orderIds.length) {
    for (const collection of [
      'orderEvents',
      'paymentNotifications',
      'paymentNotificationArchives',
      'orderManualActions',
      'refunds',
      'manualReviews',
    ] as const) {
      const rows = await payload.find({
        collection,
        limit: 500,
        overrideAccess: true,
        where: { order: { in: orderIds } },
      })
      for (const row of rows.docs) {
        await ignorePayloadNotFound(() =>
          payload.delete({ collection, id: row.id, overrideAccess: true }),
        )
      }
    }
    const orderIdSet = new Set(orderIds.map(String))
    const fulfillmentJobs = await payload.find({
      collection: 'payload-jobs',
      limit: 500,
      overrideAccess: true,
      where: { workflowSlug: { equals: 'commerceFulfillment' } },
    })
    for (const job of fulfillmentJobs.docs) {
      if (orderIdSet.has(String((job.input as { orderId?: number }).orderId))) {
        await ignorePayloadNotFound(() =>
          payload.delete({ collection: 'payload-jobs', id: job.id, overrideAccess: true }),
        )
      }
    }
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 500,
    overrideAccess: true,
    where: {
      and: [
        { traceId: { contains: prefix } },
        { targetType: { in: ['order', 'payment-notification'] } },
      ],
    },
  })
  for (const audit of audits.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true }),
    )
  }
  for (const order of orders.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'orders', id: order.id, overrideAccess: true }),
    )
  }
  for (const collection of ['quotes', 'realnameTemplates', 'customers'] as const) {
    const field =
      collection === 'quotes'
        ? 'createdTraceId'
        : collection === 'customers'
          ? 'phone'
          : 'displayName'
    const rows = await payload.find({
      collection,
      limit: 100,
      overrideAccess: true,
      where: { [field]: { contains: prefix } },
    })
    for (const row of rows.docs) {
      await ignorePayloadNotFound(() =>
        payload.delete({ collection, id: row.id, overrideAccess: true }),
      )
    }
  }
  for (const id of rejectedNotificationIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'paymentNotifications', id, overrideAccess: true }),
    )
  }
  await payload.db.destroy?.()
}, 60_000)

describe('D5-03 Wechat Pay confirmation', () => {
  it('uses the quote expiry, confirms by server query and replays one notification idempotently', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const setup = await createPendingOrder('confirmed')
    const req = await customerRequest(setup.customer, 'confirmed-create')
    const session = await createWechatPayment(
      req,
      setup.order.orderNumber,
      { channel: 'native' },
      {
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-confirmed-session`,
      },
    )
    expect(session).toMatchObject({
      data: {
        channel: 'native',
        expiresAt: new Date(now.getTime() + 240_000).toISOString(),
      },
    })
    const merchantOrderNumber = session.data.merchantOrderNumber
    const paidAt = new Date(now.getTime() + 60_000).toISOString()
    const transactionId = '42000000000000000000000000000011'
    fixture.setOrder({
      amountMinor: setup.amountMinor,
      merchantOrderNumber,
      paidAt,
      state: 'paid',
      transactionId,
    })
    const notification = fixture.notification({
      amountMinor: setup.amountMinor,
      merchantOrderNumber,
      notificationId: notificationId(),
      paidAt,
      transactionId,
    })
    const first = await processWechatPaymentNotification(
      await createLocalReq({}, payload),
      { ...notification, traceId: `${prefix}-confirmed-notify` },
      fixture.provider,
    )
    const replay = await processWechatPaymentNotification(
      await createLocalReq({}, payload),
      { ...notification, traceId: `${prefix}-confirmed-replay` },
      fixture.provider,
    )
    expect(first.idempotentReplay).toBe(false)
    expect(replay.idempotentReplay).toBe(true)

    const storedOrder = await payload.findByID({
      collection: 'orders',
      id: setup.order.id,
      overrideAccess: true,
    })
    expect(storedOrder).toMatchObject({
      merchantOrderNumber,
      paidAt,
      paymentChannel: 'native',
      status: 'paid',
    })
    const notifications = await payload.find({
      collection: 'paymentNotifications',
      overrideAccess: true,
      where: { order: { equals: setup.order.id } },
    })
    expect(notifications.docs).toHaveLength(1)
    expect(notifications.docs[0]).toMatchObject({
      amountMinor: setup.amountMinor,
      confirmationStatus: 'confirmed',
      currency: 'CNY',
      merchantOrderNumber,
      paidAt,
      signatureVerified: true,
      source: 'notification',
      wechatTransactionId: transactionId,
    })
    const events = await payload.find({
      collection: 'orderEvents',
      overrideAccess: true,
      where: { order: { equals: setup.order.id } },
    })
    expect(events.docs).toHaveLength(1)
    expect(events.docs[0]).toMatchObject({
      fromStatus: 'pending_payment',
      reasonCode: 'wechatpay.payment_confirmed',
      toStatus: 'paid',
    })
    const fulfillmentJobs = await payload.find({
      collection: 'payload-jobs',
      overrideAccess: true,
      where: { workflowSlug: { equals: 'commerceFulfillment' } },
    })
    expect(
      fulfillmentJobs.docs.filter(
        (job) => (job.input as { orderId?: number }).orderId === setup.order.id,
      ),
    ).toHaveLength(1)

    await expect(
      payload.create({
        collection: 'paymentNotifications',
        data: {
          amountMinor: setup.amountMinor,
          confirmationStatus: 'confirmed',
          currency: 'CNY',
          merchantOrderNumber,
          notificationId: `${prefix}-duplicate-constraint`,
          paidAt,
          payloadDigest: '3'.repeat(64),
          receivedAt: now.toISOString(),
          signatureVerified: true,
          source: 'notification',
          wechatTransactionId: transactionId,
        },
        overrideAccess: true,
      }),
    ).rejects.toThrow()
  })

  it('records forged notifications without trusting their identifiers or advancing the order', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const setup = await createPendingOrder('forged')
    const session = await createWechatPayment(
      await customerRequest(setup.customer, 'forged-create'),
      setup.order.orderNumber,
      { channel: 'h5' },
      {
        clientIp: '192.0.2.40',
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-forged-session`,
      },
    )
    const forged = fixture.notification({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: session.data.merchantOrderNumber,
      notificationId: notificationId(),
      paidAt: now.toISOString(),
      transactionId: '42000000000000000000000000000012',
    })
    forged.headers.set('wechatpay-signature', 'WECHATPAY/SIGNTEST/invalid')
    await expect(
      processWechatPaymentNotification(
        await createLocalReq({}, payload),
        { ...forged, traceId: `${prefix}-forged-notify` },
        fixture.provider,
      ),
    ).rejects.toMatchObject({ code: 'WECHATPAY_NOTIFICATION_SIGNATURE_INVALID' })
    expect(
      (await payload.findByID({ collection: 'orders', id: setup.order.id, overrideAccess: true }))
        .status,
    ).toBe('pending_payment')
    const rejected = await payload.find({
      collection: 'paymentNotifications',
      overrideAccess: true,
      where: { payloadDigest: { equals: paymentPayloadDigest(forged.body) } },
    })
    const row = rejected.docs[0]
    if (row) rejectedNotificationIds.push(row.id)
    expect(row).toMatchObject({
      amountMinor: null,
      confirmationStatus: 'rejected',
      merchantOrderNumber: null,
      signatureVerified: false,
      wechatTransactionId: null,
    })
  })

  it('moves confirmed amount mismatches and unknown query results to manual review', async () => {
    const mismatchFixture = createWechatPayFixture({ now: () => now })
    const mismatch = await createPendingOrder('mismatch')
    const mismatchSession = await createWechatPayment(
      await customerRequest(mismatch.customer, 'mismatch-create'),
      mismatch.order.orderNumber,
      { channel: 'native' },
      {
        customer: mismatch.customer,
        now: () => now,
        provider: mismatchFixture.provider,
        traceId: `${prefix}-mismatch-session`,
      },
    )
    const mismatchPaidAt = new Date(now.getTime() + 30_000).toISOString()
    const mismatchTransaction = '42000000000000000000000000000013'
    mismatchFixture.setOrder({
      amountMinor: mismatch.amountMinor + 1,
      merchantOrderNumber: mismatchSession.data.merchantOrderNumber,
      paidAt: mismatchPaidAt,
      state: 'paid',
      transactionId: mismatchTransaction,
    })
    await processWechatPaymentNotification(
      await createLocalReq({}, payload),
      {
        ...mismatchFixture.notification({
          amountMinor: mismatch.amountMinor + 1,
          merchantOrderNumber: mismatchSession.data.merchantOrderNumber,
          notificationId: notificationId(),
          paidAt: mismatchPaidAt,
          transactionId: mismatchTransaction,
        }),
        traceId: `${prefix}-mismatch-notify`,
      },
      mismatchFixture.provider,
    )
    expect(
      (
        await payload.findByID({
          collection: 'orders',
          id: mismatch.order.id,
          overrideAccess: true,
        })
      ).status,
    ).toBe('manual_review')

    const unknownFixture = createWechatPayFixture({ now: () => now })
    const unknown = await createPendingOrder('unknown')
    await createWechatPayment(
      await customerRequest(unknown.customer, 'unknown-create'),
      unknown.order.orderNumber,
      { channel: 'native' },
      {
        customer: unknown.customer,
        now: () => now,
        provider: unknownFixture.provider,
        traceId: `${prefix}-unknown-session`,
      },
    )
    const unknownProvider: PaymentProvider = {
      closeOrder: (input) => unknownFixture.provider.closeOrder(input),
      createPayment: (input) => unknownFixture.provider.createPayment(input),
      health: () => unknownFixture.provider.health(),
      queryOrder: async () =>
        mockFailure('WECHATPAY_QUERY_TIMEOUT', { retryable: true, statusKnown: false }),
      verifyNotification: (input) => unknownFixture.provider.verifyNotification(input),
    }
    await queryAndConfirmWechatPayment(
      await customerRequest(unknown.customer, 'unknown-query'),
      unknown.order.orderNumber,
      {
        customer: unknown.customer,
        provider: unknownProvider,
        traceId: `${prefix}-unknown-query`,
      },
    )
    expect(
      (await payload.findByID({ collection: 'orders', id: unknown.order.id, overrideAccess: true }))
        .status,
    ).toBe('manual_review')
    const reviews = await payload.find({
      collection: 'manualReviews',
      overrideAccess: true,
      where: { order: { equals: unknown.order.id } },
    })
    expect(reviews.docs).toHaveLength(1)
    expect(reviews.docs[0]).toMatchObject({ status: 'open' })
  }, 60_000)

  it('keeps a known NOTPAY query pending and never treats browser polling as payment success', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const setup = await createPendingOrder('notpay')
    await createWechatPayment(
      await customerRequest(setup.customer, 'notpay-create'),
      setup.order.orderNumber,
      { channel: 'native' },
      {
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-notpay-session`,
      },
    )
    const result = await queryAndConfirmWechatPayment(
      await customerRequest(setup.customer, 'notpay-query'),
      setup.order.orderNumber,
      {
        customer: setup.customer,
        provider: fixture.provider,
        traceId: `${prefix}-notpay-query`,
      },
    )
    expect(result.data.status).toBe('pending_payment')
    expect(
      (await payload.findByID({ collection: 'orders', id: setup.order.id, overrideAccess: true }))
        .status,
    ).toBe('pending_payment')
  })

  it('rate limits status polling and never exposes another customer order', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const setup = await createPendingOrder('poll-limit')
    await createWechatPayment(
      await customerRequest(setup.customer, 'poll-limit-create'),
      setup.order.orderNumber,
      { channel: 'native' },
      {
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-poll-limit-create`,
      },
    )
    const req = await customerRequest(setup.customer, 'poll-limit-query')
    await queryAndConfirmWechatPayment(req, setup.order.orderNumber, {
      customer: setup.customer,
      now: () => now,
      provider: fixture.provider,
      traceId: `${prefix}-poll-limit-first`,
    })
    await expect(
      queryAndConfirmWechatPayment(req, setup.order.orderNumber, {
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-poll-limit-second`,
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_STATUS_RATE_LIMITED', status: 429 })

    const stranger = await createPendingOrder('poll-stranger')
    await expect(
      queryAndConfirmWechatPayment(
        await customerRequest(stranger.customer, 'poll-stranger-query'),
        setup.order.orderNumber,
        {
          customer: stranger.customer,
          now: () => new Date(now.getTime() + 5_000),
          provider: fixture.provider,
          traceId: `${prefix}-poll-stranger`,
        },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', status: 404 })
  })

  it('closes an expired unpaid order only after WeChat reports CLOSED and is idempotent', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const setup = await createPendingOrder('timeout-close')
    await createWechatPayment(
      await customerRequest(setup.customer, 'timeout-close-create'),
      setup.order.orderNumber,
      { channel: 'native' },
      {
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-timeout-close-create`,
      },
    )
    const jobReq = await createLocalReq({}, payload)
    const first = await runPaymentTimeoutClose(jobReq, {
      now: new Date(now.getTime() + 300_000),
      orderId: setup.order.id,
      provider: fixture.provider,
      traceId: `${prefix}-timeout-close`,
    })
    expect(first).toEqual({ cancelled: 1, checked: 1, failed: 0, paid: 0, unchanged: 0 })
    expect(
      (await payload.findByID({ collection: 'orders', id: setup.order.id, overrideAccess: true }))
        .status,
    ).toBe('cancelled')
    const events = await payload.find({
      collection: 'orderEvents',
      overrideAccess: true,
      where: { order: { equals: setup.order.id } },
    })
    expect(events.docs).toHaveLength(1)
    expect(events.docs[0]).toMatchObject({
      fromStatus: 'pending_payment',
      reasonCode: 'wechatpay.payment_expired_closed',
      toStatus: 'cancelled',
    })
    await expect(
      runPaymentTimeoutClose(jobReq, {
        now: new Date(now.getTime() + 300_000),
        orderId: setup.order.id,
        provider: fixture.provider,
        traceId: `${prefix}-timeout-close-replay`,
      }),
    ).resolves.toEqual({ cancelled: 0, checked: 0, failed: 0, paid: 0, unchanged: 0 })
  })

  it('moves a cancelled order with a confirmed late payment to manual review exactly once', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const setup = await createPendingOrder('late-payment')
    const session = await createWechatPayment(
      await customerRequest(setup.customer, 'late-payment-create'),
      setup.order.orderNumber,
      { channel: 'native' },
      {
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-late-payment-create`,
      },
    )
    const jobReq = await createLocalReq({}, payload)
    await expect(
      runPaymentTimeoutClose(jobReq, {
        now: new Date(now.getTime() + 300_000),
        orderId: setup.order.id,
        provider: fixture.provider,
        traceId: `${prefix}-late-payment-close`,
      }),
    ).resolves.toEqual({ cancelled: 1, checked: 1, failed: 0, paid: 0, unchanged: 0 })

    const paidAt = new Date(now.getTime() + 360_000).toISOString()
    const transactionId = '42000000000000000000000000000015'
    fixture.setOrder({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: session.data.merchantOrderNumber,
      paidAt,
      state: 'paid',
      transactionId,
    })
    const notification = fixture.notification({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: session.data.merchantOrderNumber,
      notificationId: notificationId(),
      paidAt,
      transactionId,
    })
    const first = await processWechatPaymentNotification(
      await createLocalReq({}, payload),
      { ...notification, traceId: `${prefix}-late-payment-notify` },
      fixture.provider,
    )
    const replay = await processWechatPaymentNotification(
      await createLocalReq({}, payload),
      { ...notification, traceId: `${prefix}-late-payment-replay` },
      fixture.provider,
    )
    expect(first.idempotentReplay).toBe(false)
    expect(replay.idempotentReplay).toBe(true)

    const storedOrder = await payload.findByID({
      collection: 'orders',
      id: setup.order.id,
      overrideAccess: true,
    })
    expect(storedOrder).toMatchObject({ paidAt, status: 'manual_review' })
    const events = await payload.find({
      collection: 'orderEvents',
      overrideAccess: true,
      sort: 'createdAt',
      where: { order: { equals: setup.order.id } },
    })
    expect(events.docs).toHaveLength(2)
    expect(events.docs).toEqual([
      expect.objectContaining({
        fromStatus: 'pending_payment',
        reasonCode: 'wechatpay.payment_expired_closed',
        toStatus: 'cancelled',
      }),
      expect.objectContaining({
        evidence: expect.objectContaining({ queryState: 'paid', source: 'notification' }),
        fromStatus: 'cancelled',
        reasonCode: 'wechatpay.late_payment',
        toStatus: 'manual_review',
      }),
    ])
    const reviews = await payload.find({
      collection: 'manualReviews',
      overrideAccess: true,
      where: { order: { equals: setup.order.id } },
    })
    expect(reviews.docs).toHaveLength(1)
    expect(reviews.docs[0]).toMatchObject({
      evidence: expect.objectContaining({ queryState: 'paid', source: 'notification' }),
      reasonCode: 'wechatpay.late_payment',
      status: 'open',
    })
    const notifications = await payload.find({
      collection: 'paymentNotifications',
      overrideAccess: true,
      where: {
        and: [{ order: { equals: setup.order.id } }, { source: { equals: 'notification' } }],
      },
    })
    expect(notifications.docs).toHaveLength(1)
    expect(notifications.docs[0]).toMatchObject({
      amountMinor: setup.amountMinor,
      confirmationStatus: 'confirmed',
      merchantOrderNumber: session.data.merchantOrderNumber,
      wechatTransactionId: transactionId,
    })
    const fulfillmentJobs = await payload.find({
      collection: 'payload-jobs',
      overrideAccess: true,
      where: { workflowSlug: { equals: 'commerceFulfillment' } },
    })
    expect(
      fulfillmentJobs.docs.filter(
        (job) =>
          typeof job.input === 'object' &&
          job.input !== null &&
          !Array.isArray(job.input) &&
          job.input.orderId === setup.order.id,
      ),
    ).toHaveLength(0)
    const fulfillmentOperations = await payload.find({
      collection: 'providerOperations',
      overrideAccess: true,
      where: {
        and: [{ order: { equals: setup.order.id } }, { operation: { equals: 'register' } }],
      },
    })
    expect(fulfillmentOperations.docs).toHaveLength(0)
  })

  it('confirms a paid expired order instead of cancelling it', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const setup = await createPendingOrder('timeout-paid')
    const session = await createWechatPayment(
      await customerRequest(setup.customer, 'timeout-paid-create'),
      setup.order.orderNumber,
      { channel: 'native' },
      {
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-timeout-paid-create`,
      },
    )
    fixture.setOrder({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: session.data.merchantOrderNumber,
      paidAt: new Date(now.getTime() + 120_000).toISOString(),
      state: 'paid',
      transactionId: '42000000000000000000000000000014',
    })
    const result = await runPaymentTimeoutClose(await createLocalReq({}, payload), {
      now: new Date(now.getTime() + 300_000),
      orderId: setup.order.id,
      provider: fixture.provider,
      traceId: `${prefix}-timeout-paid`,
    })
    expect(result).toEqual({ cancelled: 0, checked: 1, failed: 0, paid: 1, unchanged: 0 })
    expect(
      (await payload.findByID({ collection: 'orders', id: setup.order.id, overrideAccess: true }))
        .status,
    ).toBe('paid')
  })

  it('does not cancel when a close request fails and the follow-up query is still NOTPAY', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const setup = await createPendingOrder('closefail')
    await createWechatPayment(
      await customerRequest(setup.customer, 'closefail-create'),
      setup.order.orderNumber,
      { channel: 'native' },
      {
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-closefail-create`,
      },
    )
    const closeFailureProvider: PaymentProvider = {
      closeOrder: async () =>
        mockFailure('WECHATPAY_CLOSE_TIMEOUT', { retryable: true, statusKnown: false }),
      createPayment: (input) => fixture.provider.createPayment(input),
      health: () => fixture.provider.health(),
      queryOrder: (input) => fixture.provider.queryOrder(input),
      verifyNotification: (input) => fixture.provider.verifyNotification(input),
    }
    const result = await runPaymentTimeoutClose(await createLocalReq({}, payload), {
      now: new Date(now.getTime() + 300_000),
      orderId: setup.order.id,
      provider: closeFailureProvider,
      traceId: `${prefix}-closefail`,
    })
    expect(result).toEqual({ cancelled: 0, checked: 1, failed: 0, paid: 0, unchanged: 1 })
    expect(
      (await payload.findByID({ collection: 'orders', id: setup.order.id, overrideAccess: true }))
        .status,
    ).toBe('pending_payment')
  })

  it('replays only a verified archive through the existing query and idempotency path', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const setup = await createPendingOrder('archive-replay')
    const session = await createWechatPayment(
      await customerRequest(setup.customer, 'archive-replay-create'),
      setup.order.orderNumber,
      { channel: 'native' },
      {
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-archive-create`,
      },
    )
    const transactionId = '42000000000000000000000000000031'
    fixture.setOrder({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: session.data.merchantOrderNumber,
      paidAt: now.toISOString(),
      state: 'paid',
      transactionId,
    })
    const notification = fixture.notification({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: session.data.merchantOrderNumber,
      notificationId: notificationId(),
      paidAt: now.toISOString(),
      transactionId,
    })
    const throwingProvider: PaymentProvider = {
      closeOrder: (input) => fixture.provider.closeOrder(input),
      createPayment: (input) => fixture.provider.createPayment(input),
      health: () => fixture.provider.health(),
      queryOrder: async () => {
        throw new Error('simulated restart after verified archive')
      },
      verifyNotification: (input) => fixture.provider.verifyNotification(input),
    }
    await expect(
      processWechatPaymentNotification(
        await createLocalReq({}, payload),
        { ...notification, traceId: `${prefix}-archive-interrupted` },
        throwingProvider,
      ),
    ).rejects.toThrow('simulated restart')
    const archive = await payload.find({
      collection: 'paymentNotificationArchives',
      overrideAccess: true,
      where: { order: { equals: setup.order.id } },
    })
    expect(archive.docs[0]).toMatchObject({ processingStatus: 'failed', signatureVerified: true })
    expect(
      await replayArchivedWechatPaymentNotification(
        await systemAdminRequest('archive-replay-admin'),
        archive.docs[0]!.notificationId,
        {
          evidence,
          note: '服务重启后重放已验签归档',
          provider: fixture.provider,
          traceId: `${prefix}-archive-replay`,
        },
      ),
    ).toMatchObject({ idempotentReplay: false, orderStatus: 'paid' })
    expect(
      await replayArchivedWechatPaymentNotification(
        await systemAdminRequest('archive-replay-again'),
        archive.docs[0]!.notificationId,
        {
          evidence,
          note: '验证重复重放不重复迁移',
          provider: fixture.provider,
          traceId: `${prefix}-archive-replay-again`,
        },
      ),
    ).toMatchObject({ idempotentReplay: true, orderStatus: 'paid' })
    const events = await payload.find({
      collection: 'orderEvents',
      overrideAccess: true,
      where: { order: { equals: setup.order.id } },
    })
    expect(events.docs).toHaveLength(1)
  })

  it('reconciles only from an active provider query and audits bounded manual finance records', async () => {
    const fixture = createWechatPayFixture({ now: () => now })
    const setup = await createPendingOrder('admin-reconcile', 10_000)
    const session = await createWechatPayment(
      await customerRequest(setup.customer, 'admin-reconcile-create'),
      setup.order.orderNumber,
      { channel: 'native' },
      {
        customer: setup.customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-admin-create`,
      },
    )
    fixture.setOrder({
      amountMinor: setup.amountMinor,
      merchantOrderNumber: session.data.merchantOrderNumber,
      paidAt: now.toISOString(),
      state: 'paid',
      transactionId: '42000000000000000000000000000032',
    })
    const req = await systemAdminRequest('admin-reconcile')
    await expect(
      reconcileWechatPaymentByOrder(req, setup.order.orderNumber, {
        evidence,
        note: '主动查单补齐付款状态',
        provider: fixture.provider,
        traceId: `${prefix}-admin-reconcile`,
      }),
    ).resolves.toMatchObject({ orderStatus: 'paid', providerState: 'paid' })
    await recordManualOrderAction(req, setup.order.orderNumber, {
      actionType: 'invoice_note',
      evidence,
      reason: '已交由现有财务流程开票',
    })
    await recordManualOrderAction(req, setup.order.orderNumber, {
      actionType: 'special_refund',
      amountMinor: 4_000,
      evidence,
      reason: '争议订单人工财务退款记录',
    })
    const concurrentRefunds = await Promise.allSettled([
      recordManualOrderAction(
        await systemAdminRequest('admin-special-refund-race-a'),
        setup.order.orderNumber,
        {
          actionType: 'special_refund',
          amountMinor: 4_000,
          evidence,
          reason: '并发退款额度竞争 A',
        },
      ),
      recordManualOrderAction(
        await systemAdminRequest('admin-special-refund-race-b'),
        setup.order.orderNumber,
        {
          actionType: 'special_refund',
          amountMinor: 4_000,
          evidence,
          reason: '并发退款额度竞争 B',
        },
      ),
    ])
    expect(concurrentRefunds.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(concurrentRefunds.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(concurrentRefunds.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'REFUND_AMOUNT_EXCEEDS_PAYMENT' },
    })
    await expect(
      recordManualOrderAction(
        await systemAdminRequest('admin-special-refund-over'),
        setup.order.orderNumber,
        {
          actionType: 'special_refund',
          amountMinor: 2_001,
          evidence,
          reason: '不得超出剩余可记录金额',
        },
      ),
    ).rejects.toMatchObject({ code: 'REFUND_AMOUNT_EXCEEDS_PAYMENT' })
    const actions = await payload.find({
      collection: 'orderManualActions',
      overrideAccess: true,
      where: { order: { equals: setup.order.id } },
    })
    expect(actions.docs).toHaveLength(3)
    expect(actions.docs.reduce((total, action) => total + (action.amountMinor ?? 0), 0)).toBe(8_000)
    await payload.create({
      collection: 'refunds',
      data: {
        amountMinor: 2_000,
        createdTraceId: `${prefix}-reserved-refund`,
        currency: 'CNY',
        order: setup.order.id,
        refundNumber: `WR${randomUUID().replaceAll('-', '')}`,
        status: 'pending',
      },
      overrideAccess: true,
    })
    await expect(
      recordManualOrderAction(
        await systemAdminRequest('admin-refund-reserved'),
        setup.order.orderNumber,
        {
          actionType: 'special_refund',
          amountMinor: 1,
          evidence,
          reason: '自动退款已占满剩余额度',
        },
      ),
    ).rejects.toMatchObject({ code: 'REFUND_AMOUNT_EXCEEDS_PAYMENT' })
    await payload.update({
      collection: 'orders',
      data: { status: 'succeeded' },
      id: setup.order.id,
      overrideAccess: true,
    })
    await expect(
      recordManualOrderAction(req, setup.order.orderNumber, {
        actionType: 'special_refund',
        amountMinor: 1,
        evidence,
        reason: '成功订单不可退款',
      }),
    ).rejects.toMatchObject({ code: 'SUCCEEDED_ORDER_REFUND_FORBIDDEN' })
    const unauthorized = await createLocalReq({}, payload)
    await expect(
      recordManualOrderAction(unauthorized, setup.order.orderNumber, {
        actionType: 'invoice_note',
        evidence,
        reason: '无权限操作',
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_ROLE_REQUIRED' })
  })
})
