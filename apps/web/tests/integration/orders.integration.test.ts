import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { MockWestDigitalRealnameAdapter } from '@/providers/westdigital-realname'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import { createCustomerOrder } from '@/services/commerce/order-creation'
import { createCustomerQuote, PayloadCustomerQuoteStore } from '@/services/pricing/customer-quotes'
import { PayloadPriceSnapshotStore } from '@/services/pricing/price-snapshots'
import {
  createRealnameTemplate,
  submitRealnameTemplate,
  syncRealnameTemplateStatus,
} from '@/services/realname/templates'

import { realnameTemplateFixture } from '../fixtures/realname'
import { PRICING_RULE_FIXTURES } from '../fixtures/pricing'

const fixturePrefix = `d5-orders-${randomUUID()}`
const created: Array<{
  collection:
    | 'customers'
    | 'orderEvents'
    | 'orders'
    | 'priceSnapshots'
    | 'quotes'
    | 'realnameTemplates'
  id: number | string
}> = []
let payload: Payload

async function requestFor(user: unknown, suffix: string): Promise<PayloadRequest> {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) } },
    payload,
  )
  req.user = user as never
  return req
}

async function customer(last4: string) {
  const document = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: [],
      phone: `${fixturePrefix}-${last4}`,
      phoneMasked: `***${last4}`,
      status: 'active',
    },
    overrideAccess: true,
  })
  created.push({ collection: 'customers', id: document.id })
  return { ...document, collection: 'customers' as const, id: Number(document.id) }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  for (const item of created.reverse()) {
    await payload
      .delete({ collection: item.collection, id: item.id, overrideAccess: true })
      .catch(() => undefined)
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 100,
    overrideAccess: true,
    where: { traceId: { contains: fixturePrefix } },
  })
  for (const audit of audits.docs) {
    await payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true })
  }
  await payload.db.destroy?.()
})

