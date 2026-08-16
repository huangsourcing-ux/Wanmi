import SmsClient, { QuerySendDetailsRequest, SendSmsRequest } from '@alicloud/dysmsapi20170525'
import { $OpenApiUtil } from '@alicloud/openapi-core'

import type { SmsFailureCategory, SmsProvider } from './types'
import { mockFailure, mockSuccess } from './mock'
import { getEnv } from '@/lib/env'

const BALANCE_CODES = new Set([
  'AMOUNT_NOT_ENOUGH',
  'ISV.OUT_OF_SERVICE',
  'REJECTED_NOT_ENOUGH_CREDITS',
])
const INVALID_NUMBER_CODES = new Set([
  'ISV.MOBILE_NUMBER_ILLEGAL',
  'MOBILE_NUMBER_ILLEGAL',
  'REJECTED_FORBIDDEN_ACTION',
])
const RATE_LIMIT_CODES = new Set([
  'FREQUENCY_LIMIT_DAY',
  'ISV.BUSINESS_LIMIT_CONTROL',
  'ISV.DAY_LIMIT_CONTROL',
  'ISV.MONTH_LIMIT_CONTROL',
  'MOBILE_SEND_LIMIT',
  'QPS_LIMIT_CONTROL',
  'REJECTED_FLOODING_CONTROL',
  'REJECTED_FLOODING_CONTROL_AL',
  'REJECTED_MOBILE_COUNT_OVER_LIMIT',
  'SYSTEM_LIMIT_CONTROL',
])
const TEMPLATE_CODES = new Set([
  'ISV.SMS_SIGNATURE_ILLEGAL',
  'ISV.SMS_TEMPLATE_ILLEGAL',
  'ISV.TEMPLATE_PARAMS_ILLEGAL',
  'SIGN_NAME_ILLEGAL',
  'SMS_SIGNATURE_ILLEGAL',
  'SMS_TEMPLATE_ILLEGAL',
  'TEMPLATE_NOT_EXIST',
])

function normalizedProviderCode(code: unknown): string {
  return typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : 'UNKNOWN'
}

export function classifySmsFailure(code: unknown): SmsFailureCategory {
  const normalized = normalizedProviderCode(code)
  if (BALANCE_CODES.has(normalized)) return 'balance_insufficient'
  if (TEMPLATE_CODES.has(normalized)) return 'template_unapproved'
  if (INVALID_NUMBER_CODES.has(normalized)) return 'invalid_number'
  if (RATE_LIMIT_CODES.has(normalized)) return 'rate_limited'
  return 'unknown'
}

export function classifySmsReceipt(sendStatus: unknown, errorCode?: unknown) {
  if (sendStatus === 3) return { status: 'delivered' as const }
  if (sendStatus !== 2) return { status: 'pending' as const }
  const providerCode = normalizedProviderCode(errorCode)
  return {
    failureCategory: classifySmsFailure(providerCode),
    providerCode,
    status: 'failed' as const,
  }
}

function exceptionCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UNKNOWN'
  const candidate = error as { code?: unknown; data?: { Code?: unknown } }
  return normalizedProviderCode(candidate.code ?? candidate.data?.Code)
}

function providerPhone(phone: string): string {
  return phone.startsWith('+86') ? phone.slice(3) : phone
}

function aliyunSendDate(sentAt: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).formatToParts(new Date(sentAt))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? ''
  return `${part('year')}${part('month')}${part('day')}`
}

class MockSmsProvider implements SmsProvider {
  async health() {
    return mockSuccess({ healthy: true })
  }

  async sendOtp(input: { traceId: string }) {
    return mockSuccess(
      {
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: `mock-sms-${input.traceId}`,
      },
      `mock-request-${input.traceId}`,
    )
  }

  async sendStepUpOtp(input: { traceId: string }) {
    return mockSuccess(
      {
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: `mock-step-up-sms-${input.traceId}`,
      },
      `mock-step-up-request-${input.traceId}`,
    )
  }

  async sendDomainExpiry(input: { traceId: string }) {
    return mockSuccess(
      {
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: `mock-expiry-sms-${input.traceId}`,
      },
      `mock-expiry-request-${input.traceId}`,
    )
  }

  async sendIdentityChanged(input: { traceId: string }) {
    return mockSuccess(
      {
        accepted: true as const,
        deliveryStatus: 'delivered' as const,
        providerMessageId: `mock-security-sms-${input.traceId}`,
      },
      `mock-security-request-${input.traceId}`,
    )
  }

  async queryReceipt() {
    return mockSuccess({ status: 'delivered' as const })
  }
}

class DisabledSmsProvider implements SmsProvider {
  async health() {
    return mockSuccess({ healthy: false })
  }

  async sendOtp() {
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }

  async sendStepUpOtp() {
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }

