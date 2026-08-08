import { expect, test, type Page } from '@playwright/test'

import {
  otherAuditTargetId,
  ownAuditTargetId,
  readAdminAuthFixture,
  type AdminAuthFixtureState,
} from './admin-auth-fixture'

type Role = keyof AdminAuthFixtureState['roleAccounts'] | 'system_admin'

async function loginAs(page: Page, role: Role) {
  const fixture = await readAdminAuthFixture()
  const account =
    role === 'system_admin'
      ? {
          email: fixture.systemEmail,
          password: fixture.systemPassword,
          recoveryCode: `${fixture.systemRecoveryCode}-2`,
        }
      : fixture.roleAccounts[role]
  await page.goto('/admin/login')
  await page.getByLabel('邮箱').fill(account.email)
  await page.getByLabel('密码').fill(account.password)
  await page.getByLabel(/恢复码/).fill(account.recoveryCode)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/admin$/, { timeout: 15_000 })
}

function collectionLink(page: Page, slug: string) {
  return page.locator(`.nav__link[href="/admin/collections/${slug}"]`)
}

function operationsLink(page: Page, path: string) {
  return page.locator(`a[href="${path}"]`)
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
  await expect(collectionLink(page, 'categories')).toBeVisible()
  await expect(collectionLink(page, 'helpPages')).toBeVisible()
  await expect(collectionLink(page, 'media')).toBeVisible()
  await expect(collectionLink(page, 'tags')).toBeVisible()
  await expect(collectionLink(page, 'forms')).toBeVisible()
  await expect(collectionLink(page, 'redirects')).toBeVisible()
  await expect(collectionLink(page, 'advertisers')).toHaveCount(0)
  await expect(collectionLink(page, 'priceRules')).toHaveCount(0)
  await expect(collectionLink(page, 'auditLogs')).toHaveCount(0)
  await expect(collectionLink(page, 'firstPartyEvents')).toHaveCount(0)
  await expect(collectionLink(page, 'toolObservabilityBuckets')).toHaveCount(0)
  await expectNavigationGroups(page, ['内容'])
  await expect(operationsLink(page, '/admin/operations/content')).toBeVisible()
  await expect(operationsLink(page, '/admin/operations/tld-pricing')).toBeVisible()
  await expect(operationsLink(page, '/admin/operations')).toHaveCount(0)
  await expect(operationsLink(page, '/admin/operations/audit')).toHaveCount(0)

  await page.goto('/admin/operations/content')
  await expect(page.getByRole('heading', { name: '内容运营' })).toBeVisible()
  const forbiddenOperations = await page.goto('/admin/operations/tools')
  expect(forbiddenOperations?.status()).toBe(404)

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
    'adMedia',
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
  await expect(collectionLink(page, 'toolObservabilityBuckets')).toHaveCount(0)
  await expectNavigationGroups(page, ['广告', '运营'])
  await expect(operationsLink(page, '/admin/operations/advertising')).toBeVisible()
  await expect(operationsLink(page, '/admin/operations/feedback')).toBeVisible()
  await expect(operationsLink(page, '/admin/operations/audit')).toBeVisible()
  await expect(operationsLink(page, '/admin/operations/tools')).toHaveCount(0)

  await page.goto('/admin/operations/audit')
  await expect(page.getByText(ownAuditTargetId, { exact: true })).toBeVisible()
  await expect(page.getByText(otherAuditTargetId, { exact: true })).toHaveCount(0)

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
    'adMedia',
    'adPlacements',
    'adSchedules',
    'reconciliations',
    'toolObservabilityBuckets',
    'userFeedback',
  ]) {
    await expect(collectionLink(page, slug)).toBeVisible()
  }
  await expect(collectionLink(page, 'auditLogs')).toHaveCount(0)
  await expect(collectionLink(page, 'firstPartyEvents')).toHaveCount(0)
  await expect(collectionLink(page, 'articles')).toHaveCount(0)
  await expect(collectionLink(page, 'admins')).toHaveCount(0)
  await expectNavigationGroups(page, ['广告', '运营'])
  await expect(operationsLink(page, '/admin/operations')).toBeVisible()
  await expect(operationsLink(page, '/admin/operations/tools')).toBeVisible()
  await expect(operationsLink(page, '/admin/operations/advertising')).toBeVisible()
  await expect(operationsLink(page, '/admin/operations/feedback')).toBeVisible()
  await expect(operationsLink(page, '/admin/operations/audit')).toHaveCount(0)

  await page.goto('/admin/operations')
  await expect(page.getByRole('heading', { name: '基础运营仪表盘' })).toBeVisible()
  await expect(page.getByText(/不读取或展示原始事件/)).toBeVisible()
  const forbiddenAuditView = await page.goto('/admin/operations/audit')
  expect(forbiddenAuditView?.status()).toBe(404)

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
  const eventDirect = await page.goto('/admin/collections/firstPartyEvents')
  expect(eventDirect?.status()).toBe(404)
  const aggregateDirect = await page.goto('/admin/collections/toolObservabilityBuckets')
  expect(aggregateDirect?.status()).toBe(200)
  const aggregateWriteStatus = await page.evaluate(
    async () =>
      (
        await fetch('/api/toolObservabilityBuckets', {
          body: JSON.stringify({ scope: 'tool' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      ).status,
  )
  expect(aggregateWriteStatus).toBe(403)
})

test('system administrators can use every operations view and see the full audit scope', async ({
  page,
}) => {
  await loginAs(page, 'system_admin')
  await expect(collectionLink(page, 'priceRules')).toBeVisible()
  for (const path of [
    '/admin/operations',
    '/admin/operations/tools',
    '/admin/operations/content',
    '/admin/operations/advertising',
    '/admin/operations/tld-pricing',
    '/admin/operations/feedback',
    '/admin/operations/audit',
  ]) {
    await expect(operationsLink(page, path)).toBeVisible()
  }

  await page.goto('/admin/operations/audit')
  await expect(page.getByText(ownAuditTargetId, { exact: true })).toBeVisible()
  await expect(page.getByText(otherAuditTargetId, { exact: true })).toBeVisible()
  await page.goto('/admin/operations/tld-pricing')
  await expect(page.getByRole('heading', { name: '最新价格快照' })).toBeVisible()
  await expect(page.getByText(/价格成本与规则仅/)).toHaveCount(0)
})
