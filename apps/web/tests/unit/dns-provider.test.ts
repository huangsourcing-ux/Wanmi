import { Buffer } from 'node:buffer'

import * as dnsPacket from 'dns-packet'
import { describe, expect, it, vi } from 'vitest'

import { AliDnsProvider, type AliDnsConfig } from '@/providers/alidns'
import { DNS_RECORD_TYPES, type DnsRecordType } from '@/schemas/dns'

const config: AliDnsConfig = {
  burst: 40,
  maxConcurrency: 8,
  maxResponseBytes: 65_536,
  queueCapacity: 64,
  queueWaitMs: 2_000,
  ratePerSecond: 20,
  timeoutMs: 3_000,
}

function packetResponse(
  input: RequestInit | undefined,
  answers: dnsPacket.Answer[],
  options: { authorities?: dnsPacket.Answer[]; flags?: number; idOffset?: number } = {},
): Response {
  const query = dnsPacket.decode(Buffer.from(input?.body as Uint8Array))
  const encoded = dnsPacket.encode({
    additionals: [],
    answers,
    authorities: options.authorities ?? [],
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE | (options.flags ?? 0),
    id: (query.id ?? 0) + (options.idOffset ?? 0),
    questions: query.questions,
    type: 'response',
  })
  return new Response(new Uint8Array(encoded), {
    headers: { 'content-type': 'application/dns-message' },
  })
}

