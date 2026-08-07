import { expect, test } from '@playwright/test'

import { readAdvertisingFixture } from './advertising-fixture'

test('commercial content is unmistakably labeled and follows the safe-link contract', async ({
  page,
}) => {
  const fixture = await readAdvertisingFixture()
  const fixtureDomain = 'd3-advertising.net'
  const advertisingEvents: Array<Record<string, unknown>> = []
  await page.route('**/api/v1/events', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    if (typeof body.event === 'string' && body.event.startsWith('ad_')) {
      advertisingEvents.push(body)
    }
    await route.fulfill({ json: { accepted: true }, status: 202 })
  })
  await page.goto(`/tools/domain-search?q=${fixtureDomain}`)
  const result = page.getByRole('heading', { level: 2, name: '可注册查询结果' })
  await expect(result).toBeVisible()

  const advertisement = page.locator('[data-commercial-content="advertisement"]')
  await expect(advertisement).toBeVisible()
  await expect(advertisement.getByText('广告', { exact: true })).toBeVisible()
  await expect(advertisement).toContainText('不影响工具结果排序')
  expect(await advertisement.locator('[data-domain-status]').count()).toBe(0)

  const link = advertisement.getByRole('link', { name: /D3 受控广告测试/ })
  await expect(link).toHaveAttribute('href', `/go/ad/${fixture.publicId}`)
  await expect(link).toHaveAttribute('rel', 'sponsored nofollow noopener')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('referrerpolicy', 'origin')
  expect((await link.getAttribute('href')) ?? '').not.toContain(fixtureDomain)

  const resultTop = await result.evaluate((element) => element.getBoundingClientRect().top)
  const advertisementTop = await advertisement.evaluate(
    (element) => element.getBoundingClientRect().top,
  )
  expect(advertisementTop).toBeGreaterThan(resultTop)
  const queryInput = page.getByLabel('输入完整域名或关键词')
  const inputBox = await queryInput.boundingBox()
  const advertisementBox = await advertisement.boundingBox()
  expect(inputBox).not.toBeNull()
  expect(advertisementBox).not.toBeNull()
  expect(advertisementBox!.y).toBeGreaterThan(inputBox!.y + inputBox!.height)
  await expect(advertisement).not.toHaveCSS('position', 'fixed')

  await advertisement.scrollIntoViewIfNeeded()
  await expect
    .poll(() => advertisingEvents.map(({ event }) => event), { timeout: 5_000 })
    .toEqual(expect.arrayContaining(['ad_requested', 'ad_served', 'ad_viewable']))
  await link.evaluate((element) => {
    element.addEventListener('click', (event) => event.preventDefault(), { once: true })
    ;(element as HTMLAnchorElement).click()
  })
  await expect.poll(() => advertisingEvents.map(({ event }) => event)).toContain('ad_clicked')

  for (const event of advertisingEvents) {
    expect(JSON.stringify(event)).not.toMatch(/d3-advertising\.net|domain|query|user|crossSite/i)
    expect(Object.keys(event).sort()).toEqual(
      event.event === 'ad_requested'
        ? ['event', 'pageType', 'placementCode', 'schemaVersion']
        : ['campaignId', 'event', 'pageType', 'placementCode', 'schemaVersion'],
    )
  }
})

test('controlled ad redirects ignore query input and fail closed for inactive schedules', async ({
  request,
}) => {
  const fixture = await readAdvertisingFixture()
  const sensitiveDomain = 'private-query.example'
  const response = await request.get(`/go/ad/${fixture.publicId}?q=${sensitiveDomain}`, {
    headers: {
      referer: `http://127.0.0.1:3100/tools/domain-search?q=${sensitiveDomain}`,
    },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(302)
  expect(response.headers().location).toBe(fixture.externalTarget)
  expect(response.headers().location).not.toContain(sensitiveDomain)
  expect(response.headers()['referrer-policy']).toBe('origin')
  expect(response.headers()['cache-control']).toContain('no-store')

  const expired = await request.get(`/go/ad/${fixture.expiredPublicId}`, { maxRedirects: 0 })
  expect(expired.status()).toBe(404)
  expect(expired.headers().location).toBeUndefined()
  const arbitrary = await request.get('/go/ad/https:%2F%2Fevil.example', { maxRedirects: 0 })
  expect(arbitrary.status()).toBe(404)
})
