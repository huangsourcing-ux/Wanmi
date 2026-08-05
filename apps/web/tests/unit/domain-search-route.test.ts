import { describe, expect, it } from 'vitest'

import { POST } from '@/app/api/v1/tools/domain-search/route'
import { domainSearchResultSchema } from '@/schemas/domain-search'

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3000/api/v1/tools/domain-search', {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

describe('POST /api/v1/tools/domain-search', () => {
  it('returns a schema-validated no-store fixture result with a request ID', async () => {
    const response = await POST(
      request(JSON.stringify({ query: 'premium.top' }), {
        'x-request-id': 'trace-domain-search-route',
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-request-id')).toBe('trace-domain-search-route')
    const body = domainSearchResultSchema.parse(await response.json())
    expect(body.state).toBe('ready')
    if ('data' in body) expect(body.data.items[0].status).toBe('premium')
  })

  it('rejects 11 TLDs with a clear stable error instead of truncating', async () => {
    const response = await POST(
      request(
        JSON.stringify({
          query: 'wanmi',
          tlds: ['com', 'cn', 'net', 'org', 'top', 'xyz', 'vip', 'cc', 'tv', 'com.cn', 'io'],
        }),
      ),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'DOMAIN_SEARCH_TLD_LIMIT_EXCEEDED',
      detail: '单次最多查询 10 个域名后缀，当前提交了 11 个',
      retryable: false,
    })
  })

  it('rejects duplicate normalized TLDs, malformed JSON, media types and oversized bodies', async () => {
    const duplicate = await POST(request(JSON.stringify({ query: 'wanmi', tlds: ['com', '.COM'] })))
    expect(duplicate.status).toBe(400)
    expect((await duplicate.json()).code).toBe('DOMAIN_SEARCH_DUPLICATE_TLD')

    const malformed = await POST(request('{'))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).code).toBe('INVALID_REQUEST')

    const media = await POST(request('{}', { 'content-type': 'text/plain' }))
    expect(media.status).toBe(415)
    expect((await media.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE')

    const oversized = await POST(request('{}', { 'content-length': '4097' }))
    expect(oversized.status).toBe(413)
    expect((await oversized.json()).code).toBe('DOMAIN_SEARCH_REQUEST_TOO_LARGE')
  })
})
