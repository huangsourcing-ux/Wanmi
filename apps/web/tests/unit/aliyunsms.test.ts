import { afterEach, describe, expect, it, vi } from 'vitest'

import { getEnv, resetEnvForTests } from '@/lib/env'
import {
  classifySmsFailure,
  classifySmsReceipt,
  createSmsProvider,
  validateAliyunSmsLiveConfiguration,
} from '@/providers/aliyunsms'

describe('Alibaba Cloud SMS adapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    process.env.ALIYUN_SMS_MODE = 'mock'
    process.env.ALLOW_REAL_PROVIDER_WRITES = 'false'
    process.env.CUSTOMER_SESSION_COOKIE = 'wanmi_customer_session'
    resetEnvForTests()
  })

  it.each([
    ['isv.OUT_OF_SERVICE', 'balance_insufficient'],
    ['AMOUNT_NOT_ENOUGH', 'balance_insufficient'],
    ['isv.SMS_TEMPLATE_ILLEGAL', 'template_unapproved'],
    ['isv.SMS_SIGNATURE_ILLEGAL', 'template_unapproved'],
    ['isv.MOBILE_NUMBER_ILLEGAL', 'invalid_number'],
    ['isv.BUSINESS_LIMIT_CONTROL', 'rate_limited'],
    ['unexpected.provider.code', 'unknown'],
  ] as const)('classifies %s as %s', (code, category) => {
    expect(classifySmsFailure(code)).toBe(category)
  })

  it('keeps live SMS writes disabled without calling the provider', async () => {
    vi.stubEnv('ALIYUN_SMS_MODE', 'live')
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_ALIYUN_SMS_SENDS', 'false')
    vi.stubEnv('CI', 'false')
    resetEnvForTests()

    const result = await createSmsProvider().sendOtp({
      code: '123456',
      phone: '+8613900000000',
      traceId: 'unit-live-write-gate',
    })

    expect(result).toMatchObject({
      error: { code: 'PROVIDER_WRITE_DISABLED', statusKnown: true },
      ok: false,
    })
  })

  it('rejects a customer cookie name that collides with the admin cookie', () => {
    process.env.CUSTOMER_SESSION_COOKIE = 'wanmi_admin-token'
    resetEnvForTests()
    expect(() => getEnv()).toThrow(/customer\/admin cookies must be distinct/u)
  })

  it('loads credential, sign, and both template references without sending SMS', () => {
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_ID', 'fixture-access-key')
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'fixture-access-secret')
    vi.stubEnv('ALIBABA_CLOUD_REGION_ID', 'cn-shanghai')
    vi.stubEnv('ALIBABA_CLOUD_SMS_SIGN_NAME', 'fixture-sign')
    vi.stubEnv('ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE', 'SMS_OTP_FIXTURE')
    vi.stubEnv('ALIBABA_CLOUD_SMS_DOMAIN_EXPIRY_TEMPLATE_CODE', 'SMS_EXPIRY_FIXTURE')

    expect(validateAliyunSmsLiveConfiguration()).toEqual({
      credentialsConfigured: true,
      domainExpiryTemplateConfigured: true,
      otpTemplateConfigured: true,
      signConfigured: true,
    })
  })

  it('fails closed when any live SMS template reference is absent', () => {
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_ID', 'fixture-access-key')
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'fixture-access-secret')
    vi.stubEnv('ALIBABA_CLOUD_REGION_ID', 'cn-shanghai')
    vi.stubEnv('ALIBABA_CLOUD_SMS_SIGN_NAME', 'fixture-sign')
    vi.stubEnv('ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE', 'SMS_OTP_FIXTURE')
    vi.stubEnv('ALIBABA_CLOUD_SMS_DOMAIN_EXPIRY_TEMPLATE_CODE', '')

    expect(() => validateAliyunSmsLiveConfiguration()).toThrow(
      /ALIBABA_CLOUD_SMS_DOMAIN_EXPIRY_TEMPLATE_CODE/u,
    )
  })

  it('maps Alibaba Cloud receipt statuses without retaining provider messages', () => {
    expect(classifySmsReceipt(1)).toEqual({ status: 'pending' })
    expect(classifySmsReceipt(3)).toEqual({ status: 'delivered' })
    expect(classifySmsReceipt(2, 'isv.MOBILE_NUMBER_ILLEGAL')).toEqual({
      failureCategory: 'invalid_number',
      providerCode: 'ISV.MOBILE_NUMBER_ILLEGAL',
      status: 'failed',
    })
  })

  it('keeps mock delivery receipts deterministic and free of raw OTP data', async () => {
    const provider = createSmsProvider()
    const sent = await provider.sendOtp({
      code: '123456',
      phone: '+8613900000000',
      traceId: 'unit-mock-sms',
    })
    expect(sent).toMatchObject({
      data: { accepted: true, deliveryStatus: 'delivered' },
      ok: true,
    })
    expect(JSON.stringify(sent)).not.toContain('123456')

    const receipt = await provider.queryReceipt({
      phone: '+8613900000000',
      providerMessageId: 'mock-message',
      sentAt: new Date().toISOString(),
      traceId: 'unit-mock-receipt',
    })
    expect(receipt).toMatchObject({ data: { status: 'delivered' }, ok: true })
  })
})
