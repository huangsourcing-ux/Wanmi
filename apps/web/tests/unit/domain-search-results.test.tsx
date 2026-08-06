// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DomainSearchResults } from '@/components/results/domain-search-results'
import { AppError, toProblemDetails } from '@/lib/errors'
import { domainSearchResultSchema } from '@/schemas/domain-search'

const observedAt = '2026-08-05T12:00:00.000Z'
const traceId = 'trace-domain-search-component'

function item(status: 'available' | 'registered' | 'restricted' | 'unsupported') {
  return {
    cache: { status: status === 'unsupported' ? ('not_used' as const) : ('miss' as const) },
    dataSource: status === 'unsupported' ? 'Wanmi fixture TLD 配置' : '西部数码 fixture（非实时）',
    domainAscii: `fixture-${status}.com`,
    domainUnicode: `fixture-${status}.com`,
    observedAt,
    status,
    tld: 'com',
  }
}

const itemProblem = toProblemDetails(
  new AppError('WESTDIGITAL_UNAVAILABLE', '暂时无法确认该域名的可注册状态', 503),
  traceId,
)

const result = domainSearchResultSchema.parse({
  data: {
    items: [
      item('available'),
      {
        ...item('available'),
        currency: 'CNY',
        domainAscii: 'premium.top',
        domainUnicode: 'premium.top',
        premiumRegistrationPriceFen: 318_100,
        status: 'premium',
        tld: 'top',
      },
      item('registered'),
      item('restricted'),
      item('unsupported'),
      {
        ...item('available'),
        domainAscii: 'failed.xyz',
        domainUnicode: 'failed.xyz',
        problem: itemProblem,
        status: 'query_failed',
        tld: 'xyz',
      },
    ],
    mode: 'keyword',
    normalizedQueryAscii: 'fixture',
    normalizedQueryUnicode: 'fixture',
    risks: [],
    tlds: ['com', 'top', 'com', 'com', 'com', 'xyz'],
  },
  meta: {
    cacheStatus: 'mixed',
    dataSource: '西部数码 fixture（非实时） + Wanmi fixture TLD 配置',
    observedAt,
    traceId,
  },
  problem: toProblemDetails(
    new AppError('DOMAIN_SEARCH_PARTIAL', '一个域名暂时无法确认', 503),
    traceId,
  ),
  state: 'partial',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('D2-03 domain search result presentation', () => {
  it('renders all six statuses with source, time and cache while keeping the API request private', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void init
      if (String(url) === '/api/v1/tools/domain-search') return Response.json(result)
      return new Response(null, { status: 202 })
    })
    vi.stubGlobal('fetch', fetch)

    const { container } = render(<DomainSearchResults query="fixture" />)
    await screen.findByRole('heading', { level: 2, name: '可注册查询结果' })
    for (const status of [
      'available',
      'premium',
      'registered',
      'restricted',
      'unsupported',
      'query_failed',
    ]) {
      expect(container.querySelector(`[data-domain-status="${status}"]`)).not.toBeNull()
    }
    expect(screen.getAllByText(/fixture/).length).toBeGreaterThan(6)
    expect(screen.getAllByText(/最新查询|未使用缓存/).length).toBeGreaterThan(5)
    expect(screen.getAllByRole('button', { name: /复制可售记录/u })).toHaveLength(6)
    expect(screen.getAllByRole('link', { name: 'WHOIS / RDAP' })).toHaveLength(6)
    expect(screen.queryByRole('link', { name: /购买|注册/ })).toBeNull()

    expect(fetch.mock.calls[0]).toEqual([
      '/api/v1/tools/domain-search',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'omit',
        method: 'POST',
        referrerPolicy: 'origin',
      }),
    ])
    await vi.waitFor(() =>
      expect(
        fetch.mock.calls.filter(([url]) => String(url) === '/api/v1/events').length,
      ).toBeGreaterThan(0),
    )
    const analyticsCalls = fetch.mock.calls.filter(([url]) => String(url) === '/api/v1/events')
    for (const [, init] of analyticsCalls) {
      expect(String((init as RequestInit).body)).not.toContain('fixture.com')
      expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'origin' })
    }
  })
})
