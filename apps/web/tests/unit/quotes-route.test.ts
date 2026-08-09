import { describe, expect, it, vi } from 'vitest'

import { createQuotePostHandler } from '@/app/api/v1/quotes/route'
import { AppError, toProblemDetails } from '@/lib/errors'
import type { WestDigitalReadProvider } from '@/providers/types'
import { quoteCreationResultSchema, type QuoteCreationResult } from '@/schemas/quotes'

import { PRICING_RULE_FIXTURES } from '../fixtures/pricing'

const provider = {} as WestDigitalReadProvider
const context = {
  customer: { collection: 'customers' as const, id: 7 },
  quoteStore: {} as never,
  rules: PRICING_RULE_FIXTURES,
  snapshots: {} as never,
}

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3000/api/v1/quotes', {
    body,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'trace-quotes-route',
      ...headers,
    },
    method: 'POST',
  })
}

function problem(code: string, status = 503) {
  return toProblemDetails(new AppError(code, '测试问题', status), 'trace-quotes-route')
}

describe('POST /api/v1/quotes', () => {
  it('authenticates before creating a quote and returns a no-store six-state Result contract', async () => {
    const ready: QuoteCreationResult = {
      data: {
        quote: {
          currency: 'CNY',
          domainAscii: 'example.com',
          expiresAt: '2026-08-07T15:05:00.000Z',
          priceClass: 'standard',
          providerObservedAt: '2026-08-07T15:00:00.000Z',
          quotedAt: '2026-08-07T15:00:00.000Z',
          quoteRef: '11111111-1111-4111-8111-111111111111',
          sourcePriceSnapshotRef: '22222222-2222-4222-8222-222222222222',
          userPriceMinor: 2_500,
          years: 1,
        },
      },
      state: 'ready',
    }
    const resolveContext = vi.fn(async () => context)
    const createQuote = vi.fn(async () => ready)
    const handler = createQuotePostHandler({ createQuote, provider, resolveContext })
    const response = await handler(request(JSON.stringify({ domain: 'example.com', years: 1 })))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-request-id')).toBe('trace-quotes-route')
    expect(quoteCreationResultSchema.parse(await response.json())).toEqual(ready)
    expect(resolveContext).toHaveBeenCalledOnce()
    expect(createQuote).toHaveBeenCalledWith(
      { domain: 'example.com', operation: 'registration', years: 1 },
      expect.objectContaining({
        customer: context.customer,
        provider,
        traceId: 'trace-quotes-route',
      }),
    )

    const blockedData = { blockCode: 'DOMAIN_UNAVAILABLE' as const, quote: null }
    const states: QuoteCreationResult[] = [
      { data: blockedData, state: 'empty' },
      { data: blockedData, problem: problem('QUOTE_PARTIAL'), state: 'partial' },
      { data: blockedData, problem: problem('QUOTE_DEGRADED'), state: 'degraded' },
      { problem: problem('QUOTE_ERROR'), state: 'error' },
      { problem: problem('QUOTE_RATE_LIMITED', 429), state: 'rate_limited' },
    ]
    for (const state of states)
      expect(quoteCreationResultSchema.safeParse(state).success).toBe(true)
  })

  it('does not parse or process quote input when customer authentication fails', async () => {
    const resolveContext = vi.fn(async () => {
      throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
    })
    const createQuote = vi.fn()
    const handler = createQuotePostHandler({ createQuote, provider, resolveContext })
    const response = await handler(request('{'))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
    expect(createQuote).not.toHaveBeenCalled()
  })

  it('rejects malformed, non-JSON, oversized and non-integer-money-adjacent inputs', async () => {
    const handler = createQuotePostHandler({ provider, resolveContext: async () => context })
    const malformed = await handler(request('{'))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).code).toBe('INVALID_REQUEST')

    const media = await handler(request('{}', { 'content-type': 'text/plain' }))
    expect(media.status).toBe(415)
    expect((await media.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE')

    const oversized = await handler(request('{}', { 'content-length': '4097' }))
    expect(oversized.status).toBe(413)
    expect((await oversized.json()).code).toBe('QUOTE_REQUEST_TOO_LARGE')

    const fractionalYears = await handler(
      request(JSON.stringify({ domain: 'example.com', years: 1.5 })),
    )
    expect(fractionalYears.status).toBe(400)
    expect((await fractionalYears.json()).code).toBe('INVALID_REQUEST')
  })
})
