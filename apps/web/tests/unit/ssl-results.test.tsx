// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SslResults } from '@/components/results/ssl-results'
import { AppError, toProblemDetails } from '@/lib/errors'
import { sslCheckResultSchema, type SslCheckResult } from '@/schemas/tls'

const observedAt = '2026-08-05T12:00:00.000Z'
const traceId = 'trace-ssl-component'

function data(
  options: { finding?: boolean; tlsStatus?: 'connected' | 'connection_failed' | 'no_address' } = {},
) {
  const connected = options.tlsStatus !== 'connection_failed'
  return {
    caa: {
      effectiveOwnerName: 'example.test',
      inherited: true,
      records: [
        {
          critical: true,
          explanation: '该属性设置了 critical 标志；issue 指定可签发的 CA。',
          flags: 128,
          ownerName: 'example.test',
          tag: 'issue' as const,
          ttl: 300,
          value: 'ca.example',
        },
        {
          critical: false,
          explanation: 'iodef 是报告地址；Wanmi 不会访问该地址。',
          flags: 0,
          ownerName: 'example.test',
          tag: 'iodef' as const,
          ttl: 300,
          value: 'mailto:security@example.test',
        },
      ],
      source: {
        cacheStatus: 'hit' as const,
        dataSource: '阿里公共 DNS（受控 DoH）',
        observedAt,
      },
      status: 'records' as const,
    },
    normalizedQueryAscii: 'xn--fsqu00a.xn--0zwm56d',
    normalizedQueryUnicode: '例子.测试',
    risks: [],
    tls: connected
      ? {
          certificate: {
            chain: {
              certificates: [
                {
                  fingerprint256: 'AA:BB',
                  issuer: { commonName: 'Test Intermediate', organization: 'Wanmi Tests' },
                  subject: { commonName: '例子.测试', organization: 'Wanmi Tests' },
                  validFrom: '2026-08-01T00:00:00.000Z',
                  validTo: '2026-09-01T00:00:00.000Z',
                },
                {
                  fingerprint256: 'CC:DD',
                  issuer: { commonName: 'Test Root', organization: 'Wanmi Tests' },
                  subject: { commonName: 'Test Intermediate', organization: 'Wanmi Tests' },
                  validFrom: '2025-01-01T00:00:00.000Z',
                  validTo: '2030-01-01T00:00:00.000Z',
                },
              ],
              depth: 2,
              status: options.finding ? ('self_signed' as const) : ('trusted' as const),
              truncated: false,
            },
            daysRemaining: 27,
            hostnameMatch: !options.finding,
            issuer: { commonName: 'Test Intermediate', organization: 'Wanmi Tests' },
            sanCount: 2,
            sanTruncated: false,
            subject: { commonName: '例子.测试', organization: 'Wanmi Tests' },
            subjectAlternativeNames: ['xn--fsqu00a.xn--0zwm56d', '*.xn--0zwm56d'],
            validFrom: '2026-08-01T00:00:00.000Z',
            validityStatus: 'valid' as const,
            validTo: '2026-09-01T00:00:00.000Z',
          },
          cipherSuite: 'TLS_AES_256_GCM_SHA384',
          findings: options.finding
            ? [
                {
                  code: 'TLS_HOSTNAME_MISMATCH' as const,
                  message: '证书名称与查询域名不匹配',
                  severity: 'error' as const,
                },
              ]
            : [],
          port: 443 as const,
          protocol: 'TLSv1.3',
          source: {
            cacheStatus: 'miss' as const,
            dataSource: '直接 TLS 443 握手（Node.js 系统信任库）',
            observedAt,
          },
          status: 'connected' as const,
        }
      : {
          certificate: null,
          cipherSuite: null,
          findings: [],
          ...(options.tlsStatus === 'connection_failed'
            ? {
                issue: { code: 'TLS_TIMEOUT', message: 'TLS 连接或握手超时', retryable: true },
              }
            : {}),
          port: 443 as const,
          protocol: null,
          source: {
            cacheStatus: 'miss' as const,
            dataSource: '直接 TLS 443 握手（Node.js 系统信任库）',
            observedAt,
          },
          status: options.tlsStatus ?? ('connection_failed' as const),
        },
  }
}

function problem(code: string, status = 503) {
  return toProblemDetails(
    new AppError(code, 'SSL 检查结果说明', status, {
      action: '请检查配置后重试',
      retryable: status !== 422,
      title: 'SSL 检查状态',
    }),
    traceId,
  )
}

