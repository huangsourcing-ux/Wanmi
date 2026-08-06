import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  LiveWestDigitalWhoisTransport,
  WestDigitalWhoisProvider,
  type WestDigitalWhoisTransport,
} from '@/providers/westdigital-whois'

const observedAt = '2026-08-05T12:00:00.000Z'
const now = Date.parse(observedAt)

function upstreamData(overrides: Record<string, unknown> = {}) {
  return {
    clientid: 'sensitive-client-id',
    data: {
      bizserver: 'sensitive-provider-host',
      body: 'raw private whois body',
      code: 200,
      dom_em: 'private@example.test',
      dom_org: 'Private Registrant',
      expdate: '2030-01-01 00:00:00',
      nameserver: 'NS1.EXAMPLE.TEST, NS2.EXAMPLE.TEST',
      registrar: '测试注册商',
      regdate: '2000-01-01 00:00:00',
      status: 'ok, clientTransferProhibited',
      updated: '2026-01-01 00:00:00',
      ...overrides,
    },
    result: 200,
  }
}

function fixtureTransport(body: unknown, status = 200): WestDigitalWhoisTransport {
  return {
    execute: vi.fn(async () => ({ body, status })),
  }
}

function provider(transport: WestDigitalWhoisTransport) {
  return new WestDigitalWhoisProvider({
    config: {
      burst: 4,
      queueCapacity: 8,
      queueWaitMs: 100,
      ratePerSecond: 4,
      timeoutMs: 100,
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => now,
    requestIdFactory: () => 'westdigital-whois-request',
    transport,
  })
}

function gb18030JsonBytes(): Uint8Array {
  const json = JSON.stringify(upstreamData({ registrar: '__REGISTRAR__' }))
  const [prefix, suffix] = json.split('__REGISTRAR__')
  const prefixBytes = Buffer.from(prefix, 'utf8')
  const suffixBytes = Buffer.from(suffix, 'utf8')
  // “测试注册商” in GB18030/GBK.
  const registrarBytes = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xd7, 0xa2, 0xb2, 0xe1, 0xc9, 0xcc])
  return Buffer.concat([prefixBytes, registrarBytes, suffixBytes])
}

describe('West Digital WHOIS fallback adapter', () => {
  it('builds the documented HTTPS-only authenticated whois request and decodes GB18030', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(gb18030JsonBytes(), {
          headers: { 'content-type': 'application/json;charset=GB2312' },
          status: 200,
        }),
    )
    const transport = new LiveWestDigitalWhoisTransport({
      apiPassword: 'fixture-password',
      fetchImpl,
      maxResponseBytes: 65_536,
      now: () => now,
      username: 'fixture-user',
    })
    const response = await transport.execute({
      domainAscii: 'example.test',
      requestId: 'request-id',
      signal: AbortSignal.timeout(100),
    })
    const [url, init] = fetchImpl.mock.calls[0]
    const time = String(now)
    expect(String(url)).toBe('https://api.west.cn/api/v2/domain/')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const body = new URLSearchParams(String(init?.body))
    expect(Object.fromEntries(body)).toEqual({
      act: 'whois',
      domain: 'example.test',
      time,
      token: createHash('md5').update(`fixture-userfixture-password${time}`).digest('hex'),
      username: 'fixture-user',
    })
    expect(JSON.stringify(response.body)).toContain('测试注册商')
    expect(String(url)).not.toContain('example.test')
  })

  it('maps only documented public fields without exposing contacts, raw body or client ID', async () => {
    const transport = fixtureTransport(upstreamData())
    const result = await provider(transport).queryPublicRegistration({
      domainAscii: 'example.test',
      traceId: 'trace-westdigital-whois',
    })
    expect(result).toMatchObject({
      cache: { status: 'miss' },
      data: {
        dates: {
          created: '2000-01-01 00:00:00',
          expires: '2030-01-01 00:00:00',
          updated: '2026-01-01 00:00:00',
        },
        domainAscii: 'example.test',
        nameServers: ['NS1.EXAMPLE.TEST', 'NS2.EXAMPLE.TEST'],
        recordStatus: 'record_found',
        registrar: '测试注册商',
        source: { protocol: 'whois', provider: 'westdigital' },
        statuses: ['ok', 'clientTransferProhibited'],
      },
      observedAt,
      ok: true,
    })
    expect(JSON.stringify(result)).not.toMatch(
      /clientid|dom_em|dom_org|private@|raw private|bizserver/i,
    )
    expect(transport.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        domainAscii: 'example.test',
        requestId: 'westdigital-whois-request',
      }),
    )
  })

  it('never infers no-record or availability from empty or malformed fields', async () => {
    const empty = await provider(
      fixtureTransport(
        upstreamData({
          expdate: '',
          nameserver: '',
          registrar: '',
          regdate: '',
          status: '',
          updated: '',
        }),
      ),
    ).queryPublicRegistration({ domainAscii: 'example.test', traceId: 'trace-empty' })
    expect(empty).toMatchObject({ error: { code: 'WESTDIGITAL_WHOIS_STATUS_UNKNOWN' }, ok: false })
    expect(JSON.stringify(empty)).not.toContain('available')

    const malformed = await provider(
      fixtureTransport({ result: 200, clientid: 'private' }),
    ).queryPublicRegistration({ domainAscii: 'example.test', traceId: 'trace-malformed' })
    expect(malformed).toMatchObject({
      error: { code: 'WESTDIGITAL_WHOIS_INVALID_RESPONSE' },
      ok: false,
    })
  })

  it('maps rate limiting, timeout and response-size failures to safe errors', async () => {
    const rateLimited = await provider(
      fixtureTransport({ result: 429 }, 429),
    ).queryPublicRegistration({ domainAscii: 'example.test', traceId: 'trace-rate' })
    expect(rateLimited).toMatchObject({
      error: { code: 'WESTDIGITAL_RATE_LIMITED', retryable: true },
      ok: false,
    })

    const timeoutTransport: WestDigitalWhoisTransport = {
      execute: vi.fn(async () => Promise.reject(new DOMException('timeout', 'TimeoutError'))),
    }
    const timedOut = await provider(timeoutTransport).queryPublicRegistration({
      domainAscii: 'example.test',
      traceId: 'trace-timeout',
    })
    expect(timedOut).toMatchObject({ error: { code: 'WESTDIGITAL_TIMEOUT' }, ok: false })

    const oversizedTransport: WestDigitalWhoisTransport = {
      execute: vi.fn(async () => Promise.reject(new RangeError('too large'))),
    }
    const oversized = await provider(oversizedTransport).queryPublicRegistration({
      domainAscii: 'example.test',
      traceId: 'trace-oversized',
    })
    expect(oversized).toMatchObject({
      error: { code: 'WESTDIGITAL_RESPONSE_TOO_LARGE', retryable: false },
      ok: false,
    })
  })
})
