import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import {
  createCustomerQuote,
  getUsableCustomerQuote,
  PayloadCustomerQuoteStore,
} from '@/services/pricing/customer-quotes'
import { PayloadPriceSnapshotStore } from '@/services/pricing/price-snapshots'

import { PRICING_RULE_FIXTURES } from '../fixtures/pricing'

const fixturePrefix = `d5-quotes-${randomUUID()}`
const createdCustomers: Array<number | string> = []
const createdQuotes: Array<number | string> = []
const createdSnapshots: Array<number | string> = []
let payload: Payload

async function customer(last4: string) {
  const doc = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: [],
      phone: `${fixturePrefix}-${last4}`,
      phoneMasked: `***${last4}`,
      status: 'active',
    },
    overrideAccess: true,
  })
  createdCustomers.push(doc.id)
  return { ...doc, collection: 'customers' as const }
}

async function requestFor(user: Awaited<ReturnType<typeof customer>>): Promise<PayloadRequest> {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-trace` }) } },
    payload,
  )
  req.user = user
  return req
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  for (const id of createdQuotes) {
    await payload.delete({ collection: 'quotes', id, overrideAccess: true }).catch(() => undefined)
  }
  for (const id of createdSnapshots) {
    await payload
      .delete({ collection: 'priceSnapshots', id, overrideAccess: true })
      .catch(() => undefined)
  }
  for (const id of createdCustomers) {
    await payload
      .delete({ collection: 'customers', id, overrideAccess: true })
      .catch(() => undefined)
  }
  await payload.db.destroy?.()
})

describe('D5-01 quote persistence and customer isolation', () => {
  it('persists a replayable quote, exposes only safe owner fields and rejects cross-customer use', async () => {
    const owner = await customer('5101')
    const other = await customer('5102')
    const ownerReq = await requestFor(owner)
    const ownerStore = new PayloadCustomerQuoteStore(ownerReq, owner)
    const result = await createCustomerQuote(
      { domain: `${fixturePrefix}.com`, years: 3 },
      {
        customer: owner,
        now: () => Date.parse('2026-08-07T16:00:00.000Z'),
        provider: new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() }),
        quoteStore: ownerStore,
        rules: PRICING_RULE_FIXTURES,
        snapshots: new PayloadPriceSnapshotStore(payload),
        traceId: `${fixturePrefix}-trace`,
      },
    )
    expect(result.state).toBe('ready')
    if (!('data' in result) || !result.data.quote) throw new Error('Expected quote')

    const quoteRows = await payload.find({
      collection: 'quotes',
      overrideAccess: true,
      where: { quoteRef: { equals: result.data.quote.quoteRef } },
    })
    const quote = quoteRows.docs[0]!
    createdQuotes.push(quote.id)
    const snapshotRows = await payload.find({
      collection: 'priceSnapshots',
      overrideAccess: true,
      where: { snapshotRef: { equals: quote.sourcePriceSnapshotRef } },
    })
    createdSnapshots.push(snapshotRows.docs[0]!.id)

    expect(quote).toMatchObject({
      domainAscii: `${fixturePrefix}.com`,
      upstreamCostMinor: 8_000,
      userPriceMinor: 9_500,
      years: 3,
    })
    expect(Date.parse(quote.expiresAt) - Date.parse(quote.quotedAt)).toBe(300_000)
    await expect(
      getUsableCustomerQuote({
        customer: owner,
        now: () => Date.parse('2026-08-07T16:04:59.999Z'),
        quoteRef: quote.quoteRef,
        store: ownerStore,
      }),
    ).resolves.toMatchObject({ quoteRef: quote.quoteRef })

    const ownerView = await payload.find({
      collection: 'quotes',
      overrideAccess: false,
      user: owner,
      where: { quoteRef: { equals: quote.quoteRef } },
    })
    expect(ownerView.docs).toHaveLength(1)
    expect(ownerView.docs[0]).not.toHaveProperty('upstreamCostMinor')
    expect(ownerView.docs[0]).not.toHaveProperty('ruleKey')
    expect(ownerView.docs[0]).not.toHaveProperty('quoteIntegrityHash')

    const otherReq = await requestFor(other)
    const otherStore = new PayloadCustomerQuoteStore(otherReq, other)
    const otherView = await payload.find({
      collection: 'quotes',
      overrideAccess: false,
      user: other,
      where: { quoteRef: { equals: quote.quoteRef } },
    })
    expect(otherView.docs).toHaveLength(0)
    await expect(
      getUsableCustomerQuote({ customer: other, quoteRef: quote.quoteRef, store: otherStore }),
    ).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND' })

    for (const actor of [undefined, owner, other]) {
      await expect(
        payload.update({
          collection: 'quotes',
          data: { userPriceMinor: 1 },
          id: quote.id,
          overrideAccess: false,
          user: actor as never,
        }),
      ).rejects.toThrow()
      await expect(
        payload.delete({
          collection: 'quotes',
          id: quote.id,
          overrideAccess: false,
          user: actor as never,
        }),
      ).rejects.toThrow()
    }
  })
})