function answerFor(type: DnsRecordType, name = 'example.test'): dnsPacket.Answer {
  const base = { class: 'IN' as const, name, ttl: 300, type }
  if (type === 'A') return { ...base, data: '93.184.216.34', type }
  if (type === 'AAAA') return { ...base, data: '2606:2800:220:1:248:1893:25c8:1946', type }
  if (type === 'CNAME') return { ...base, data: 'target.example.test', type }
  if (type === 'MX') {
    return { ...base, data: { exchange: 'mail.example.test', preference: 10 }, type }
  }
  if (type === 'TXT') return { ...base, data: [Buffer.from('v=spf1 '), Buffer.from('~all')], type }
  if (type === 'NS') return { ...base, data: 'ns1.example.test', type }
  if (type === 'SOA') {
    return {
      ...base,
      data: {
        expire: 604_800,
        minimum: 300,
        mname: 'ns1.example.test',
        refresh: 3_600,
        retry: 600,
        rname: 'hostmaster.example.test',
        serial: 2_026_080_501,
      },
      type,
    }
  }
  return { ...base, data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' }, type }
}

function provider(
  fetchImpl: typeof fetch,
  logger?: {
    info: (fields: Record<string, unknown>) => void
    warn: (fields: Record<string, unknown>) => void
  },
) {
  return new AliDnsProvider({
    config,
    fetchImpl,
    logger,
    now: () => Date.parse('2026-08-05T12:00:00.000Z'),
    requestIdFactory: () => 'dns-provider-request',
    transactionIdFactory: () => 42,
  })
}

describe('AliDNS controlled DoH provider', () => {
  it('allows a single-label TLD only for RFC 8659 CAA tree climbing', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      packetResponse(init, [answerFor('CAA', 'test')]),
    ) as unknown as typeof fetch
    const dns = provider(fetchImpl)
    await expect(
      dns.queryRecordSet({ domainAscii: 'test', recordType: 'CAA', traceId: 'trace-caa-tld' }),
    ).resolves.toMatchObject({ data: { records: [{ type: 'CAA' }], status: 'records' }, ok: true })
    await expect(
      dns.queryRecordSet({ domainAscii: 'test', recordType: 'A', traceId: 'trace-a-tld' }),
    ).resolves.toMatchObject({ error: { code: 'DNS_INVALID_DOMAIN' }, ok: false })
  })

  it.each(DNS_RECORD_TYPES)(
    'parses %s records with TTL from a strict DNS response',
    async (type) => {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        packetResponse(init, [answerFor(type)]),
      ) as unknown as typeof fetch
      const result = await provider(fetchImpl).queryRecordSet({
        domainAscii: 'example.test',
        recordType: type,
        traceId: 'trace-dns-provider',
      })
      expect(result).toMatchObject({
        data: {
          fallbackUsed: false,
          records: [{ ttl: 300, type }],
          resolverNode: 'alidns_primary',
          status: 'records',
        },
        ok: true,
      })
      const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(url).toBe('https://223.5.5.5/dns-query')
      expect(init).toMatchObject({
        cache: 'no-store',
        headers: {
          accept: 'application/dns-message',
          'content-type': 'application/dns-message',
        },
        method: 'POST',
        redirect: 'error',
      })
      const query = dnsPacket.decode(Buffer.from((init as RequestInit).body as Uint8Array))
      expect(query.questions).toEqual([{ class: 'IN', name: 'example.test', type }])
    },
  )

  it('distinguishes NXDOMAIN, SERVFAIL and NOERROR without records', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const query = dnsPacket.decode(Buffer.from(init?.body as Uint8Array))
      const name = query.questions?.[0]?.name
      const rcode = name === 'one.example.test' ? 3 : name === 'two.example.test' ? 2 : 0
      return packetResponse(init, [], {
        authorities:
          rcode === 3
            ? [
                {
                  class: 'IN',
                  data: {
                    expire: 604_800,
                    minimum: 30,
                    mname: 'ns1.example.test',
                    refresh: 3_600,
                    retry: 600,
                    rname: 'hostmaster.example.test',
                    serial: 1,
                  },
                  name: 'example.test',
                  ttl: 60,
                  type: 'SOA',
                },
              ]
            : [],
        flags: rcode,
      })
    }) as unknown as typeof fetch
    const dns = provider(fetchImpl)
    const nxdomain = await dns.queryRecordSet({
      domainAscii: 'one.example.test',
      recordType: 'A',
      traceId: 'trace-one',
    })
    const servfail = await dns.queryRecordSet({
      domainAscii: 'two.example.test',
      recordType: 'A',
      traceId: 'trace-two',
    })
    const noRecord = await dns.queryRecordSet({
      domainAscii: 'three.example.test',
      recordType: 'A',
      traceId: 'trace-three',
    })
    expect(nxdomain).toMatchObject({
      data: { negativeTtlSeconds: 30, status: 'nxdomain' },
      ok: true,
    })
    expect(servfail).toMatchObject({ data: { status: 'servfail' }, ok: true })
    expect(noRecord).toMatchObject({ data: { status: 'no_record' }, ok: true })
  })

  it('uses only the fixed secondary endpoint after a primary transport failure', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('223.5.5.5')) throw new TypeError('offline')
      return packetResponse(init, [answerFor('A')])
    }) as unknown as typeof fetch
    const result = await provider(fetchImpl).queryRecordSet({
      domainAscii: 'example.test',
      recordType: 'A',
      traceId: 'trace-fallback',
    })
    expect(result).toMatchObject({
      data: { fallbackUsed: true, resolverNode: 'alidns_secondary', status: 'records' },
      ok: true,
    })
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url))).toEqual([
      'https://223.5.5.5/dns-query',
      'https://223.6.6.6/dns-query',
    ])
  })

  it('refuses redirects instead of following a controlled resolver request into an internal host', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      return Response.redirect('http://127.0.0.1/internal-dns', 302)
    }) as unknown as typeof fetch
    const result = await provider(fetchImpl).queryRecordSet({
      domainAscii: 'redirect.example.test',
      recordType: 'A',
      traceId: 'trace-dns-internal-redirect',
    })
    expect(result).toMatchObject({ error: { code: 'DNS_UNAVAILABLE' }, ok: false })
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url))).toEqual([
      'https://223.5.5.5/dns-query',
      'https://223.6.6.6/dns-query',
    ])
  })

  it('maps dual timeout, oversized and mismatched packets to safe failures', async () => {
    const timeoutFetch = vi.fn(async () => {
      throw new DOMException('timeout', 'TimeoutError')
    }) as unknown as typeof fetch
    const timeout = await provider(timeoutFetch).queryRecordSet({
      domainAscii: 'timeout.example.test',
      recordType: 'A',
      traceId: 'trace-timeout',
    })
    expect(timeout).toMatchObject({ error: { code: 'DNS_TIMEOUT' }, ok: false })

    const oversizedFetch = vi.fn(
      async () =>
        new Response(new Uint8Array(), {
          headers: {
            'content-length': '65537',
            'content-type': 'application/dns-message',
          },
        }),
    ) as unknown as typeof fetch
    const oversized = await provider(oversizedFetch).queryRecordSet({
      domainAscii: 'oversized.example.test',
      recordType: 'A',
      traceId: 'trace-oversized',
    })
    expect(oversized).toMatchObject({ error: { code: 'DNS_RESPONSE_TOO_LARGE' }, ok: false })

    const mismatchFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      packetResponse(init, [answerFor('A')], { idOffset: 1 }),
    ) as unknown as typeof fetch
    const mismatch = await provider(mismatchFetch).queryRecordSet({
      domainAscii: 'mismatch.example.test',
      recordType: 'A',
      traceId: 'trace-mismatch',
    })
    expect(mismatch).toMatchObject({ error: { code: 'DNS_INVALID_RESPONSE' }, ok: false })
  })

  it('rejects record counts over the per-type limit', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      packetResponse(
        init,
        Array.from({ length: 33 }, () => answerFor('A')),
      ),
    ) as unknown as typeof fetch
    const result = await provider(fetchImpl).queryRecordSet({
      domainAscii: 'example.test',
      recordType: 'A',
      traceId: 'trace-record-limit',
    })
    expect(result).toMatchObject({ error: { code: 'DNS_INVALID_RESPONSE' }, ok: false })
  })

  it('enforces the outbound concurrency and bounded queue limits', async () => {
    const pending: Array<{ init?: RequestInit; resolve: (response: Response) => void }> = []
    let active = 0
    let maxActive = 0
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          pending.push({
            init,
            resolve: (response) => {
              active -= 1
              resolve(response)
            },
          })
        }),
    ) as unknown as typeof fetch
    const dns = new AliDnsProvider({
      config: { ...config, maxConcurrency: 1, queueCapacity: 1 },
      fetchImpl,
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => Date.parse('2026-08-05T12:00:00.000Z'),
      requestIdFactory: () => 'dns-concurrency-request',
      transactionIdFactory: () => 42,
    })
    const first = dns.queryRecordSet({
      domainAscii: 'one.example.test',
      recordType: 'A',
      traceId: 'trace-concurrency-one',
    })
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const second = dns.queryRecordSet({
      domainAscii: 'two.example.test',
      recordType: 'A',
      traceId: 'trace-concurrency-two',
    })
    await Promise.resolve()
    await Promise.resolve()
    const rejected = dns.queryRecordSet({
      domainAscii: 'three.example.test',
      recordType: 'A',
      traceId: 'trace-concurrency-three',
    })
    await expect(rejected).resolves.toMatchObject({ error: { code: 'DNS_QUEUE_FULL' }, ok: false })

    const firstQuestion = dnsPacket.decode(Buffer.from(pending[0].init?.body as Uint8Array))
    pending[0].resolve(
      packetResponse(pending[0].init, [answerFor('A', firstQuestion.questions?.[0]?.name)]),
    )
    await expect(first).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    const secondQuestion = dnsPacket.decode(Buffer.from(pending[1].init?.body as Uint8Array))
    pending[1].resolve(
      packetResponse(pending[1].init, [answerFor('A', secondQuestion.questions?.[0]?.name)]),
    )
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(maxActive).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('deduplicates in-flight requests and never logs domains or record values', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    let capturedInit: RequestInit | undefined
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          capturedInit = init
          resolveFetch = (response) => resolve(response)
        }),
    ) as unknown as typeof fetch
    const logger = { info: vi.fn(), warn: vi.fn() }
    const dns = provider(fetchImpl, logger)
    const first = dns.queryRecordSet({
      domainAscii: 'secret.example.test',
      recordType: 'A',
      traceId: 'trace-first',
    })
    const second = dns.queryRecordSet({
      domainAscii: 'secret.example.test',
      recordType: 'A',
      traceId: 'trace-second',
    })
    await vi.waitFor(() => expect(resolveFetch).toBeDefined())
    resolveFetch?.(packetResponse(capturedInit, [answerFor('A', 'secret.example.test')]))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('secret.example.test')
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('93.184.216.34')
  })
})