describe('D5-02 order creation', () => {
  it('revalidates quote, approved real-name template and availability before one atomic pending order', async () => {
    const owner = await customer('5201')
    const ownerReq = await requestFor(owner, 'order')
    const quoteResult = await createCustomerQuote(
      { domain: `${fixturePrefix}.com`, years: 3 },
      {
        customer: owner,
        provider: new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() }),
        quoteStore: new PayloadCustomerQuoteStore(ownerReq, owner),
        rules: PRICING_RULE_FIXTURES,
        snapshots: new PayloadPriceSnapshotStore(payload),
        traceId: `${fixturePrefix}-quote`,
      },
    )
    if (!('data' in quoteResult) || !quoteResult.data.quote) throw new Error('Expected quote')
    const quoteRows = await payload.find({
      collection: 'quotes',
      overrideAccess: true,
      where: { quoteRef: { equals: quoteResult.data.quote.quoteRef } },
    })
    const quote = quoteRows.docs[0]!
    created.push({ collection: 'quotes', id: quote.id })
    const snapshotRows = await payload.find({
      collection: 'priceSnapshots',
      overrideAccess: true,
      where: { snapshotRef: { equals: quote.sourcePriceSnapshotRef } },
    })
    created.push({ collection: 'priceSnapshots', id: snapshotRows.docs[0]!.id })

    const draft = await createRealnameTemplate(
      ownerReq,
      realnameTemplateFixture({ displayName: `${fixturePrefix}-approved` }),
    )
    created.push({ collection: 'realnameTemplates', id: draft.id })
    const realnameProvider = new MockWestDigitalRealnameAdapter({
      'mock-realname-1': { reviewState: 'approved' },
    })
    await submitRealnameTemplate(await requestFor(owner, 'submit'), draft.id, realnameProvider)
    await syncRealnameTemplateStatus(
      await createLocalReq(
        { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-sync` }) } },
        payload,
      ),
      draft.id,
      realnameProvider,
    )

    const result = await createCustomerOrder(
      ownerReq,
      { quoteRef: quote.quoteRef, realnameTemplateId: Number(draft.id) },
      {
        customer: owner,
        orderNumber: () => `${fixturePrefix}-order`,
        provider: new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() }),
        rules: PRICING_RULE_FIXTURES,
        traceId: `${fixturePrefix}-create`,
      },
    )
    expect(result).toMatchObject({
      data: {
        amountMinor: quote.userPriceMinor,
        domainAscii: `${fixturePrefix}.com`,
        orderNumber: `${fixturePrefix}-order`,
        quoteRef: quote.quoteRef,
        status: 'pending_payment',
        years: 3,
      },
      state: 'ready',
    })

    const orderRows = await payload.find({
      collection: 'orders',
      overrideAccess: true,
      where: { orderNumber: { equals: `${fixturePrefix}-order` } },
    })
    const order = orderRows.docs[0]!
    created.push({ collection: 'orders', id: order.id })
    expect(order).toMatchObject({
      amountMinor: quote.userPriceMinor,
      currency: 'CNY',
      domainAscii: `${fixturePrefix}.com`,
      quoteSnapshot: expect.objectContaining({
        customerId: String(owner.id),
        orderAvailability: expect.objectContaining({
          observedAt: expect.any(String),
          requestId: expect.any(String),
        }),
        quoteId: quote.id,
        quoteIntegrityHash: quote.quoteIntegrityHash,
        quoteRef: quote.quoteRef,
        userPriceMinor: quote.userPriceMinor,
      }),
      status: 'pending_payment',
    })
    expect(typeof order.customer === 'object' ? order.customer.id : order.customer).toBe(owner.id)
    expect(typeof order.quote === 'object' ? order.quote.id : order.quote).toBe(quote.id)
    expect(
      typeof order.realnameTemplate === 'object'
        ? order.realnameTemplate.id
        : order.realnameTemplate,
    ).toBe(draft.id)

    const events = await payload.find({
      collection: 'orderEvents',
      overrideAccess: true,
      where: { order: { equals: order.id } },
    })
    expect(events.docs).toHaveLength(1)
    expect(events.docs[0]).toMatchObject({
      actorId: String(owner.id),
      actorType: 'customer',
      evidence: expect.objectContaining({
        quoteIntegrityHash: quote.quoteIntegrityHash,
        quoteRef: quote.quoteRef,
        realnameTemplateId: draft.id,
      }),
      fromStatus: null,
      reasonCode: 'order.created',
      toStatus: 'pending_payment',
    })
    created.push({ collection: 'orderEvents', id: events.docs[0]!.id })

    const ownerView = await payload.findByID({
      collection: 'orders',
      id: order.id,
      overrideAccess: false,
      user: owner,
    })
    expect(ownerView).not.toHaveProperty('quoteSnapshot')
    await expect(
      payload.update({
        collection: 'orders',
        data: { status: 'succeeded' },
        id: order.id,
        overrideAccess: false,
        user: owner,
      }),
    ).rejects.toThrow()

    const unusableTemplate = await createRealnameTemplate(
      await requestFor(owner, 'draft'),
      realnameTemplateFixture({ displayName: `${fixturePrefix}-draft` }),
    )
    created.push({ collection: 'realnameTemplates', id: unusableTemplate.id })
    await expect(
      createCustomerOrder(
        await requestFor(owner, 'draft-order'),
        { quoteRef: quote.quoteRef, realnameTemplateId: Number(unusableTemplate.id) },
        {
          customer: owner,
          provider: new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() }),
          rules: PRICING_RULE_FIXTURES,
          traceId: `${fixturePrefix}-draft-order`,
        },
      ),
    ).rejects.toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_USABLE' })

    const unavailableTransport = new FixtureWestDigitalTransport((request) => ({
      body: {
        clientid: `${fixturePrefix}-unavailable`,
        data: [
          {
            avail: 0,
            name: `${request.body.domain}${request.body.suffix}`,
          },
        ],
        result: 200,
      },
      status: 200,
    }))
    await expect(
      createCustomerOrder(
        await requestFor(owner, 'unavailable-order'),
        { quoteRef: quote.quoteRef, realnameTemplateId: Number(draft.id) },
        {
          customer: owner,
          provider: new WestDigitalReadAdapter({ transport: unavailableTransport }),
          rules: PRICING_RULE_FIXTURES,
          traceId: `${fixturePrefix}-unavailable-order`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_UNAVAILABLE' })
    expect(
      (
        await payload.find({
          collection: 'orders',
          overrideAccess: true,
          where: { customer: { equals: owner.id } },
        })
      ).docs.filter((candidate) => candidate.orderNumber.startsWith(fixturePrefix)),
    ).toHaveLength(1)
  })
})
