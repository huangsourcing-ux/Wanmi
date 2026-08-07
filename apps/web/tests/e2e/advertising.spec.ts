import { expect, test } from '@playwright/test'

import { readAdvertisingFixture } from './advertising-fixture'

test('commercial content is unmistakably labeled and follows the safe-link contract', async ({
  page,
}) => {
  const fixture = await readAdvertisingFixture()
  const fixtureDomain = 'd3-advertising.net'
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
