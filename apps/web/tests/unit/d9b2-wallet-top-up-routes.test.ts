import { describe, expect, it, vi } from 'vitest'

import { createWalletTopUpPaymentRouteHandlers } from '@/app/api/v1/wallet/top-ups/[topUpOrderNumber]/payments/route'
import { createWalletTopUpPostHandler } from '@/app/api/v1/wallet/top-ups/route'
import type { PaymentProvider } from '@/providers/types'
import { paymentSessionResultSchema } from '@/schemas/payments'
import { walletTopUpOrderResultSchema } from '@/schemas/wallet'

const context = {
  customer: { collection: 'customers' as const, id: 7, status: 'active' },
  req: {} as never,
}
const provider = {} as PaymentProvider
const routeContext = {
  params: Promise.resolve({ topUpOrderNumber: 'WT123456789012345678901234567890' }),
}

describe('D9-B-2 wallet top-up routes', () => {
  it('passes only a WeChat top-up request to the authenticated customer service', async () => {
    const createTopUp = vi.fn(async () => ({
      data: {
        amountFen: 10_000,
        currency: 'CNY' as const,
        status: 'created' as const,
        topUpOrderNumber: 'WT123456789012345678901234567890',
      },
      state: 'ready' as const,
    }))
    const response = await createWalletTopUpPostHandler({
      createTopUp,
      resolveContext: async () => context,
    })(
      new Request('http://wanmi.test/api/v1/wallet/top-ups', {
        body: JSON.stringify({ amountFen: 10_000, fundingSource: 'wechat' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(201)
    expect(walletTopUpOrderResultSchema.parse(await response.json())).toMatchObject({
      data: { amountFen: 10_000, status: 'created' },
      state: 'ready',
    })
    expect(createTopUp).toHaveBeenCalledWith(
      context.req,
      { amountFen: 10_000, currency: 'CNY', fundingSource: 'wechat' },
      { customer: context.customer },
    )
  })

  it('rejects a balance-funded request before the top-up service call', async () => {
    const createTopUp = vi.fn()
    const response = await createWalletTopUpPostHandler({
      createTopUp,
      resolveContext: async () => context,
    })(
      new Request('http://wanmi.test/api/v1/wallet/top-ups', {
        body: JSON.stringify({ amountFen: 10_000, fundingSource: 'balance' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    )

    expect(response.status).toBe(400)
    expect(createTopUp).not.toHaveBeenCalled()
  })

  it('uses the existing payment provider for creation and active status query', async () => {
    const createPayment = vi.fn(async () => ({
      data: {
        channel: 'native' as const,
        codeUrl: 'weixin://fixture',
        expiresAt: '2026-08-18T04:00:00.000Z',
        merchantOrderNumber: 'WT123456789012345678901234567890',
      },
      state: 'ready' as const,
    }))
    const queryPayment = vi.fn(async () => ({
      data: {
        amountFen: 10_000,
        currency: 'CNY' as const,
        status: 'credited' as const,
        topUpOrderNumber: 'WT123456789012345678901234567890',
      },
      state: 'ready' as const,
    }))
    const handlers = createWalletTopUpPaymentRouteHandlers({
      createPayment,
      provider,
      queryPayment,
      resolveContext: async () => context,
    })
    const postResponse = await handlers.POST(
      new Request(
        'http://wanmi.test/api/v1/wallet/top-ups/WT123456789012345678901234567890/payments',
        {
          body: JSON.stringify({ channel: 'native' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
      ),
      routeContext,
    )
    const getResponse = await handlers.GET(
      new Request(
        'http://wanmi.test/api/v1/wallet/top-ups/WT123456789012345678901234567890/payments',
      ),
      routeContext,
    )

    expect(paymentSessionResultSchema.parse(await postResponse.json())).toMatchObject({
      data: { channel: 'native' },
      state: 'ready',
    })
    expect(walletTopUpOrderResultSchema.parse(await getResponse.json())).toMatchObject({
      data: { status: 'credited' },
      state: 'ready',
    })
    expect(createPayment).toHaveBeenCalledWith(
      context.req,
      'WT123456789012345678901234567890',
      { channel: 'native' },
      expect.objectContaining({ customer: context.customer, provider }),
    )
    expect(queryPayment).toHaveBeenCalledWith(
      context.req,
      'WT123456789012345678901234567890',
      expect.objectContaining({ customer: context.customer, provider }),
    )
  })

  it('rejects the balance payment channel before the top-up payment service call', async () => {
    const createPayment = vi.fn()
    const handlers = createWalletTopUpPaymentRouteHandlers({
      createPayment,
      provider,
      resolveContext: async () => context,
    })
    const response = await handlers.POST(
      new Request(
        'http://wanmi.test/api/v1/wallet/top-ups/WT123456789012345678901234567890/payments',
        {
          body: JSON.stringify({ channel: 'balance' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
      ),
      routeContext,
    )

    expect(response.status).toBe(400)
    expect(createPayment).not.toHaveBeenCalled()
  })
})
