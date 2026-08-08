import { describe, expect, it, vi } from 'vitest'

import { createOrderPostHandler } from '@/app/api/v1/orders/route'
import { AppError } from '@/lib/errors'
import type { WestDigitalReadProvider } from '@/providers/types'
import { orderCreationResultSchema, type OrderCreationResult } from '@/schemas/orders'

const provider = {} as WestDigitalReadProvider
const context = {
  customer: { collection: 'customers' as const, id: 7, status: 'active' },
  req: {} as never,
}

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3000/api/v1/orders', {
    body,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'trace-orders-route',
      ...headers,
    },
    method: 'POST',
  })
}

describe('POST /api/v1/orders', () => {
  it('accepts no client amount and returns a server-created pending-payment order', async () => {
    const ready: OrderCreationResult = {
      data: {
        amountMinor: 9_500,
        currency: 'CNY',
        domainAscii: 'example.com',
        orderNumber: 'WM-11111111-1111-4111-8111-111111111111',
        quoteExpiresAt: '2026-08-07T15:05:00.000Z',
        quoteRef: '22222222-2222-4222-8222-222222222222',
        status: 'pending_payment',
        years: 3,
      },
      state: 'ready',
    }
    const createOrder = vi.fn(async () => ready)
    const resolveContext = vi.fn(async () => context)
    const handler = createOrderPostHandler({ createOrder, provider, resolveContext })
    const response = await handler(
      request(
        JSON.stringify({
          quoteRef: '22222222-2222-4222-8222-222222222222',
          realnameTemplateId: 19,
        }),
      ),
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(orderCreationResultSchema.parse(await response.json())).toEqual(ready)
    expect(createOrder).toHaveBeenCalledWith(
      context.req,
      { quoteRef: '22222222-2222-4222-8222-222222222222', realnameTemplateId: 19 },
      { customer: context.customer, provider, traceId: 'trace-orders-route' },
    )
  })

  it('authenticates first and rejects client-controlled amount, status or domain fields', async () => {
    const createOrder = vi.fn()
    const authFailure = createOrderPostHandler({
      createOrder,
      provider,
      resolveContext: async () => {
        throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
      },
    })
    const unauthenticated = await authFailure(request('{'))
    expect(unauthenticated.status).toBe(401)
    expect(createOrder).not.toHaveBeenCalled()

    const handler = createOrderPostHandler({
      createOrder,
      provider,
      resolveContext: async () => context,
    })
    const controlled = await handler(
      request(
        JSON.stringify({
          amountMinor: 1,
          domainAscii: 'attacker.example',
          quoteRef: '22222222-2222-4222-8222-222222222222',
          realnameTemplateId: 19,
          status: 'succeeded',
        }),
      ),
    )
    expect(controlled.status).toBe(400)
    expect((await controlled.json()).code).toBe('INVALID_REQUEST')
    expect(createOrder).not.toHaveBeenCalled()
  })

  it('rejects malformed, non-JSON and oversized requests', async () => {
    const handler = createOrderPostHandler({ provider, resolveContext: async () => context })
    expect((await handler(request('{'))).status).toBe(400)
    expect((await handler(request('{}', { 'content-type': 'text/plain' }))).status).toBe(415)
    expect((await handler(request('{}', { 'content-length': '4097' }))).status).toBe(413)
  })
})
