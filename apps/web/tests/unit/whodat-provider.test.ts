import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { WhoDatProvider } from '@/providers/whodat'

const server = setupServer(
  http.get('http://127.0.0.1:8080/', () => new HttpResponse(null, { status: 200 })),
  http.get('http://127.0.0.1:8080/v1/whois/:domain', () =>
    HttpResponse.json({ isRegistered: false }),
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('Who-Dat adapter contract', () => {
  it('maps health and query responses into stable provider results', async () => {
    const provider = new WhoDatProvider()
    expect((await provider.health()).ok).toBe(true)
    const result = await provider.queryRegistration({
      domainAscii: 'example.test',
      traceId: 'trace-whodat',
    })
    expect(result.ok && result.data.registered).toBe(false)
  })

  it('maps upstream failure without leaking the response body', async () => {
    server.use(
      http.get('http://127.0.0.1:8080/v1/whois/:domain', () =>
        HttpResponse.text('provider secret detail', { status: 503 }),
      ),
    )
    const result = await new WhoDatProvider().queryRegistration({
      domainAscii: 'example.test',
      traceId: 'trace-whodat-failure',
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toMatchObject({ code: 'WHODAT_QUERY_FAILED', retryable: true })
    expect(JSON.stringify(result)).not.toContain('provider secret detail')
  })
})
