// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WhoisResults } from '@/components/results/whois-results'
import { AppError, toProblemDetails } from '@/lib/errors'
import { whoisLookupResultSchema } from '@/schemas/whois'

const observedAt = '2026-08-05T12:00:00.000Z'
const traceId = 'trace-whois-component'

function data(provider: 'whodat' | 'westdigital' = 'whodat') {
  return {
    dates: {
      created: '2000-01-01T00:00:00.000Z',
      expires: null,
      updated: '2026-01-01T00:00:00.000Z',
    },
    domainAscii: 'xn--fsqu00a.xn--0zwm56d',
    domainUnicode: '例子.测试',
    nameServers: ['ns1.example.test'],
    normalizedQueryAscii: 'xn--fsqu00a.xn--0zwm56d',
    normalizedQueryUnicode: '例子.测试',
    recordStatus: 'record_found' as const,
    registrar: 'Fixture Registrar',
    risks: [],
    source: { protocol: provider === 'whodat' ? ('rdap' as const) : ('whois' as const), provider },
    statuses: ['client transfer prohibited'],
  }
}

function mockFetch(result: unknown) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void init
    if (String(url) === '/api/v1/tools/whois') return Response.json(result)
    return new Response(null, { status: 202 })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('D2-04 WHOIS result presentation', () => {
  it('renders public fields, source, time and cache without availability or sensitive fields', async () => {
    const result = whoisLookupResultSchema.parse({
      data: data(),
      meta: {
        cacheStatus: 'hit',
        dataSource: 'Who-Dat RDAP',
        observedAt,
        traceId,
      },
      state: 'ready',
    })
    const fetch = mockFetch(result)
    vi.stubGlobal('fetch', fetch)
    render(<WhoisResults query="例子.测试" />)

    await screen.findByRole('heading', { level: 2, name: 'RDAP / WHOIS 查询结果' })
    expect(screen.getByText('Who-Dat RDAP')).not.toBeNull()
    expect(screen.getByText('Who-Dat 缓存命中')).not.toBeNull()
    expect(screen.getByText('Fixture Registrar')).not.toBeNull()
    expect(screen.getByText('数据源未提供')).not.toBeNull()
    expect(screen.getByText('例子.测试')).not.toBeNull()
    expect(screen.getByRole('button', { name: '复制 WHOIS 字段：注册商' })).not.toBeNull()
    expect(screen.getByRole('button', { name: /复制 WHOIS 状态/u })).not.toBeNull()
    expect(screen.getByRole('button', { name: /复制 Name Server/u })).not.toBeNull()
    expect(screen.queryByRole('link', { name: /购买|注册/ })).toBeNull()
    expect(document.body.textContent).not.toMatch(/邮箱|电话|地址|联系人|clientid/i)

    expect(fetch.mock.calls[0]).toEqual([
      '/api/v1/tools/whois',
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
    for (const [, init] of fetch.mock.calls.filter(([url]) => String(url) === '/api/v1/events')) {
      expect(String((init as RequestInit).body)).not.toMatch(/例子|xn--fsqu00a/)
      expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'origin' })
    }
  })

  it('states that an empty public record is not availability', async () => {
    const result = whoisLookupResultSchema.parse({
      data: { ...data(), recordStatus: 'no_public_record' },
      meta: { cacheStatus: 'miss', dataSource: 'Who-Dat RDAP', observedAt, traceId },
      state: 'empty',
    })
    vi.stubGlobal('fetch', mockFetch(result))
    render(<WhoisResults query="例子.测试" />)
    await screen.findByRole('heading', { name: '未查到公开注册记录' })
    expect(screen.getByText(/绝不代表该域名可注册/)).not.toBeNull()
    expect(screen.queryByText('公开注册记录', { selector: '[data-slot="badge"]' })).toBeNull()
  })

  it('renders a West Digital degraded record with the primary-source failure explanation', async () => {
    const result = whoisLookupResultSchema.parse({
      data: data('westdigital'),
      meta: {
        cacheStatus: 'miss',
        dataSource: '西部数码 WHOIS（Who-Dat 降级）',
        observedAt,
        traceId,
      },
      problem: toProblemDetails(
        new AppError(
          'WHOIS_FALLBACK_USED',
          'Who-Dat 暂时不可用，当前展示西部数码 WHOIS 降级结果',
          503,
        ),
        traceId,
      ),
      state: 'degraded',
    })
    vi.stubGlobal('fetch', mockFetch(result))
    render(<WhoisResults query="例子.测试" />)
    await screen.findByRole('heading', { name: '服务暂时不可用' })
    expect(screen.getByText(/当前展示西部数码 WHOIS 降级结果/)).not.toBeNull()
    expect(screen.getByText('西部数码 WHOIS')).not.toBeNull()
  })

  it.each([
    ['error', 503, 'WHOIS_SOURCES_UNAVAILABLE'],
    ['rate_limited', 429, 'WHODAT_RATE_LIMITED'],
  ] as const)('renders the visible %s state', async (state, status, code) => {
    const result = whoisLookupResultSchema.parse({
      meta: { cacheStatus: 'miss', dataSource: 'Who-Dat RDAP/WHOIS', observedAt, traceId },
      problem: toProblemDetails(new AppError(code, '安全的查询失败说明', status), traceId),
      state,
    })
    vi.stubGlobal('fetch', mockFetch(result))
    render(<WhoisResults query="example.test" />)
    await screen.findByText('安全的查询失败说明')
    expect(screen.getByRole('alert')).not.toBeNull()
  })
})
