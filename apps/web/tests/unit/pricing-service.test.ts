import { randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { ProviderResult } from '@/lib/domain'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter, type WestDigitalReadConfig } from '@/providers/westdigital'
import type { WestDigitalPrice, WestDigitalReadProvider } from '@/providers/types'
import { DEFAULT_DOMAIN_SEARCH_TLDS } from '@/services/domain-search/query-availability'
import { createPriceCalculationHash } from '@/services/pricing/price-snapshots'
import type {
  PriceSnapshotInput,
  PriceSnapshotStore,
  StoredPriceSnapshot,
} from '@/services/pricing/price-snapshots'
import { queryTldPricing } from '@/services/pricing/query-tld-pricing'

import { PRICING_RULE_FIXTURES } from '../fixtures/pricing'

const traceId = 'trace-pricing-service'
const fastConfig: WestDigitalReadConfig = {
  availabilityCacheMaxEntries: 5_000,
  availabilityCacheTtlMs: 45_000,
  burst: 100,
  priceCacheMaxEntries: 512,
  priceCacheTtlMs: 3_600_000,
  queueCapacity: 32,
  queueWaitMs: 5_000,
  ratePerSecond: 1_000,
  transportTimeoutMs: 5_000,
}

class MemorySnapshotStore implements PriceSnapshotStore {
  readonly records: StoredPriceSnapshot[] = []

  async findLatest(input: { ruleKey: string; ruleVersion: 1; tld: string }) {
    return this.records
      .filter(
        (record) =>
          record.tld === input.tld &&
          record.calculation.rule.key === input.ruleKey &&
          record.calculation.rule.version === input.ruleVersion,
      )
      .sort((left, right) => right.providerObservedAt.localeCompare(left.providerObservedAt))[0]
  }

  async record(input: PriceSnapshotInput) {
    const calculationHash = createPriceCalculationHash(input)
    const existing = this.records.find((record) => record.calculationHash === calculationHash)
    if (existing) return existing
    const stored: StoredPriceSnapshot = {
      ...input,
      calculationHash,
      createdAt: input.providerObservedAt,
      snapshotRef: randomUUID(),
    }
    this.records.push(stored)
    return stored
  }
}

function fixtureProvider() {
  const transport = new FixtureWestDigitalTransport()
  const provider = new WestDigitalReadAdapter({
    config: fastConfig,
    logger: { info() {}, warn() {} },
    requestIdFactory: (() => {
      let sequence = 0
      return () => `pricing-fixture-${++sequence}`
    })(),
    transport,
  })
  return { provider, transport }
}

function dataFrom(result: Awaited<ReturnType<typeof queryTldPricing>>) {
  if (!('data' in result)) throw new Error(`Expected data-bearing result, received ${result.state}`)
  return result.data
}

function failureProvider(code = 'WESTDIGITAL_UNAVAILABLE'): WestDigitalReadProvider {
  return {
    async health() {
      return failure(code)
    },
    async queryAvailability() {
      return failure(code)
    },
    async queryPrice() {
      return failure(code)
    },
  }
}

function failure<T>(code: string): ProviderResult<T> {
  return {
    cache: { status: 'miss' },
    error: {
      code,
      message: 'fixture failure',
      retryable: true,
      statusKnown: false,
    },
    observedAt: '2026-08-06T12:00:00.000Z',
    ok: false,
    requestId: 'fixture-failure',
  }
}

