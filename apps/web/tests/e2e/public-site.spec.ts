import { expect, test } from '@playwright/test'

import { readContentCmsFixture } from './content-cms-fixture'
import { redirectFixtureFrom } from './redirect-fixture'

const canonicalOrigin = 'http://127.0.0.1:3100'
const localHistoryStorageKey = 'wanmi:tool-history:v1'
const localFavoritesStorageKey = 'wanmi:tool-favorites:v1'

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
  const domainCard = page.locator('[data-domain-status="available"]')
  await expect(domainCard.getByRole('link', { name: 'WHOIS / RDAP' })).toHaveAttribute(
    'href',
    '/tools/whois?q=wanmi.net',
  )
  await expect(domainCard.getByRole('link', { name: 'TLD 价格与成本' })).toHaveAttribute(
    'href',
    '/pricing',
  )

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
  await expect(
    page
      .locator('section[data-tool-actions="domain-search"]')
      .first()
      .getByRole('link', { name: 'WHOIS / RDAP' }),
  ).toHaveAttribute('href', '/tools/whois')

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

test('pricing exposes 10 traceable fixture results, reuses snapshots and has no purchase surface', async ({
  page,
  request,
}) => {
  const first = await request.post('/api/v1/tools/pricing', { data: { tlds: ['com'] } })
  const second = await request.post('/api/v1/tools/pricing', { data: { tlds: ['com'] } })
  expect(first.status()).toBe(200)
  expect(second.status()).toBe(200)
  expect(first.headers()['cache-control']).toBe('no-store')
  expect(first.headers()['set-cookie']).toBeUndefined()
  const firstBody = (await first.json()) as Record<string, unknown>
  const secondBody = (await second.json()) as Record<string, unknown>
  const firstItem = (firstBody as { data: { items: Array<Record<string, unknown>> } }).data
    .items[0]!
  const secondItem = (secondBody as { data: { items: Array<Record<string, unknown>> } }).data
    .items[0]!
  expect(firstItem.cache).toMatchObject({ status: 'miss' })
  expect(secondItem.cache).toMatchObject({ status: 'hit' })
  expect(secondItem.snapshotRef).toBe(firstItem.snapshotRef)
  for (const body of [firstBody, secondBody]) {
    const serialized = JSON.stringify(body)
    expect(serialized).not.toMatch(
      /upstreamRegistrationPriceFen|upstreamRenewalPriceFen|fixedAmountFen|percentageBasisPoints|markupAmountFen/,
    )
  }

  const analyticsRequests: Array<{
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  const pricingRequests: Array<{
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
    await route.fulfill({ json: { accepted: true }, status: 202 })
  })
  await page.route('**/api/v1/tools/pricing', async (route) => {
    pricingRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: await route.request().allHeaders(),
    })
    await route.continue()
  })
  await page.goto('/pricing')

  await expect(page.getByRole('heading', { level: 2, name: '普通域名价格表' })).toBeVisible()
  await expect(page.locator('[data-pricing-status]')).toHaveCount(10)
  await expect(page.locator('[data-pricing-status="priced"]')).toHaveCount(9)
  await expect(page.locator('[data-pricing-status="unconfigured"]')).toHaveCount(1)
  await expect(page.locator('[data-pricing-status="unconfigured"]')).toContainText('.tv')
  await expect(page.getByText('未配置加价规则，不开放购买。')).toBeVisible()
  await expect(page.getByText('¥25.00').first()).toBeVisible()
  await expect(page.getByText('¥95.00').first()).toBeVisible()
  await expect(page.getByText('数据源').first()).toBeVisible()
  await expect(page.getByText('取价时间').first()).toBeVisible()
  await expect(page.getByText('缓存状态').first()).toBeVisible()
  await expect(page.getByText('快照引用').first()).toBeVisible()
  await expect(page.getByText(/溢价域名不在本表内/)).toBeVisible()
  await expect(page.getByText(/交易功能尚未开放/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /购买|注册/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /购买|在 Wanmi 注册|立即注册/u })).toHaveCount(0)

  expect(pricingRequests).toHaveLength(1)
  expect(pricingRequests[0].body).toEqual({})
  expect(pricingRequests[0].headers.cookie).toBeUndefined()
  expect(pricingRequests[0].headers.referer).toBe(`${canonicalOrigin}/`)
  await expect
    .poll(() => analyticsRequests.some(({ body }) => body.event === 'tool_completed'))
    .toBe(true)
  const pricingAnalytics = analyticsRequests.find(
    ({ body }) => body.event === 'tool_completed' && body.tool === 'pricing',
  )!
  expect(pricingAnalytics.body).not.toHaveProperty('tld')
  expect(JSON.stringify(pricingAnalytics.body)).not.toMatch(/snapshotRef|2500|9500/)
  expect(pricingAnalytics.headers.cookie).toBeUndefined()
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
  expect(sitemapText).toContain(`<loc>${canonicalOrigin}/articles/e2e-d3-content-relations</loc>`)
  expect(sitemapText).not.toContain('/help/e2e-d3-content-draft-help')
  expect(sitemapText).not.toContain('/help/e2e-d3-content-noindex-help')

  const image = await request.get('/opengraph-image')
  expect(image.ok()).toBe(true)
  expect(image.headers()['content-type']).toContain('image/png')
  expect((await image.body()).byteLength).toBeGreaterThan(1_000)
})