  async sendDomainExpiry() {
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }

  async sendIdentityChanged() {
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }

  async queryReceipt() {
    return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
  }
}

function liveSmsAllowed(): boolean {
  const env = getEnv()
  return env.ALLOW_REAL_PROVIDER_WRITES && env.ALLOW_REAL_ALIYUN_SMS_SENDS
}

const liveSmsConfigurationKeys = [
  'ALIBABA_CLOUD_ACCESS_KEY_ID',
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  'ALIBABA_CLOUD_REGION_ID',
  'ALIBABA_CLOUD_SMS_SIGN_NAME',
  'ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE',
  'ALIBABA_CLOUD_SMS_STEP_UP_TEMPLATE_CODE',
  'ALIBABA_CLOUD_SMS_DOMAIN_EXPIRY_TEMPLATE_CODE',
  'ALIBABA_CLOUD_SMS_SECURITY_TEMPLATE_CODE',
] as const

export function validateAliyunSmsLiveConfiguration(): {
  credentialsConfigured: true
  domainExpiryTemplateConfigured: true
  otpTemplateConfigured: true
  securityTemplateConfigured: true
  signConfigured: true
  stepUpTemplateConfigured: true
} {
  const missing = liveSmsConfigurationKeys.filter((key) => !process.env[key]?.trim())
  if (missing.length > 0) {
    throw new Error(`Aliyun SMS live configuration is missing: ${missing.join(', ')}`)
  }
  if (
    process.env.ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE?.trim() ===
    process.env.ALIBABA_CLOUD_SMS_STEP_UP_TEMPLATE_CODE?.trim()
  ) {
    throw new Error('Aliyun SMS login OTP and step-up templates must be distinct')
  }
  return {
    credentialsConfigured: true,
    domainExpiryTemplateConfigured: true,
    otpTemplateConfigured: true,
    securityTemplateConfigured: true,
    signConfigured: true,
    stepUpTemplateConfigured: true,
  }
}

class LiveSmsProvider implements SmsProvider {
  private readonly client: SmsClient

  constructor() {
    this.client = new SmsClient(
      new $OpenApiUtil.Config({
        accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
        accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
        connectTimeout: 2_000,
        readTimeout: 3_000,
        regionId: process.env.ALIBABA_CLOUD_REGION_ID,
      }),
    )
  }

  async health() {
    try {
      validateAliyunSmsLiveConfiguration()
      return mockSuccess({ healthy: true })
    } catch {
      return mockSuccess({ healthy: false })
    }
  }

