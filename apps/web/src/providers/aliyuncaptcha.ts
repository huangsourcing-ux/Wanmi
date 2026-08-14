import CaptchaClient, { VerifyIntelligentCaptchaRequest } from '@alicloud/captcha20230305'
import { $OpenApiUtil } from '@alicloud/openapi-core'

import { getEnv } from '@/lib/env'

export const CAPTCHA_FIXTURE_TOKEN = 'wanmi-captcha-fixture-pass'

export type CaptchaPurpose = 'qrcode' | 'sms'

export type CaptchaVerification =
  | { ok: true; requestId: string; verifyCode: string }
  | { ok: false; code: string; requestId?: string }

export interface CaptchaProvider {
  verify(input: {
    captchaVerifyParam: string
    purpose: CaptchaPurpose
    traceId: string
  }): Promise<CaptchaVerification>
}

export function validateAliyunCaptchaLiveConfiguration(): void {
  const required = [
    'ALIBABA_CLOUD_ACCESS_KEY_ID',
    'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
    'ALIBABA_CLOUD_REGION_ID',
    'ALIYUN_CAPTCHA_PREFIX',
    'ALIYUN_CAPTCHA_SMS_SCENE_ID',
    'ALIYUN_CAPTCHA_QRCODE_SCENE_ID',
  ] as const
  const missing = required.filter((key) => !process.env[key]?.trim())
  if (missing.length > 0) {
    throw new Error(`Aliyun Captcha live configuration is missing: ${missing.join(', ')}`)
  }
}

class FixtureCaptchaProvider implements CaptchaProvider {
  async verify(input: { captchaVerifyParam: string; purpose: CaptchaPurpose; traceId: string }) {
    return input.captchaVerifyParam === CAPTCHA_FIXTURE_TOKEN
      ? { ok: true as const, requestId: `captcha-fixture-${input.traceId}`, verifyCode: 'T001' }
      : { ok: false as const, code: 'CAPTCHA_REJECTED' }
  }
}

class LiveCaptchaProvider implements CaptchaProvider {
  private readonly client: CaptchaClient

  constructor() {
    validateAliyunCaptchaLiveConfiguration()
    this.client = new CaptchaClient(
      new $OpenApiUtil.Config({
        accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
        accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
        connectTimeout: 2_000,
        endpoint: `captcha.${process.env.ALIBABA_CLOUD_REGION_ID}.aliyuncs.com`,
        readTimeout: 3_000,
        regionId: process.env.ALIBABA_CLOUD_REGION_ID,
      }),
    )
  }

  async verify(input: {
    captchaVerifyParam: string
    purpose: CaptchaPurpose
    traceId: string
  }): Promise<CaptchaVerification> {
    const env = getEnv()
    const sceneId =
      input.purpose === 'sms' ? env.ALIYUN_CAPTCHA_SMS_SCENE_ID : env.ALIYUN_CAPTCHA_QRCODE_SCENE_ID
    if (!sceneId) return { ok: false, code: 'CAPTCHA_CONFIGURATION_MISSING' }
    try {
      const response = await this.client.verifyIntelligentCaptcha(
        new VerifyIntelligentCaptchaRequest({
          captchaVerifyParam: input.captchaVerifyParam,
          sceneId,
        }),
      )
      const body = response.body
      const requestId = body?.requestId
      const verifyCode = body?.result?.verifyCode ?? 'UNKNOWN'
      if (body?.success === true && body.result?.verifyResult === true && requestId) {
        return { ok: true, requestId, verifyCode }
      }
      return { ok: false, code: `CAPTCHA_${verifyCode}`, requestId }
    } catch {
      return { ok: false, code: 'CAPTCHA_PROVIDER_UNAVAILABLE' }
    }
  }
}

export function createCaptchaProvider(): CaptchaProvider {
  return getEnv().ALIYUN_CAPTCHA_MODE === 'live'
    ? new LiveCaptchaProvider()
    : new FixtureCaptchaProvider()
}
