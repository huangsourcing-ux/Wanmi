import { describe, expect, it } from 'vitest'

import type { ProviderResult } from '@/lib/domain'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter, type WestDigitalReadConfig } from '@/providers/westdigital'
import type { WestDigitalPrice, WestDigitalReadProvider } from '@/providers/types'
import {
  DEFAULT_DOMAIN_SEARCH_TLDS,
  queryDomainAvailability,
  type DomainSearchCatalog,
} from '@/services/domain-search/query-availability'

const traceId = 'trace-domain-search-service'
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

function fixtureProvider() {
  return new WestDigitalReadAdapter({
    config: fastConfig,
    logger: { info() {}, warn() {} },
    requestIdFactory: (() => {
      let sequence = 0
      return () => `domain-search-fixture-${++sequence}`
    })(),
    transport: new FixtureWestDigitalTransport(),
  })
}

function dataFrom(result: Awaited<ReturnType<typeof queryDomainAvailability>>) {
  if (!('data' in result)) throw new Error(`Expected data-bearing result, received ${result.state}`)
  return result.data
}

describe('D2-03 domain availability orchestration', () => {
  it('normalizes a keyword, queries the exact default 10 TLDs and reuses provider cache entries', async () => {
    const provider = fixtureProvider()
    const first = await queryDomainAvailability({ query: '  WANMI  ' }, { provider, traceId })
    expect(first.state).toBe('ready')
    expect(dataFrom(first)).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ domainAscii: 'wanmi.com', status: 'available', tld: 'com' }),
        expect.objectContaining({
          domainAscii: 'wanmi.com.cn',
          status: 'available',
          tld: 'com.cn',
        }),
      ]),
      mode: 'keyword',
      normalizedQueryAscii: 'wanmi',
      tlds: DEFAULT_DOMAIN_SEARCH_TLDS,
    })
    expect(dataFrom(first).items).toHaveLength(10)
    expect(dataFrom(first).items.every((item) => item.cache.status === 'miss')).toBe(true)

    const second = await queryDomainAvailability({ query: 'wanmi' }, { provider, traceId })
    expect(second.state).toBe('ready')
    expect(dataFrom(second).items.every((item) => item.cache.status === 'hit')).toBe(true)
    expect(second.meta?.cacheStatus).toBe('hit')
  })

  it('keeps full-domain suffix matching and Unicode normalization separate from WHOIS', async () => {
    const provider = fixtureProvider()
    const multiLabel = await queryDomainAvailability(
      { query: 'WANMI.COM.CN' },
      { provider, traceId },
    )
    expect(multiLabel.state).toBe('ready')
    expect(dataFrom(multiLabel)).toMatchObject({
      items: [expect.objectContaining({ domainAscii: 'wanmi.com.cn', tld: 'com.cn' })],
      mode: 'full_domain',
    })

    const unicode = await queryDomainAvailability({ query: '例子。中国' }, { provider, traceId })
    expect(unicode.state).toBe('ready')
    expect(dataFrom(unicode).items[0]).toMatchObject({
      cache: { status: 'not_used' },
      domainAscii: 'xn--fsqu00a.xn--fiqs8s',
      domainUnicode: '例子.中国',
      status: 'unsupported',
    })
  })

  it('maps all six PRD item statuses with explicit unavailable evidence', async () => {
    const provider = fixtureProvider()
    const cases = [
      ['ordinary.com', 'available'],
      ['premium.top', 'premium'],
      ['taken.cn', 'registered'],
      ['reserved.net', 'restricted'],
      ['ordinary.io', 'unsupported'],
    ] as const
    for (const [query, status] of cases) {
      const result = await queryDomainAvailability({ query }, { provider, traceId })
      expect(result.state, query).toBe('ready')
      expect(dataFrom(result).items[0].status, query).toBe(status)
      expect(dataFrom(result).items[0]).toMatchObject({
        dataSource: expect.any(String),
        observedAt: expect.any(String),
      })
    }

    const ambiguous = await queryDomainAvailability(
      { query: 'ambiguous', tlds: ['com', 'io'] },
      { provider, traceId },
    )
    expect(ambiguous.state).toBe('degraded')
    expect(dataFrom(ambiguous).items.map((item) => item.status)).toEqual([
      'query_failed',
      'unsupported',
    ])
    const failed = dataFrom(ambiguous).items[0]
    expect(failed.status).toBe('query_failed')
    if (failed.status === 'query_failed') {
      expect(failed.problem.code).toBe('WESTDIGITAL_STATUS_AMBIGUOUS')
      expect(failed.problem.detail).toContain('无法区分已注册与保留/限制')
    }
  })

  it('expresses partial, degraded, error, rate-limited and empty aggregate states', async () => {
    const provider = fixtureProvider()
    expect((await queryDomainAvailability({ query: 'partial' }, { provider, traceId })).state).toBe(
      'partial',
    )
    expect((await queryDomainAvailability({ query: 'failed' }, { provider, traceId })).state).toBe(
      'error',
    )
    expect(
      (await queryDomainAvailability({ query: 'ratelimited' }, { provider, traceId })).state,
    ).toBe('rate_limited')

    const emptyCatalog: DomainSearchCatalog = {
      defaultTlds: [],
      supportedTlds: [],
      unavailableEvidence: {},
    }
    const empty = await queryDomainAvailability(
      { query: 'wanmi' },
      { catalog: emptyCatalog, provider, traceId },
    )
    expect(empty.state).toBe('empty')
    expect(dataFrom(empty).items).toEqual([])
    expect(empty.meta?.cacheStatus).toBe('not_used')
  })

  it('isolates a thrown TLD request and rejects ambiguous request shapes explicitly', async () => {
    const provider: WestDigitalReadProvider = {
      async health() {
        return success({ healthy: true })
      },
      async queryAvailability({ domain }) {
        if (domain.endsWith('.xyz')) throw new Error('fixture transport exploded')
        return success({
          available: true,
          currency: 'CNY',
          domainAscii: domain,
          premium: false,
        })
      },
      async queryPrice(): Promise<ProviderResult<WestDigitalPrice>> {
        throw new Error('not used')
      },
    }
    const partial = await queryDomainAvailability({ query: 'wanmi' }, { provider, traceId })
    expect(partial.state).toBe('partial')
    expect(dataFrom(partial).items.filter((item) => item.status === 'query_failed')).toHaveLength(1)
    expect(dataFrom(partial).items.filter((item) => item.status === 'available')).toHaveLength(9)

    await expect(
      queryDomainAvailability({ query: 'wanmi', tlds: ['com', '.COM'] }, { provider, traceId }),
    ).rejects.toMatchObject({ code: 'DOMAIN_SEARCH_DUPLICATE_TLD' })
    await expect(
      queryDomainAvailability({ query: 'wanmi.com', tlds: ['net'] }, { provider, traceId }),
    ).rejects.toMatchObject({ code: 'DOMAIN_SEARCH_TLDS_NOT_ALLOWED' })
  })
})

function success<T>(data: T): ProviderResult<T> {
  return {
    cache: { status: 'miss' },
    data,
    observedAt: '2026-08-05T12:00:00.000Z',
    ok: true,
    requestId: 'fixture-request-id',
  }
}