  async sendOtp(input: { code: string; phone: string; traceId: string }) {
    if (!liveSmsAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      const response = await this.client.sendSms(
        new SendSmsRequest({
          outId: input.traceId,
          phoneNumbers: providerPhone(input.phone),
          signName: process.env.ALIBABA_CLOUD_SMS_SIGN_NAME,
          templateCode: process.env.ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE,
          templateParam: JSON.stringify({ code: input.code }),
        }),
      )
      if (response.body?.code !== 'OK') {
        const code = normalizedProviderCode(response.body?.code)
        const category = classifySmsFailure(code)
        return mockFailure(`SMS_${category.toUpperCase()}`, {
          retryable: category === 'rate_limited',
          statusKnown: true,
        })
      }
      if (!response.body.bizId) {
        return mockFailure('SMS_UNKNOWN', { retryable: false, statusKnown: true })
      }
      return mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'accepted' as const,
          providerMessageId: response.body.bizId,
        },
        response.body.requestId,
      )
    } catch (error) {
      const code = exceptionCode(error)
      const category = classifySmsFailure(code)
      return mockFailure(
        category === 'unknown' ? 'SMS_PROVIDER_UNAVAILABLE' : `SMS_${category.toUpperCase()}`,
        { retryable: category === 'rate_limited' || category === 'unknown', statusKnown: false },
      )
    }
  }

  async sendStepUpOtp(input: { code: string; phone: string; traceId: string }) {
    if (!liveSmsAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      const response = await this.client.sendSms(
        new SendSmsRequest({
          outId: input.traceId,
          phoneNumbers: providerPhone(input.phone),
          signName: process.env.ALIBABA_CLOUD_SMS_SIGN_NAME,
          templateCode: process.env.ALIBABA_CLOUD_SMS_STEP_UP_TEMPLATE_CODE,
          templateParam: JSON.stringify({ code: input.code }),
        }),
      )
      if (response.body?.code !== 'OK') {
        const code = normalizedProviderCode(response.body?.code)
        const category = classifySmsFailure(code)
        return mockFailure(`SMS_${category.toUpperCase()}`, {
          retryable: category === 'rate_limited',
          statusKnown: true,
        })
      }
      if (!response.body.bizId) {
        return mockFailure('SMS_UNKNOWN', { retryable: false, statusKnown: true })
      }
      return mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'accepted' as const,
          providerMessageId: response.body.bizId,
        },
        response.body.requestId,
      )
    } catch (error) {
      const code = exceptionCode(error)
      const category = classifySmsFailure(code)
      return mockFailure(
        category === 'unknown' ? 'SMS_PROVIDER_UNAVAILABLE' : `SMS_${category.toUpperCase()}`,
        { retryable: category === 'rate_limited' || category === 'unknown', statusKnown: false },
      )
    }
  }

  async sendDomainExpiry(input: {
    daysRemaining: number
    domainAscii: string
    expiresOn: string
    phone: string
    traceId: string
  }) {
    if (!liveSmsAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      const response = await this.client.sendSms(
        new SendSmsRequest({
          outId: input.traceId,
          phoneNumbers: providerPhone(input.phone),
          signName: process.env.ALIBABA_CLOUD_SMS_SIGN_NAME,
          templateCode: process.env.ALIBABA_CLOUD_SMS_DOMAIN_EXPIRY_TEMPLATE_CODE,
          templateParam: JSON.stringify({
            days: input.daysRemaining,
            domain: input.domainAscii,
            expires: input.expiresOn,
          }),
        }),
      )
      if (response.body?.code !== 'OK') {
        const code = normalizedProviderCode(response.body?.code)
        const category = classifySmsFailure(code)
        return mockFailure(`SMS_${category.toUpperCase()}`, {
          retryable: category === 'rate_limited',
          statusKnown: true,
        })
      }
      if (!response.body.bizId) {
        return mockFailure('SMS_UNKNOWN', { retryable: false, statusKnown: true })
      }
      return mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'accepted' as const,
          providerMessageId: response.body.bizId,
        },
        response.body.requestId,
      )
    } catch (error) {
      const code = exceptionCode(error)
      const category = classifySmsFailure(code)
      return mockFailure(
        category === 'unknown' ? 'SMS_PROVIDER_UNAVAILABLE' : `SMS_${category.toUpperCase()}`,
        { retryable: category === 'rate_limited' || category === 'unknown', statusKnown: false },
      )
    }
  }

  async sendIdentityChanged(input: { phone: string; traceId: string }) {
    if (!liveSmsAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    if (!process.env.ALIBABA_CLOUD_SMS_SECURITY_TEMPLATE_CODE?.trim()) {
      return mockFailure('SMS_TEMPLATE_UNAPPROVED', { statusKnown: true })
    }
    try {
      const response = await this.client.sendSms(
        new SendSmsRequest({
          outId: input.traceId,
          phoneNumbers: providerPhone(input.phone),
          signName: process.env.ALIBABA_CLOUD_SMS_SIGN_NAME,
          templateCode: process.env.ALIBABA_CLOUD_SMS_SECURITY_TEMPLATE_CODE,
        }),
      )
      if (response.body?.code !== 'OK' || !response.body.bizId) {
        const category = classifySmsFailure(response.body?.code)
        return mockFailure(`SMS_${category.toUpperCase()}`, { statusKnown: true })
      }
      return mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'accepted' as const,
          providerMessageId: response.body.bizId,
        },
        response.body.requestId,
      )
    } catch {
      return mockFailure('SMS_PROVIDER_UNAVAILABLE', { retryable: true, statusKnown: false })
    }
  }

  async queryReceipt(input: { phone: string; providerMessageId: string; sentAt: string }) {
    if (!liveSmsAllowed()) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      const response = await this.client.querySendDetails(
        new QuerySendDetailsRequest({
          bizId: input.providerMessageId,
          currentPage: 1,
          pageSize: 1,
          phoneNumber: providerPhone(input.phone),
          sendDate: aliyunSendDate(input.sentAt),
        }),
      )
      const body = response.body
      if (body?.code !== 'OK') {
        if (normalizedProviderCode(body?.code) === 'DATA_NOT_EXIST') {
          return mockSuccess({ status: 'pending' as const }, body?.requestId)
        }
        return mockFailure('SMS_RECEIPT_UNAVAILABLE', { retryable: true, statusKnown: false })
      }
      const detail = body.smsSendDetailDTOs?.smsSendDetailDTO?.[0]
      return mockSuccess(classifySmsReceipt(detail?.sendStatus, detail?.errCode), body.requestId)
    } catch {
      return mockFailure('SMS_RECEIPT_UNAVAILABLE', { retryable: true, statusKnown: false })
    }
  }
}

export function createSmsProvider(): SmsProvider {
  const env = getEnv()
  if (env.ALIYUN_SMS_MODE !== 'live') return new MockSmsProvider()
  return liveSmsAllowed() ? new LiveSmsProvider() : new DisabledSmsProvider()
}
