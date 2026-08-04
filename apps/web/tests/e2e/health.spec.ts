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
  const traceId = 'e2e-request-d1-02'
  const response = await request.post('/api/v1/auth/sms/request', {
    data: { deviceId: 'short' },
    headers: { 'x-request-id': traceId },
  })
  expect(response.status()).toBe(400)
  expect(response.headers()['content-type']).toBe('application/problem+json')
  expect(response.headers()['x-request-id']).toBe(traceId)
  const problem = await response.json()
  expect(problem).toMatchObject({
    action: expect.any(String),
    code: 'INVALID_REQUEST',
    detail: expect.any(String),
    message: expect.any(String),
    retryable: false,
    status: 400,
    title: expect.any(String),
    traceId: expect.any(String),
    type: 'urn:wanmi:problem:INVALID_REQUEST',
  })
  expect(problem.detail).toBe(problem.message)
  expect(problem.traceId).toBe(traceId)
  expect(problem.stack).toBeUndefined()

  const invalidTrace = await request.post('/api/v1/auth/sms/request', {
    data: { deviceId: 'short' },
    headers: { 'x-request-id': 'short' },
  })
  const replacement = await invalidTrace.json()
  expect(replacement.traceId).not.toBe('short')
  expect(invalidTrace.headers()['x-request-id']).toBe(replacement.traceId)
})
