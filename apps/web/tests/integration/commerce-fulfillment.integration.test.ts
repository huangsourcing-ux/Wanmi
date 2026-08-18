import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mockSuccess } from '@/providers/mock'
import type { ProviderResult } from '@/lib/domain'
import type { WestDigitalAvailability, WestDigitalWriteProvider } from '@/providers/types'
import {
  FixtureWestDigitalWriteTransport,
  timeoutAfterSubmission,
} from '@/providers/westdigital-write-fixtures'
import {
  WestDigitalWriteAdapter,
  WestDigitalWriteTransportError,
} from '@/providers/westdigital-write'
import {
  enqueueCommerceFulfillment,
  runCommerceFulfillment,
  type FulfillmentDependencies,
} from '@/services/commerce/fulfillment'
import { requestAutomaticRegistrationFailureRefund } from '@/services/commerce/refunds'
import { submitRealnameTemplate, syncRealnameTemplateStatus } from '@/services/realname/templates'

import { fulfillmentQuoteSnapshotFixture } from '../fixtures/commerce'
import { approvedRealnameProviderFixture, realnameTemplateFixture } from '../fixtures/realname'

const prefix = `d6-fulfillment-${randomUUID()}`
let payload: Payload

function assetResponse(domain: string, clientid = 'asset-query') {
  return {
    body: {
      clientid,
      data: {
        dns1: 'ns1.myhostadmin.net',
        dns2: 'ns2.myhostadmin.net',
        dns3: '',
        dns4: '',
        dns5: '',
        dns6: '',
        domain,
        expdate: '2027-08-08 12:00:00',
        id: '44169980',
        regdate: '2026-08-08 12:00:00',
        registrars: 'west',
      },
      result: 200,
    },
    status: 200,
  }
}

function registrationResponse(domain: string) {
  return {
    body: { clientid: 'registration-write', data: { [domain]: 200 }, result: 200 },
    status: 200,
  }
}

