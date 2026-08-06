import { describe, expect, it, vi } from 'vitest'

import { WhoDatProvider } from '@/providers/whodat'

const observedAt = '2026-08-05T12:00:00.000Z'

function contact() {
  return {
    address: { city: null, country: null, postalCode: null, state: null, street: null },
    email: null,
    name: null,
    organization: null,
    phone: null,
    redacted: true,
  }
}

function fixture(
  options: {
    cached?: boolean
    domain?: string
    isRegistered?: boolean
    source?: 'rdap' | 'whois'
  } = {},
) {
  const domain = options.domain ?? 'example.test'
  return {
    contacts: {
      admin: contact(),
      billing: contact(),
      registrant: contact(),
      tech: contact(),
    },
    dates: {
      created: options.isRegistered === false ? null : '2000-01-01T00:00:00.000Z',
      expires: options.isRegistered === false ? null : '2030-01-01T00:00:00.000Z',
      updated: options.isRegistered === false ? null : '2026-01-01T00:00:00.000Z',
    },
    dnssec: { dsData: [], signed: false },
    domain,
    domainUnicode: domain,
    id: null,
    isRegistered: options.isRegistered ?? true,
    meta: {
      cached: options.cached ?? false,
      fetchedAt: observedAt,
      server: 'must-not-be-public.example',
      source: options.source ?? 'rdap',
    },
    nameservers: [{ ipv4: [], ipv6: [], name: 'NS1.EXAMPLE.TEST' }],
    query: domain,
    registrar: {
      abuseEmail: 'private@example.test',
      abusePhone: '+1.5555555555',
      ianaId: '376',
      name: 'Fixture Registrar',
      reseller: null,
      url: 'https://registrar.example',
      whoisServer: 'whois.example.test',
    },
    status: ['client transfer prohibited'],
    tld: 'test',
  }
}

function provider(
  fetchImpl: typeof fetch,
  overrides: Partial<{
    burst: number
    maxResponseBytes: number
    queueCapacity: number
    queueWaitMs: number
    ratePerSecond: number
    timeoutMs: number
  }> = {},
) {
  return new WhoDatProvider({
    config: {
      baseUrl: 'http://127.0.0.1:8080',
      burst: 10,
      maxResponseBytes: 65_536,
      queueCapacity: 8,
      queueWaitMs: 100,
      ratePerSecond: 10,
      timeoutMs: 100,
      ...overrides,
    },
    fetchImpl,
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => Date.parse(observedAt),
    requestIdFactory: () => 'whodat-request-id',
  })
}

