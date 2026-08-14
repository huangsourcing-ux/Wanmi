import { randomBytes, randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import type { Customer } from '@/payload-types'
import { CAPTCHA_FIXTURE_TOKEN, type CaptchaProvider } from '@/providers/aliyuncaptcha'
import type { WechatOfficialProvider } from '@/providers/wechatofficial'
import {
  authenticateVerifiedPhone,
  bindVerifiedIdentity,
  changeDefaultCustomerProfileType,
  createRegistrationIntent,
  identityProviderInstance,
  protectedIdentifier,
  registerCustomer,
  unbindCustomerIdentity,
} from '@/services/auth/customer-identities'
import { clientHashes, maskPhone } from '@/services/auth/client-facts'
import { registrationConsentDocument } from '@/services/auth/registration-consents'
import { requestOtp, verifyOtp } from '@/services/auth/otp'
import {
  completeWechatOAuth,
  confirmWechatQr,
  consumeWechatQr,
  createWechatQrScene,
  handleWechatQrEvent,
  pollWechatQr,
  startWechatOAuth,
} from '@/services/auth/wechat'

let payload: Payload

function phone(): string {
  return `+86199${randomInt(10_000_000, 100_000_000)}`
}

function headers(suffix = randomUUID()): Headers {
  return new Headers({
    'user-agent': `Wanmi-D9A-Test/${suffix} Chrome`,
    'x-forwarded-for': `192.0.2.${randomInt(1, 250)}`,
    'x-request-id': `d9a-${suffix}`,
  })
}

async function request(requestHeaders: Headers, user?: Customer): Promise<PayloadRequest> {
  const req = await createLocalReq({ req: { headers: requestHeaders } }, payload)
  if (user) req.user = { ...user, collection: 'customers' }
  return req
}

async function phoneIntent(input: { deviceId: string; phone: string; requestHeaders: Headers }) {
  const hashes = clientHashes(input.requestHeaders, input.deviceId)
  return createRegistrationIntent(await request(input.requestHeaders), {
    ...hashes,
    identifier: input.phone,
    phoneMasked: maskPhone(input.phone),
    provider: 'phone',
    source: 'phone',
  })
}

function registrationInput(input: {
  deviceId: string
  invitationCode?: string
  phoneRegistrationToken?: string
  registrationToken: string
}) {
  return {
    acceptedPrivacyPolicy: true as const,
    acceptedServiceTerms: true as const,
    confirmsAdultOrAuthorizedRepresentative: true as const,
    defaultCustomerProfileType: 'individual' as const,
    deviceId: input.deviceId,
    invitationCode: input.invitationCode,
    phoneRegistrationToken: input.phoneRegistrationToken,
    registrationToken: input.registrationToken,
  }
}

function wechatProvider(
  input: {
    confirmationUrl?: (value: string) => void
    rejectConfirmation?: boolean
  } = {},
): WechatOfficialProvider {
  return {
    createTemporaryQr: vi.fn(async ({ expiresSeconds, scene, traceId }) => ({
      expiresSeconds,
      requestId: `qr-${traceId}`,
      ticket: hmac(scene, getEnv().SESSION_PEPPER),
      url: 'https://fixture.invalid/wanmi-qrcode',
    })),
    exchangeOAuthCode: vi.fn(async ({ code, traceId }) => ({
      openid: hmac(code, getEnv().SESSION_PEPPER),
      requestId: `oauth-${traceId}`,
    })),
    sendLoginConfirmation: vi.fn(async ({ confirmationUrl, traceId }) => {
      if (input.rejectConfirmation) throw new Error('fixture confirmation rejected')
      input.confirmationUrl?.(confirmationUrl)
      return { requestId: `confirmation-${traceId}` }
    }),
    sendSecurityNotice: vi.fn(async ({ traceId }) => ({ requestId: `security-${traceId}` })),
  }
}

async function customerById(id: number): Promise<Customer> {
  return payload.findByID({ collection: 'customers', depth: 0, id, overrideAccess: true })
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9-A-1 explicit registration and identity invariants', () => {
  it('does not create an account at OTP verification and records two real registration consents', async () => {
    const registrationPhone = phone()
    const invitationCode = randomBytes(6).toString('hex').toUpperCase()
    const inviterPhone = phone()
    const inviter = await payload.create({
      collection: 'customers',
      data: {
        inviteCode: invitationCode,
        phone: inviterPhone,
        phoneMasked: maskPhone(inviterPhone),
        status: 'active',
      },
      overrideAccess: true,
    })
    const deviceId = `d9a-device-${randomUUID()}`
    const requestHeaders = headers()
    const before = await payload.count({
      collection: 'customers',
      overrideAccess: true,
      where: { phone: { equals: registrationPhone } },
    })
    const challenge = await requestOtp(
      payload,
      { captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN, deviceId, phone: registrationPhone },
      requestHeaders,
      `d9a-otp-${randomUUID()}`,
    )
    const verified = await verifyOtp(
      await request(requestHeaders),
      { challengeId: challenge.challengeId, code: getEnv().MOCK_SMS_OTP_CODE, deviceId },
      requestHeaders,
    )
    expect(verified.kind).toBe('registration_required')
    expect(
      await payload.count({
        collection: 'customers',
        overrideAccess: true,
        where: { phone: { equals: registrationPhone } },
      }),
    ).toEqual(before)
    if (verified.kind !== 'registration_required') throw new Error('registration token missing')

    const registered = await registerCustomer(
      await request(requestHeaders),
      registrationInput({
        deviceId,
        invitationCode,
        registrationToken: verified.registrationToken,
      }),
      requestHeaders,
      null,
    )
    const customer = await customerById(registered.customer.id)
    expect(customer).toMatchObject({
      accountType: 'registered',
      defaultCustomerProfileType: 'individual',
      invitedByCustomer: inviter.id,
      phone: registrationPhone,
      registrationSource: 'phone',
    })
    const identities = await payload.find({
      collection: 'customerIdentities',
      depth: 0,
      overrideAccess: true,
      where: { customer: { equals: customer.id } },
    })
    expect(identities.docs).toHaveLength(1)
    expect(identities.docs[0]).toMatchObject({
      identifierHash: hmac(registrationPhone, getEnv().SESSION_PEPPER),
      provider: 'phone',
      providerInstanceId: getEnv().CUSTOMER_PHONE_IDENTITY_INSTANCE_ID,
      status: 'active',
    })
    expect(identities.docs[0]!.identifierEncrypted).not.toContain(registrationPhone)
    expect(identities.docs[0]!.identifierHash).not.toBe(registrationPhone)

    const consents = await payload.find({
      collection: 'consentRecords',
      overrideAccess: true,
      sort: 'consentType',
      where: { customer: { equals: customer.id } },
    })
    expect(consents.docs).toHaveLength(2)
    expect(consents.docs.map((record) => record.consentType).sort()).toEqual([
      'privacy_policy',
      'service_terms',
    ])
    for (const record of consents.docs) {
      const expected = registrationConsentDocument(record.consentType as never)
      expect(record).toMatchObject({
        ...expected,
        ipMasked: '192.0.2.0/24',
        source: 'phone_registration',
      })
    }
    const registrationEvent = await payload.find({
      collection: 'customerSecurityEvents',
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: customer.id } },
          { event: { equals: 'registration_completed' } },
        ],
      },
    })
    expect(registrationEvent.docs[0]?.safeMetadata).toMatchObject({
      eligibilityDeclaration: 'adult_or_authorized_representative',
    })
  })

  it('resolves concurrent registration for one phone to one account without leaking a unique error', async () => {
    const sharedPhone = phone()
    const first = {
      deviceId: `d9a-phone-a-${randomUUID()}`,
      requestHeaders: headers(),
    }
    const second = {
      deviceId: `d9a-phone-b-${randomUUID()}`,
      requestHeaders: headers(),
    }
    const [firstIntent, secondIntent] = await Promise.all([
      phoneIntent({ ...first, phone: sharedPhone }),
      phoneIntent({ ...second, phone: sharedPhone }),
    ])
    const results = await Promise.all([
      registerCustomer(
        await request(first.requestHeaders),
        registrationInput({
          deviceId: first.deviceId,
          registrationToken: firstIntent.registrationToken,
        }),
        first.requestHeaders,
        null,
      ),
      registerCustomer(
        await request(second.requestHeaders),
        registrationInput({
          deviceId: second.deviceId,
          registrationToken: secondIntent.registrationToken,
        }),
        second.requestHeaders,
        null,
      ),
    ])

    expect(new Set(results.map((result) => result.customer.id)).size).toBe(1)
    expect(
      await payload.count({
        collection: 'customers',
        overrideAccess: true,
        where: { phone: { equals: sharedPhone } },
      }),
    ).toEqual({ totalDocs: 1 })
    expect(
      await payload.count({
        collection: 'customerIdentities',
        overrideAccess: true,
        where: {
          and: [
            { provider: { equals: 'phone' } },
            { identifierHash: { equals: hmac(sharedPhone, getEnv().SESSION_PEPPER) } },
          ],
        },
      }),
    ).toEqual({ totalDocs: 1 })
  })

  it('resolves concurrent registration for one Wechat identity to one account', async () => {
    const openid = randomBytes(24).toString('base64url')
    const flows = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')]
    const devices = [`d9a-wechat-a-${randomUUID()}`, `d9a-wechat-b-${randomUUID()}`]
    const requestHeaders = [headers(), headers()]
    const phones = [phone(), phone()]
    const phoneIntents = await Promise.all(
      phones.map((value, index) =>
        phoneIntent({
          deviceId: devices[index]!,
          phone: value,
          requestHeaders: requestHeaders[index]!,
        }),
      ),
    )
    const primaryIntents = await Promise.all(
      flows.map(async (flowToken, index) =>
        createRegistrationIntent(await request(requestHeaders[index]!), {
          deviceHash: hmac(flowToken, getEnv().SESSION_PEPPER),
          identifier: openid,
          ipHash: clientHashes(requestHeaders[index]!, devices[index]!).ipHash,
          provider: 'wechat',
          source: 'wechat_qrcode',
        }),
      ),
    )

    const results = await Promise.all(
      primaryIntents.map(async (primary, index) =>
        registerCustomer(
          await request(requestHeaders[index]!),
          registrationInput({
            deviceId: devices[index]!,
            phoneRegistrationToken: phoneIntents[index]!.registrationToken,
            registrationToken: primary.registrationToken,
          }),
          requestHeaders[index]!,
          flows[index]!,
        ),
      ),
    )
    expect(new Set(results.map((result) => result.customer.id)).size).toBe(1)
    expect(
      await payload.count({
        collection: 'customerIdentities',
        overrideAccess: true,
        where: {
          and: [
            { provider: { equals: 'wechat' } },
            { identifierHash: { equals: hmac(openid, getEnv().SESSION_PEPPER) } },
          ],
        },
      }),
    ).toEqual({ totalDocs: 1 })
  })

  it('binds OAuth state to the browser and consumes both state and authorization code once', async () => {
    const flowToken = randomBytes(32).toString('base64url')
    const requestHeaders = headers()
    const provider = wechatProvider()
    const started = await startWechatOAuth(await request(requestHeaders), {
      flowToken,
      purpose: 'login',
    })
    const state = new URL(started.authorizationUrl).searchParams.get('state')
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    const code = randomBytes(32).toString('base64url')
    const result = await completeWechatOAuth(
      await request(requestHeaders),
      {
        code,
        flowToken,
        headers: requestHeaders,
        state: state!,
        traceId: `d9a-oauth-${randomUUID()}`,
      },
      { provider },
    )
    expect(result).toMatchObject({ kind: 'registration_required', provider: 'wechat' })
    await expect(
      completeWechatOAuth(
        await request(requestHeaders),
        {
          code: randomBytes(32).toString('base64url'),
          flowToken,
          headers: requestHeaders,
          state: state!,
          traceId: `d9a-oauth-replay-${randomUUID()}`,
        },
        { provider },
      ),
    ).rejects.toMatchObject({ code: 'WECHAT_OAUTH_STATE_INVALID' })

    const second = await startWechatOAuth(await request(requestHeaders), {
      flowToken,
      purpose: 'login',
    })
    await expect(
      completeWechatOAuth(
        await request(requestHeaders),
        {
          code,
          flowToken,
          headers: requestHeaders,
          state: new URL(second.authorizationUrl).searchParams.get('state')!,
          traceId: `d9a-oauth-code-replay-${randomUUID()}`,
        },
        { provider },
      ),
    ).rejects.toMatchObject({ code: 'WECHAT_OAUTH_CODE_REPLAYED' })

    const wrongBrowser = await startWechatOAuth(await request(requestHeaders), {
      flowToken,
      purpose: 'login',
    })
    await expect(
      completeWechatOAuth(
        await request(requestHeaders),
        {
          code: randomBytes(32).toString('base64url'),
          flowToken: randomBytes(32).toString('base64url'),
          headers: requestHeaders,
          state: new URL(wrongBrowser.authorizationUrl).searchParams.get('state')!,
          traceId: `d9a-oauth-browser-${randomUUID()}`,
        },
        { provider },
      ),
    ).rejects.toMatchObject({ code: 'WECHAT_OAUTH_STATE_INVALID' })
  })

  it('requires captcha before SMS or QR creation and keeps polling captcha-free', async () => {
    const rejectCaptcha: CaptchaProvider = {
      verify: vi.fn(async () => ({ code: 'REJECTED', ok: false as const })),
    }
    const rejectedPhone = phone()
    const beforeChallenges = await payload.count({
      collection: 'smsChallenges',
      overrideAccess: true,
      where: { phone: { equals: rejectedPhone } },
    })
    await expect(
      requestOtp(
        payload,
        {
          captchaVerifyParam: 'rejected-by-injected-provider',
          deviceId: `d9a-captcha-${randomUUID()}`,
          phone: rejectedPhone,
        },
        headers(),
        `d9a-captcha-${randomUUID()}`,
        { captchaProvider: rejectCaptcha },
      ),
    ).rejects.toMatchObject({ code: 'CAPTCHA_REJECTED' })
    expect(
      await payload.count({
        collection: 'smsChallenges',
        overrideAccess: true,
        where: { phone: { equals: rejectedPhone } },
      }),
    ).toEqual(beforeChallenges)

    const provider = wechatProvider()
    await expect(
      createWechatQrScene(
        await request(headers()),
        {
          captchaVerifyParam: 'rejected-by-injected-provider',
          deviceId: `d9a-captcha-qr-${randomUUID()}`,
          flowToken: randomBytes(32).toString('base64url'),
          headers: headers(),
          purpose: 'login',
          traceId: `d9a-captcha-qr-${randomUUID()}`,
        },
        { captchaProvider: rejectCaptcha, provider },
      ),
    ).rejects.toMatchObject({ code: 'CAPTCHA_REJECTED' })
    expect(provider.createTemporaryQr).not.toHaveBeenCalled()

    const flowToken = randomBytes(32).toString('base64url')
    const created = await createWechatQrScene(
      await request(headers()),
      {
        captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
        deviceId: `d9a-poll-${randomUUID()}`,
        flowToken,
        headers: headers(),
        purpose: 'login',
        traceId: `d9a-poll-${randomUUID()}`,
      },
      { provider },
    )
    await expect(
      pollWechatQr(await request(headers()), created.scene, flowToken),
    ).resolves.toMatchObject({ status: 'created' })
  })

  it('keeps SCAN at scanned, fails closed on confirmation-message errors, and consumes once', async () => {
    const openid = randomBytes(24).toString('base64url')
    const existingPhone = phone()
    const customer = await payload.create({
      collection: 'customers',
      data: { phone: existingPhone, phoneMasked: maskPhone(existingPhone), status: 'active' },
      overrideAccess: true,
    })
    const protectedOpenid = protectedIdentifier(openid)
    await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedOpenid,
        boundAt: new Date().toISOString(),
        customer: customer.id,
        provider: 'wechat',
        providerInstanceId: identityProviderInstance('wechat'),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const flowToken = randomBytes(32).toString('base64url')
    const requestHeaders = headers()
    let confirmationUrl = ''
    const provider = wechatProvider({ confirmationUrl: (value) => (confirmationUrl = value) })
    const created = await createWechatQrScene(
      await request(requestHeaders),
      {
        captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
        deviceId: `d9a-scan-${randomUUID()}`,
        flowToken,
        headers: requestHeaders,
        purpose: 'login',
        traceId: `d9a-scan-${randomUUID()}`,
      },
      { provider },
    )
    const sessionsBefore = await payload.count({
      collection: 'customerSessions',
      overrideAccess: true,
      where: { customer: { equals: customer.id } },
    })
    await expect(
      handleWechatQrEvent(
        await request(requestHeaders),
        { event: 'SCAN', eventKey: created.scene, fromUserName: openid },
        `d9a-scan-event-${randomUUID()}`,
        { provider },
      ),
    ).resolves.toBe('processed')
    expect(
      await payload.count({
        collection: 'customerSessions',
        overrideAccess: true,
        where: { customer: { equals: customer.id } },
      }),
    ).toEqual(sessionsBefore)
    await expect(
      pollWechatQr(await request(requestHeaders), created.scene, flowToken),
    ).resolves.toMatchObject({ status: 'scanned' })
    const confirmationLink = new URL(confirmationUrl)
    expect(confirmationLink.search).toBe('')
    const confirmationToken = new URLSearchParams(confirmationLink.hash.slice(1)).get('token')
    expect(confirmationToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    await confirmWechatQr(await request(requestHeaders), confirmationToken!)

    const settled = await Promise.allSettled([
      consumeWechatQr(await request(requestHeaders), {
        deviceId: `d9a-consume-a-${randomUUID()}`,
        flowToken,
        headers: requestHeaders,
        scene: created.scene,
        traceId: `d9a-consume-a-${randomUUID()}`,
      }),
      consumeWechatQr(await request(requestHeaders), {
        deviceId: `d9a-consume-b-${randomUUID()}`,
        flowToken,
        headers: requestHeaders,
        scene: created.scene,
        traceId: `d9a-consume-b-${randomUUID()}`,
      }),
    ])
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = settled.find((result) => result.status === 'rejected')
    expect(rejection).toMatchObject({
      reason: expect.objectContaining({ code: 'WECHAT_QR_ALREADY_CONSUMED' }),
      status: 'rejected',
    })

    const rejectedFlow = randomBytes(32).toString('base64url')
    const rejectProvider = wechatProvider({ rejectConfirmation: true })
    const rejectedScene = await createWechatQrScene(
      await request(requestHeaders),
      {
        captchaVerifyParam: CAPTCHA_FIXTURE_TOKEN,
        deviceId: `d9a-reject-${randomUUID()}`,
        flowToken: rejectedFlow,
        headers: requestHeaders,
        purpose: 'login',
        traceId: `d9a-reject-${randomUUID()}`,
      },
      { provider: rejectProvider },
    )
    await handleWechatQrEvent(
      await request(requestHeaders),
      { event: 'SCAN', eventKey: rejectedScene.scene, fromUserName: randomUUID() },
      `d9a-reject-event-${randomUUID()}`,
      { provider: rejectProvider },
    )
    const rejected = await payload.find({
      collection: 'wechatLoginScenes',
      overrideAccess: true,
      where: { sceneHash: { equals: hmac(rejectedScene.scene, getEnv().SESSION_PEPPER) } },
    })
    expect(rejected.docs[0]?.status).toBe('rejected')
  })

  it('atomically refuses the last identity and permits only one concurrent unbind', async () => {
    const customerPhone = phone()
    const customer = await payload.create({
      collection: 'customers',
      data: { phone: customerPhone, phoneMasked: maskPhone(customerPhone), status: 'active' },
      overrideAccess: true,
    })
    const now = new Date().toISOString()
    const phoneIdentity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(customerPhone),
        boundAt: now,
        customer: customer.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        status: 'active',
        verifiedAt: now,
      },
      overrideAccess: true,
    })
    const customerReq = await request(headers(), customer)
    await expect(
      unbindCustomerIdentity(customerReq, customer, phoneIdentity.id, `d9a-last-${randomUUID()}`),
    ).rejects.toMatchObject({ code: 'LAST_LOGIN_IDENTITY_REQUIRED' })

    const wechatIdentity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(randomUUID()),
        boundAt: now,
        customer: customer.id,
        provider: 'wechat',
        providerInstanceId: identityProviderInstance('wechat'),
        status: 'active',
        verifiedAt: now,
      },
      overrideAccess: true,
    })
    const settled = await Promise.allSettled([
      unbindCustomerIdentity(
        await request(headers(), customer),
        customer,
        phoneIdentity.id,
        `d9a-unbind-phone-${randomUUID()}`,
      ),
      unbindCustomerIdentity(
        await request(headers(), customer),
        customer,
        wechatIdentity.id,
        `d9a-unbind-wechat-${randomUUID()}`,
      ),
    ])
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ code: 'LAST_LOGIN_IDENTITY_REQUIRED' }),
    })
    expect(
      await payload.count({
        collection: 'customerIdentities',
        overrideAccess: true,
        where: {
          and: [{ customer: { equals: customer.id } }, { status: { equals: 'active' } }],
        },
      }),
    ).toEqual({ totalDocs: 1 })
  })

  it('fails closed on an identity collision and creates a manual-review record', async () => {
    const firstPhone = phone()
    const secondPhone = phone()
    const [owner, contender] = await Promise.all([
      payload.create({
        collection: 'customers',
        data: { phone: firstPhone, phoneMasked: maskPhone(firstPhone), status: 'active' },
        overrideAccess: true,
      }),
      payload.create({
        collection: 'customers',
        data: { phone: secondPhone, phoneMasked: maskPhone(secondPhone), status: 'active' },
        overrideAccess: true,
      }),
    ])
    const openid = randomUUID()
    const existing = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(openid),
        boundAt: new Date().toISOString(),
        customer: owner.id,
        provider: 'wechat',
        providerInstanceId: identityProviderInstance('wechat'),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const requestHeaders = headers()
    const intent = await createRegistrationIntent(await request(requestHeaders), {
      ...clientHashes(requestHeaders, `d9a-collision-${randomUUID()}`),
      identifier: openid,
      provider: 'wechat',
      source: 'wechat_oauth',
    })
    await expect(
      bindVerifiedIdentity(
        await request(requestHeaders, contender),
        contender,
        intent.registrationToken,
        `d9a-collision-${randomUUID()}`,
      ),
    ).rejects.toMatchObject({ code: 'IDENTITY_COLLISION_REVIEW_REQUIRED' })
    expect(
      await payload.count({
        collection: 'manualReviews',
        overrideAccess: true,
        where: {
          and: [
            { customer: { equals: contender.id } },
            { customerIdentity: { equals: existing.id } },
            { reasonCode: { equals: 'customer_identity_collision' } },
          ],
        },
      }),
    ).toEqual({ totalDocs: 1 })
  })

  it('records the cooldown, revokes sessions, updates the legacy phone column, and notifies old channels on replacement', async () => {
    const oldPhone = phone()
    const nextPhone = phone()
    const customer = await payload.create({
      collection: 'customers',
      data: { phone: oldPhone, phoneMasked: maskPhone(oldPhone), status: 'active' },
      overrideAccess: true,
    })
    const now = new Date().toISOString()
    const oldPhoneIdentity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(oldPhone),
        boundAt: now,
        customer: customer.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        status: 'active',
        verifiedAt: now,
      },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(randomUUID()),
        boundAt: now,
        customer: customer.id,
        provider: 'wechat',
        providerInstanceId: identityProviderInstance('wechat'),
        status: 'active',
        verifiedAt: now,
      },
      overrideAccess: true,
    })
    const loginHeaders = headers()
    await authenticateVerifiedPhone(await request(loginHeaders), {
      ...clientHashes(loginHeaders, `d9a-replacement-login-${randomUUID()}`),
      phone: oldPhone,
    })
    const bindingHeaders = headers()
    const deviceId = `d9a-replacement-${randomUUID()}`
    const intent = await phoneIntent({ deviceId, phone: nextPhone, requestHeaders: bindingHeaders })
    await bindVerifiedIdentity(
      await request(bindingHeaders, customer),
      customer,
      intent.registrationToken,
      `d9a-replacement-${randomUUID()}`,
    )

    const changed = await customerById(customer.id)
    expect(changed).toMatchObject({
      identityRiskCooldownStartedAt: expect.any(String),
      phone: nextPhone,
      phoneMasked: maskPhone(nextPhone),
    })
    expect(
      await payload.findByID({
        collection: 'customerIdentities',
        id: oldPhoneIdentity.id,
        overrideAccess: true,
      }),
    ).toMatchObject({ status: 'unbound', unboundAt: expect.any(String) })
    const activeSessions = await payload.count({
      collection: 'customerSessions',
      overrideAccess: true,
      where: {
        and: [{ customer: { equals: customer.id } }, { revokedAt: { exists: false } }],
      },
    })
    expect(activeSessions.totalDocs).toBe(0)
    const notifications = await payload.count({
      collection: 'customerSecurityEvents',
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: customer.id } },
          { event: { equals: 'identity_change_notification' } },
        ],
      },
    })
    expect(notifications.totalDocs).toBe(2)
  })

  it('keeps customer-scoped reads private and denies generic identity/consent mutations', async () => {
    const ownerPhone = phone()
    const attackerPhone = phone()
    const [owner, attacker] = await Promise.all([
      payload.create({
        collection: 'customers',
        data: { phone: ownerPhone, phoneMasked: maskPhone(ownerPhone), status: 'active' },
        overrideAccess: true,
      }),
      payload.create({
        collection: 'customers',
        data: { phone: attackerPhone, phoneMasked: maskPhone(attackerPhone), status: 'active' },
        overrideAccess: true,
      }),
    ])
    const identity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(ownerPhone),
        boundAt: new Date().toISOString(),
        customer: owner.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const ownerUser = { ...owner, collection: 'customers' as const }
    const attackerUser = { ...attacker, collection: 'customers' as const }
    const ownerView = await payload.find({
      collection: 'customerIdentities',
      overrideAccess: false,
      user: ownerUser,
    })
    expect(ownerView.docs.some((record) => record.id === identity.id)).toBe(true)
    expect(ownerView.docs.find((record) => record.id === identity.id)).not.toHaveProperty(
      'identifierHash',
    )
    expect(
      (
        await payload.find({
          collection: 'customerIdentities',
          overrideAccess: false,
          user: attackerUser,
        })
      ).docs.some((record) => record.id === identity.id),
    ).toBe(false)
    await expect(
      payload.update({
        collection: 'customerIdentities',
        data: { status: 'unbound' },
        id: identity.id,
        overrideAccess: false,
        user: ownerUser,
      }),
    ).rejects.toThrow()
    await expect(
      payload.create({
        collection: 'consentRecords',
        data: {
          acceptedAt: new Date().toISOString(),
          consentType: 'service_terms',
          customer: owner.id,
          documentHash: '0'.repeat(64),
          documentVersion: 'forbidden-generic-write',
          ipMasked: 'unknown',
          source: 'phone_registration',
          userAgentSummary: 'Other/desktop',
        },
        overrideAccess: false,
        user: ownerUser,
      }),
    ).rejects.toThrow()
  })

  it('audits a default customer profile change without using it as a transaction fact', async () => {
    const customerPhone = phone()
    const customer = await payload.create({
      collection: 'customers',
      data: {
        defaultCustomerProfileType: 'individual',
        phone: customerPhone,
        phoneMasked: maskPhone(customerPhone),
        status: 'active',
      },
      overrideAccess: true,
    })
    const requestHeaders = headers()
    await changeDefaultCustomerProfileType(
      await request(requestHeaders, customer),
      customer,
      'organization',
    )
    expect(await customerById(customer.id)).toMatchObject({
      defaultCustomerProfileType: 'organization',
    })
    expect(
      await payload.count({
        collection: 'auditLogs',
        overrideAccess: true,
        where: {
          and: [
            { action: { equals: 'customer.default_profile_type.changed' } },
            { actorId: { equals: String(customer.id) } },
          ],
        },
      }),
    ).toEqual({ totalDocs: 1 })
  })

  it('authenticates an existing phone identity without returning to registration', async () => {
    const existingPhone = phone()
    const customer = await payload.create({
      collection: 'customers',
      data: { phone: existingPhone, phoneMasked: maskPhone(existingPhone), status: 'active' },
      overrideAccess: true,
    })
    const now = new Date().toISOString()
    await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(existingPhone),
        boundAt: now,
        customer: customer.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        status: 'active',
        verifiedAt: now,
      },
      overrideAccess: true,
    })
    const requestHeaders = headers()
    await expect(
      authenticateVerifiedPhone(await request(requestHeaders), {
        ...clientHashes(requestHeaders, `d9a-existing-${randomUUID()}`),
        phone: existingPhone,
      }),
    ).resolves.toMatchObject({ customer: { id: customer.id }, kind: 'authenticated' })
  })
})
