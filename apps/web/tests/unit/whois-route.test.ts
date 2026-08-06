import { describe, expect, it, vi } from 'vitest'

import { createWhoisPostHandler } from '@/app/api/v1/tools/whois/route'
import type { ProviderResult } from '@/lib/domain'
import type { PublicRegistrationProvider, PublicRegistrationRecord } from '@/providers/types'
import { whoisLookupResultSchema } from '@/schemas/whois'

const observedAt = '2026-08-05T12:00:00.000Z'

function primary(): PublicRegistrationProvider {
  const queryPublicRegistration: PublicRegistrationProvider['queryPublicRegistration'] = vi.fn(
    async ({ domainAscii }): Promise<ProviderResult<PublicRegistrationRecord>> => ({
      cache: { status: 'miss' },
      data: {
        dates: { created: null, expires: null, updated: null },
        domainAscii,
        domainUnicode: domainAscii,
        nameServers: [],
        recordStatus: 'no_public_record',
        registrar: null,
        source: { protocol: 'rdap', provider: 'whodat' },
        statuses: [],
      },
      observedAt,
      ok: true,
      requestId: 'provider-request-id',
    }),
  )
  return {
    health: async () => ({
      data: { healthy: true },
      observedAt,
      ok: true,
      requestId: 'health-request-id',
    }),
    queryPublicRegistration,
  }
}

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3000/api/v1/tools/whois', {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

describe('POST /api/v1/tools/whois', () => {
  it('allows anonymous lookup and returns a validated no-store Result with request ID', async () => {
    const provider = primary()
    const POST = createWhoisPostHandler({ primary: provider })
    const response = await POST(
      request(JSON.stringify({ query: '例子.测试' }), {
        'x-request-id': 'trace-whois-route',
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-request-id')).toBe('trace-whois-route')
    expect(response.headers.get('set-cookie')).toBeNull()
    const body = whoisLookupResultSchema.parse(await response.json())
    expect(body).toMatchObject({
      data: {
        normalizedQueryAscii: 'xn--fsqu00a.xn--0zwm56d',
        recordStatus: 'no_public_record',
      },
      state: 'empty',
    })
    expect(JSON.stringify(body)).not.toMatch(/available|price|purchase/i)
  })

  it('rejects unknown keys, malformed JSON, media types and bodies over 4 KiB', async () => {
    const POST = createWhoisPostHandler({ primary: primary() })
    const unknownKey = await POST(
      request(JSON.stringify({ query: 'example.test', available: true })),
    )
    expect(unknownKey.status).toBe(400)
    expect((await unknownKey.json()).code).toBe('INVALID_REQUEST')

    const malformed = await POST(request('{'))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).code).toBe('INVALID_REQUEST')

    const media = await POST(request('{}', { 'content-type': 'text/plain' }))
    expect(media.status).toBe(415)
    expect((await media.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE')

    const oversized = await POST(request('{}', { 'content-length': '4097' }))
    expect(oversized.status).toBe(413)
    expect((await oversized.json()).code).toBe('WHOIS_REQUEST_TOO_LARGE')
    expect(oversized.headers.get('cache-control')).toBe('no-store')
    expect(oversized.headers.get('x-request-id')).toBeTruthy()

    const streamedOversized = await POST(
      request(JSON.stringify({ query: `example.${'a'.repeat(5_000)}` })),
    )
    expect(streamedOversized.status).toBe(413)
    expect((await streamedOversized.json()).code).toBe('WHOIS_REQUEST_TOO_LARGE')
  })

  it('returns stable SSRF and full-domain validation errors before provider access', async () => {
    const provider = primary()
    const POST = createWhoisPostHandler({ primary: provider })
    const forbidden = await POST(request(JSON.stringify({ query: '169.254.169.254' })))
    expect(forbidden.status).toBe(400)
    expect(await forbidden.json()).toMatchObject({ code: 'DOMAIN_TARGET_FORBIDDEN' })

    const singleLabel = await POST(request(JSON.stringify({ query: 'example' })))
    expect(singleLabel.status).toBe(400)
    expect(await singleLabel.json()).toMatchObject({ code: 'WHOIS_FULL_DOMAIN_REQUIRED' })
    expect(provider.queryPublicRegistration).not.toHaveBeenCalled()
  })
})
