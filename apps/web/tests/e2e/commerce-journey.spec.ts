import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test'

import {
  CommerceJourneyFixture,
  commerceFixturePhone,
  commerceFixturePrefix,
} from './commerce-journey-fixture'

const origin = 'http://127.0.0.1:3100'
const fixture = new CommerceJourneyFixture()
const captchaVerifyParam = 'wanmi-captcha-fixture-pass'

type Session = {
  cookie: string
  customer: Awaited<ReturnType<CommerceJourneyFixture['customerByPhone']>>
}

type Quote = {
  domainAscii: string
  expiresAt: string
  operation?: 'registration' | 'renewal'
  quoteRef: string
  userPriceMinor: number
}

type PublicOrder = {
  amountMinor: number
  domainAscii: string
  orderNumber: string
  status: string
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]!
}

async function addCustomerCookie(context: BrowserContext, cookie: string): Promise<void> {
  const separator = cookie.indexOf('=')
  await context.addCookies([
    {
      name: cookie.slice(0, separator),
      url: origin,
      value: cookie.slice(separator + 1),
    },
  ])
}

async function login(request: APIRequestContext, index: number): Promise<Session> {
  const phone = commerceFixturePhone(index)
  const deviceId = `${commerceFixturePrefix}-device-${index}`
  const requested = await request.post('/api/v1/auth/sms/request', {
    data: { captchaVerifyParam, deviceId, phone },
    headers: {
      'x-forwarded-for': `192.0.2.${40 + index}`,
      'x-request-id': `${commerceFixturePrefix}-otp-request-${index}`,
    },
  })
  expect(requested.status()).toBe(202)
  const challenge = (await requested.json()) as { challengeId: string; message: string }
  expect(challenge).toMatchObject({
    challengeId: expect.any(String),
    message: '如果手机号可用，验证码将很快送达',
  })
  expect(JSON.stringify(challenge)).not.toContain(phone)

  let authenticated = await request.post('/api/v1/auth/sms/verify', {
    data: { challengeId: challenge.challengeId, code: '246810', deviceId },
    headers: {
      'x-forwarded-for': `192.0.2.${40 + index}`,
      'x-request-id': `${commerceFixturePrefix}-otp-verify-${index}`,
    },
  })
  expect(authenticated.status()).toBe(200)
  const verificationBody = await authenticated.json()
  if (verificationBody.kind === 'registration_required') {
    authenticated = await request.post('/api/v1/auth/register', {
      data: {
        acceptedDeviceIdentifierNotice: true,
        acceptedPrivacyPolicy: true,
        acceptedServiceTerms: true,
        confirmsAdultOrAuthorizedRepresentative: true,
        defaultCustomerProfileType: 'individual',
        deviceId,
        registrationToken: verificationBody.registrationToken,
      },
      headers: {
        'x-forwarded-for': `192.0.2.${40 + index}`,
        'x-request-id': `${commerceFixturePrefix}-register-${index}`,
      },
    })
  }
  expect(authenticated.status()).toBe(200)
  const body = (await authenticated.json()) as { customer: { phoneMasked: string } }
  expect(body.customer.phoneMasked).toMatch(/\*{4}/u)
  expect(JSON.stringify(body)).not.toContain(phone)
  const cookie = cookiePair(authenticated.headers()['set-cookie'])
  expect(cookie).toContain('wanmi_customer_session=')
  return { cookie, customer: await fixture.customerByPhone(phone) }
}

async function quote(
  request: APIRequestContext,
  session: Session,
  suffix: string,
  input:
    | { domain: string; operation?: 'registration'; years: number }
    | { assetId: number; operation: 'renewal'; years: number },
): Promise<Quote> {
  const response = await request.post('/api/v1/quotes', {
    data: input,
    headers: {
      cookie: session.cookie,
      'x-request-id': `${commerceFixturePrefix}-quote-${suffix}`,
    },
  })
  const body = await response.json()
  expect(response.status(), JSON.stringify(body)).toBe(200)
  expect(body).toMatchObject({ data: { quote: expect.any(Object) }, state: 'ready' })
  expect(body.data.quote).not.toHaveProperty('upstreamCostMinor')
  expect(body.data.quote).not.toHaveProperty('ruleKey')
  return body.data.quote as Quote
}

