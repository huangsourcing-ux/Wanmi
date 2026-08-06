import { describe, expect, it, vi } from 'vitest'

import { createSslCheckPostHandler } from '@/app/api/v1/tools/ssl-check/route'
import type { DnsReadProvider, TlsHandshakeProvider } from '@/providers/types'
import { sslCheckResultSchema } from '@/schemas/tls'
import { DnsResultCache } from '@/services/dns/query-dns-records'
import { TlsResultCache } from '@/services/tls/query-tls-certificate'

const observedAt = '2026-08-05T12:00:00.000Z'

function dnsProvider(): DnsReadProvider & { queryRecordSet: ReturnType<typeof vi.fn> } {
  const queryRecordSet = vi.fn<DnsReadProvider['queryRecordSet']>(
    async ({ domainAscii, recordType }) => ({
      cache: { status: 'miss' },
      data: {
        fallbackUsed: false,
        ...(recordType === 'A' ? {} : { negativeTtlSeconds: 30 }),
        records:
          recordType === 'A'
            ? [{ address: '93.184.216.34', ownerName: domainAscii, ttl: 60, type: 'A' as const }]
            : [],
        resolverNode: 'alidns_primary',
        status: recordType === 'A' ? ('records' as const) : ('no_record' as const),
      },
      observedAt,
      ok: true,
      requestId: `dns-${recordType}`,
    }),
  )
  return {
    health: async () => ({
      data: { healthy: true },
      observedAt,
      ok: true,
      requestId: 'dns-health',
    }),
    queryRecordSet,
  }
}

function tlsProvider(): TlsHandshakeProvider & { inspectCertificate: ReturnType<typeof vi.fn> } {
  const inspectCertificate = vi.fn<TlsHandshakeProvider['inspectCertificate']>(async () => ({
    cache: { status: 'miss' },
    data: {
      certificate: {
        chain: {
          certificates: [
            {
              fingerprint256: 'AA:BB',
              issuer: { commonName: 'Test Root', organization: null },
              subject: { commonName: '例子.测试', organization: null },
              validFrom: '2026-08-01T00:00:00.000Z',
              validTo: '2026-09-01T00:00:00.000Z',
            },
          ],
          depth: 1,
          status: 'trusted',
          truncated: false,
        },
        daysRemaining: 27,
        hostnameMatch: true,
        issuer: { commonName: 'Test Root', organization: null },
        sanCount: 1,
        sanTruncated: false,
        subject: { commonName: '例子.测试', organization: null },
        subjectAlternativeNames: ['xn--fsqu00a.xn--0zwm56d'],
        validFrom: '2026-08-01T00:00:00.000Z',
        validityStatus: 'valid',
        validTo: '2026-09-01T00:00:00.000Z',
      },
      cipherSuite: 'TLS_AES_256_GCM_SHA384',
      findings: [],
      protocol: 'TLSv1.3',
    },
    observedAt,
    ok: true,
    requestId: 'tls-route',
  }))
  return {
    health: async () => ({
      data: { healthy: true },
      observedAt,
      ok: true,
      requestId: 'tls-health',
    }),
    inspectCertificate,
  }
}

function handler() {
  return createSslCheckPostHandler({
    dnsCache: new DnsResultCache(64, () => Date.parse(observedAt)),
    dnsProvider: dnsProvider(),
    resultCache: new TlsResultCache(64, () => Date.parse(observedAt)),
    tlsProvider: tlsProvider(),
  })
}

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3000/api/v1/tools/ssl-check', {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

describe('POST /api/v1/tools/ssl-check', () => {
  it('allows anonymous IDN checks and returns a validated no-store six-state result', async () => {
    const response = await handler()(
      request(JSON.stringify({ query: '例子.测试' }), { 'x-request-id': 'trace-tls-route' }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-request-id')).toBe('trace-tls-route')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(sslCheckResultSchema.parse(await response.json())).toMatchObject({
      data: {
        normalizedQueryAscii: 'xn--fsqu00a.xn--0zwm56d',
        normalizedQueryUnicode: '例子.测试',
        tls: { port: 443, status: 'connected' },
      },
      meta: { traceId: 'trace-tls-route' },
      state: 'ready',
    })
  })

  it('rejects controls, unknown keys, malformed JSON, media types and bodies over 4 KiB', async () => {
    const POST = handler()
    for (const candidate of [
      { address: '93.184.216.34', query: 'example.test' },
      { port: 8443, query: 'example.test' },
      { query: 'example.test', resolver: '8.8.8.8' },
      { query: 'example.test', url: 'https://example.test' },
    ]) {
      const response = await POST(request(JSON.stringify(candidate)))
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe('INVALID_REQUEST')
    }

    expect((await POST(request('{'))).status).toBe(400)
    expect((await POST(request('{}', { 'content-type': 'text/plain' }))).status).toBe(415)
    const declared = await POST(request('{}', { 'content-length': '4097' }))
    expect(declared.status).toBe(413)
    expect((await declared.json()).code).toBe('TLS_REQUEST_TOO_LARGE')
    const streamed = await POST(request(JSON.stringify({ query: `example.${'a'.repeat(5_000)}` })))
    expect(streamed.status).toBe(413)
    expect((await streamed.json()).code).toBe('TLS_REQUEST_TOO_LARGE')
  })

  it('rejects IP, URL, local, metadata, port and single-label input before DNS or TLS access', async () => {
    for (const query of [
      '169.254.169.254',
      '[::1]',
      'https://example.test',
      'service.localhost',
      'metadata.google.internal',
      'example.test:443',
      'example',
    ]) {
      const response = await handler()(request(JSON.stringify({ query })))
      expect(response.status).toBe(400)
      expect((await response.json()).code).toMatch(
        /^(TLS_TARGET_FORBIDDEN|TLS_DOMAIN_FORMAT_INVALID|TLS_FULL_DOMAIN_REQUIRED)$/u,
      )
    }
  })
})
