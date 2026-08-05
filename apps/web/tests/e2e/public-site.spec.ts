import { expect, test } from '@playwright/test'

import { redirectFixtureFrom } from './redirect-fixture'

const canonicalOrigin = 'http://127.0.0.1:3100'

test('database redirect returns a canonical 301 with query parameters and a request ID', async ({
  request,
}) => {
  const response = await request.get(`${redirectFixtureFrom}?q=wanmi.net&utm_source=e2e`, {
    maxRedirects: 0,
  })
  expect(response.status()).toBe(301)
  expect(new URL(response.headers().location, canonicalOrigin).toString()).toBe(
    `${canonicalOrigin}/help?q=wanmi.net&utm_source=e2e`,
  )
  expect(response.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  expect((await request.get('/d1-redirect-e2e-unknown')).status()).toBe(404)
})

test('homepage works on desktop and submits a noindex domain query without provider access', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { level: 1, name: /查清域名状态/ })).toBeVisible()
  const input = page.getByLabel('输入完整域名或关键词')
  await input.fill('  wanmi.net  ')
  await page.getByRole('button', { name: '查询域名' }).click()

  await expect(page).toHaveURL(/\/tools\/domain-search\?q=.*wanmi\.net/)
  await expect(page.getByText('已收到查询：')).toContainText('wanmi.net')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${canonicalOrigin}/tools/domain-search`,
  )
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    `${canonicalOrigin}/tools/domain-search`,
  )
  await expect(page.getByText(/不会调用查询 provider/)).toBeVisible()
  await expect(page.getByLabel('输入完整域名或关键词')).toHaveValue('wanmi.net')
})

test('mobile navigation is keyboard-accessible and keeps primary routes reachable', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto('/')

  const openNavigation = page.getByRole('button', { name: '打开导航' })
  await openNavigation.focus()
  await expect(openNavigation).toBeFocused()
  await openNavigation.press('Enter')
  await expect(page.getByRole('navigation', { name: '移动端主导航' })).toBeVisible()
  await page.getByRole('link', { name: '工具中心' }).click()
  await expect(page).toHaveURL(/\/tools$/)
  await expect(page.getByRole('heading', { level: 1, name: '域名工具中心' })).toBeVisible()
})

test('planned public skeleton routes are available and unknown slugs return 404', async ({
  request,
}) => {
  for (const path of [
    '/tools',
    '/tools/whois',
    '/tools/dns',
    '/tools/ssl-check',
    '/tools/idn',
    '/pricing',
    '/articles',
    '/topics',
    '/help',
    '/legal',
    '/legal/privacy',
    '/legal/terms',
    '/legal/cookies',
    '/legal/advertising',
  ]) {
    const response = await request.get(path)
    expect(response.status(), path).toBe(200)
    expect(await response.text(), path).toContain(
      `<link rel="canonical" href="${canonicalOrigin}${path}"`,
    )
  }

  expect((await request.get('/tools/not-a-tool')).status()).toBe(404)
  expect((await request.get('/legal/not-a-document')).status()).toBe(404)
})

test('robots, sitemap and the branded Open Graph image expose only stable public URLs', async ({
  request,
}) => {
  const robots = await request.get('/robots.txt')
  expect(robots.ok()).toBe(true)
  const robotsText = await robots.text()
  expect(robotsText).toContain('Disallow: /admin/')
  expect(robotsText).toContain('Disallow: /api/')
  expect(robotsText).toContain('Disallow: /healthz')
  expect(robotsText).toContain(`Sitemap: ${canonicalOrigin}/sitemap.xml`)

  const sitemap = await request.get('/sitemap.xml')
  expect(sitemap.ok()).toBe(true)
  const sitemapText = await sitemap.text()
  expect(sitemapText).toContain(`<loc>${canonicalOrigin}/tools/domain-search</loc>`)
  expect(sitemapText).toContain(`<loc>${canonicalOrigin}/legal/privacy</loc>`)
  expect(sitemapText).not.toContain('/admin')
  expect(sitemapText).not.toContain('/api/')
  expect(sitemapText).not.toContain('?q=')
  expect(sitemapText).not.toMatch(/<loc>[^<]*\/articles\/.+<\/loc>/)

  const image = await request.get('/opengraph-image')
  expect(image.ok()).toBe(true)
  expect(image.headers()['content-type']).toContain('image/png')
  expect((await image.body()).byteLength).toBeGreaterThan(1_000)
})

test('all query-capable tool pages keep clean canonicals and noindex parameter results', async ({
  page,
}) => {
  await page.goto('/tools/whois?q=wanmi.net')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${canonicalOrigin}/tools/whois`,
  )

  await page.goto('/tools/whois')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /index, follow/)
})

test('content fallback and branded not-found states work on mobile', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto('/articles')
  await expect(page.getByRole('heading', { level: 1, name: '实用内容' })).toBeVisible()
  await expect(
    page.getByRole('heading', { level: 2, name: /暂无已发布内容|内容数据暂时不可用/ }),
  ).toBeVisible()

  await page.goto('/tools/not-a-tool')
  await expect(page).toHaveTitle(/Wanmi/)
  await expect(page.getByRole('heading', { level: 1, name: '没有找到这个页面' })).toBeVisible()
  await expect(page.getByText('请求 ID')).toBeVisible()
  await expect(page.getByRole('link', { name: '前往工具中心' })).toBeVisible()
  await expect(page.getByRole('link', { name: '返回首页' })).toBeVisible()
})
