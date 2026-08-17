import { expect, test } from '@playwright/test'

const captchaVerifyParam = 'wanmi-captcha-fixture-pass'

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]!
}

test('customer OTP, all-session logout, deletion, and admin isolation work end to end', async ({
  request,
}) => {
  const phone = `139${String(Date.now()).slice(-8)}`
  const deviceId = `e2e-customer-device-${Date.now()}`

  const anonymousQuote = await request.post('/api/v1/quotes', {
    data: { domain: 'anonymous-quote.com', years: 1 },
  })
  expect(anonymousQuote.status()).toBe(401)
  expect(await anonymousQuote.json()).toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })

  async function login() {
    const requested = await request.post('/api/v1/auth/sms/request', {
      data: { captchaVerifyParam, deviceId, phone },
    })
    expect(requested.status()).toBe(202)
    const requestBody = await requested.json()
    expect(requestBody).toMatchObject({
      accepted: true,
      challengeId: expect.any(String),
      message: '如果手机号可用，验证码将很快送达',
    })
    expect(JSON.stringify(requestBody)).not.toContain(phone)
    expect(JSON.stringify(requestBody)).not.toContain('246810')

    let authenticated = await request.post('/api/v1/auth/sms/verify', {
      data: { challengeId: requestBody.challengeId, code: '246810', deviceId },
    })
    expect(authenticated.status()).toBe(200)
    const verificationBody = await authenticated.json()
    if (verificationBody.kind === 'registration_required') {
      expect(authenticated.headers()['set-cookie']).toBeUndefined()
      authenticated = await request.post('/api/v1/auth/register', {
        data: {
          acceptedPrivacyPolicy: true,
          acceptedServiceTerms: true,
          confirmsAdultOrAuthorizedRepresentative: true,
          defaultCustomerProfileType: 'individual',
          deviceId,
          registrationToken: verificationBody.registrationToken,
        },
      })
      expect(authenticated.status()).toBe(200)
    }
    const verifiedBody = await authenticated.json()
    expect(verifiedBody.customer.phoneMasked).toMatch(/\*{4}/u)
    expect(JSON.stringify(verifiedBody)).not.toContain(phone)
    expect(JSON.stringify(verifiedBody)).not.toContain('246810')
    const setCookie = authenticated.headers()['set-cookie']
    expect(setCookie).toContain('wanmi_customer_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).not.toContain('wanmi_admin')
    return cookiePair(setCookie)
  }

  const firstCookie = await login()
  const quote = await request.post('/api/v1/quotes', {
    data: { domain: `e2e-${Date.now()}.com`, years: 3 },
    headers: { cookie: firstCookie },
  })
  expect(quote.status()).toBe(200)
  expect(quote.headers()['cache-control']).toBe('no-store')
  const quoteBody = await quote.json()
  expect(quoteBody).toMatchObject({
    data: {
      quote: {
        currency: 'CNY',
        domainAscii: expect.stringMatching(/\.com$/u),
        expiresAt: expect.any(String),
        quoteRef: expect.any(String),
        quotedAt: expect.any(String),
        sourcePriceSnapshotRef: expect.any(String),
        userPriceMinor: 9_500,
        years: 3,
      },
    },
    state: 'ready',
  })
  expect(
    Date.parse(quoteBody.data.quote.expiresAt) - Date.parse(quoteBody.data.quote.quotedAt),
  ).toBe(300_000)
  expect(quoteBody.data.quote).not.toHaveProperty('upstreamCostMinor')
  expect(quoteBody.data.quote).not.toHaveProperty('ruleKey')
  expect(quoteBody.data.quote).not.toHaveProperty('providerRequestId')

  const adminAttempt = await request.post('/api/v1/admin/auth/login', {
    data: {
      email: 'customer-cookie@example.test',
      password: 'not-a-valid-administrator-password',
      totp: '000000',
    },
    headers: { cookie: firstCookie },
  })
  expect(adminAttempt.status()).toBe(401)

  const logout = await request.post('/api/v1/auth/logout', {
    data: { scope: 'all' },
    headers: { cookie: firstCookie },
  })
  expect(logout.status()).toBe(200)
  expect(await logout.json()).toEqual({ loggedOut: true, scope: 'all' })
  expect(logout.headers()['set-cookie']).toContain('wanmi_customer_session=;')

  const oldSessionDeletion = await request.post('/api/v1/auth/deletion-request', {
    data: { confirmation: 'DELETE_MY_ACCOUNT' },
    headers: { cookie: firstCookie },
  })
  expect(oldSessionDeletion.status()).toBe(401)

  const secondCookie = await login()
  const adminCookieDeletion = await request.post('/api/v1/auth/deletion-request', {
    data: { confirmation: 'DELETE_MY_ACCOUNT' },
    headers: { cookie: 'wanmi_admin-token=not-a-customer-session' },
  })
  expect(adminCookieDeletion.status()).toBe(401)

  const stepUpRequested = await request.post('/api/v1/auth/step-up/request', {
    data: { captchaVerifyParam, deviceId, purpose: 'account_deletion' },
    headers: { cookie: secondCookie },
  })
  expect(stepUpRequested.status()).toBe(202)
  const stepUpChallenge = await stepUpRequested.json()
  const stepUpVerified = await request.post('/api/v1/auth/step-up/verify', {
    data: {
      challengeId: stepUpChallenge.challengeId,
      code: '246810',
      deviceId,
      purpose: 'account_deletion',
    },
    headers: { cookie: secondCookie },
  })
  expect(stepUpVerified.status()).toBe(200)
  const stepUpGrant = await stepUpVerified.json()
  const deletion = await request.post('/api/v1/auth/deletion-request', {
    data: {
      confirmation: 'DELETE_MY_ACCOUNT',
      deviceId,
      reason: '不再使用此测试账号',
      stepUpToken: stepUpGrant.stepUpToken,
    },
    headers: { cookie: secondCookie },
  })
  expect(deletion.status()).toBe(202)
  expect(await deletion.json()).toMatchObject({
    blockers: [],
    cooldownEndsAt: expect.any(String),
    deletionRequestedAt: expect.any(String),
    requestId: expect.any(String),
    status: 'pending',
  })
  expect(deletion.headers()['set-cookie']).toBeUndefined()

  const postDeletionRequest = await request.post('/api/v1/auth/sms/request', {
    data: { captchaVerifyParam, deviceId, phone },
  })
  expect(postDeletionRequest.status()).toBe(202)
  const postDeletionBody = await postDeletionRequest.json()
  expect(postDeletionBody).toMatchObject({
    accepted: true,
    message: '如果手机号可用，验证码将很快送达',
  })
  expect(JSON.stringify(postDeletionBody)).not.toContain(phone)
})
