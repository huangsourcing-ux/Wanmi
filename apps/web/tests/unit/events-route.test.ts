import { describe, expect, it } from 'vitest'

import { POST } from '@/app/api/v1/events/route'

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3000/api/v1/events', {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

describe('POST /api/v1/events admission boundary', () => {
  it.each([['dnt'], ['sec-gpc']] as const)(
    'drops opted-out requests identified by %s',
    async (name) => {
      const response = await POST(request('not-json', { [name]: '1' }))
      expect(response.status).toBe(204)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toBe('')
    },
  )

  it('rejects unsupported media types, malformed JSON and oversized bodies safely', async () => {
    const media = await POST(request('{}', { 'content-type': 'text/plain' }))
    expect(media.status).toBe(415)
    expect((await media.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE')

    const malformed = await POST(request('{'))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).code).toBe('INVALID_REQUEST')

    const oversized = await POST(request('{}', { 'content-length': '4097' }))
    expect(oversized.status).toBe(413)
    expect((await oversized.json()).code).toBe('EVENT_TOO_LARGE')
  })

  it('rejects complete domains and unknown sensitive fields before opening Payload', async () => {
    for (const candidate of [
      {
        event: 'tool_submitted',
        fromLocalHistory: false,
        inputType: 'full_domain',
        schemaVersion: 1,
        tld: 'wanmi.net',
        tool: 'domain-search',
      },
      {
        event: 'tool_submitted',
        fromLocalHistory: false,
        inputType: 'full_domain',
        schemaVersion: 1,
        tld: 'net',
        token: 'secret-token',
        tool: 'domain-search',
      },
    ]) {
      const response = await POST(request(JSON.stringify(candidate)))
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe('INVALID_REQUEST')
    }
  })
})
