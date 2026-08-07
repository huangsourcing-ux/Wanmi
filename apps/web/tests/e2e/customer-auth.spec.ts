import { expect, test } from '@playwright/test'

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]!
}

test('customer OTP, all-session logout, deletion, and admin isolation work end to end', async ({
  request,
}) => {
  const phone = `139${String(Date.now()).slice(-8)}`
  const deviceId = `e2e-customer-device-${Date.now()}`

  async function login() {
    const requested = await request.post('/api/v1/auth/sms/request', {
      data: { deviceId, phone },
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

    const verified = await request.post('/api/v1/auth/sms/verify', {
      data: { challengeId: requestBody.challengeId, code: '246810', deviceId },
    })
    expect(verified.status()).toBe(200)
    const verifiedBody = await verified.json()
    expect(verifiedBody.customer.phoneMasked).toMatch(/\*{4}/u)
    expect(JSON.stringify(verifiedBody)).not.toContain(phone)
    expect(JSON.stringify(verifiedBody)).not.toContain('246810')
    const setCookie = verified.headers()['set-cookie']
    expect(setCookie).toContain('wanmi_customer_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).not.toContain('wanmi_admin')
    return cookiePair(setCookie)
  }

  const firstCookie = await login()
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

  const deletion = await request.post('/api/v1/auth/deletion-request', {
    data: { confirmation: 'DELETE_MY_ACCOUNT' },
    headers: { cookie: secondCookie },
  })
  expect(deletion.status()).toBe(200)
  expect(await deletion.json()).toMatchObject({
    deletionRequestedAt: expect.any(String),
    status: 'deletion_requested',
  })
  expect(deletion.headers()['set-cookie']).toContain('wanmi_customer_session=;')

  const postDeletionRequest = await request.post('/api/v1/auth/sms/request', {
    data: { deviceId, phone },
  })
  expect(postDeletionRequest.status()).toBe(202)
  const postDeletionBody = await postDeletionRequest.json()
  expect(postDeletionBody).toMatchObject({
    accepted: true,
    message: '如果手机号可用，验证码将很快送达',
  })
  expect(JSON.stringify(postDeletionBody)).not.toContain(phone)
})
