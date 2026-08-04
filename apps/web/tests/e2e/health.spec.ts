import { expect, test } from '@playwright/test'

test('health, readiness and admin MFA login are available', async ({ page, request }) => {
  const health = await request.get('/healthz')
  expect(health.ok()).toBeTruthy()
  expect(await health.json()).toEqual({ status: 'ok' })
  expect(health.headers()['x-request-id']).toBeTruthy()

  const ready = await request.get('/readyz')
  expect(ready.ok()).toBeTruthy()
  expect(await ready.json()).toMatchObject({
    components: { database: { healthy: true, required: true } },
    status: 'ready',
  })

  await page.goto('/admin/login')
  await expect(page.getByRole('heading', { name: '安全登录' })).toBeVisible()
  await expect(page.getByLabel('TOTP 验证码')).toBeVisible()
  await expect(page.getByLabel(/恢复码/)).toBeVisible()
})

test('invalid API input uses the stable problem shape without a stack', async ({ request }) => {
  const response = await request.post('/api/v1/auth/sms/request', { data: { deviceId: 'short' } })
  expect(response.status()).toBe(400)
  const problem = await response.json()
  expect(problem).toMatchObject({
    code: 'INVALID_REQUEST',
    message: expect.any(String),
    traceId: expect.any(String),
  })
  expect(problem.stack).toBeUndefined()
})
