import { describe, expect, it, vi } from 'vitest'

import { createDnsPostHandler } from '@/app/api/v1/tools/dns/route'
import type { DnsReadProvider } from '@/providers/types'
import { DNS_RECORD_TYPES, dnsLookupResultSchema } from '@/schemas/dns'

const observedAt = '2026-08-05T12:00:00.000Z'

function dnsProvider(): DnsReadProvider & { queryRecordSet: ReturnType<typeof vi.fn> } {
  const queryRecordSet = vi.fn<DnsReadProvider['queryRecordSet']>(async ({ recordType }) => ({
    cache: { status: 'miss' },
    data: {
      fallbackUsed: false,
      negativeTtlSeconds: 30,
      records: [],
      resolverNode: 'alidns_primary',
      status: 'no_record',
    },
    observedAt,
    ok: true,
    requestId: `dns-${recordType}`,
  }))
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

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3000/api/v1/tools/dns', {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

describe('POST /api/v1/tools/dns', () => {
  it('allows anonymous IDN lookup and returns eight validated no-store record sets', async () => {
    const provider = dnsProvider()
    const POST = createDnsPostHandler({ provider })
    const response = await POST(
      request(JSON.stringify({ query: '例子.测试' }), {
        'x-request-id': 'trace-dns-route',
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-request-id')).toBe('trace-dns-route')
    expect(response.headers.get('set-cookie')).toBeNull()
    const body = dnsLookupResultSchema.parse(await response.json())
    expect(body).toMatchObject({
      data: {
        normalizedQueryAscii: 'xn--fsqu00a.xn--0zwm56d',
        normalizedQueryUnicode: '例子.测试',
        recordSets: DNS_RECORD_TYPES.map((type) => ({ status: 'no_record', type })),
      },
      state: 'empty',
    })
    expect(provider.queryRecordSet).toHaveBeenCalledTimes(8)
    expect(JSON.stringify(body)).not.toMatch(/available|register|purchase/i)
  })

  it('rejects resolver controls, unknown keys, malformed JSON, media types and large bodies', async () => {
    const POST = createDnsPostHandler({ provider: dnsProvider() })
    for (const candidate of [
      { query: 'example.test', resolver: '8.8.8.8' },
      { port: 53, query: 'example.test' },
      { query: 'example.test', recordType: 'A' },
      { query: 'example.test', url: 'https://223.5.5.5/dns-query' },
    ]) {
      const response = await POST(request(JSON.stringify(candidate)))
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe('INVALID_REQUEST')
    }

    const malformed = await POST(request('{'))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).code).toBe('INVALID_REQUEST')

    const media = await POST(request('{}', { 'content-type': 'text/plain' }))
    expect(media.status).toBe(415)
    expect((await media.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE')

    const declaredOversized = await POST(request('{}', { 'content-length': '4097' }))
    expect(declaredOversized.status).toBe(413)
    expect((await declaredOversized.json()).code).toBe('DNS_REQUEST_TOO_LARGE')

    const streamedOversized = await POST(
      request(JSON.stringify({ query: `example.${'a'.repeat(5_000)}` })),
    )
    expect(streamedOversized.status).toBe(413)
    expect((await streamedOversized.json()).code).toBe('DNS_REQUEST_TOO_LARGE')
  })

  it('rejects IP, URL, local, metadata, port and single-label input before provider access', async () => {
    const provider = dnsProvider()
    const POST = createDnsPostHandler({ provider })
    for (const query of [
      '169.254.169.254',
      'https://example.test',
      'service.localhost',
      'metadata.google.internal',
      'example.test:53',
      'example',
    ]) {
      const response = await POST(request(JSON.stringify({ query })))
      expect(response.status).toBe(400)
      expect((await response.json()).code).toMatch(
        /^(DOMAIN_TARGET_FORBIDDEN|DNS_DOMAIN_FORMAT_INVALID|DNS_FULL_DOMAIN_REQUIRED)$/u,
      )
    }
    expect(provider.queryRecordSet).not.toHaveBeenCalled()
  })
})