test('WHOIS stays separate from availability and keeps result requests and analytics private', async ({
  page,
}) => {
  const observedAt = '2026-08-05T12:00:00.000Z'
  const analyticsRequests: Array<{
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  const whoisRequests: Array<{
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  await page.setViewportSize({ height: 844, width: 390 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: canonicalOrigin,
  })
  await page
    .context()
    .addCookies([{ name: 'tracking_test_cookie', url: canonicalOrigin, value: 'must-not-be-sent' }])
  await page.route('**/api/v1/events', async (route) => {
    analyticsRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: await route.request().allHeaders(),
    })
    await route.fulfill({ json: { accepted: true }, status: 202 })
  })
  await page.route('**/api/v1/tools/whois', async (route) => {
    whoisRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: await route.request().allHeaders(),
    })
    await route.fulfill({
      json: {
        data: {
          dates: {
            created: '2000-01-01T00:00:00.000Z',
            expires: null,
            updated: '2026-01-01T00:00:00.000Z',
          },
          domainAscii: 'xn--fsqu00a.xn--0zwm56d',
          domainUnicode: '例子.测试',
          nameServers: ['ns1.example.test'],
          normalizedQueryAscii: 'xn--fsqu00a.xn--0zwm56d',
          normalizedQueryUnicode: '例子.测试',
          recordStatus: 'record_found',
          registrar: 'Fixture Registrar',
          risks: [],
          source: { protocol: 'rdap', provider: 'whodat' },
          statuses: ['client transfer prohibited'],
        },
        meta: {
          cacheStatus: 'hit',
          dataSource: 'Who-Dat RDAP',
          observedAt,
          traceId: 'trace-whois-e2e',
        },
        state: 'ready',
      },
      status: 200,
    })
  })

  await page.goto('/tools/whois')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /index, follow/)
  await page.getByLabel('输入要查询公开注册信息的完整域名').fill('例子.测试')
  await page.getByRole('button', { name: '查询 WHOIS' }).click()

  await expect(page).toHaveURL(/\/tools\/whois\?q=/)
  await expect(page.getByRole('heading', { level: 2, name: 'RDAP / WHOIS 查询结果' })).toBeVisible()
  await expect(page.getByText('Fixture Registrar')).toBeVisible()
  await expect(page.getByText('Who-Dat RDAP')).toBeVisible()
  await expect(page.getByText('Who-Dat 缓存命中')).toBeVisible()
  await expect(page.getByText(/此页面不判断可注册状态/)).toBeVisible()
  await expect(page.getByRole('link', { name: /购买|在 Wanmi 注册|立即注册/u })).toHaveCount(0)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex, nofollow/)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${canonicalOrigin}/tools/whois`,
  )
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    `${canonicalOrigin}/tools/whois`,
  )
  await expect(page.getByRole('link', { name: 'DNS / NS 查询' })).toHaveAttribute(
    'href',
    '/tools/dns?q=xn--fsqu00a.xn--0zwm56d',
  )
  await expect(page.getByRole('link', { name: 'SSL / CAA 检查' })).toHaveAttribute(
    'href',
    '/tools/ssl-check?q=xn--fsqu00a.xn--0zwm56d',
  )

  await page.getByRole('button', { name: '复制 Name Server：ns1.example.test' }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('Name Server\tns1.example.test')

  await page.getByRole('button', { name: '生成分享链接' }).click()
  await expect(page.getByRole('radio', { name: /仅分享工具入口/u })).toBeChecked()
  await page.getByRole('button', { name: '确认并生成链接' }).click()
  await expect(page.getByLabel('可分享链接')).toHaveValue(`${canonicalOrigin}/tools/whois`)
  await page.getByRole('radio', { name: /包含当前域名/u }).check()
  await expect(page.getByText('确认公开域名')).toBeVisible()
  await page.getByRole('button', { name: '确认并生成链接' }).click()
  const domainShareUrl = `${canonicalOrigin}/tools/whois?q=xn--fsqu00a.xn--0zwm56d`
  await expect(page.getByLabel('可分享链接')).toHaveValue(domainShareUrl)
  expect(domainShareUrl).not.toMatch(/traceId|requestId|cacheKey|trace-whois-e2e/u)
  await page.getByRole('button', { name: '取消' }).click()

  expect(whoisRequests).toHaveLength(1)
  expect(whoisRequests[0].body).toEqual({ query: '例子.测试' })
  expect(whoisRequests[0].headers.cookie).toBeUndefined()
  expect(whoisRequests[0].headers.referer ?? '').not.toContain('?q=')
  await expect
    .poll(() => analyticsRequests.some(({ body }) => body.event === 'tool_completed'))
    .toBe(true)
  for (const event of analyticsRequests) {
    expect(JSON.stringify(event.body)).not.toMatch(/例子|xn--fsqu00a/)
    expect(event.body).not.toHaveProperty('domain')
    expect(event.body).not.toHaveProperty('query')
    expect(event.headers.cookie).toBeUndefined()
    expect(event.headers.referer ?? '').not.toContain('?q=')
  }
})

test('DNS renders eight mobile record sets, isolates requests and never treats NXDOMAIN as availability', async ({
  page,
}) => {
  const observedAt = '2026-08-05T12:00:00.000Z'
  const recordTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA'] as const
  const analyticsRequests: Array<{
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  const dnsRequests: Array<{
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  let responseMode: 'nxdomain' | 'ready' = 'ready'
  await page.setViewportSize({ height: 844, width: 390 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: canonicalOrigin,
  })
  await page
    .context()
    .addCookies([{ name: 'tracking_test_cookie', url: canonicalOrigin, value: 'must-not-be-sent' }])
  await page.route('**/api/v1/events', async (route) => {
    analyticsRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: await route.request().allHeaders(),
    })
    await route.fulfill({ json: { accepted: true }, status: 202 })
  })
  await page.route('**/api/v1/tools/dns', async (route) => {
    dnsRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: await route.request().allHeaders(),
    })
    const recordFor = (type: (typeof recordTypes)[number]) => {
      const base = { ownerName: 'xn--fsqu00a.xn--0zwm56d', ttl: 300, type }
      if (type === 'A') return { ...base, address: '93.184.216.34' }
      if (type === 'AAAA') return { ...base, address: '2606:2800:220:1:248:1893:25c8:1946' }
      if (type === 'CNAME') return { ...base, target: 'target.example.test' }
      if (type === 'MX') return { ...base, exchange: 'mail.example.test', priority: 10 }
      if (type === 'TXT') return { ...base, value: 'v=spf1 ~all' }
      if (type === 'NS') return { ...base, host: 'ns1.example.test' }
      if (type === 'SOA') {
        return {
          ...base,
          expire: 604_800,
          minimum: 300,
          primaryNameServer: 'ns1.example.test',
          refresh: 3_600,
          responsibleMailbox: 'hostmaster.example.test',
          retry: 600,
          serial: 2_026_080_501,
        }
      }
      return { ...base, flags: 0, tag: 'issue', value: 'letsencrypt.org' }
    }
    await route.fulfill({
      json: {
        data: {
          normalizedQueryAscii:
            responseMode === 'ready' ? 'xn--fsqu00a.xn--0zwm56d' : 'missing.example.test',
          normalizedQueryUnicode: responseMode === 'ready' ? '例子.测试' : 'missing.example.test',
          recordSets: recordTypes.map((type, index) => ({
            cacheStatus: responseMode === 'ready' && index === 0 ? 'hit' : 'miss',
            observedAt,
            records: responseMode === 'ready' ? [recordFor(type)] : [],
            resolverNode:
              responseMode === 'ready' && index === 0 ? 'alidns_secondary' : 'alidns_primary',
            status: responseMode === 'ready' ? 'records' : 'nxdomain',
            type,
          })),
          risks: [],
        },
        meta: {
          cacheStatus: responseMode === 'ready' ? 'mixed' : 'miss',
          dataSource: '阿里公共 DNS（受控 DoH）',
          observedAt,
          traceId: 'trace-dns-e2e',
        },
        state: responseMode === 'ready' ? 'ready' : 'empty',
      },
      status: 200,
    })
  })

  await page.goto('/tools/dns')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /index, follow/)
  await page.getByLabel('输入要查询 DNS 记录的完整域名').fill('例子.测试')
  await page.getByRole('button', { name: '查询 DNS' }).click()

  await expect(page).toHaveURL(/\/tools\/dns\?q=/)
  await expect(page.getByRole('heading', { level: 2, name: 'DNS / NS 查询结果' })).toBeVisible()
  await expect(page.locator('[data-dns-status="records"]')).toHaveCount(8)
  await expect(page.getByText('例子.测试')).toBeVisible()
  await expect(page.getByText('xn--fsqu00a.xn--0zwm56d').first()).toBeVisible()
  await expect(page.getByText('阿里公共 DNS（受控 DoH）').first()).toBeVisible()
  await expect(page.getByText('阿里公共 DNS 备用节点').first()).toBeVisible()
  await expect(page.getByText('部分缓存命中').first()).toBeVisible()
  await expect(page.getByText('300 秒').first()).toBeVisible()
  await expect(page.getByText(/单一受控递归解析视角/)).toBeVisible()
  await expect(page.getByText(/CAA 在此只作为原始 DNS 记录展示/)).toBeVisible()
  await expect(
    page.getByRole('link', { name: /购买|在 Wanmi 注册|立即注册|管理 DNS/u }),
  ).toHaveCount(0)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex, nofollow/)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${canonicalOrigin}/tools/dns`,
  )
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    `${canonicalOrigin}/tools/dns`,
  )
  await page.getByRole('button', { name: '复制 A 记录 1' }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('xn--fsqu00a.xn--0zwm56d 300 IN A 93.184.216.34')

  responseMode = 'nxdomain'
  await page.goto('/tools/dns?q=missing.example.test')
  await expect(page.getByRole('heading', { name: 'DNS 返回 NXDOMAIN' })).toBeVisible()
  await expect(page.getByText(/绝不代表域名可注册/)).toBeVisible()
  await expect(page.locator('[data-dns-status="nxdomain"]')).toHaveCount(8)

  expect(dnsRequests.map(({ body }) => body)).toEqual([
    { query: '例子.测试' },
    { query: 'missing.example.test' },
  ])
  for (const request of dnsRequests) {
    expect(request.headers.cookie).toBeUndefined()
    expect(request.headers.referer ?? '').not.toContain('?q=')
  }
  await expect
    .poll(() => analyticsRequests.filter(({ body }) => body.event === 'tool_completed').length)
    .toBeGreaterThanOrEqual(2)
  for (const event of analyticsRequests) {
    expect(JSON.stringify(event.body)).not.toMatch(/例子|xn--fsqu00a|missing\.example/)
    expect(event.body).not.toHaveProperty('domain')
    expect(event.body).not.toHaveProperty('query')
    expect(event.headers.cookie).toBeUndefined()
    expect(event.headers.referer ?? '').not.toContain('?q=')
  }
})