async function request(suffix: string): Promise<PayloadRequest> {
  return createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${prefix}-${suffix}` }) } },
    payload,
  )
}

async function createPaidOrder(suffix: string, options: { expiredQuote?: boolean } = {}) {
  const customer = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: [],
      phone: `${prefix}-${suffix}`,
      phoneMasked: `***${suffix}`,
      status: 'active',
    },
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
  const customerReq = await request(`realname-${suffix}`)
  customerReq.user = { ...customer, collection: 'customers' } as never
  const realnameProvider = approvedRealnameProviderFixture()
  await submitRealnameTemplate(customerReq, template.id, realnameProvider)
  const approvedTemplate = await syncRealnameTemplateStatus(
    await request(`realname-sync-${suffix}`),
    template.id,
    realnameProvider,
  )
  const domainAscii = `${suffix}-${randomUUID()}.com`
  const quote = await payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: new Date().toISOString(),
      availabilityRequestId: `${prefix}-availability-${suffix}`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `${prefix}-quote-${suffix}`,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: new Date().toISOString(),
      providerProductId: `${prefix}-product-${suffix}`,
      providerRequestId: `${prefix}-price-${suffix}`,
      quotedAt: new Date().toISOString(),
      quoteIntegrityHash: '2'.repeat(64),
      quoteRef: randomUUID(),
      registrationPriceMinor: 2_999,
      renewalPriceMinor: 2_999,
      ruleFixedAmountMinor: 0,
      ruleKey: `${prefix}-rule-${suffix}`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
      roundingMode: 'half_up_to_fen',
      schemaVersion: 1,
      sourceCalculationHash: '3'.repeat(64),
      sourcePriceSnapshotRef: randomUUID(),
      tld: 'com',
      upstreamCostMinor: 2_999,
      upstreamRegistrationPriceMinor: 2_999,
      upstreamRenewalPriceMinor: 2_999,
      userPriceMinor: 2_999,
      years: 1,
    },
    overrideAccess: true,
  })
  const paidAt = new Date().toISOString()
  const merchantOrderNumber = `WM${randomUUID().replaceAll('-', '')}`
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor: 2_999,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      merchantOrderNumber,
      orderNumber: `${prefix}-${suffix}-${randomUUID()}`,
      paidAt,
      paymentChannel: 'native',
      quote: quote.id,
      quoteSnapshot: fulfillmentQuoteSnapshotFixture({
        amountMinor: 2_999,
        customerId: customer.id,
        domainAscii,
        expiresAt: options.expiredQuote ? new Date(Date.now() - 60_000).toISOString() : undefined,
        quoteId: quote.id,
      }),
      realnameTemplate: template.id,
      status: 'paid',
    },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'paymentNotifications',
    data: {
      amountMinor: 2_999,
      confirmationStatus: 'confirmed',
      currency: 'CNY',
      merchantOrderNumber,
      notificationId: `PAY-${randomUUID()}`,
      order: order.id,
      paidAt,
      payloadDigest: '4'.repeat(64),
      providerRequestId: `${prefix}-payment-${suffix}`,
      receivedAt: paidAt,
      signatureVerified: true,
      source: 'query',
      wechatTransactionId: `WX-${randomUUID()}`,
    },
    overrideAccess: true,
  })
  return { approvedTemplate, customer, domainAscii, order, quote, template }
}

function dependencies(
  write: WestDigitalWriteProvider,
  options: { availableMinor?: number; domainAvailable?: boolean } = {},
): FulfillmentDependencies {
  return {
    preflight: {
      queryAvailability: async ({ domain, traceId }) =>
        mockSuccess(
          {
            available: options.domainAvailable ?? true,
            currency: 'CNY',
            domainAscii: domain,
            premium: false,
          },
          `${traceId}-availability`,
        ) as ProviderResult<WestDigitalAvailability>,
      queryBalance: async ({ traceId }) =>
        mockSuccess(
          { availableMinor: options.availableMinor ?? 1_000_000, frozenMinor: 0 },
          `${traceId}-balance`,
        ),
    },
    write,
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
    for (const collection of [
      'domainAssets',
      'manualReviews',
      'orderEvents',
      'paymentNotifications',
      'providerOperations',
      'refunds',
    ] as const) {
      const rows = await payload.find({
        collection,
        limit: 100,
        overrideAccess: true,
        where:
          collection === 'domainAssets'
            ? { domainAscii: { equals: order.domainAscii } }
            : { order: { equals: order.id } },
      })
      for (const row of rows.docs) {
        await payload.delete({ collection, id: row.id, overrideAccess: true })
      }
    }
    await payload.delete({ collection: 'orders', id: order.id, overrideAccess: true })
  }
  const jobs = await payload.find({
    collection: 'payload-jobs',
    limit: 500,
    overrideAccess: true,
    where: { workflowSlug: { equals: 'commerceFulfillment' } },
  })
  for (const job of jobs.docs) {
    if (JSON.stringify(job.input).includes(prefix)) {
      await payload.delete({ collection: 'payload-jobs', id: job.id, overrideAccess: true })
    }
  }
  for (const collection of ['quotes', 'realnameTemplates', 'customers'] as const) {
    const rows = await payload.find({
      collection,
      limit: 100,
      overrideAccess: true,
      where:
        collection === 'customers'
          ? { phone: { contains: prefix } }
          : collection === 'quotes'
            ? { createdTraceId: { contains: prefix } }
            : { displayName: { contains: prefix } },
    })
    for (const row of rows.docs) {
      await payload.delete({ collection, id: row.id, overrideAccess: true })
    }
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 500,
    overrideAccess: true,
    where: { traceId: { contains: prefix } },
  })
  for (const audit of audits.docs) {
    await payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true })
  }
  await payload.db.destroy?.()
}, 90_000)

describe('D6-02 commerce fulfillment', () => {
  it('atomically lands one commerce job under concurrent payment confirmations', async () => {
    const fixture = await createPaidOrder('enqueue-cas')
    const results = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        enqueueCommerceFulfillment(await request(`enqueue-${index}`), {
          orderId: fixture.order.id,
          traceId: `${prefix}-enqueue-${index}`,
        }),
      ),
    )
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1)
    const jobs = await payload.find({
      collection: 'payload-jobs',
      overrideAccess: true,
      where: { workflowSlug: { equals: 'commerceFulfillment' } },
    })
    expect(
      jobs.docs.filter((job) => (job.input as { orderId?: number }).orderId === fixture.order.id),
    ).toHaveLength(1)
  })

  it('uses the frozen paid amount after quote expiry, the approved owner template, and creates an asset only after query confirmation', async () => {
    const fixture = await createPaidOrder('success', { expiredQuote: true })
    const transport = new FixtureWestDigitalWriteTransport((input) =>
      input.operation === 'register'
        ? registrationResponse(fixture.domainAscii)
        : assetResponse(fixture.domainAscii),
    )
    const result = await runCommerceFulfillment(
      await request('success-run'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${prefix}-success`,
      },
      dependencies(new WestDigitalWriteAdapter({ transport })),
    )
    expect(result).toMatchObject({ idempotentReplay: false, status: 'succeeded' })
    expect(transport.writeCount).toBe(1)
    const register = transport.requests.find((item) => item.operation === 'register')
    expect(register?.body).toMatchObject({
      c_sysid: fixture.approvedTemplate.providerTemplateId,
      client_price: '29.99',
      domain: fixture.domainAscii,
    })
    const asset = await payload.find({
      collection: 'domainAssets',
      overrideAccess: true,
      where: { domainAscii: { equals: fixture.domainAscii } },
    })
    expect(asset.docs).toHaveLength(1)
    expect(asset.docs[0]?.status).toBe('active')
    expect(
      typeof asset.docs[0]?.customer === 'object'
        ? asset.docs[0].customer.id
        : asset.docs[0]?.customer,
    ).toBe(fixture.customer.id)
    expect(
      typeof asset.docs[0]?.realnameTemplate === 'object'
        ? asset.docs[0].realnameTemplate.id
        : asset.docs[0]?.realnameTemplate,
    ).toBe(fixture.template.id)
    await expect(
      requestAutomaticRegistrationFailureRefund(await request('success-refund'), {
        evidence: { providerAssetId: '44169980' },
        note: '不应允许成功订单退款',
        orderId: fixture.order.id,
        traceId: `${prefix}-success-refund`,
      }),
    ).rejects.toMatchObject({ code: 'SUCCEEDED_ORDER_REFUND_FORBIDDEN' })
  })

  it('recovers after a restart between provider confirmation and asset persistence without a second registration', async () => {
    const fixture = await createPaidOrder('restart')
    let assetQueries = 0
    const transport = new FixtureWestDigitalWriteTransport((input) => {
      if (input.operation === 'register') return registrationResponse(fixture.domainAscii)
      assetQueries += 1
      if (assetQueries === 2) {
        throw new WestDigitalWriteTransportError('TEMPORARILY_UNAVAILABLE', 'not_submitted')
      }
      return assetResponse(fixture.domainAscii)
    })
    const provider = new WestDigitalWriteAdapter({ transport })
    const first = await runCommerceFulfillment(
      await request('restart-first'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${prefix}-restart-first`,
      },
      dependencies(provider),
    )
    expect(first.status).toBe('manual_review')
    const replay = await runCommerceFulfillment(
      await request('restart-second'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${prefix}-restart-second`,
      },
      dependencies(provider),
    )
    expect(replay.status).toBe('succeeded')
    expect(transport.writeCount).toBe(1)
    expect(
      (
        await payload.find({
          collection: 'domainAssets',
          overrideAccess: true,
          where: { domainAscii: { equals: fixture.domainAscii } },
        })
      ).totalDocs,
    ).toBe(1)
  })

  it('routes an explicit registration rejection into the existing full-refund commerce workflow', async () => {
    const fixture = await createPaidOrder('failure')
    const transport = new FixtureWestDigitalWriteTransport(() => ({
      body: { clientid: 'explicit-failure', result: 500 },
      status: 200,
    }))
    const result = await runCommerceFulfillment(
      await request('failure-run'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${prefix}-failure`,
      },
      dependencies(new WestDigitalWriteAdapter({ transport })),
    )
    expect(result.status).toBe('refund_pending')
    expect(
      (await payload.findByID({ collection: 'orders', id: fixture.order.id, overrideAccess: true }))
        .status,
    ).toBe('refund_pending')
    const refunds = await payload.find({
      collection: 'refunds',
      overrideAccess: true,
      where: { order: { equals: fixture.order.id } },
    })
    expect(refunds.docs).toHaveLength(1)
    expect(refunds.docs[0]).toMatchObject({ amountMinor: 2_999, status: 'pending' })
  })

  it('moves a post-submission timeout to manual review and only queries on every replay', async () => {
    const fixture = await createPaidOrder('unknown')
    const transport = new FixtureWestDigitalWriteTransport((input) => {
      if (input.operation === 'register') timeoutAfterSubmission()
      throw new WestDigitalWriteTransportError('TEMPORARILY_UNAVAILABLE', 'not_submitted')
    })
    const provider = new WestDigitalWriteAdapter({ transport })
    const first = await runCommerceFulfillment(
      await request('unknown-first'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${prefix}-unknown-first`,
      },
      dependencies(provider),
    )
    const replay = await runCommerceFulfillment(
      await request('unknown-replay'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${prefix}-unknown-replay`,
      },
      dependencies(provider),
    )
    expect(first.status).toBe('manual_review')
    expect(replay).toMatchObject({ idempotentReplay: true, status: 'manual_review' })
    expect(transport.writeCount).toBe(1)
    expect(
      (await payload.findByID({ collection: 'orders', id: fixture.order.id, overrideAccess: true }))
        .status,
    ).toBe('manual_review')
    expect(
      (
        await payload.find({
          collection: 'domainAssets',
          overrideAccess: true,
          where: { domainAscii: { equals: fixture.domainAscii } },
        })
      ).totalDocs,
    ).toBe(0)
  })
})