function result(state: SslCheckResult['state']): SslCheckResult {
  const meta = {
    cacheStatus: 'mixed' as const,
    dataSource: '阿里公共 DNS + 直接 TLS 443 握手',
    observedAt,
    traceId,
  }
  if (state === 'ready') return sslCheckResultSchema.parse({ data: data(), meta, state })
  if (state === 'empty') {
    return sslCheckResultSchema.parse({ data: data({ tlsStatus: 'no_address' }), meta, state })
  }
  if (state === 'degraded') {
    return sslCheckResultSchema.parse({
      data: data({ finding: true }),
      meta,
      problem: problem('TLS_HOSTNAME_MISMATCH', 422),
      state,
    })
  }
  if (state === 'partial') {
    return sslCheckResultSchema.parse({
      data: data({ tlsStatus: 'connection_failed' }),
      meta,
      problem: problem('TLS_TIMEOUT'),
      state,
    })
  }
  return sslCheckResultSchema.parse({
    meta,
    problem: problem(
      state === 'rate_limited' ? 'TLS_RATE_LIMITED' : 'TLS_TARGET_BLOCKED',
      state === 'rate_limited' ? 429 : 403,
    ),
    state,
  })
}

function mockFetch(value: SslCheckResult) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void init
    if (String(url) === '/api/v1/tools/ssl-check') return Response.json(value)
    return new Response(null, { status: 202 })
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('D2-06 SSL result presentation', () => {
  it('renders certificate, chain, CAA and source metadata with isolated requests', async () => {
    const fetch = mockFetch(result('ready'))
    vi.stubGlobal('fetch', fetch)
    render(<SslResults query="例子.测试" />)

    await screen.findByRole('heading', { level: 2, name: 'SSL / TLS / CAA 检查结果' })
    expect(screen.getByText('TLSv1.3')).not.toBeNull()
    expect(screen.getByText('TLS_AES_256_GCM_SHA384')).not.toBeNull()
    expect(screen.getByText(/系统信任库验证通过/)).not.toBeNull()
    expect(screen.getByText(/证书链（共 2 层）/)).not.toBeNull()
    expect(screen.getByText(/继承自父域：example.test/)).not.toBeNull()
    expect(screen.getByText(/128 issue/)).not.toBeNull()
    expect(screen.getByText(/不会访问该地址/)).not.toBeNull()
    expect(screen.getByRole('button', { name: '复制 TLS 连接' })).not.toBeNull()
    expect(screen.getAllByRole('button', { name: /复制 SAN/u })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /复制证书链第/u })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /复制 CAA 记录/u })).toHaveLength(2)
    expect(screen.getByText('trace-ssl-component')).not.toBeNull()
    expect(screen.getAllByText('Wanmi 短时缓存命中').length).toBeGreaterThan(0)
    expect(screen.getAllByText('本次重新查询').length).toBeGreaterThan(0)

    expect(fetch.mock.calls[0]).toEqual([
      '/api/v1/tools/ssl-check',
      expect.objectContaining({
        body: JSON.stringify({ query: '例子.测试' }),
        cache: 'no-store',
        credentials: 'omit',
        method: 'POST',
        referrerPolicy: 'origin',
      }),
    ])
    await vi.waitFor(() =>
      expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/v1/events').length).toBe(1),
    )
    const analyticsCall = fetch.mock.calls.find(([url]) => String(url) === '/api/v1/events')
    if (!analyticsCall) throw new Error('expected analytics request')
    const analyticsInit = analyticsCall[1]
    expect(String(analyticsInit?.body)).not.toMatch(/例子|xn--fsqu00a/)
    expect(JSON.parse(String(analyticsInit?.body))).toMatchObject({
      dataSource: 'tls',
      event: 'tool_completed',
      tool: 'ssl-check',
    })
  })

  it.each([
    ['empty', '没有可连接的公网地址'],
    ['degraded', 'SSL 检查状态'],
    ['partial', 'SSL 检查状态'],
    ['error', 'SSL 检查状态'],
    ['rate_limited', 'SSL 检查状态'],
  ] as const)('renders the %s contract state', async (state, heading) => {
    vi.stubGlobal('fetch', mockFetch(result(state)))
    render(<SslResults query={`${state}.example.test`} />)
    expect(await screen.findByRole('heading', { name: heading })).not.toBeNull()
    if (state === 'degraded') {
      expect(screen.getByText('TLS_HOSTNAME_MISMATCH')).not.toBeNull()
      expect(screen.getByText('证书名称与查询域名不匹配')).not.toBeNull()
    }
  })
})
