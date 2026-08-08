import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import {
  createCustomerQuote,
  createQuoteIntegrityHash,
  getUsableCustomerQuote,
  QUOTE_VALIDITY_MS,
  type CustomerQuoteStore,
  type QuoteSnapshotInput,
  type StoredCustomerQuote,
} from '@/services/pricing/customer-quotes'
import { createPriceCalculationHash } from '@/services/pricing/price-snapshots'
import type {
  PriceSnapshotInput,
  PriceSnapshotStore,
  StoredPriceSnapshot,
} from '@/services/pricing/price-snapshots'

import { PRICING_RULE_FIXTURES } from '../fixtures/pricing'

class MemorySnapshotStore implements PriceSnapshotStore {
  readonly records: StoredPriceSnapshot[] = []

  async findLatest() {
    return undefined
  }

  async record(input: PriceSnapshotInput): Promise<StoredPriceSnapshot> {
    const stored = {
      ...input,
      calculationHash: createPriceCalculationHash(input),
      createdAt: input.providerObservedAt,
      snapshotRef: randomUUID(),
    }
    this.records.push(stored)
    return stored
  }
}

class MemoryQuoteStore implements CustomerQuoteStore {
  readonly records: StoredCustomerQuote[] = []

  async findOwnedByRef(quoteRef: string) {
    return this.records.find((quote) => quote.quoteRef === quoteRef)
  }

  async record(input: QuoteSnapshotInput): Promise<StoredCustomerQuote> {
    const stored = {
      ...input,
      quoteId: this.records.length + 1,
      quoteIntegrityHash: createQuoteIntegrityHash(input),
      quoteRef: randomUUID(),
    }
    this.records.push(stored)
    return stored
  }
}

function fixture() {
  const transport = new FixtureWestDigitalTransport()
  const snapshots = new MemorySnapshotStore()
  const quotes = new MemoryQuoteStore()
  return {
    options: {
      customer: { collection: 'customers' as const, id: 101 },
      now: () => Date.parse('2026-08-07T15:00:00.000Z'),
      provider: new WestDigitalReadAdapter({ transport }),
      quoteStore: quotes,
      rules: PRICING_RULE_FIXTURES,
      snapshots,
      traceId: 'trace-customer-quote',
    },
    quotes,
    snapshots,
    transport,
  }
}

describe('D5-01 customer quotes', () => {
  it('binds the customer, domain and years to a complete integer-fen five-minute snapshot', async () => {
    const { options, quotes, snapshots } = fixture()
    const result = await createCustomerQuote({ domain: 'Example.COM', years: 3 }, options)

    expect(result).toMatchObject({
      data: {
        quote: {
          currency: 'CNY',
          domainAscii: 'example.com',
          expiresAt: '2026-08-07T15:05:00.000Z',
          quotedAt: '2026-08-07T15:00:00.000Z',
          userPriceMinor: 9_500,
          years: 3,
        },
      },
      state: 'ready',
    })
    expect(Date.parse(quotes.records[0]!.expiresAt) - Date.parse(quotes.records[0]!.quotedAt)).toBe(
      QUOTE_VALIDITY_MS,
    )
    expect(quotes.records[0]).toMatchObject({
      customerId: 101,
      domainAscii: 'example.com',
      upstreamCostMinor: 8_000,
      userPriceMinor: 9_500,
      years: 3,
    })
    expect(quotes.records[0]!.calculation.rule).toMatchObject({
      fixedAmountFen: 500,
      mode: 'fixed',
    })
    expect(snapshots.records[0]).toMatchObject({ representativeDomainAscii: 'example.com' })
    for (const amount of [
      quotes.records[0]!.calculation.upstreamRegistrationPriceFen,
      quotes.records[0]!.calculation.upstreamRenewalPriceFen,
      quotes.records[0]!.calculation.registrationPriceFen,
      quotes.records[0]!.calculation.renewalPriceFen,
      quotes.records[0]!.upstreamCostMinor,
      quotes.records[0]!.userPriceMinor,
    ]) {
      expect(Number.isSafeInteger(amount)).toBe(true)
    }
  })

  it('blocks unsupported, unconfigured, unavailable and premium domains without unsafe fallback', async () => {
    const unconfigured = fixture()
    await expect(
      createCustomerQuote({ domain: 'example.tv', years: 1 }, unconfigured.options),
    ).resolves.toMatchObject({
      data: { blockCode: 'PRICE_RULE_UNCONFIGURED', quote: null },
      state: 'empty',
    })
    expect(unconfigured.transport.requests).toHaveLength(0)

    const unsupported = fixture()
    await expect(
      createCustomerQuote({ domain: 'example.io', years: 1 }, unsupported.options),
    ).resolves.toMatchObject({
      data: { blockCode: 'TLD_UNSUPPORTED', quote: null },
      state: 'empty',
    })
    expect(unsupported.transport.requests).toHaveLength(0)

    const unavailable = fixture()
    await expect(
      createCustomerQuote({ domain: 'taken.cn', years: 1 }, unavailable.options),
    ).resolves.toMatchObject({
      data: { blockCode: 'DOMAIN_UNAVAILABLE', quote: null },
      state: 'empty',
    })
    expect(unavailable.transport.requests).toHaveLength(1)

    const premium = fixture()
    await expect(
      createCustomerQuote({ domain: 'premium.top', years: 1 }, premium.options),
    ).resolves.toMatchObject({
      data: { blockCode: 'PREMIUM_UNSUPPORTED', quote: null },
      state: 'empty',
    })
    expect(premium.transport.requests).toHaveLength(1)
  })

  it('refuses another customer, expiration and modified calculation snapshots before order use', async () => {
    const { options, quotes } = fixture()
    const result = await createCustomerQuote({ domain: 'secure.com', years: 1 }, options)
    if (!('data' in result) || !result.data.quote) throw new Error('Expected quote')
    const quoteRef = result.data.quote.quoteRef

    await expect(
      getUsableCustomerQuote({
        customer: { collection: 'customers', id: 102 },
        quoteRef,
        store: quotes,
      }),
    ).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND' })
    await expect(
      getUsableCustomerQuote({
        customer: options.customer,
        now: () => Date.parse('2026-08-07T15:05:00.000Z'),
        quoteRef,
        store: quotes,
      }),
    ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })

    quotes.records[0]!.userPriceMinor += 1
    await expect(
      getUsableCustomerQuote({
        customer: options.customer,
        now: options.now,
        quoteRef,
        store: quotes,
      }),
    ).rejects.toMatchObject({ code: 'QUOTE_INTEGRITY_MISMATCH' })
  })

  it('maps provider throttling into the shared rate-limited state', async () => {
    const { options } = fixture()
    await expect(
      createCustomerQuote({ domain: 'ratelimited.com', years: 1 }, options),
    ).resolves.toMatchObject({
      problem: { code: 'QUOTE_RATE_LIMITED', status: 429 },
      state: 'rate_limited',
    })
  })
})
