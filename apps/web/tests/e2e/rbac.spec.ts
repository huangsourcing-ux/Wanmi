import { expect, test, type Page } from '@playwright/test'

import {
  otherAuditTargetId,
  ownAuditTargetId,
  readAdminAuthFixture,
  type AdminAuthFixtureState,
} from './admin-auth-fixture'

type Role = keyof AdminAuthFixtureState['roleAccounts']

async function loginAs(page: Page, role: Role) {
  const fixture = await readAdminAuthFixture()
  const account = fixture.roleAccounts[role]
  await page.goto('/admin/login')
  await page.getByLabel('邮箱').fill(account.email)
  await page.getByLabel('密码').fill(account.password)
  await page.getByLabel(/恢复码/).fill(account.recoveryCode)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/admin$/)
}

function collectionLink(page: Page, slug: string) {
  return page.locator(`.nav__link[href="/admin/collections/${slug}"]`)
}

async function expectNavigationGroups(page: Page, expected: string[]) {
  await expect
    .poll(async () => (await page.locator('.nav-group__label').allTextContents()).sort())
    .toEqual([...expected].sort())
}

test('content editors see content only and cannot open or write advertising collections', async ({
  page,
}) => {
  await loginAs(page, 'content_editor')
  await expect(collectionLink(page, 'articles')).toBeVisible()
  await expect(collectionLink(page, 'media')).toBeVisible()
  await expect(collectionLink(page, 'forms')).toBeVisible()
  await expect(collectionLink(page, 'redirects')).toBeVisible()
  await expect(collectionLink(page, 'advertisers')).toHaveCount(0)
  await expect(collectionLink(page, 'auditLogs')).toHaveCount(0)
  await expectNavigationGroups(page, ['内容'])

  const status = await page.evaluate(
    async () =>
      (
        await fetch('/api/advertisers', {
          body: JSON.stringify({ name: 'forbidden', status: 'active' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      ).status,
  )
  expect(status).toBe(403)
  const direct = await page.goto('/admin/collections/advertisers')
  expect(direct?.status()).toBe(404)
})

test('ad operators see advertising and own-audit workspaces but no content workspace', async ({
  page,
}) => {
  await loginAs(page, 'ad_operator')
  for (const slug of [
    'advertisers',
    'adCreatives',
    'adPlacements',
    'adSchedules',
    'reconciliations',
    'userFeedback',
    'auditLogs',
  ]) {
    await expect(collectionLink(page, slug)).toBeVisible()
  }
  await expect(collectionLink(page, 'articles')).toHaveCount(0)
  await expect(collectionLink(page, 'admins')).toHaveCount(0)
  await expectNavigationGroups(page, ['广告', '运营'])

  await page.goto(`/admin/collections/auditLogs?search=${ownAuditTargetId}`)
  await expect(page.getByText(ownAuditTargetId, { exact: true })).toBeVisible()
  await page.goto(`/admin/collections/auditLogs?search=${otherAuditTargetId}`)
  await expect(page.getByText(otherAuditTargetId, { exact: true })).toHaveCount(0)

  const status = await page.evaluate(
    async () =>
      (
        await fetch('/api/articles', {
          body: JSON.stringify({ slug: 'forbidden', title: 'forbidden' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      ).status,
  )
  expect(status).toBe(403)
  const direct = await page.goto('/admin/collections/articles')
  expect(direct?.status()).toBe(404)
})

test('analysts have safe read-only operations navigation and no audit or mutation access', async ({
  page,
}) => {
  await loginAs(page, 'analyst')
  for (const slug of [
    'advertisers',
    'adCreatives',
    'adPlacements',
    'adSchedules',
    'reconciliations',
    'userFeedback',
  ]) {
    await expect(collectionLink(page, slug)).toBeVisible()
  }
  await expect(collectionLink(page, 'auditLogs')).toHaveCount(0)
  await expect(collectionLink(page, 'articles')).toHaveCount(0)
  await expect(collectionLink(page, 'admins')).toHaveCount(0)
  await expectNavigationGroups(page, ['广告', '运营'])

  const status = await page.evaluate(
    async () =>
      (
        await fetch('/api/advertisers', {
          body: JSON.stringify({ name: 'forbidden', status: 'active' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      ).status,
  )
  expect(status).toBe(403)
  const direct = await page.goto('/admin/collections/auditLogs')
  expect(direct?.status()).toBe(404)
})