test('SSL renders mobile certificate and inherited CAA diagnostics with isolated noindex requests', async ({
  page,
}) => {
  const observedAt = '2026-08-05T12:00:00.000Z'
  const analyticsRequests: Array<{
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  const sslRequests: Array<{
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  await page.setViewportSize({ height: 844, width: 390 })
  await page
    .context()
    .addCookies([{ name: 'tracking_test_cookie', url: canonicalOrigin, value: 'must-not-be-sent' }])
  await page.route('**/api/v1/events', async (route) => {
    analyticsRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: await route.request().allHeaders(),
    })
    await route.fulfill({ json: { accepted: true }, status: 202 })
  })
  await page.route('**/api/v1/tools/ssl-check', async (route) => {
    sslRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: await route.request().allHeaders(),
    })
    await route.fulfill({
      json: {
        data: {
          caa: {
            effectiveOwnerName: 'example.test',
            inherited: true,
            records: [
              {
                critical: true,
                explanation: '该属性设置了 critical 标志；issue 指定可签发的 CA。',
                flags: 128,
                ownerName: 'example.test',
                tag: 'issue',
                ttl: 300,
                value: 'ca.example',
              },
              {
                critical: false,
                explanation: 'iodef 是违规签发报告地址；Wanmi 不会访问该地址。',
                flags: 0,
                ownerName: 'example.test',
                tag: 'iodef',
                ttl: 300,
                value: 'mailto:security@example.test',
              },
            ],
            source: {
              cacheStatus: 'hit',
              dataSource: '阿里公共 DNS（受控 DoH）',
              observedAt,
            },
            status: 'records',
          },
          normalizedQueryAscii: 'xn--fsqu00a.xn--0zwm56d',
          normalizedQueryUnicode: '例子.测试',
          risks: [],
          tls: {
            certificate: {
              chain: {
                certificates: [
                  {
                    fingerprint256: 'AA:BB',
                    issuer: { commonName: 'Test Intermediate', organization: 'Wanmi Tests' },
                    subject: { commonName: '例子.测试', organization: 'Wanmi Tests' },
                    validFrom: '2026-08-01T00:00:00.000Z',
                    validTo: '2026-09-01T00:00:00.000Z',
                  },
                  {
                    fingerprint256: 'CC:DD',
                    issuer: { commonName: 'Test Root', organization: 'Wanmi Tests' },
                    subject: { commonName: 'Test Intermediate', organization: 'Wanmi Tests' },
                    validFrom: '2025-01-01T00:00:00.000Z',
                    validTo: '2030-01-01T00:00:00.000Z',
                  },
                ],
                depth: 2,
                status: 'trusted',
                truncated: false,
              },
              daysRemaining: 27,
              hostnameMatch: true,
              issuer: { commonName: 'Test Intermediate', organization: 'Wanmi Tests' },
              sanCount: 1,
              sanTruncated: false,
              subject: { commonName: '例子.测试', organization: 'Wanmi Tests' },
              subjectAlternativeNames: ['xn--fsqu00a.xn--0zwm56d'],
              validFrom: '2026-08-01T00:00:00.000Z',
              validityStatus: 'valid',
              validTo: '2026-09-01T00:00:00.000Z',
            },
            cipherSuite: 'TLS_AES_256_GCM_SHA384',
            findings: [],
            port: 443,
            protocol: 'TLSv1.3',
            source: {
              cacheStatus: 'miss',
              dataSource: '直接 TLS 443 握手（Node.js 系统信任库）',
              observedAt,
            },
            status: 'connected',
          },
        },
        meta: {
          cacheStatus: 'mixed',
          dataSource: '阿里公共 DNS + 直接 TLS 443 握手',
          observedAt,
          traceId: 'trace-ssl-e2e',
        },
        state: 'ready',
      },
      status: 200,
    })
  })

  await page.goto('/tools/ssl-check')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /index, follow/)
  await page.getByLabel('输入要检查 TLS 证书与 CAA 的完整域名').fill('例子.测试')
  await page.getByRole('button', { name: '检查 SSL' }).click()

  await expect(page).toHaveURL(/\/tools\/ssl-check\?q=/)
  await expect(
    page.getByRole('heading', { level: 2, name: 'SSL / TLS / CAA 检查结果' }),
  ).toBeVisible()
  await expect(page.locator('[data-tls-status="connected"]')).toBeVisible()
  await expect(page.locator('[data-caa-status="records"]')).toBeVisible()
  await expect(page.getByText('TLS_AES_256_GCM_SHA384')).toBeVisible()
  await expect(page.getByText(/证书链（共 2 层）/)).toBeVisible()
  await expect(page.getByText(/继承自父域：example.test/)).toBeVisible()
  await expect(page.getByText(/不会访问该地址/)).toBeVisible()
  await expect(page.getByText('trace-ssl-e2e')).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex, nofollow/)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${canonicalOrigin}/tools/ssl-check`,
  )
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    `${canonicalOrigin}/tools/ssl-check`,
  )

  expect(sslRequests).toHaveLength(1)
  expect(sslRequests[0].body).toEqual({ query: '例子.测试' })
  expect(sslRequests[0].headers.cookie).toBeUndefined()
  expect(sslRequests[0].headers.referer ?? '').not.toContain('?q=')
  await expect
    .poll(() => analyticsRequests.some(({ body }) => body.event === 'tool_completed'))
    .toBe(true)
  const outcomeEvents = analyticsRequests.filter(
    ({ body }) => body.event === 'tool_completed' || body.event === 'tool_failed',
  )
  expect(outcomeEvents.length).toBeGreaterThan(0)
  for (const event of outcomeEvents) {
    expect(event.body).toMatchObject({ dataSource: 'tls', tool: 'ssl-check' })
  }
  for (const event of analyticsRequests) {
    expect(JSON.stringify(event.body)).not.toMatch(/例子|xn--fsqu00a/)
    expect(event.body).not.toHaveProperty('domain')
    expect(event.body).not.toHaveProperty('query')
    expect(event.headers.cookie).toBeUndefined()
    expect(event.headers.referer ?? '').not.toContain('?q=')
  }
})

test('IDN converts locally on mobile, keeps Punycode public and marks parameter results noindex', async ({
  page,
}) => {
  const analyticsRequests: Array<{
    body: Record<string, unknown>
    headers: Record<string, string>
  }> = []
  let idnApiRequests = 0

  await page.setViewportSize({ height: 844, width: 390 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: canonicalOrigin,
  })
  await page
    .context()
    .addCookies([{ name: 'tracking_test_cookie', url: canonicalOrigin, value: 'must-not-be-sent' }])
  await page.route('**/api/v1/events', async (route) => {
    analyticsRequests.push({
      body: route.request().postDataJSON() as Record<string, unknown>,
      headers: await route.request().allHeaders(),
    })
    await route.fulfill({ json: { accepted: true }, status: 202 })
  })
  await page.route('**/api/v1/tools/idn', async (route) => {
    idnApiRequests += 1
    await route.abort()
  })

  await page.goto('/tools/idn')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /index, follow/)
  await page.getByLabel('输入要转换的域名').fill('例子.中国')
  await page.getByRole('button', { name: '转换 IDN' }).click()

  await expect(page).toHaveURL(`${canonicalOrigin}/tools/idn`)
  await expect(page.locator('[data-idn-result="punycode"]')).toContainText('xn--fsqu00a.xn--fiqs8s')
  await expect(page.locator('[data-idn-result="unicode"]')).toContainText('例子.中国')
  await expect(page.locator('[data-public-domain]')).toHaveAttribute(
    'data-public-domain',
    'xn--fsqu00a.xn--fiqs8s',
  )
  await expect(page.getByRole('link', { name: 'WHOIS / RDAP' })).toHaveAttribute(
    'href',
    '/tools/whois?q=xn--fsqu00a.xn--fiqs8s',
  )
  await page.getByRole('button', { name: '复制 Punycode' }).click()
  await expect(page.getByText('已复制 Punycode')).toBeVisible()
  await expect(page.getByRole('button', { name: '复制 Unicode' })).toHaveCount(0)

  await page.getByLabel('输入要转换的域名').fill('раypal.com')
  await page.getByRole('button', { name: '转换 IDN' }).click()
  await expect(page.locator('[data-idn-risk]')).toContainText('西里尔文（Cyrillic）')
  await expect(page.locator('[data-idn-risk]')).toContainText('拉丁文（Latin）')
  await expect(page.getByText(/转换成功不代表可注册或商标安全/u).first()).toBeVisible()

  await page.getByLabel('输入要转换的域名').fill('wanmi..com')
  await page.getByRole('button', { name: '转换 IDN' }).click()
  await expect(page.getByText('第 2 个标签为空').first()).toBeVisible()

  await page.goto('/tools/idn?q=%E4%BE%8B%E5%AD%90.%E4%B8%AD%E5%9B%BD')
  await expect(page.locator('[data-idn-result="punycode"]')).toContainText('xn--fsqu00a.xn--fiqs8s')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex, nofollow/)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${canonicalOrigin}/tools/idn`,
  )
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    `${canonicalOrigin}/tools/idn`,
  )

  expect(idnApiRequests).toBe(0)
  await expect.poll(() => analyticsRequests.some(({ body }) => body.tool === 'idn')).toBe(true)
  for (const request of analyticsRequests) {
    expect(JSON.stringify(request.body)).not.toMatch(
      /例子|中国|раypal|xn--fsqu00a|xn--fiqs8s|xn--ypal-43d9g/u,
    )
    expect(request.body).not.toHaveProperty('domain')
    expect(request.body).not.toHaveProperty('query')
    if (request.body.tool === 'idn') expect(request.body).not.toHaveProperty('tld')
    expect(request.headers.cookie).toBeUndefined()
    expect(request.headers.referer ?? '').not.toContain('?q=')
  }
})