describe('Who-Dat public registration adapter', () => {
  it('maps an RDAP record, source time and cache metadata without exposing private fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(fixture()))
    const result = await provider(fetchImpl).queryPublicRegistration({
      domainAscii: 'EXAMPLE.TEST',
      traceId: 'trace-whodat-rdap',
    })

    expect(result).toMatchObject({
      cache: { status: 'miss' },
      data: {
        domainAscii: 'example.test',
        nameServers: ['ns1.example.test'],
        recordStatus: 'record_found',
        registrar: 'Fixture Registrar',
        source: { protocol: 'rdap', provider: 'whodat' },
      },
      observedAt,
      ok: true,
    })
    expect(JSON.stringify(result)).not.toMatch(
      /abuse|private@example|whoisServer|must-not-be-public/i,
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8080/v1/whois/example.test'),
      expect.objectContaining({ redirect: 'error' }),
    )
  })

  it('treats Who-Dat WHOIS coverage and no-public-record as normal outcomes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(fixture({ cached: true, isRegistered: false, source: 'whois' })),
    )
    const result = await provider(fetchImpl).queryPublicRegistration({
      domainAscii: 'example.test',
      traceId: 'trace-whodat-whois',
    })
    expect(result).toMatchObject({
      cache: { status: 'hit' },
      data: {
        recordStatus: 'no_public_record',
        source: { protocol: 'whois', provider: 'whodat' },
      },
      ok: true,
    })
    expect(JSON.stringify(result)).not.toContain('available')
  })

  it.each([
    [400, 'WHODAT_INVALID_DOMAIN', false],
    [401, 'WHODAT_AUTH_FAILED', false],
    [429, 'WHODAT_RATE_LIMITED', true],
    [501, 'WHODAT_UNSUPPORTED_TLD', false],
    [502, 'WHODAT_UPSTREAM_ERROR', true],
    [504, 'WHODAT_TIMEOUT', true],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('private upstream detail', {
          headers: status === 429 ? { 'retry-after': '7' } : undefined,
          status,
        }),
    )
    const result = await provider(fetchImpl).queryPublicRegistration({
      domainAscii: 'example.test',
      traceId: `trace-whodat-${status}`,
    })
    expect(result).toMatchObject({ error: { code, retryable }, ok: false })
    if (!result.ok && status === 429) expect(result.error.retryAfterSeconds).toBe(7)
    expect(JSON.stringify(result)).not.toContain('private upstream detail')
  })

  it('rejects redirects, wrong content type, oversized and malformed responses', async () => {
    const cases: [Response, string][] = [
      [
        new Response(null, { headers: { location: 'http://private.test' }, status: 302 }),
        'WHODAT_REDIRECT_REJECTED',
      ],
      [
        new Response('html', { headers: { 'content-type': 'text/html' } }),
        'WHODAT_INVALID_RESPONSE',
      ],
      [
        new Response(JSON.stringify(fixture()), {
          headers: { 'content-length': '100000', 'content-type': 'application/json' },
        }),
        'WHODAT_RESPONSE_TOO_LARGE',
      ],
      [
        new Response('{', { headers: { 'content-type': 'application/json' } }),
        'WHODAT_INVALID_RESPONSE',
      ],
      [
        Response.json({ ...fixture(), registrar: { name: 'missing strict fields' } }),
        'WHODAT_INVALID_RESPONSE',
      ],
    ]
    for (const [response, code] of cases) {
      const result = await provider(
        vi.fn<typeof fetch>(async () => response),
      ).queryPublicRegistration({
        domainAscii: 'example.test',
        traceId: 'trace-invalid',
      })
      expect(result).toMatchObject({ error: { code }, ok: false })
    }
  })

  it('maps connection and timeout failures and coalesces identical in-flight queries', async () => {
    const unavailable = await provider(
      vi.fn<typeof fetch>(async () => Promise.reject(new TypeError('connection refused'))),
    ).queryPublicRegistration({ domainAscii: 'example.test', traceId: 'trace-unavailable' })
    expect(unavailable).toMatchObject({ error: { code: 'WHODAT_UNAVAILABLE' }, ok: false })

    const timedOut = await provider(
      vi.fn<typeof fetch>(async () => Promise.reject(new DOMException('timeout', 'TimeoutError'))),
    ).queryPublicRegistration({ domainAscii: 'example.test', traceId: 'trace-timeout' })
    expect(timedOut).toMatchObject({ error: { code: 'WHODAT_TIMEOUT' }, ok: false })

    let resolveResponse!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    const fetchImpl = vi.fn<typeof fetch>(async () => pending)
    const instance = provider(fetchImpl)
    const first = instance.queryPublicRegistration({
      domainAscii: 'example.test',
      traceId: 'trace-first',
    })
    const second = instance.queryPublicRegistration({
      domainAscii: 'example.test',
      traceId: 'trace-second',
    })
    resolveResponse(Response.json(fixture()))
    expect(await first).toEqual(await second)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('bounds distinct queued lookups and returns stable full and timeout errors', async () => {
    let resolveResponse!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    const fetchImpl = vi.fn<typeof fetch>(async () => pending)
    const instance = provider(fetchImpl, {
      burst: 1,
      queueCapacity: 1,
      queueWaitMs: 10,
      ratePerSecond: 0.01,
    })
    const first = instance.queryPublicRegistration({
      domainAscii: 'example.test',
      traceId: 'trace-first',
    })
    const queued = instance.queryPublicRegistration({
      domainAscii: 'queued.test',
      traceId: 'trace-queued',
    })
    const full = await instance.queryPublicRegistration({
      domainAscii: 'full.test',
      traceId: 'trace-full',
    })
    expect(full).toMatchObject({ error: { code: 'WHODAT_QUEUE_FULL' }, ok: false })
    await expect(queued).resolves.toMatchObject({
      error: { code: 'WHODAT_QUEUE_TIMEOUT' },
      ok: false,
    })
    resolveResponse(Response.json(fixture()))
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('checks the bounded health endpoint without calling a queried host', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ status: 'ok' }))
    const result = await provider(fetchImpl).health()
    expect(result).toMatchObject({ data: { healthy: true }, ok: true })
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8080/health'),
      expect.objectContaining({ redirect: 'error' }),
    )
  })
})
