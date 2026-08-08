import { expect, test } from '@playwright/test'

const orderNumber = 'WM-E2E-PAYMENT-1'
const expiresAt = '2099-08-08T01:04:00.000Z'

function paymentStatus(status: 'paid' | 'pending_payment') {
  return {
    data: { amountMinor: 12_300, currency: 'CNY', orderNumber, status },
    state: 'ready',
  }
}

test('desktop payment page renders a QR and remains pending until server confirmation', async ({
  page,
}) => {
  await page.route(`**/api/v1/orders/${orderNumber}/payments`, async (route, request) => {
    await route.fulfill({
      contentType: 'application/json',
      json:
        request.method() === 'POST'
          ? {
              data: {
                channel: 'native',
                codeUrl: 'weixin://wxpay/bizpayurl/up?pr=e2e-safe-code',
                expiresAt,
                merchantOrderNumber: 'WME2ENATIVE1',
              },
              state: 'ready',
            }
          : paymentStatus('pending_payment'),
    })
  })
  await page.goto(`/account/orders/${orderNumber}/payment`)
  await expect(page.getByRole('img', { name: '微信支付二维码' })).toBeVisible()
  await expect(page.getByText('等待支付确认')).toBeVisible()
  await expect(page.getByText(/扫码动作本身不会被视为支付成功/u)).toBeVisible()
})

test('mobile payment page sends H5 channel and adds the Wanmi return page', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile',
    })
  })
  let postedChannel: string | undefined
  await page.route(`**/api/v1/orders/${orderNumber}/payments`, async (route, request) => {
    if (request.method() === 'POST') {
      postedChannel = (request.postDataJSON() as { channel?: string }).channel
      await route.fulfill({
        contentType: 'application/json',
        json: {
          data: {
            channel: 'h5',
            expiresAt,
            h5Url: 'https://wx.tenpay.com/pay?prepay_id=e2e',
            merchantOrderNumber: 'WME2EH5001',
          },
          state: 'ready',
        },
      })
      return
    }
    await route.fulfill({ contentType: 'application/json', json: paymentStatus('pending_payment') })
  })
  await page.goto(`/account/orders/${orderNumber}/payment`)
  const link = page.getByRole('link', { name: '前往微信支付' })
  await expect(link).toBeVisible()
  expect(postedChannel).toBe('h5')
  expect(decodeURIComponent((await link.getAttribute('href')) ?? '')).toContain(
    `/account/orders/${orderNumber}/payment/return`,
  )
  await expect(page.getByText(/跳转或返回动作本身不会被视为支付成功/u)).toBeVisible()
})

test('return page only polls server status and never creates or infers a payment', async ({
  page,
}) => {
  const methods: string[] = []
  await page.route(`**/api/v1/orders/${orderNumber}/payments`, async (route, request) => {
    methods.push(request.method())
    await route.fulfill({ contentType: 'application/json', json: paymentStatus('paid') })
  })
  await page.goto(`/account/orders/${orderNumber}/payment/return`)
  await expect(page.getByText(/返回页面不代表支付成功/u)).toBeVisible()
  await expect(page.getByText('支付已确认')).toBeVisible()
  expect(methods).toEqual(['GET'])
})
