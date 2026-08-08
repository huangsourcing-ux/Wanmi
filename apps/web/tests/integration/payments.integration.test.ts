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
} from '@/services/commerce/payments'

import { realnameTemplateFixture } from '../fixtures/realname'

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
    limit: 100,
    overrideAccess: true,
    where: { orderNumber: { contains: prefix } },
  })
  for (const order of orders.docs) {
    for (const collection of ['orderEvents', 'paymentNotifications', 'manualReviews'] as const) {
      const rows = await payload.find({
        collection,
        limit: 100,
        overrideAccess: true,
        where: { order: { equals: order.id } },
      })
      for (const row of rows.docs) {
        await payload.delete({ collection, id: row.id, overrideAccess: true })
      }
    }
    await payload.delete({ collection: 'orders', id: order.id, overrideAccess: true })
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
      await payload.delete({ collection, id: row.id, overrideAccess: true })
    }
  }
  for (const id of rejectedNotificationIds) {
    await payload.delete({ collection: 'paymentNotifications', id, overrideAccess: true })
  }
  await payload.db.destroy?.()
})

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
  })

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
})