test('local history and favorites stay browser-only, rerun safely, and clear every key', async ({
  page,
}) => {
  const analyticsRequests: Array<Record<string, unknown>> = []
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.route('**/api/v1/events', async (route) => {
    analyticsRequests.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ json: { accepted: true }, status: 202 })
  })

  await page.goto('/tools/whois?q=wanmi.net')
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), localHistoryStorageKey),
  ).toBeNull()

  await page.goto('/')
  await page.getByLabel('输入完整域名或关键词').fill('wanmi.net')
  await page.getByRole('button', { name: '查询域名' }).click()
  await expect(page).toHaveURL(/\/tools\/domain-search\?q=.*wanmi\.net/)
  await expect(page.getByRole('heading', { level: 2, name: '可注册查询结果' })).toBeVisible()
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), localHistoryStorageKey),
  ).toContain('wanmi.net')

  analyticsRequests.length = 0
  await page.goto('/tools')
  await expect(page.getByRole('heading', { name: '我的本地工具箱' })).toBeVisible()
  await expect(page.locator('[data-nextjs-dialog]')).toHaveCount(0)
  await expect(page.locator('[data-local-history-list]')).toContainText('wanmi.net')
  await expect.poll(() => analyticsRequests.some((body) => body.event === 'page_viewed')).toBe(true)
  analyticsRequests.length = 0

  await page.getByRole('button', { name: '收藏工具：TLD 价格与成本' }).click()
  await expect(page.getByRole('button', { name: '取消收藏工具：TLD 价格与成本' })).toBeVisible()
  await page.getByRole('button', { name: '收藏域名：wanmi.net' }).click()
  await expect(page.getByRole('button', { name: '取消收藏域名：wanmi.net' })).toBeVisible()
  await page.waitForTimeout(250)
  expect(analyticsRequests).toEqual([])
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), localFavoritesStorageKey),
  ).toContain('wanmi.net')

  await page
    .locator('[data-local-history-list] li')
    .filter({ hasText: 'wanmi.net' })
    .getByRole('link', { name: '再次查询' })
    .click()
  await expect(page).toHaveURL(/\/tools\/domain-search\?q=wanmi\.net/)
  await expect(page.getByRole('heading', { level: 2, name: '可注册查询结果' })).toBeVisible()
  await expect.poll(() => analyticsRequests.length).toBeGreaterThan(0)
  for (const body of analyticsRequests) {
    expect(JSON.stringify(body)).not.toContain('wanmi.net')
    expect(body).not.toHaveProperty('query')
    expect(body).not.toHaveProperty('domain')
  }

  analyticsRequests.length = 0
  await page.goto('/tools')
  await expect(page.locator('[data-local-history-list]')).toContainText('wanmi.net')
  await expect.poll(() => analyticsRequests.some((body) => body.event === 'page_viewed')).toBe(true)
  analyticsRequests.length = 0
  await page.getByRole('button', { name: '删除查询历史：wanmi.net' }).click()
  await expect(page.getByText('已删除查询历史“wanmi.net”')).toBeVisible()
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), localHistoryStorageKey),
  ).toBeNull()

  await page.getByRole('button', { name: '清空全部本地数据' }).click()
  await expect(page.getByText('已清空全部本地历史与收藏')).toBeVisible()
  expect(
    await page.evaluate(
      ([historyKey, favoritesKey]) => ({
        favorites: window.localStorage.getItem(favoritesKey),
        history: window.localStorage.getItem(historyKey),
      }),
      [localHistoryStorageKey, localFavoritesStorageKey],
    ),
  ).toEqual({ favorites: null, history: null })
  await page.waitForTimeout(250)
  expect(analyticsRequests).toEqual([])

  await page.evaluate((key) => {
    window.localStorage.setItem(key, '{broken-json')
    window.dispatchEvent(new StorageEvent('storage', { key }))
  }, localHistoryStorageKey)
  await expect(page.getByText('已修复本地数据')).toBeVisible()
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), localHistoryStorageKey),
  ).toBeNull()
  expect(browserErrors).toEqual([])
})

