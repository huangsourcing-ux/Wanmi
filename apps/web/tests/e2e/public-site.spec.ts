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

test('homepage submits a noindex fixture domain query without leaking cookies or full referrers', async ({
  page,
}) => {
  const analyticsRequests: Array<{
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  const domainSearchRequests: Array<{
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  await page
    .context()
    .addCookies([{ name: 'tracking_test_cookie', url: canonicalOrigin, value: 'must-not-be-sent' }])
  await page.route('**/api/v1/events', async (route) => {
    analyticsRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: await route.request().allHeaders(),
    })
    await route.fulfill({ body: 'analytics unavailable', status: 503 })
  })
  await page.route('**/api/v1/tools/domain-search', async (route) => {
    domainSearchRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: await route.request().allHeaders(),
    })
    await route.continue()
  })
  await page.goto('/')

  await expect(page.getByRole('heading', { level: 1, name: /查清域名状态/ })).toBeVisible()
  const input = page.getByLabel('输入完整域名或关键词')
  await input.fill('  wanmi.net  ')
  await page.getByRole('button', { name: '查询域名' }).click()

  await expect(page).toHaveURL(/\/tools\/domain-search\?q=.*wanmi\.net/)
  await expect(page.getByRole('heading', { level: 2, name: '可注册查询结果' })).toBeVisible()
  await expect(page.locator('[data-domain-status="available"]')).toContainText('wanmi.net')
  await expect(page.getByText('西部数码 fixture（非实时）').first()).toBeVisible()
  await expect(page.getByText('最新查询').first()).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${canonicalOrigin}/tools/domain-search`,
  )
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    `${canonicalOrigin}/tools/domain-search`,
  )
  await expect(page.getByText(/与 WHOIS\/RDAP 注册信息严格分离/)).toBeVisible()
  await expect(page.getByLabel('输入完整域名或关键词')).toHaveValue('wanmi.net')

  await expect
    .poll(() => analyticsRequests.some(({ body }) => body.event === 'tool_submitted'))
    .toBe(true)
  const submitted = analyticsRequests.find(({ body }) => body.event === 'tool_submitted')!
  expect(submitted.body).toEqual({
    event: 'tool_submitted',
    fromLocalHistory: false,
    inputType: 'full_domain',
    schemaVersion: 1,
    tld: 'net',
    tool: 'domain-search',
  })
  expect(analyticsRequests.some(({ body }) => body.event === 'page_viewed')).toBe(true)
  await expect
    .poll(() => analyticsRequests.some(({ body }) => body.event === 'tool_completed'))
    .toBe(true)
  for (const event of analyticsRequests) {
    expect(JSON.stringify(event.body)).not.toContain('wanmi.net')
    expect(event.body).not.toHaveProperty('domain')
    expect(event.body).not.toHaveProperty('query')
    expect(event.body).not.toHaveProperty('referrer')
    expect(event.headers.cookie).toBeUndefined()
    expect(event.headers.referer ?? '').not.toContain('?q=')
  }
  expect(domainSearchRequests).toHaveLength(1)
  expect(domainSearchRequests[0].body).toEqual({ query: 'wanmi.net' })
  expect(domainSearchRequests[0].headers.cookie).toBeUndefined()
  expect(domainSearchRequests[0].headers.referer ?? '').not.toContain('?q=')
})

test('keyword queries return 10 ordered TLD results with partial success and bounded cache metadata', async ({
  page,
  request,
}) => {
  await page.goto('/tools/domain-search?q=partial')
  await expect(page.getByRole('heading', { level: 2, name: '可注册查询结果' })).toBeVisible()
  await expect(page.locator('[data-domain-status]')).toHaveCount(10)
  await expect(page.locator('[data-domain-status="query_failed"]')).toContainText('partial.xyz')
  await expect(page.getByRole('heading', { level: 2, name: /部分域名状态无法确认/ })).toBeVisible()
  await expect(page.getByText('数据源').first()).toBeVisible()
  await expect(page.getByText('查询时间').first()).toBeVisible()
  await expect(page.getByText('缓存状态').first()).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)

  const first = await request.post('/api/v1/tools/domain-search', {
    data: { query: 'premium.top' },
    headers: { 'x-request-id': 'e2e-domain-cache-first' },
  })
  const second = await request.post('/api/v1/tools/domain-search', {
    data: { query: 'premium.top' },
    headers: { 'x-request-id': 'e2e-domain-cache-second' },
  })
  expect(first.status()).toBe(200)
  expect(second.status()).toBe(200)
  expect((await second.json()).data.items[0].cache.status).toBe('hit')

  const overLimit = await request.post('/api/v1/tools/domain-search', {
    data: {
      query: 'wanmi',
      tlds: ['com', 'cn', 'net', 'org', 'top', 'xyz', 'vip', 'cc', 'tv', 'com.cn', 'io'],
    },
  })
  expect(overLimit.status()).toBe(400)
  expect(await overLimit.json()).toMatchObject({
    code: 'DOMAIN_SEARCH_TLD_LIMIT_EXCEEDED',
    detail: '单次最多查询 10 个域名后缀，当前提交了 11 个',
  })
})

test('the first-party endpoint and client honor DNT/GPC without blocking tools', async ({
  page,
  request,
}) => {
  for (const header of ['dnt', 'sec-gpc']) {
    const response = await request.post('/api/v1/events', {
      data: 'not-a-valid-event',
      headers: { [header]: '1' },
    })
    expect(response.status()).toBe(204)
  }

  const accepted = await request.post('/api/v1/events', {
    data: {
      deviceCategory: 'desktop',
      event: 'page_viewed',
      pageType: 'home',
      schemaVersion: 1,
      source: 'direct',
    },
  })
  expect(accepted.status()).toBe(202)
  expect(await accepted.json()).toEqual({ accepted: true })

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' })
  })
  let eventRequests = 0
  await page.route('**/api/v1/events', async (route) => {
    eventRequests += 1
    await route.fulfill({ json: { accepted: true }, status: 202 })
  })
  await page.goto('/')
  await page.getByLabel('输入完整域名或关键词').fill('wanmi.net')
  await page.getByRole('button', { name: '查询域名' }).click()
  await expect(page).toHaveURL(/\/tools\/domain-search\?q=.*wanmi\.net/)
  await page.waitForTimeout(250)
  expect(eventRequests).toBe(0)
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
