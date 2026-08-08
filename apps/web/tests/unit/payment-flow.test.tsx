// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PaymentFlow } from '@/components/commerce/payment-flow'

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,qr') } }))

const expiresAt = '2099-08-08T01:04:00.000Z'

function status(statusValue: 'paid' | 'pending_payment') {
  return {
    data: {
      amountMinor: 12_300,
      currency: 'CNY',
      orderNumber: 'WM-ORDER-1',
      status: statusValue,
    },
    state: 'ready',
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('payment front-end flow', () => {
  it('renders only the Native code_url as a QR image and keeps server status pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        Response.json(
          init?.method === 'POST'
            ? {
                data: {
                  channel: 'native',
                  codeUrl: 'weixin://wxpay/bizpayurl/up?pr=safe-code-url',
                  expiresAt,
                  merchantOrderNumber: 'WMNATIVE0001',
                },
                state: 'ready',
              }
            : status('pending_payment'),
        ),
      ),
    )
    render(<PaymentFlow orderNumber="WM-ORDER-1" preferredChannel="native" />)

    expect((await screen.findByAltText('微信支付二维码')).getAttribute('src')).toBe(
      'data:image/png;base64,qr',
    )
    expect((await screen.findByText('等待支付确认')).textContent).toBe('等待支付确认')
    expect(screen.getByText(/扫码动作本身不会被视为支付成功/u).textContent).toContain(
      '不会被视为支付成功',
    )
    expect(document.body.textContent).not.toContain('safe-code-url')
  })

  it('builds an H5 return URL without treating the jump as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        Response.json(
          init?.method === 'POST'
            ? {
                data: {
                  channel: 'h5',
                  expiresAt,
                  h5Url: 'https://wx.tenpay.com/pay?prepay_id=safe',
                  merchantOrderNumber: 'WMH50001',
                },
                state: 'ready',
              }
            : status('pending_payment'),
        ),
      ),
    )
    render(<PaymentFlow orderNumber="WM-ORDER-1" preferredChannel="h5" />)
    const link = await screen.findByRole('link', { name: '前往微信支付' })
    expect(link.getAttribute('href')).toContain('redirect_url=')
    expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain(
      '/account/orders/WM-ORDER-1/payment/return',
    )
    expect(screen.getByText(/跳转或返回动作本身不会被视为支付成功/u).textContent).toContain(
      '不会被视为支付成功',
    )
  })

  it('return landing polls the server, makes no payment-create request and labels only paid state successful', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input
      void _init
      return Response.json(status('paid'))
    })
    vi.stubGlobal('fetch', fetch)
    render(<PaymentFlow orderNumber="WM-ORDER-1" returned />)

    expect(screen.getByText(/返回页面不代表支付成功/u).textContent).toContain('不代表支付成功')
    expect((await screen.findByText('支付已确认')).textContent).toBe('支付已确认')
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' })
  })
})
