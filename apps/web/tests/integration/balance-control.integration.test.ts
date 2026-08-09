import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mockSuccess } from '@/providers/mock'
import type {
  ProviderResult,
} from '@/lib/domain'
import type {
  WestDigitalAvailability,
  WestDigitalBalanceProvider,
  WestDigitalWriteProvider,
} from '@/providers/types'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import {
  FixtureWestDigitalWriteTransport,
} from '@/providers/westdigital-write-fixtures'
import { WestDigitalWriteAdapter } from '@/providers/westdigital-write'
import {
  getTldSalesStopState,
  monitorWestDigitalBalance,
  resolvePaidOrderSalesStop,
  updateBalanceControl,
  WESTDIGITAL_BALANCE_CONTROL_KEY,
} from '@/services/commerce/balance-control'
import {
  runCommerceFulfillment,
  type FulfillmentDependencies,
} from '@/services/commerce/fulfillment'
import { createCustomerOrder } from '@/services/commerce/order-creation'
import { createCustomerQuote, PayloadCustomerQuoteStore } from '@/services/pricing/customer-quotes'
import { PayloadPriceSnapshotStore } from '@/services/pricing/price-snapshots'
import { submitRealnameTemplate, syncRealnameTemplateStatus } from '@/services/realname/templates'

import { fulfillmentQuoteSnapshotFixture } from '../fixtures/commerce'
import { PRICING_RULE_FIXTURES } from '../fixtures/pricing'
import { approvedRealnameProviderFixture, realnameTemplateFixture } from '../fixtures/realname'
import {
  ensureAnchorSystemAdmin,
  findOrCreateUniqueFixture,
  ignorePayloadNotFound,
} from '../test-cleanup'

const prefix = `d6-balance-control-${randomUUID()}`
let payload: Payload
let systemAdmin: Awaited<ReturnType<Payload['findByID']>>

