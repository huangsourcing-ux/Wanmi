import type { Payload } from 'payload'

import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'

type RateDimension = 'device' | 'global' | 'ip' | 'phone'

const RATE_WINDOW_MS = 3_600_000

async function consumeRateLimit(
  payload: Payload,
  dimension: RateDimension,
  identityHash: string,
  limit: number,
): Promise<boolean> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - RATE_WINDOW_MS)
  const expiresAt = new Date(now.getTime() + RATE_WINDOW_MS)
  const bucketKey = `${dimension}:${identityHash}`
  const result = await payload.db.pool.query(
    `INSERT INTO "sms_rate_limits" (
       "bucket_key", "dimension", "identity_hash", "window_started_at", "count",
       "expires_at", "updated_at", "created_at"
     ) VALUES ($1, $2, $3, $4, 1, $5, $4, $4)
     ON CONFLICT ("bucket_key") DO UPDATE SET
       "count" = CASE
         WHEN "sms_rate_limits"."window_started_at" <= $6 THEN 1
         ELSE "sms_rate_limits"."count" + 1
       END,
       "window_started_at" = CASE
         WHEN "sms_rate_limits"."window_started_at" <= $6 THEN $4
         ELSE "sms_rate_limits"."window_started_at"
       END,
       "expires_at" = CASE
         WHEN "sms_rate_limits"."window_started_at" <= $6 THEN $5
         ELSE "sms_rate_limits"."expires_at"
       END,
       "updated_at" = $4
     WHERE "sms_rate_limits"."window_started_at" <= $6
        OR "sms_rate_limits"."count" < $7
     RETURNING "count"`,
    [bucketKey, dimension, identityHash, now, expiresAt, cutoff, limit],
  )
  return result.rowCount === 1
}

export async function enforceSmsRateLimits(
  payload: Payload,
  hashes: { deviceHash: string; ipHash: string; phoneHash: string },
): Promise<void> {
  const env = getEnv()
  const dimensions = [
    ['phone', hashes.phoneHash, env.OTP_PHONE_LIMIT_PER_HOUR],
    ['ip', hashes.ipHash, env.OTP_IP_LIMIT_PER_HOUR],
    ['device', hashes.deviceHash, env.OTP_DEVICE_LIMIT_PER_HOUR],
    ['global', hmac('sms-rate-limit:global', env.SESSION_PEPPER), env.OTP_GLOBAL_LIMIT_PER_HOUR],
  ] as const
  for (const [dimension, identityHash, limit] of dimensions) {
    if (!(await consumeRateLimit(payload, dimension, identityHash, limit))) {
      throw new AppError('AUTH_RATE_LIMITED', '请求过于频繁，请稍后再试', 429, {
        retryAfterSeconds: 300,
      })
    }
  }
}
