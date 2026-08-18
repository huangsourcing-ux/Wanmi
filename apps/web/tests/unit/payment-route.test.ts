import { describe, expect, it, vi } from 'vitest'

import { createPaymentRouteHandlers } from '@/app/api/v1/orders/[orderNumber]/payments/route'
import { AppError } from '@/lib/errors'
import type { PaymentProvider } from '@/providers/types'
import { paymentSessionResultSchema, paymentStatusResultSchema } from '@/schemas/payments'

const provider = {} as PaymentProvider
const context = {
  customer: { collection: 'customers' as const, id: 7, status: 'active' },
  req: {} as never,
}
const routeContext = { params: Promise.resolve({ orderNumber: 'WM-ORDER-7' }) }

describe('GET /api/v1/orders/:orderNumber/payments', () => {
  it('passes the authenticated customer to the service and returns the six-state contract', async () => {
    const ready = {
      data: {
        amountMinor: 12_300,
        currency: 'CNY' as const,
        orderNumber: 'WM-ORDER-7',
        status: 'paid' as const,
      },
      state: 'ready' as const,
    }
    const queryPayment = vi.fn(async () => ready)
    const handler = createPaymentRouteHandlers({
      provider,
      queryPayment,
      resolveContext: async () => context,
    }).GET
    const response = await handler(
      new Request('http://wanmi.test/api/v1/orders/WM-ORDER-7/payments'),
      routeContext,
    )
    expect(response.status).toBe(200)
    expect(paymentStatusResultSchema.parse(await response.json())).toEqual(ready)
    expect(queryPayment).toHaveBeenCalledWith(
      context.req,
      'WM-ORDER-7',
      expect.objectContaining({ customer: context.customer, provider }),
    )
  })

  it('returns rate_limited without leaking a different response shape', async () => {
    const handler = createPaymentRouteHandlers({
      provider,
      queryPayment: async () => {
        throw new AppError('PAYMENT_STATUS_RATE_LIMITED', '支付状态查询过于频繁', 429, {
          retryAfterSeconds: 3,
        })
      },
      resolveContext: async () => context,
    }).GET
    const response = await handler(
      new Request('http://wanmi.test/api/v1/orders/WM-ORDER-7/payments', {
        headers: { 'x-request-id': 'trace-payment-route' },
      }),
      routeContext,
    )
    expect(response.status).toBe(429)
    expect(paymentStatusResultSchema.parse(await response.json())).toMatchObject({
      problem: { code: 'PAYMENT_STATUS_RATE_LIMITED', retryAfterSeconds: 3 },
      state: 'rate_limited',
    })
  })
})

describe('POST /api/v1/orders/:orderNumber/payments', () => {
  it('dispatches balance without invoking the WeChat payment path or returning provider URLs', async () => {
    const ready = {
      data: {
        amountMinor: 12_300,
        channel: 'balance' as const,
        currency: 'CNY' as const,
        orderNumber: 'WM-ORDER-7',
        status: 'paid' as const,
      },
      state: 'ready' as const,
    }
    const createBalance = vi.fn(async () => ready)
    const createWechat = vi.fn()
    const handler = createPaymentRouteHandlers({
      createBalance,
      createWechat,
      provider,
      resolveContext: async () => context,
    }).POST
    const response = await handler(
      new Request('http://wanmi.test/api/v1/orders/WM-ORDER-7/payments', {
        body: JSON.stringify({ channel: 'balance' }),
        headers: { 'content-type': 'application/json', 'x-request-id': 'trace-balance-route' },
        method: 'POST',
      }),
      routeContext,
    )
    expect(response.status).toBe(201)
    const body = paymentSessionResultSchema.parse(await response.json())
    expect(body).toEqual(ready)
    if (body.state !== 'ready') throw new Error('Expected ready balance payment response')
    expect(body.data).not.toHaveProperty('codeUrl')
    expect(body.data).not.toHaveProperty('h5Url')
    expect(createBalance).toHaveBeenCalledWith(context.req, 'WM-ORDER-7', {
      customer: context.customer,
      traceId: 'trace-balance-route',
    })
    expect(createWechat).not.toHaveBeenCalled()
  })
})
