// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PricingResults } from '@/components/results/pricing-results'
import { AppError, toProblemDetails } from '@/lib/errors'
import { pricingResultSchema } from '@/schemas/pricing'

const observedAt = '2026-08-06T12:00:00.000Z'
const traceId = 'trace-pricing-component'
const base = {
  cache: { status: 'miss' as const },
  dataSource: '西部数码价格 fixture（非实时） + Wanmi fixture 加价规则目录',
  observedAt,
  purchaseEligible: false as const,
}
const price = {
  calculationFormula: 'registration_price_plus_annual_renewal_price' as const,
  currency: 'CNY' as const,
  markupConfigured: true as const,
  minimumRegistrationYears: 1 as const,
  oneYearTotalFen: 2_500,
  priceClass: 'standard' as const,
  registrationPriceFen: 2_500,
  renewalPriceFen: 3_500,
  threeYearTotalFen: 9_500,
}
const result = pricingResultSchema.parse({
  data: {
    items: [
      {
        ...base,
        ...price,
        purchaseBlockCode: 'PURCHASE_NOT_IMPLEMENTED',
        snapshotRef: '98a2c3c4-79ac-4b48-9380-0ffcf01555af',
        status: 'priced',
        tld: 'com',
      },
      {
        ...base,
        ...price,
        cache: { status: 'not_used' },
        dataSource: '西部数码价格 fixture（非实时）历史快照',
        lastSuccessfulAt: observedAt,
        purchaseBlockCode: 'PRICE_STALE',
        snapshotRef: '59b67a10-403e-4dce-9328-62ab4a084f1a',
        status: 'stale',
        tld: 'cn',
      },
      {
        ...base,
        cache: { status: 'not_used' },
        dataSource: 'Wanmi fixture 加价规则目录',
        markupConfigured: false,
        purchaseBlockCode: 'PRICE_RULE_UNCONFIGURED',
        status: 'unconfigured',
        tld: 'tv',
      },
      {
        ...base,
        cache: { status: 'not_used' },
        dataSource: 'Wanmi fixture 加价规则目录',
        purchaseBlockCode: 'TLD_UNSUPPORTED',
        status: 'unsupported',
        tld: 'io',
      },
      {
        ...base,
        problem: toProblemDetails(
          new AppError('WESTDIGITAL_UNAVAILABLE', '暂时无法取得最新 TLD 价格', 503),
          traceId,
        ),
        purchaseBlockCode: 'PRICE_QUERY_FAILED',
        status: 'query_failed',
        tld: 'xyz',
      },
    ],
    priceClass: 'standard',
    tlds: ['com', 'cn', 'tv', 'io', 'xyz'],
  },
  meta: {
    cacheStatus: 'mixed',
    dataSource: '西部数码价格 fixture（非实时） + Wanmi fixture 加价规则目录',
    observedAt,
    traceId,
  },
  problem: toProblemDetails(
    new AppError('PRICING_PARTIAL', '部分 TLD 暂时无法取得最新价格', 503),
    traceId,
  ),
  state: 'partial',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('D2-07 pricing presentation', () => {
  it('shows all item states and integer-formatted totals without a purchase entry point', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void init
      if (String(url) === '/api/v1/tools/pricing') return Response.json(result)
      return new Response(null, { status: 202 })
    })
    vi.stubGlobal('fetch', fetch)

    const { container } = render(<PricingResults />)
    await screen.findByRole('heading', { level: 2, name: '普通域名价格表' })
    for (const status of ['priced', 'stale', 'unconfigured', 'unsupported', 'query_failed']) {
      expect(container.querySelector(`[data-pricing-status="${status}"]`)).not.toBeNull()
    }
    expect(screen.getAllByText('¥25.00')).toHaveLength(4)
    expect(screen.getAllByText('¥95.00')).toHaveLength(2)
    expect(screen.queryByText('未配置加价规则，不开放购买。')).not.toBeNull()
    expect(screen.queryByText(/溢价域名不在本表内/u)).not.toBeNull()
    expect(screen.queryByText(/交易功能尚未开放/u)).not.toBeNull()
    expect(screen.queryByRole('button', { name: /购买|注册/u })).toBeNull()
    expect(screen.queryByRole('link', { name: /购买|注册/u })).toBeNull()

    expect(fetch.mock.calls[0]).toEqual([
      '/api/v1/tools/pricing',
      expect.objectContaining({
        body: '{}',
        cache: 'no-store',
        credentials: 'omit',
        method: 'POST',
        referrerPolicy: 'origin',
      }),
    ])
    await vi.waitFor(() =>
      expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/v1/events')).toHaveLength(1),
    )
    const analyticsCall = fetch.mock.calls.find(([url]) => String(url) === '/api/v1/events')
    const analyticsBody = String(analyticsCall?.[1]?.body)
    const analytics = JSON.parse(analyticsBody) as Record<string, unknown>
    expect(analytics).not.toHaveProperty('tld')
    expect(analyticsBody).not.toMatch(/2500|upstream|snapshotRef/iu)
  })
})
