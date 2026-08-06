// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DnsResults } from '@/components/results/dns-results'
import { AppError, toProblemDetails } from '@/lib/errors'
import {
  DNS_RECORD_TYPES,
  dnsLookupResultSchema,
  type DnsRecord,
  type DnsRecordSet,
  type DnsRecordType,
} from '@/schemas/dns'

const observedAt = '2026-08-05T12:00:00.000Z'
const traceId = 'trace-dns-component'

function record(type: DnsRecordType): DnsRecord {
  const base = { ownerName: 'xn--fsqu00a.xn--0zwm56d', ttl: 300, type }
  if (type === 'A') return { ...base, address: '93.184.216.34', type }
  if (type === 'AAAA') {
    return { ...base, address: '2606:2800:220:1:248:1893:25c8:1946', type }
  }
  if (type === 'CNAME') return { ...base, target: 'target.example.test', type }
  if (type === 'MX') {
    return { ...base, exchange: 'mail.example.test', priority: 10, type }
  }
  if (type === 'TXT') return { ...base, type, value: 'v=spf1 ~all' }
  if (type === 'NS') return { ...base, host: 'ns1.example.test', type }
  if (type === 'SOA') {
    return {
      ...base,
      expire: 604_800,
      minimum: 300,
      primaryNameServer: 'ns1.example.test',
      refresh: 3_600,
      responsibleMailbox: 'hostmaster.example.test',
      retry: 600,
      serial: 2_026_080_501,
      type,
    }
  }
  return { ...base, flags: 0, tag: 'issue', type, value: 'letsencrypt.org' }
}

function recordSets(status: DnsRecordSet['status'] = 'records'): DnsRecordSet[] {
  return DNS_RECORD_TYPES.map((type, index) => {
    const base = {
      cacheStatus: index === 0 ? ('hit' as const) : ('miss' as const),
      observedAt,
      records: status === 'records' ? [record(type)] : [],
      resolverNode: index === 0 ? ('alidns_secondary' as const) : ('alidns_primary' as const),
      status,
      type,
    }
    if (status === 'records' || status === 'no_record' || status === 'nxdomain') return base
    return {
      ...base,
      issue: {
        code: status === 'blocked' ? 'DNS_TARGET_BLOCKED' : 'DNS_TIMEOUT',
        message: status === 'blocked' ? 'DNS 记录目标未通过安全校验' : 'DNS 查询超时',
        retryable: status !== 'blocked',
      },
    }
  }) as DnsRecordSet[]
}

function mockFetch(result: unknown) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void init
    if (String(url) === '/api/v1/tools/dns') return Response.json(result)
    return new Response(null, { status: 202 })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('D2-05 DNS result presentation', () => {
  it('renders eight typed records, TTL, source, time and cache with isolated requests', async () => {
    const result = dnsLookupResultSchema.parse({
      data: {
        normalizedQueryAscii: 'xn--fsqu00a.xn--0zwm56d',
        normalizedQueryUnicode: '例子.测试',
        recordSets: recordSets(),
        risks: [],
      },
      meta: {
        cacheStatus: 'mixed',
        dataSource: '阿里公共 DNS（受控 DoH）',
        observedAt,
        traceId,
      },
      state: 'ready',
    })
    const fetch = mockFetch(result)
    vi.stubGlobal('fetch', fetch)
    render(<DnsResults query="例子.测试" />)

    await screen.findByRole('heading', { level: 2, name: 'DNS / NS 查询结果' })
    for (const type of DNS_RECORD_TYPES) {
      expect(screen.getByRole('heading', { name: type })).not.toBeNull()
    }
    expect(screen.getAllByText('300 秒')).toHaveLength(8)
    expect(screen.getByText('例子.测试')).not.toBeNull()
    expect(screen.getAllByText('xn--fsqu00a.xn--0zwm56d').length).toBeGreaterThan(0)
    expect(screen.getAllByText('阿里公共 DNS（受控 DoH）').length).toBeGreaterThan(0)
    expect(screen.getAllByText('阿里公共 DNS 备用节点').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Wanmi 短时缓存命中').length).toBeGreaterThan(0)
    expect(screen.getAllByText('部分缓存命中').length).toBeGreaterThan(0)
    expect(screen.getByText(/CAA 在此只作为原始 DNS 记录展示/)).not.toBeNull()
    expect(screen.queryByRole('link', { name: /购买|注册|管理/ })).toBeNull()

    expect(fetch.mock.calls[0]).toEqual([
      '/api/v1/tools/dns',
      expect.objectContaining({
        body: JSON.stringify({ query: '例子.测试' }),
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

  it('states that NXDOMAIN is not availability or a registration signal', async () => {
    const result = dnsLookupResultSchema.parse({
      data: {
        normalizedQueryAscii: 'missing.example.test',
        normalizedQueryUnicode: 'missing.example.test',
        recordSets: recordSets('nxdomain'),
        risks: [],
      },
      meta: { cacheStatus: 'miss', dataSource: '阿里公共 DNS（受控 DoH）', observedAt, traceId },
      state: 'empty',
    })
    vi.stubGlobal('fetch', mockFetch(result))
    render(<DnsResults query="missing.example.test" />)

    await screen.findByRole('heading', { name: 'DNS 返回 NXDOMAIN' })
    expect(screen.getByText(/绝不代表域名可注册/)).not.toBeNull()
    expect(screen.getAllByText(/这不是可注册状态/)).toHaveLength(8)
  })

  it('renders blocked and timeout record sets as distinct partial failures', async () => {
    const sets = recordSets('no_record')
    sets[0] = recordSets('blocked')[0]
    sets[1] = recordSets('timeout')[1]
    const result = dnsLookupResultSchema.parse({
      data: {
        normalizedQueryAscii: 'partial.example.test',
        normalizedQueryUnicode: 'partial.example.test',
        recordSets: sets,
        risks: [],
      },
      meta: { cacheStatus: 'miss', dataSource: '阿里公共 DNS（受控 DoH）', observedAt, traceId },
      problem: toProblemDetails(
        new AppError('DNS_PARTIAL_RESULT', '部分 DNS 记录类型未能完成查询', 503),
        traceId,
      ),
      state: 'partial',
    })
    vi.stubGlobal('fetch', mockFetch(result))
    render(<DnsResults query="partial.example.test" />)

    await screen.findByText('DNS 记录目标未通过安全校验')
    expect(screen.getByText('DNS 查询超时')).not.toBeNull()
    expect(document.querySelector('[data-dns-type="A"]')?.getAttribute('data-dns-status')).toBe(
      'blocked',
    )
    expect(document.querySelector('[data-dns-type="AAAA"]')?.getAttribute('data-dns-status')).toBe(
      'timeout',
    )
  })
})
