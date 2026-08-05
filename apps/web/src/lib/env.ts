import { z } from 'zod'

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const schema = z.object({
  ALLOW_REAL_PROVIDER_WRITES: booleanFromString,
  ALIYUN_KMS_MODE: z.enum(['mock', 'live']).default('mock'),
  ALIYUN_OSS_REALNAME_MODE: z.enum(['mock', 'live']).default('mock'),
  ALIYUN_SMS_MODE: z.enum(['mock', 'live']).default('mock'),
  CUSTOMER_SESSION_COOKIE: z.string().min(1).default('wanmi_customer_session'),
  CUSTOMER_SESSION_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  DATABASE_URL: z.string().min(1),
  FIRST_PARTY_EVENT_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(1_000),
  NEXT_PUBLIC_SERVER_URL: z.url().default('http://localhost:3000'),
  MOCK_SMS_OTP_CODE: z
    .string()
    .regex(/^\d{6}$/)
    .default('246810'),
  OTP_DEVICE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(10),
  OTP_GLOBAL_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(1_000),
  OTP_IP_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(20),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_PHONE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(5),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  PAYLOAD_SECRET: z.string().min(24),
  PUBLIC_STORAGE_MODE: z.enum(['local', 's3']).default('local'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_FORCE_PATH_STYLE: booleanFromString,
  S3_REGION: z.string().default('us-east-1'),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  SESSION_PEPPER: z.string().min(24),
  TOTP_ENCRYPTION_KEY: z.string().min(1),
  WHO_DAT_AUTH_KEY: z.string().optional(),
  WHO_DAT_URL: z.url().default('http://127.0.0.1:8080'),
})

export type WanmiEnv = z.infer<typeof schema>

let cached: WanmiEnv | undefined

export function getEnv(): WanmiEnv {
  cached ??= schema.parse(process.env)
  return cached
}

export function resetEnvForTests(): void {
  cached = undefined
}
