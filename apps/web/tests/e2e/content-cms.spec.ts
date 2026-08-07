import { expect, test, type Page } from '@playwright/test'

import { readAdminAuthFixture } from './admin-auth-fixture'
import { readContentCmsFixture } from './content-cms-fixture'

async function loginContentEditor(page: Page) {
  const fixture = await readAdminAuthFixture()
  const account = fixture.roleAccounts.content_editor
  await page.goto('/admin/login')
  await page.getByLabel('邮箱').fill(account.email)
  await page.getByLabel('密码').fill(account.password)
  await page.getByLabel(/恢复码/).fill(`${account.recoveryCode}-2`)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/admin$/, { timeout: 15_000 })
}

test('content workflow keeps preview private and publishes only through audited actions', async ({
  page,
  request,
}) => {
  const fixture = await readContentCmsFixture()
  const previewPath = `/preview/content/articles/${fixture.articleSlug}`
  const publicPath = `/articles/${fixture.articleSlug}`
  const anonymousPreview = await request.get(previewPath)
  expect(anonymousPreview.status()).toBe(404)
  expect(anonymousPreview.headers()['cache-control']).toMatch(
    /(?:private.*no-store)|(?:no-cache.*must-revalidate)/u,
  )
  expect(anonymousPreview.headers()['x-robots-tag']).toBe('noindex, nofollow')
  expect((await request.get(publicPath)).status()).toBe(404)

  await loginContentEditor(page)
  await page.goto(`/admin/collections/articles/${fixture.articleId}`)
  await expect(page.getByText('状态：draft')).toBeVisible()
  await expect(page.getByRole('button', { name: '提交审核' })).toBeVisible()
  await expect(page.getByRole('link', { name: '预览' })).toHaveAttribute('target', '_blank')
  await page.goto(previewPath)
  await expect(page.getByRole('heading', { level: 1, name: 'D3 内容工作流文章' })).toBeVisible()
  await expect(page.getByText('预览 · draft')).toBeVisible()

  const runAction = (action: string) =>
    page.evaluate(
      async ({ action, id }) => {
        const response = await fetch(`/api/v1/content/articles/${id}/workflow`, {
          body: JSON.stringify({ action }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
        return { body: await response.json(), status: response.status }
      },
      { action, id: fixture.articleId },
    )

  expect((await runAction('archive')).status).toBe(409)
  expect((await runAction('submit_review')).status).toBe(200)
  expect((await runAction('publish')).status).toBe(200)

  await page.goto(publicPath)
  await expect(page.getByRole('heading', { level: 1, name: 'D3 内容工作流文章' })).toBeVisible()
  await expect(page.getByText('来源：Wanmi E2E 来源')).toBeVisible()
  const external = page.getByRole('link', { name: '外部安全来源' })
  await expect(external).toHaveAttribute('rel', 'nofollow noopener')
  await expect(external).not.toHaveAttribute('onmouseover', /.+/)

  expect((await runAction('unpublish')).status).toBe(200)
  expect((await request.get(publicPath)).status()).toBe(404)
  expect((await runAction('archive')).status).toBe(200)
  await page.goto(previewPath)
  await expect(page.getByText('预览 · archived')).toBeVisible()
})

test('all D3 public detail routes render only published content', async ({ page }) => {
  const fixture = await readContentCmsFixture()
  for (const route of fixture.publishedRoutes) {
    const response = await page.goto(route)
    expect(response?.status(), route).toBe(200)
    await expect(page.getByText('来源：Wanmi E2E 来源')).toBeVisible()
  }
})

test('SEO, sitemap and bidirectional links expose only published related content', async ({
  page,
  request,
}) => {
  const fixture = await readContentCmsFixture()

  await page.goto(fixture.relationArticlePath)
  await expect(page).toHaveTitle(/D3 关联文章 SEO/)
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'D3 SEO 与双向关联验证',
  )
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `http://127.0.0.1:3100${fixture.relationArticlePath}`,
  )
  await expect(page.getByRole('link', { name: 'DNS / NS 查询' })).toHaveAttribute(
    'href',
    '/tools/dns',
  )
  await expect(page.getByRole('link', { name: 'D3 公开 TLD' })).toHaveAttribute(
    'href',
    fixture.relationTldPath,
  )

  await page.goto(fixture.relationTldPath)
  await expect(page.getByRole('link', { name: 'D3 关联文章' })).toHaveAttribute(
    'href',
    fixture.relationArticlePath,
  )

  await page.goto('/tools/dns')
  await expect(page.getByRole('link', { name: 'D3 关联文章' })).toHaveAttribute(
    'href',
    fixture.relationArticlePath,
  )
  await expect(page.getByRole('link', { name: 'D3 公开 TLD' })).toHaveAttribute(
    'href',
    fixture.relationTldPath,
  )

  await page.goto(fixture.categoryPath)
  await expect(page.getByRole('heading', { level: 1, name: 'D3 域名指南分类' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'D3 关联文章' })).toBeVisible()

  await page.goto(fixture.tagPath)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/u)
  await page.goto(fixture.noIndexHelpPath)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/u)
  expect((await request.get(fixture.draftHelpPath)).status()).toBe(404)

  const sitemapResponse = await request.get('/sitemap.xml')
  expect(sitemapResponse.headers()['cache-control']).toMatch(
    /(?:no-store)|(?:no-cache)|(?:max-age=0.*must-revalidate)/u,
  )
  const sitemap = await sitemapResponse.text()
  expect(sitemap).toContain(`<loc>http://127.0.0.1:3100${fixture.relationArticlePath}</loc>`)
  expect(sitemap).toContain(`<loc>http://127.0.0.1:3100${fixture.relationTldPath}</loc>`)
  expect(sitemap).toContain(`<loc>http://127.0.0.1:3100${fixture.categoryPath}</loc>`)
  expect(sitemap).not.toContain(fixture.tagPath)
  expect(sitemap).not.toContain(fixture.noIndexHelpPath)
  expect(sitemap).not.toContain(fixture.draftHelpPath)
})
