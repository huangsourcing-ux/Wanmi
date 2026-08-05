import * as OTPAuth from 'otpauth'
import { expect, test } from '@playwright/test'

import { readAdminAuthFixture } from './admin-auth-fixture'

test('administrator login reaches the protected security workspace', async ({ page }) => {
  const fixture = await readAdminAuthFixture()
  await page.goto('/admin/login')
  await page.getByLabel('邮箱').fill(fixture.systemEmail)
  await page.getByLabel('密码').fill(fixture.systemPassword)
  await page.getByLabel(/恢复码/).fill(fixture.systemRecoveryCode)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await page.goto('/admin/security')
  await expect(page.getByRole('heading', { level: 1, name: '账号安全' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '创建管理员邀请' })).toBeVisible()
})

test('fragment invitation binds a QR code and reveals recovery codes once without leaking the token', async ({
  page,
}) => {
  const fixture = await readAdminAuthFixture()
  const token = new URL(fixture.invitationUrl).hash.slice('#token='.length)
  const requestUrls: string[] = []
  const consoleMessages: string[] = []
  page.on('request', (request) => requestUrls.push(request.url()))
  page.on('console', (message) => consoleMessages.push(message.text()))

  await page.goto(fixture.invitationUrl)
  await expect(page).toHaveURL(/\/admin\/enroll$/)
  await expect(page.getByAltText('TOTP 绑定二维码')).toBeVisible()
  await page.getByText('无法扫描？显示配置 URI').click()
  const provisioningUri = await page.locator('.wanmi-enrollment__uri').textContent()
  const totp = OTPAuth.URI.parse(provisioningUri!) as OTPAuth.TOTP
  await page.getByLabel(/新密码/).fill(fixture.invitationPassword)
  await page.getByLabel('TOTP 验证码').fill(totp.generate())
  await page.getByRole('button', { name: '完成安全绑定' }).click()
  await expect(page.getByRole('heading', { name: '保存恢复码' })).toBeVisible()
  const recoveryText = await page.locator('.wanmi-enrollment__codes').textContent()
  const recoveryCodes = recoveryText!.trim().split('\n')
  expect(recoveryCodes).toHaveLength(8)

  expect(requestUrls.every((url) => !url.includes(token))).toBe(true)
  expect(consoleMessages.every((message) => !message.includes(token))).toBe(true)
  expect(await page.evaluate(() => Object.values(localStorage))).not.toContain(token)
  expect(await page.evaluate(() => Object.values(sessionStorage))).not.toContain(token)
  expect(page.url()).not.toContain(token)

  await page.goto('/admin/login')
  await page.getByLabel('邮箱').fill(fixture.invitedEmail)
  await page.getByLabel('密码').fill(fixture.invitationPassword)
  await page.getByLabel(/恢复码/).fill(recoveryCodes[0]!)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/admin$/)
  const forbiddenStatus = await page.evaluate(
    async () => (await fetch('/api/v1/admin/auth/invitations')).status,
  )
  expect(forbiddenStatus).toBe(403)
  await page.goto('/admin/security')
  await expect(page.getByRole('heading', { name: '创建管理员邀请' })).toHaveCount(0)
})

test('disabled accounts and default Payload auth surfaces stay unavailable', async ({
  page,
  request,
}) => {
  const fixture = await readAdminAuthFixture()
  await page.goto('/admin/login')
  await page.getByLabel('邮箱').fill(fixture.disabledEmail)
  await page.getByLabel('密码').fill(fixture.disabledPassword)
  await page.getByLabel(/恢复码/).fill(fixture.disabledRecoveryCode)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByText('邮箱、密码或第二因素无效')).toBeVisible()
  await expect(page).toHaveURL(/\/admin\/login$/)

  for (const path of [
    '/api/admins/login',
    '/api/admins/first-register',
    '/api/admins/forgot-password',
    '/api/admins/reset-password',
    '/api/admins/unlock',
    '/api/admins/refresh-token',
    '/api/graphql',
  ]) {
    expect((await request.post(path, { data: {} })).status(), path).toBe(404)
  }
  expect((await request.get('/api/graphql-playground')).status()).toBe(404)
})
