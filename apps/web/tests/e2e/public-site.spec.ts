import { expect, test } from '@playwright/test'

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
    expect((await request.get(path)).status(), path).toBe(200)
  }

  expect((await request.get('/tools/not-a-tool')).status()).toBe(404)
  expect((await request.get('/legal/not-a-document')).status()).toBe(404)
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
