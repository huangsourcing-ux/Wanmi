import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { getEnv } from '@/lib/env'
import { createSmsProvider } from '@/providers/aliyunsms'
import { createRealnameObjectProvider } from '@/providers/oss-realname'
import type { HealthAwareProvider } from '@/providers/types'
import { MockWechatPayProvider } from '@/providers/wechatpay'
import { MockWestDigitalProvider } from '@/providers/westdigital'
import { WhoDatProvider } from '@/providers/whodat'

type ComponentHealth = { healthy: boolean; required: boolean }

async function optionalProviderHealth(
  factory: () => HealthAwareProvider,
): Promise<ComponentHealth> {
  try {
    const result = await factory().health()
    return { healthy: result.ok && result.data.healthy, required: false }
  } catch {
    return { healthy: false, required: false }
  }
}

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    await payload.count({ collection: 'admins', overrideAccess: true })
    const env = getEnv()
    const [whodat, westdigital, wechatpay, sms, privateStorage] = await Promise.all([
      optionalProviderHealth(() => new WhoDatProvider()),
      optionalProviderHealth(() => new MockWestDigitalProvider()),
      optionalProviderHealth(() => new MockWechatPayProvider()),
      optionalProviderHealth(createSmsProvider),
      optionalProviderHealth(createRealnameObjectProvider),
    ])
    const publicStorage = {
      healthy:
        env.PUBLIC_STORAGE_MODE === 'local' ||
        Boolean(
          env.S3_ACCESS_KEY_ID &&
            env.S3_SECRET_ACCESS_KEY &&
            env.S3_BUCKET &&
            env.S3_ENDPOINT &&
            env.S3_REGION,
        ),
      required: false,
    }
    return successResponse(
      {
        components: {
          database: { healthy: true, required: true },
          privateStorage,
          publicStorage,
          sms,
          wechatpay,
          westdigital,
          whodat,
        },
        status: 'ready',
      },
      traceId,
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