test('DNT and GPC stop automatic local history but allow explicit local favorites', async ({
  browser,
}) => {
  for (const signal of ['dnt', 'gpc'] as const) {
    const context = await browser.newContext()
    await context.addInitScript((activeSignal) => {
      if (activeSignal === 'dnt') {
        Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' })
      } else {
        Object.defineProperty(navigator, 'globalPrivacyControl', {
          configurable: true,
          value: true,
        })
      }
    }, signal)
    const privacyPage = await context.newPage()
    await privacyPage.goto('/')
    await privacyPage.getByLabel('输入完整域名或关键词').fill(`${signal}.example`)
    await privacyPage.getByRole('button', { name: '查询域名' }).click()
    await expect(privacyPage).toHaveURL(/\/tools\/domain-search\?q=/)
    expect(
      await privacyPage.evaluate((key) => window.localStorage.getItem(key), localHistoryStorageKey),
    ).toBeNull()

    await privacyPage.goto('/tools')
    await expect(privacyPage.getByText('已尊重 DNT / GPC 隐私信号')).toBeVisible()
    await privacyPage.getByRole('button', { name: '收藏工具：DNS / NS 查询' }).click()
    expect(
      await privacyPage.evaluate(
        (key) => window.localStorage.getItem(key),
        localFavoritesStorageKey,
      ),
    ).toContain('dns')
    await context.close()
  }
})

test('published content and branded not-found states work on mobile', async ({ page }) => {
  const contentFixture = await readContentCmsFixture()
  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto('/articles')
  await expect(page.getByRole('heading', { level: 1, name: '实用内容' })).toBeVisible()
  await expect(page.locator(`a[href="${contentFixture.relationArticlePath}"]`)).toBeVisible()
  await expect(page.getByText('D3 草稿帮助')).toHaveCount(0)

  await page.goto('/tools/not-a-tool')
  await expect(page).toHaveTitle(/Wanmi/)
  await expect(page.getByRole('heading', { level: 1, name: '没有找到这个页面' })).toBeVisible()
  await expect(page.getByText('请求 ID')).toBeVisible()
  await expect(page.getByRole('link', { name: '前往工具中心' })).toBeVisible()
  await expect(page.getByRole('link', { name: '返回首页' })).toBeVisible()
})