describe('D2-07 TLD pricing orchestration', () => {
  it('queries every configured default TLD once, skips tv and reuses snapshots on cache hits', async () => {
    const { provider, transport } = fixtureProvider()
    const queryPrice = vi.spyOn(provider, 'queryPrice')
    const snapshots = new MemorySnapshotStore()
    const first = await queryTldPricing(
      {},
      { provider, rules: PRICING_RULE_FIXTURES, snapshots, traceId },
    )

    expect(first.state).toBe('ready')
    expect(dataFrom(first).tlds).toEqual(DEFAULT_DOMAIN_SEARCH_TLDS)
    expect(dataFrom(first).items).toHaveLength(10)
    expect(queryPrice).toHaveBeenCalledTimes(9)
    expect(queryPrice.mock.calls.every(([input]) => input.years === 1)).toBe(true)
    expect(transport.requests.filter((request) => request.operation === 'price')).toHaveLength(9)
    const com = dataFrom(first).items.find((item) => item.tld === 'com')
    expect(com).toMatchObject({
      cache: { status: 'miss' },
      oneYearTotalFen: 2_500,
      registrationPriceFen: 2_500,
      renewalPriceFen: 3_500,
      status: 'priced',
      threeYearTotalFen: 9_500,
    })
    const tv = dataFrom(first).items.find((item) => item.tld === 'tv')
    expect(tv).toMatchObject({
      cache: { status: 'not_used' },
      markupConfigured: false,
      purchaseBlockCode: 'PRICE_RULE_UNCONFIGURED',
      status: 'unconfigured',
    })
    expect(tv).not.toHaveProperty('registrationPriceFen')

    const firstRefs = Object.fromEntries(
      dataFrom(first)
        .items.filter((item) => item.status === 'priced')
        .map((item) => [item.tld, item.snapshotRef]),
    )
    const second = await queryTldPricing(
      {},
      { provider, rules: PRICING_RULE_FIXTURES, snapshots, traceId },
    )
    expect(second.state).toBe('ready')
    expect(dataFrom(second).items.filter((item) => item.status === 'priced')).toHaveLength(9)
    expect(
      dataFrom(second)
        .items.filter((item) => item.status === 'priced')
        .every((item) => item.cache.status === 'hit' && item.snapshotRef === firstRefs[item.tld]),
    ).toBe(true)
    expect(transport.requests.filter((request) => request.operation === 'price')).toHaveLength(9)
    expect(snapshots.records).toHaveLength(9)
  })

  it('falls back to a matching historical snapshot and distinguishes all aggregate states', async () => {
    const { provider } = fixtureProvider()
    const snapshots = new MemorySnapshotStore()
    const fresh = await queryTldPricing(
      { tlds: ['com'] },
      { provider, rules: PRICING_RULE_FIXTURES, snapshots, traceId },
    )
    expect(fresh.state).toBe('ready')

    const stale = await queryTldPricing(
      { tlds: ['com'] },
      { provider: failureProvider(), rules: PRICING_RULE_FIXTURES, snapshots, traceId },
    )
    expect(stale.state).toBe('degraded')
    expect(dataFrom(stale).items[0]).toMatchObject({
      cache: { status: 'not_used' },
      purchaseEligible: false,
      status: 'stale',
    })

    const queueLimitedStale = await queryTldPricing(
      { tlds: ['com'] },
      {
        provider: failureProvider('WESTDIGITAL_QUEUE_FULL'),
        rules: PRICING_RULE_FIXTURES,
        snapshots,
        traceId,
      },
    )
    expect(queueLimitedStale).toMatchObject({
      data: {
        items: [
          expect.objectContaining({
            purchaseBlockCode: 'PRICE_STALE',
            purchaseEligible: false,
            status: 'stale',
          }),
        ],
      },
      problem: {
        detail: '当前仅能展示历史价格快照，不能用于购买',
      },
      state: 'degraded',
    })

    const partialProvider: WestDigitalReadProvider = {
      ...failureProvider(),
      async queryPrice(input): Promise<ProviderResult<WestDigitalPrice>> {
        if (input.domain.endsWith('.cn')) return failure('WESTDIGITAL_UNAVAILABLE')
        return {
          cache: { status: 'miss' },
          data: {
            currency: 'CNY',
            domainAscii: input.domain,
            productId: 'fixture-partial',
            purchaseYears: 1,
            registrationPriceFen: 2_000,
            renewalPriceFen: 3_000,
          },
          observedAt: '2026-08-06T12:00:00.000Z',
          ok: true,
          requestId: 'fixture-partial',
        }
      },
    }
    expect(
      (
        await queryTldPricing(
          { tlds: ['com', 'cn'] },
          {
            provider: partialProvider,
            rules: PRICING_RULE_FIXTURES,
            snapshots: new MemorySnapshotStore(),
            traceId,
          },
        )
      ).state,
    ).toBe('partial')
    expect(
      (
        await queryTldPricing(
          { tlds: ['com', 'tv'] },
          {
            provider: failureProvider(),
            rules: PRICING_RULE_FIXTURES,
            snapshots: new MemorySnapshotStore(),
            traceId,
          },
        )
      ).state,
    ).toBe('error')
    for (const code of [
      'WESTDIGITAL_RATE_LIMITED',
      'WESTDIGITAL_QUEUE_FULL',
      'WESTDIGITAL_QUEUE_TIMEOUT',
    ]) {
      const capacityLimited = await queryTldPricing(
        { tlds: ['com', 'tv'] },
        {
          provider: failureProvider(code),
          rules: PRICING_RULE_FIXTURES,
          snapshots: new MemorySnapshotStore(),
          traceId,
        },
      )
      expect(capacityLimited, code).toMatchObject({
        problem: {
          action: '请稍后重试',
          code: 'PRICING_RATE_LIMITED',
          detail: '价格查询请求过于频繁，请稍后重试',
          retryable: true,
          status: 429,
        },
        state: 'rate_limited',
      })
      expect(capacityLimited).not.toHaveProperty('data')
    }
    expect(
      (
        await queryTldPricing(
          { tlds: ['tv'] },
          {
            provider,
            rules: PRICING_RULE_FIXTURES,
            snapshots: new MemorySnapshotStore(),
            traceId,
          },
        )
      ).state,
    ).toBe('empty')
  })

  it('fails closed when the traceable snapshot cannot be saved', async () => {
    const { provider } = fixtureProvider()
    const memory = new MemorySnapshotStore()
    const snapshots: PriceSnapshotStore = {
      async findLatest(input) {
        return memory.findLatest(input)
      },
      async record(input) {
        if (input.tld === 'com') throw new Error('database unavailable')
        return memory.record(input)
      },
    }
    const result = await queryTldPricing(
      { tlds: ['com', 'cn'] },
      { provider, rules: PRICING_RULE_FIXTURES, snapshots, traceId },
    )
    expect(result.state).toBe('partial')
    const failed = dataFrom(result).items.find((item) => item.tld === 'com')
    expect(failed).toMatchObject({
      problem: { code: 'PRICE_SNAPSHOT_UNAVAILABLE' },
      status: 'query_failed',
    })
    expect(failed).not.toHaveProperty('registrationPriceFen')
  })

  it('rejects duplicate normalized TLDs and invalid values without silently changing scope', async () => {
    const { provider } = fixtureProvider()
    const snapshots = new MemorySnapshotStore()
    await expect(
      queryTldPricing(
        { tlds: ['com', '.COM'] },
        { provider, rules: PRICING_RULE_FIXTURES, snapshots, traceId },
      ),
    ).rejects.toMatchObject({ code: 'PRICING_DUPLICATE_TLD' })
    await expect(
      queryTldPricing(
        { tlds: ['com/evil'] },
        { provider, rules: PRICING_RULE_FIXTURES, snapshots, traceId },
      ),
    ).rejects.toMatchObject({ code: expect.any(String) })
  })
})