async function order(
  request: APIRequestContext,
  session: Session,
  suffix: string,
  input: { quoteRef: string; realnameTemplateId?: number },
): Promise<PublicOrder> {
  const response = await request.post('/api/v1/orders', {
    data: input,
    headers: {
      cookie: session.cookie,
      'x-request-id': `${commerceFixturePrefix}-order-${suffix}`,
    },
  })
  const body = await response.json()
  expect(response.status(), JSON.stringify(body)).toBe(201)
  expect(body).toMatchObject({
    data: { orderNumber: expect.any(String), status: 'pending_payment' },
    state: 'ready',
  })
  const publicOrder = body.data as PublicOrder
  await fixture.trackOrder(publicOrder.orderNumber)
  return publicOrder
}

async function startPayment(
  request: APIRequestContext,
  session: Session,
  publicOrder: PublicOrder,
  suffix: string,
): Promise<void> {
  const response = await request.post(`/api/v1/orders/${publicOrder.orderNumber}/payments`, {
    data: { channel: 'native' },
    headers: {
      cookie: session.cookie,
      'x-request-id': `${commerceFixturePrefix}-payment-${suffix}`,
    },
  })
  const body = await response.json()
  expect(response.status(), JSON.stringify(body)).toBe(201)
  expect(body).toMatchObject({
    data: {
      channel: 'native',
      codeUrl: expect.stringMatching(/^weixin:\/\//u),
      merchantOrderNumber: expect.any(String),
    },
    state: 'ready',
  })
}

async function nameserverStepUp(
  request: APIRequestContext,
  session: Session,
  suffix: string,
): Promise<{ deviceId: string; stepUpToken: string }> {
  const deviceId = `${commerceFixturePrefix}-${suffix}-device`
  const headers = {
    cookie: session.cookie,
    'x-forwarded-for': '192.0.2.49',
    'x-request-id': `${commerceFixturePrefix}-${suffix}`,
  }
  const requested = await request.post('/api/v1/auth/step-up/request', {
    data: { captchaVerifyParam, deviceId, purpose: 'nameserver_change' },
    headers,
  })
  expect(requested.status()).toBe(202)
  const challenge = (await requested.json()) as { challengeId: string }
  const verified = await request.post('/api/v1/auth/step-up/verify', {
    data: {
      challengeId: challenge.challengeId,
      code: '246810',
      deviceId,
      purpose: 'nameserver_change',
    },
    headers,
  })
  expect(verified.status()).toBe(200)
  const grant = (await verified.json()) as { stepUpToken: string }
  return { deviceId, stepUpToken: grant.stepUpToken }
}

test.describe.serial('D7 M01-M16 customer commerce journey', () => {
  let owner: Session
  let ownerTemplateId: number
  let mainAssetId: number

  test.beforeAll(async () => {
    await fixture.initialize()
  })

  test.afterAll(async () => {
    await fixture.cleanup()
  })

  test('runs the public-query to reminder mainline with matching UI and server state', async ({
    context,
    page,
    request,
  }) => {
    const domainAscii = fixture.domain('mainline')

    await page.goto('/')
    await expect(
      page.getByRole('heading', { level: 1, name: /一个搜索框，看清\s*域名状态与价格/u }),
    ).toBeVisible()
    const publicQuery = await request.post('/api/v1/tools/domain-search', {
      data: { query: 'partial' },
      headers: { 'x-request-id': `${commerceFixturePrefix}-public-query` },
    })
    const publicQueryBody = await publicQuery.json()
    expect(publicQuery.status(), JSON.stringify(publicQueryBody)).toBe(200)
    expect(publicQueryBody).toMatchObject({
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({ domainAscii: 'partial.com', status: 'available' }),
          expect.objectContaining({ domainAscii: 'partial.xyz', status: 'query_failed' }),
        ]),
      },
      state: 'partial',
    })
    expect(publicQueryBody.data.items).toHaveLength(10)
    await page.goto('/tools/domain-search?q=partial')
    await expect(page.getByRole('heading', { level: 2, name: '可注册查询结果' })).toBeVisible()
    await expect(
      page
        .locator('[data-domain-status="available"]')
        .filter({ has: page.getByText('partial.com', { exact: true }) }),
    ).toBeVisible()
    await expect(
      page
        .locator('[data-domain-status="query_failed"]')
        .filter({ has: page.getByText('partial.xyz', { exact: true }) }),
    ).toBeVisible()
    await expect(page.locator('[data-domain-status]')).toHaveCount(10)

    owner = await login(request, 8)
    await addCustomerCookie(context, owner.cookie)
    const template = await fixture.createApprovedTemplate(owner.customer, 'mainline')
    ownerTemplateId = Number(template.id)
    const visibleTemplate = await fixture.customerVisibleTemplate(owner.customer, ownerTemplateId)
    expect(visibleTemplate.docs).toHaveLength(1)
    expect(visibleTemplate.docs[0]).toMatchObject({
      providerReviewState: 'approved',
      status: 'approved',
    })

    const registrationQuote = await quote(request, owner, 'mainline', {
      domain: domainAscii,
      years: 1,
    })
    expect(Date.parse(registrationQuote.expiresAt) - Date.now()).toBeGreaterThan(240_000)
    const registrationOrder = await order(request, owner, 'mainline', {
      quoteRef: registrationQuote.quoteRef,
      realnameTemplateId: ownerTemplateId,
    })
    const storedPending = await fixture.trackOrder(registrationOrder.orderNumber)
    expect(storedPending).toMatchObject({
      amountMinor: registrationOrder.amountMinor,
      domainAscii,
      status: 'pending_payment',
    })
    await startPayment(request, owner, registrationOrder, 'mainline')

    await page.goto(`/account/orders/${registrationOrder.orderNumber}/payment`)
    await expect(page.locator('main [data-registrar-disclosure]')).toContainText(
      '实际域名注册服务机构为西部数码',
    )
    await expect(page.getByText('等待支付确认')).toBeVisible()
    await expect(page.getByText(/扫码动作本身不会被视为支付成功/u)).toBeVisible()
    await expect(
      fixture.fulfill(storedPending.id, { registerMode: 'ready' }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FULFILLABLE' })
    expect((await fixture.readOrder(storedPending.id)).status).toBe('pending_payment')
    expect(
      (await request.get('/api/v1/domains', { headers: { cookie: owner.cookie } })).status(),
    ).toBe(200)

    const paid = await fixture.confirmPayment(storedPending.id, 'mainline')
    expect(paid.status).toBe('paid')
    await page.reload()
    await expect(page.getByText('支付已确认')).toBeVisible()

    const fulfilled = await fixture.fulfill(storedPending.id)
    expect(fulfilled.result).toMatchObject({ status: 'succeeded' })
    expect((await fixture.readOrder(storedPending.id)).status).toBe('succeeded')
    const asset = await fixture.assetByDomain(domainAscii)
    mainAssetId = Number(asset.id)

    const listed = await request.get('/api/v1/domains', { headers: { cookie: owner.cookie } })
    const listedBody = await listed.json()
    expect(listed.status(), JSON.stringify(listedBody)).toBe(200)
    expect(listedBody).toMatchObject({
      data: { items: [expect.objectContaining({ domainAscii, status: 'active' })] },
      state: 'ready',
    })
    await page.goto('/account/domains')
    await expect(page.getByText(domainAscii)).toBeVisible()
    await expect(page.getByText('正常')).toBeVisible()

    await page.goto(`/account/domains/${mainAssetId}`)
    await expect(page.locator('main [data-registrar-disclosure]')).toContainText(
      '实际域名注册服务机构为西部数码',
    )
    await expect(page.getByLabel('当前 Name Server')).toHaveValue(
      ['ns1.myhostadmin.net', 'ns2.myhostadmin.net'].join('\n'),
    )
    await expect(page.getByLabel('当前 Name Server')).toBeDisabled()
    await expect(page.getByRole('button', { name: '提交变更' })).toBeDisabled()
    await expect(
      page.getByText('Name Server 变更正在升级为需要二次验证的流程，暂不可用。'),
    ).toBeVisible()

    const renewalQuote = await quote(request, owner, 'renewal', {
      assetId: mainAssetId,
      operation: 'renewal',
      years: 1,
    })
    expect(renewalQuote).toMatchObject({ domainAscii, operation: 'renewal' })
    const renewalOrder = await order(request, owner, 'renewal', {
      quoteRef: renewalQuote.quoteRef,
    })
    await startPayment(request, owner, renewalOrder, 'renewal')
    const storedRenewal = await fixture.trackOrder(renewalOrder.orderNumber)
    expect((await fixture.confirmPayment(storedRenewal.id, 'renewal')).status).toBe('paid')
    const currentAsset = await fixture.assetByDomain(domainAscii)
    const renewedExpiresAt = new Date(
      Date.parse(String(currentAsset.expiresAt)) + 366 * 86_400_000,
    ).toISOString()
    const renewalResult = await fixture.fulfill(storedRenewal.id, {
      asset: {
        domainAscii,
        expiresAt: String(currentAsset.expiresAt),
        nameservers: [...(currentAsset.nameservers ?? [])],
        providerAssetId: `${commerceFixturePrefix}-asset-${mainAssetId}`,
        registeredAt: String(currentAsset.registeredAt),
        registrarCode: String(currentAsset.registrar),
        status: 'active',
      },
      renewedExpiresAt,
      renewMode: 'ready',
    })
    expect(renewalResult.result).toMatchObject({ status: 'succeeded' })
    expect((await fixture.readOrder(storedRenewal.id)).status).toBe('succeeded')
    expect((await fixture.assetByDomain(domainAscii)).expiresAt).toBe(renewedExpiresAt)

    const reminderSummary = await fixture.runExpiryReminder(mainAssetId, renewedExpiresAt)
    expect(reminderSummary).toMatchObject({ delivered: 1, failed: 0, scanned: 1 })
    const reminders = await fixture.remindersForAsset(mainAssetId)
    expect(reminders.docs).toHaveLength(2)
    expect(reminders.docs.map((item) => `${item.channel}:${item.status}`).sort()).toEqual([
      'in_app:delivered',
      'sms:delivered',
    ])
    await page.reload()
    await expect(page.getByText(/短信 · 提前 30 天 · delivered/u)).toBeVisible()
    await expect(page.getByText(/站内 · 提前 30 天 · delivered/u)).toBeVisible()
  })

  test('fails closed for expired quotes, explicit registration failure and unknown status', async ({
    context,
    page,
    request,
  }) => {
    await addCustomerCookie(context, owner.cookie)
    const expired = await quote(request, owner, 'expired', {
      domain: fixture.domain('expired'),
      years: 1,
    })
    await fixture.expireQuote(expired.quoteRef)
    const expiredOrder = await request.post('/api/v1/orders', {
      data: { quoteRef: expired.quoteRef, realnameTemplateId: ownerTemplateId },
      headers: {
        cookie: owner.cookie,
        'x-request-id': `${commerceFixturePrefix}-expired-order`,
      },
    })
    const expiredBody = await expiredOrder.json()
    expect(expiredOrder.status()).toBe(409)
    expect(expiredBody).toMatchObject({ code: 'QUOTE_EXPIRED' })
    expect(JSON.stringify(expiredBody)).not.toContain(expired.domainAscii)

    const failedQuote = await quote(request, owner, 'register-failed', {
      domain: fixture.domain('registerfailed'),
      years: 1,
    })
    const failedOrder = await order(request, owner, 'register-failed', {
      quoteRef: failedQuote.quoteRef,
      realnameTemplateId: ownerTemplateId,
    })
    await startPayment(request, owner, failedOrder, 'register-failed')
    const failedStored = await fixture.trackOrder(failedOrder.orderNumber)
    await fixture.confirmPayment(failedStored.id, 'register-failed')
    const failedFulfillment = await fixture.fulfill(failedStored.id, { registerMode: 'failed' })
    expect(failedFulfillment.result).toMatchObject({ status: 'refund_pending' })
    expect((await fixture.readOrder(failedStored.id)).status).toBe('refund_pending')
    const refunds = await fixture.refundsForOrder(failedStored.id)
    expect(refunds.docs).toHaveLength(1)
    expect(refunds.docs[0]).toMatchObject({
      amountMinor: failedOrder.amountMinor,
      currency: 'CNY',
      status: 'pending',
    })
    expect(await fixture.completeRefund(failedStored.id, 'register-failed')).toMatchObject({
      status: 'refunded',
    })
    expect((await fixture.readOrder(failedStored.id)).status).toBe('refunded')
    expect((await fixture.refundsForOrder(failedStored.id)).docs[0]).toMatchObject({
      amountMinor: failedOrder.amountMinor,
      status: 'succeeded',
    })
    await page.goto(`/account/orders/${failedOrder.orderNumber}/payment`)
    await expect(page.getByText('已退款')).toBeVisible()

    const unknownQuote = await quote(request, owner, 'register-unknown', {
      domain: fixture.domain('registerunknown'),
      years: 1,
    })
    const unknownOrder = await order(request, owner, 'register-unknown', {
      quoteRef: unknownQuote.quoteRef,
      realnameTemplateId: ownerTemplateId,
    })
    await startPayment(request, owner, unknownOrder, 'register-unknown')
    const unknownStored = await fixture.trackOrder(unknownOrder.orderNumber)
    await fixture.confirmPayment(unknownStored.id, 'register-unknown')
    const unknownFulfillment = await fixture.fulfill(unknownStored.id, {
      registerMode: 'unknown',
    })
    expect(unknownFulfillment.result).toMatchObject({ status: 'manual_review' })
    expect((await fixture.readOrder(unknownStored.id)).status).toBe('manual_review')
    expect((await fixture.openReviewsForOrder(unknownStored.id)).docs).toHaveLength(1)
    await page.goto(`/account/orders/${unknownOrder.orderNumber}/payment`)
    await expect(page.getByText('人工复核中')).toBeVisible()
  })

  test('keeps cross-customer data hidden and preserves a paid order during sales stop', async ({
    context,
    page,
    request,
  }) => {
    await addCustomerCookie(context, owner.cookie)
    const other = await login(request, 9)
    const otherTemplate = await fixture.createApprovedTemplate(other.customer, 'other-customer')

    const hiddenDetail = await request.get(`/api/v1/domains/${mainAssetId}`, {
      headers: { cookie: other.cookie },
    })
    expect(hiddenDetail.status()).toBe(404)
    expect(await hiddenDetail.json()).toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND' })
    const otherNameserverGrant = await nameserverStepUp(request, other, 'cross-customer-step-up')
    const hiddenNameserver = await request.post(`/api/v1/domains/${mainAssetId}/nameservers`, {
      data: {
        confirmed: true,
        deviceId: otherNameserverGrant.deviceId,
        nameservers: ['ns1.attacker.example', 'ns2.attacker.example'],
        stepUpToken: otherNameserverGrant.stepUpToken,
      },
      headers: { cookie: other.cookie, 'x-forwarded-for': '192.0.2.49' },
    })
    expect(hiddenNameserver.status()).toBe(404)
    expect(await hiddenNameserver.json()).toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND' })

    const ownerOnlyQuote = await quote(request, owner, 'cross-quote', {
      domain: fixture.domain('crossquote'),
      years: 1,
    })
    const stolenQuote = await request.post('/api/v1/orders', {
      data: { quoteRef: ownerOnlyQuote.quoteRef, realnameTemplateId: Number(otherTemplate.id) },
      headers: { cookie: other.cookie },
    })
    expect(stolenQuote.status()).toBe(404)
    const stolenQuoteBody = await stolenQuote.json()
    expect(stolenQuoteBody.code).toMatch(/QUOTE_(?:NOT_FOUND|NOT_OWNED)/u)

    const foreignTemplate = await request.post('/api/v1/orders', {
      data: { quoteRef: ownerOnlyQuote.quoteRef, realnameTemplateId: Number(otherTemplate.id) },
      headers: { cookie: owner.cookie },
    })
    expect(foreignTemplate.status()).toBe(409)
    expect(await foreignTemplate.json()).toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_USABLE' })

    const stoppedQuote = await quote(request, owner, 'sales-stop', {
      domain: fixture.domain('salesstop'),
      years: 1,
    })
    const stoppedOrder = await order(request, owner, 'sales-stop', {
      quoteRef: stoppedQuote.quoteRef,
      realnameTemplateId: ownerTemplateId,
    })
    await startPayment(request, owner, stoppedOrder, 'sales-stop')
    const stoppedStored = await fixture.trackOrder(stoppedOrder.orderNumber)
    await fixture.confirmPayment(stoppedStored.id, 'sales-stop')
    await fixture.stopComSales()
    const held = await fixture.fulfill(stoppedStored.id)
    expect(held.result).toEqual({ idempotentReplay: true, status: 'paid' })
    expect((await fixture.readOrder(stoppedStored.id)).status).toBe('paid')
    const reviews = await fixture.openReviewsForOrder(stoppedStored.id)
    expect(reviews.docs).toHaveLength(1)
    expect(reviews.docs[0]).toMatchObject({
      reasonCode: 'registration.sales_stopped',
      status: 'open',
    })
    await page.goto(`/account/orders/${stoppedOrder.orderNumber}/payment`)
    await expect(page.getByText('支付已确认')).toBeVisible()

    const otherPayment = await request.get(`/api/v1/orders/${stoppedOrder.orderNumber}/payments`, {
      headers: { cookie: other.cookie },
    })
    expect(otherPayment.status()).toBe(404)
    const otherPaymentBody = await otherPayment.json()
    expect(otherPaymentBody).toMatchObject({
      problem: { code: 'ORDER_NOT_FOUND' },
      state: 'error',
    })
  })
})
