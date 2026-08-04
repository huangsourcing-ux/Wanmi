import SmsClient, { SendSmsRequest } from '@alicloud/dysmsapi20170525'
import { $OpenApiUtil } from '@alicloud/openapi-core'

import type { SmsProvider } from './types'
import { mockFailure, mockSuccess } from './mock'
import { getEnv } from '@/lib/env'

class MockSmsProvider implements SmsProvider {
  async health() {
    return mockSuccess({ healthy: true })
  }

  async sendOtp() {
    return mockSuccess({ accepted: true as const })
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
    return mockSuccess({
      healthy: Boolean(
        process.env.ALIBABA_CLOUD_ACCESS_KEY_ID &&
          process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET &&
          process.env.ALIBABA_CLOUD_REGION_ID &&
          process.env.ALIBABA_CLOUD_SMS_SIGN_NAME &&
          process.env.ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE,
      ),
    })
  }

  async sendOtp(input: { code: string; phone: string; traceId: string }) {
    if (!getEnv().ALLOW_REAL_PROVIDER_WRITES) {
      return mockFailure('PROVIDER_WRITE_DISABLED', { statusKnown: true })
    }
    try {
      const response = await this.client.sendSms(
        new SendSmsRequest({
          outId: input.traceId,
          phoneNumbers: input.phone,
          signName: process.env.ALIBABA_CLOUD_SMS_SIGN_NAME,
          templateCode: process.env.ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE,
          templateParam: JSON.stringify({ code: input.code }),
        }),
      )
      if (response.body?.code !== 'OK') {
        return mockFailure('SMS_PROVIDER_REJECTED', { retryable: false, statusKnown: true })
      }
      return mockSuccess({ accepted: true as const }, response.body.requestId)
    } catch {
      return mockFailure('SMS_PROVIDER_UNAVAILABLE', { retryable: true, statusKnown: false })
    }
  }
}

export function createSmsProvider(): SmsProvider {
  return getEnv().ALIYUN_SMS_MODE === 'live' ? new LiveSmsProvider() : new MockSmsProvider()
}