async function request(suffix: string, user?: unknown): Promise<PayloadRequest> {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${prefix}-${suffix}` }) } },
    payload,
  )
  if (user) req.user = user as never
  return req
}

async function adminRequest(suffix: string): Promise<PayloadRequest> {
  return request(suffix, { ...systemAdmin, collection: 'admins' })
}

async function approvedCustomer(suffix: string) {
  const customer = await payload.create({
    collection: 'customers',
    data: { phone: `${prefix}-${suffix}`, phoneMasked: `***${suffix}`, status: 'active' },
    overrideAccess: true,
  })
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({
        displayName: `${prefix.slice(0, 36)}-${suffix.slice(0, 20)}`,
      }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  const customerReq = await request(`realname-${suffix}`, { ...customer, collection: 'customers' })
  const provider = approvedRealnameProviderFixture()
  await submitRealnameTemplate(customerReq, template.id, provider)
  await syncRealnameTemplateStatus(await request(`realname-sync-${suffix}`), template.id, provider)
  return { customer, template }
}

async function createPaidOrder(suffix: string) {
  const { customer, template } = await approvedCustomer(suffix)
  const domainAscii = `${suffix}-${randomUUID()}.top`
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
      tld: 'top',
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
      quote: quote.id,
      quoteSnapshot: fulfillmentQuoteSnapshotFixture({
        amountMinor: 2_999,
        customerId: customer.id,
        domainAscii,
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
  return { customer, domainAscii, order, quote, template }
}

function fulfillmentDependencies(write: WestDigitalWriteProvider): FulfillmentDependencies {
  return {
    preflight: {
      queryAvailability: async ({ domain, traceId }) =>
        mockSuccess(
          { available: true, currency: 'CNY', domainAscii: domain, premium: false },
          `${traceId}-availability`,
        ) as ProviderResult<WestDigitalAvailability>,
      queryBalance: async ({ traceId }) =>
        mockSuccess({ availableMinor: 1_000_000, frozenMinor: 0 }, `${traceId}-balance`),
    },
    write,
  }
}

function concurrentLowBalanceProvider(callCount: number): WestDigitalBalanceProvider {
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  return {
    health: async () => mockSuccess({ healthy: true }, `${prefix}-balance-health`),
    queryBalance: async () => {
      const current = ++arrived
      if (arrived === callCount) release()
      await gate
      return mockSuccess(
        { availableMinor: 5_000, frozenMinor: 100 },
        `${prefix}-balance-request-${current}`,
      )
    },
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
  systemAdmin = await ensureAnchorSystemAdmin(payload)
})

afterAll(async () => {
  const jobs = await payload.find({
    collection: 'payload-jobs',
    limit: 500,
    overrideAccess: true,
  })
  for (const job of jobs.docs) {
    if (JSON.stringify(job.input).includes(prefix)) {
      await ignorePayloadNotFound(() =>
        payload.delete({ collection: 'payload-jobs', id: job.id, overrideAccess: true }),
      )
    }
  }
  const orders = await payload.find({
    collection: 'orders',
    limit: 100,
    overrideAccess: true,
    where: { orderNumber: { contains: prefix } },
  })
  const orderIds = orders.docs.map((order) => order.id)
  if (orderIds.length) {
    for (const collection of [
      'renewals',
      'manualReviews',
      'orderEvents',
      'paymentNotifications',
      'providerOperations',
      'refunds',
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
    const assets = await payload.find({
      collection: 'domainAssets',
      limit: 500,
      overrideAccess: true,
      where: { domainAscii: { in: orders.docs.map((order) => order.domainAscii) } },
    })
    for (const asset of assets.docs) {
      await ignorePayloadNotFound(() =>
        payload.delete({ collection: 'domainAssets', id: asset.id, overrideAccess: true }),
      )
    }
  }
  for (const order of orders.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'orders', id: order.id, overrideAccess: true }),
    )
  }
  for (const collection of ['quotes', 'priceSnapshots', 'realnameTemplates', 'customers'] as const) {
    const rows = await payload.find({
      collection,
      limit: 200,
      overrideAccess: true,
      where:
        collection === 'customers'
          ? { phone: { contains: prefix } }
          : collection === 'quotes'
            ? { createdTraceId: { contains: prefix } }
            : collection === 'priceSnapshots'
              ? { createdTraceId: { contains: prefix } }
              : { displayName: { contains: prefix.slice(0, 36) } },
    })
    for (const row of rows.docs) {
      await ignorePayloadNotFound(() =>
        payload.delete({ collection, id: row.id, overrideAccess: true }),
      )
    }
  }
  for (const collection of ['reconciliations', 'auditLogs'] as const) {
    const rows = await payload.find({
      collection,
      limit: 500,
      overrideAccess: true,
      where: { traceId: { contains: prefix } },
    })
    for (const row of rows.docs) {
      await ignorePayloadNotFound(() =>
        payload.delete({ collection, id: row.id, overrideAccess: true }),
      )
    }
  }
  const setting = await payload.find({
    collection: 'siteSettings',
    limit: 1,
    overrideAccess: true,
    where: { key: { equals: WESTDIGITAL_BALANCE_CONTROL_KEY } },
  })
  if (setting.docs[0]) {
    await payload.delete({
      collection: 'siteSettings',
      context: { balanceControlOperation: true },
      id: setting.docs[0].id,
      overrideAccess: true,
    })
  }
  await payload.db.destroy?.()
}, 30_000)

describe('D6-03 balance monitoring and emergency sales stop', () => {
  it('records concurrent low-balance observations and atomically emits one automatic stop alert', async () => {
    const configured = await updateBalanceControl(await adminRequest('configure'), {
      action: 'configure',
      affectedTlds: ['top', 'vip'],
      thresholdMinor: 10_000,
    })
    expect(configured.value).toMatchObject({
      affectedTlds: ['top', 'vip'],
      automaticStoppedTlds: [],
      manualStoppedTlds: [],
      thresholdMinor: 10_000,
    })
    await expect(
      payload.update({
        collection: 'siteSettings',
        data: { value: { ...configured.value, thresholdMinor: 1 } },
        id: configured.id,
        overrideAccess: true,
        req: await adminRequest('generic-setting-bypass'),
      }),
    ).rejects.toMatchObject({ code: 'BALANCE_CONTROL_SERVICE_REQUIRED' })
    await updateBalanceControl(await adminRequest('manual-vip'), {
      action: 'set_sales_stop',
      source: 'manual',
      stopped: true,
      tld: 'vip',
    })

    const nonAdminReq = await request('non-admin', {
      ...systemAdmin,
      collection: 'admins',
      roles: ['content_editor'],
    })
    await expect(
      updateBalanceControl(nonAdminReq, {
        action: 'set_sales_stop',
        source: 'manual',
        stopped: true,
        tld: 'top',
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_ROLE_REQUIRED' })

    const calls = 5
    const provider = concurrentLowBalanceProvider(calls)
    const results = await Promise.all(
      Array.from({ length: calls }, (_, index) =>
        adminRequest(`monitor-${index}`).then((req) =>
          monitorWestDigitalBalance(req, { provider, traceId: `${prefix}-monitor-${index}` }),
        ),
      ),
    )
    expect(results.filter((result) => result.automaticStopTriggered)).toHaveLength(1)

    const control = await getTldSalesStopState(await adminRequest('read-control'), 'vip')
    expect(control).toEqual({ automatic: true, manual: true, stopped: true })
    const observations = await payload.find({
      collection: 'reconciliations',
      limit: 20,
      overrideAccess: true,
      where: {
        and: [
          { ledger: { equals: 'westdigital_prepaid' } },
          { traceId: { contains: `${prefix}-monitor-` } },
        ],
      },
    })
    expect(observations.docs).toHaveLength(calls)
    expect(observations.docs.every((row) => row.differenceMinor === 0)).toBe(true)
    const alerts = await payload.find({
      collection: 'auditLogs',
      limit: 20,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'commerce.balance_low.alerted' } },
          { traceId: { contains: `${prefix}-monitor-` } },
        ],
      },
    })
    expect(alerts.docs).toHaveLength(1)
    expect(JSON.stringify(alerts.docs[0]!.metadata)).not.toMatch(/account|clientid|secret|availableMinor|thresholdMinor/iu)
  })

  it('keeps manual and automatic stop sources independent', async () => {
    await updateBalanceControl(await adminRequest('manual-vip-off'), {
      action: 'set_sales_stop',
      source: 'manual',
      stopped: false,
      tld: 'vip',
    })
    expect(await getTldSalesStopState(await adminRequest('vip-auto-only'), 'vip')).toEqual({
      automatic: true,
      manual: false,
      stopped: true,
    })
    await updateBalanceControl(await adminRequest('manual-top-on'), {
      action: 'set_sales_stop',
      source: 'manual',
      stopped: true,
      tld: 'top',
    })
    await updateBalanceControl(await adminRequest('auto-top-off'), {
      action: 'set_sales_stop',
      source: 'automatic',
      stopped: false,
      tld: 'top',
    })
    expect(await getTldSalesStopState(await adminRequest('top-manual-only'), 'top')).toEqual({
      automatic: false,
      manual: true,
      stopped: true,
    })
    await updateBalanceControl(await adminRequest('auto-top-on'), {
      action: 'set_sales_stop',
      source: 'automatic',
      stopped: true,
      tld: 'top',
    })
    await updateBalanceControl(await adminRequest('manual-top-off'), {
      action: 'set_sales_stop',
      source: 'manual',
      stopped: false,
      tld: 'top',
    })
    expect(await getTldSalesStopState(await adminRequest('top-auto-only'), 'top')).toEqual({
      automatic: true,
      manual: false,
      stopped: true,
    })
  })

  it('rejects affected TLD orders before the provider call and leaves unaffected TLDs open', async () => {
    for (const tld of ['top', 'org'] as const) {
      const { customer, template } = await approvedCustomer(`order-${tld}`)
      const customerUser = { ...customer, collection: 'customers' as const }
      const customerReq = await request(`quote-${tld}`, customerUser)
      const quoteResult = await createCustomerQuote(
        { domain: `${prefix}-${tld}.${tld}`, years: 1 },
        {
          customer: customerUser,
          provider: new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() }),
          quoteStore: new PayloadCustomerQuoteStore(customerReq, customerUser),
          rules: PRICING_RULE_FIXTURES,
          snapshots: new PayloadPriceSnapshotStore(payload),
          traceId: `${prefix}-quote-${tld}`,
        },
      )
      if (!('data' in quoteResult) || !quoteResult.data.quote) throw new Error('Expected quote')
      const transport = new FixtureWestDigitalTransport()
      const create = () =>
        createCustomerOrder(
          customerReq,
          { quoteRef: quoteResult.data.quote!.quoteRef, realnameTemplateId: Number(template.id) },
          {
            customer: customerUser,
            orderNumber: () => `${prefix}-new-order-${tld}`,
            provider: new WestDigitalReadAdapter({ transport }),
            rules: PRICING_RULE_FIXTURES,
            traceId: `${prefix}-create-${tld}`,
          },
        )
      if (tld === 'top') {
        await expect(create()).rejects.toMatchObject({ code: 'TLD_SALES_STOPPED' })
        expect(transport.requests).toHaveLength(0)
      } else {
        await expect(create()).resolves.toMatchObject({ data: { status: 'pending_payment' } })
        expect(transport.requests).toHaveLength(1)
      }
    }
  })

  it('keeps a paid order unchanged until one concurrent owner decision resumes fulfillment', async () => {
    const fixture = await createPaidOrder('resume')
    const transport = new FixtureWestDigitalWriteTransport()
    const write = new WestDigitalWriteAdapter({ transport })
    const held = await runCommerceFulfillment(
      await request('hold-resume'),
      { operationKey: `${prefix}-hold-resume`, orderId: Number(fixture.order.id), traceId: `${prefix}-hold-resume` },
      fulfillmentDependencies(write),
    )
    expect(held).toEqual({ idempotentReplay: true, status: 'paid' })
    expect(transport.writeCount).toBe(0)
    expect(
      (await payload.findByID({ collection: 'orders', id: fixture.order.id, overrideAccess: true })).status,
    ).toBe('paid')
    expect(
      (
        await payload.find({
          collection: 'refunds',
          overrideAccess: true,
          where: { order: { equals: fixture.order.id } },
        })
      ).docs,
    ).toHaveLength(0)

    const resolution = {
      decision: 'resume' as const,
      evidence: {
        observedAt: new Date().toISOString(),
        reference: `${prefix}-resume-evidence`,
        source: 'provider_query' as const,
      },
      note: '余额已补足，负责人确认恢复该已支付订单履约。',
    }
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        adminRequest(`resume-${index}`).then((req) =>
          resolvePaidOrderSalesStop(req, fixture.order.orderNumber, resolution),
        ),
      ),
    )
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const jobs = await payload.find({
      collection: 'payload-jobs',
      limit: 20,
      overrideAccess: true,
      where: { workflowSlug: { equals: 'commerceFulfillment' } },
    })
    const job = jobs.docs.find((candidate) => {
      const input = candidate.input as { orderId?: number; salesStopReviewId?: number }
      return input.orderId === Number(fixture.order.id) && input.salesStopReviewId !== undefined
    })
    expect(job).toBeDefined()
    const jobInput = job!.input as {
      operationKey: string
      orderId: number
      salesStopReviewId: number
      traceId: string
    }
    await expect(
      runCommerceFulfillment(await request('resume-run'), jobInput, fulfillmentDependencies(write)),
    ).resolves.toMatchObject({ status: 'succeeded' })
    expect(transport.writeCount).toBe(1)
    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 20,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'commerce.sales_stop.resume_selected' } },
          { targetId: { equals: String(fixture.order.id) } },
        ],
      },
    })
    expect(audits.docs).toHaveLength(1)
  })

  it('holds an already-paid renewal order with the same sales-stop semantics and no provider write', async () => {
    const fixture = await createPaidOrder('renewal-hold')
    const expiresAt = '2027-08-08T12:00:00.000Z'
    const assetFixture = await findOrCreateUniqueFixture({
      create: () =>
        payload.create({
          collection: 'domainAssets',
          data: {
            customer: fixture.customer.id,
            domainAscii: fixture.domainAscii,
            expiresAt,
            lastSyncedAt: '2026-08-08T12:00:00.000Z',
            nameservers: ['ns1.myhostadmin.net', 'ns2.myhostadmin.net'],
            realnameTemplate: fixture.template.id,
            registeredAt: '2026-08-08T12:00:00.000Z',
            registrar: 'west',
            status: 'active',
          },
          overrideAccess: true,
        }),
      find: async () =>
        (
          await payload.find({
            collection: 'domainAssets',
            limit: 1,
            overrideAccess: true,
            where: { domainAscii: { equals: fixture.domainAscii } },
          })
        ).docs[0],
      path: 'domainAscii',
      tableName: 'domain_assets',
    })
    const snapshot = {
      ...fulfillmentQuoteSnapshotFixture({
        amountMinor: 2_999,
        customerId: fixture.customer.id,
        domainAscii: fixture.domainAscii,
        quoteId: fixture.quote.id,
      }),
      assetExpiresAt: expiresAt,
      domainAssetId: assetFixture.value.id,
      operation: 'renewal' as const,
    }
    await payload.update({
      collection: 'quotes',
      data: {
        assetExpiresAt: expiresAt,
        domainAsset: assetFixture.value.id,
        operation: 'renewal',
      },
      id: fixture.quote.id,
      overrideAccess: true,
    })
    await payload.update({
      collection: 'orders',
      data: {
        domainAsset: assetFixture.value.id,
        operation: 'renewal',
        quoteSnapshot: snapshot,
      },
      id: fixture.order.id,
      overrideAccess: true,
    })
    const transport = new FixtureWestDigitalWriteTransport()
    const held = await runCommerceFulfillment(
      await request('renewal-hold-run'),
      {
        operationKey: `${prefix}-renewal-hold`,
        orderId: Number(fixture.order.id),
        traceId: `${prefix}-renewal-hold`,
      },
      fulfillmentDependencies(new WestDigitalWriteAdapter({ transport })),
    )
    expect(held).toEqual({ idempotentReplay: true, status: 'paid' })
    expect(transport.writeCount).toBe(0)
    expect(
      (await payload.findByID({ collection: 'orders', id: fixture.order.id, overrideAccess: true })).status,
    ).toBe('paid')
    expect(
      (
        await payload.find({
          collection: 'renewals',
          overrideAccess: true,
          where: { order: { equals: fixture.order.id } },
        })
      ).docs,
    ).toHaveLength(0)
  })

  it('allows one explicit refund choice without automatic cancellation or refund', async () => {
    const fixture = await createPaidOrder('refund')
    const transport = new FixtureWestDigitalWriteTransport()
    const write = new WestDigitalWriteAdapter({ transport })
    await runCommerceFulfillment(
      await request('hold-refund'),
      { operationKey: `${prefix}-hold-refund`, orderId: Number(fixture.order.id), traceId: `${prefix}-hold-refund` },
      fulfillmentDependencies(write),
    )
    expect(
      (await payload.findByID({ collection: 'orders', id: fixture.order.id, overrideAccess: true })).status,
    ).toBe('paid')
    expect(
      (
        await payload.find({
          collection: 'refunds',
          overrideAccess: true,
          where: { order: { equals: fixture.order.id } },
        })
      ).docs,
    ).toHaveLength(0)

    const decision = await resolvePaidOrderSalesStop(
      await adminRequest('refund-decision'),
      fixture.order.orderNumber,
      {
        decision: 'refund',
        evidence: {
          observedAt: new Date().toISOString(),
          reference: `${prefix}-refund-evidence`,
          source: 'written_confirmation',
        },
        note: '负责人确认该已支付订单改为原路全额退款。',
      },
    )
    expect(decision).toMatchObject({ decision: 'refund', refundId: expect.anything() })
    expect(
      (await payload.findByID({ collection: 'orders', id: fixture.order.id, overrideAccess: true })).status,
    ).toBe('refund_pending')
    expect(transport.writeCount).toBe(0)
    const refunds = await payload.find({
      collection: 'refunds',
      overrideAccess: true,
      where: { order: { equals: fixture.order.id } },
    })
    expect(refunds.docs).toHaveLength(1)
    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 20,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'commerce.sales_stop.refund_selected' } },
          { targetId: { equals: String(fixture.order.id) } },
        ],
      },
    })
    expect(audits.docs).toHaveLength(1)
    await expect(
      resolvePaidOrderSalesStop(await adminRequest('refund-replay'), fixture.order.orderNumber, {
        decision: 'refund',
        evidence: {
          observedAt: new Date().toISOString(),
          reference: `${prefix}-refund-replay`,
          source: 'written_confirmation',
        },
        note: '重复退款决定应被拒绝。',
      }),
    ).rejects.toMatchObject({ code: 'SALES_STOP_ORDER_NOT_PAID' })
  })
})
