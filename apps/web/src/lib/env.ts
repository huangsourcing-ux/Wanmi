import { z } from 'zod'

import { isBase64Aes256Key } from './crypto'

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const masterKeyVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)

export function parseRealnameDocumentMasterKeys(value: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const item of value.split(',')) {
    const separator = item.indexOf(':')
    const version = item.slice(0, separator)
    const encodedKey = item.slice(separator + 1)
    if (
      separator < 1 ||
      !masterKeyVersion.safeParse(version).success ||
      !isBase64Aes256Key(encodedKey) ||
      entries.has(version)
    ) {
      throw new Error('invalid real-name document master key configuration')
    }
    entries.set(version, encodedKey)
  }
  if (entries.size === 0) throw new Error('real-name document master key ring is empty')
  return entries
}

const schema = z
  .object({
    ALLOW_REAL_PROVIDER_WRITES: booleanFromString,
    ALLOW_REAL_ALIYUN_OSS_REALNAME: booleanFromString,
    ALLOW_REAL_ALIYUN_SMS_SENDS: booleanFromString,
    ALLOW_REAL_WECHAT_OFFICIAL_MESSAGES: booleanFromString,
    ALLOW_REAL_WECHATPAY: booleanFromString,
    ALLOW_REAL_WECHATPAY_PAYMENTS: booleanFromString,
    ALLOW_REAL_WECHATPAY_REFUNDS: booleanFromString,
    ALLOW_REAL_WESTDIGITAL: booleanFromString,
    ALLOW_REAL_WESTDIGITAL_DNS_WRITES: booleanFromString,
    ALLOW_REAL_WESTDIGITAL_DOMAIN_MANAGEMENT_WRITES: booleanFromString,
    ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES: booleanFromString,
    ALLOW_REAL_WESTDIGITAL_READS: booleanFromString,
    ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES: booleanFromString,
    ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES: booleanFromString,
    ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES: booleanFromString,
    ALIYUN_OSS_REALNAME_MODE: z.enum(['mock', 'live']).default('mock'),
    ALIYUN_CAPTCHA_MODE: z.enum(['fixture', 'live']).default('fixture'),
    ALIYUN_CAPTCHA_PREFIX: z.string().min(1).max(128).optional(),
    ALIYUN_CAPTCHA_QRCODE_SCENE_ID: z.string().min(1).max(128).optional(),
    ALIYUN_CAPTCHA_SMS_SCENE_ID: z.string().min(1).max(128).optional(),
    ALIYUN_SMS_MODE: z.enum(['mock', 'live']).default('mock'),
    ACCOUNT_CLOSURE_COOLDOWN_SECONDS: z.coerce
      .number()
      .int()
      .min(86_400)
      .max(2_592_000)
      .default(604_800),
    CUSTOMER_AUTH_FLOW_COOKIE: z
      .string()
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)
      .default('wanmi_auth_flow'),
    CUSTOMER_AUTH_FLOW_SECONDS: z.coerce.number().int().min(60).max(1_800).default(600),
    CUSTOMER_IDENTITY_ENCRYPTION_KEY: z.string().min(1).optional(),
    IDENTITY_RISK_COOLDOWN_SECONDS: z.coerce.number().int().min(60).max(604_800).default(86_400),
    IDENTITY_REBIND_COOLDOWN_SECONDS: z.coerce
      .number()
      .int()
      .min(86_400)
      .max(7_776_000)
      .default(2_592_000),
    CUSTOMER_PHONE_IDENTITY_INSTANCE_ID: z.string().min(1).max(128).default('wanmi-sms-cn'),
    CUSTOMER_REGISTRATION_SECONDS: z.coerce.number().int().min(60).max(1_800).default(600),
    CUSTOMER_SESSION_COOKIE: z
      .string()
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)
      .refine((value) => value !== 'wanmi_admin-token', 'customer/admin cookies must be distinct')
      .default('wanmi_customer_session'),
    CUSTOMER_SESSION_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    DATABASE_URL: z.string().min(1),
    DNS_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(4_096),
    DNS_CACHE_MAX_TTL_MS: z.coerce.number().int().positive().default(60_000),
    DNS_MAX_TARGETS_PER_REQUEST: z.coerce.number().int().positive().default(16),
    DNS_NEGATIVE_CACHE_MAX_TTL_MS: z.coerce.number().int().positive().default(30_000),
    DNS_READ_BURST: z.coerce.number().int().positive().default(40),
    DNS_READ_MAX_CONCURRENCY: z.coerce.number().int().positive().default(8),
    DNS_READ_QUEUE_CAPACITY: z.coerce.number().int().positive().default(64),
    DNS_READ_QUEUE_WAIT_MS: z.coerce.number().int().positive().default(2_000),
    DNS_READ_RATE_PER_SECOND: z.coerce.number().positive().default(20),
    DNS_RESPONSE_MAX_BYTES: z.coerce.number().int().positive().default(65_536),
    DNS_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
    DNS_RECORD_CHANGE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(20),
    DNS_RECORD_MAX_PER_DOMAIN: z.coerce.number().int().min(1).max(500).default(100),
    DNS_RECORD_PREVIEW_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    DOMAIN_EXPIRY_REMINDER_DAYS: z
      .string()
      .regex(/^\d{1,3}(?:,\d{1,3})*$/u)
      .default('30,7,1'),
    FIRST_PARTY_EVENT_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(1_000),
    FORM_SUBMISSION_GLOBAL_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(500),
    FORM_SUBMISSION_IP_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(10),
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
    OSS_REALNAME_BUCKET: z.string().min(3).optional(),
    OSS_REALNAME_ENDPOINT: z.url().optional(),
    OSS_REALNAME_PREFIX: z
      .string()
      .regex(/^private\/[a-z0-9][a-z0-9/_-]*$/u)
      .default('private/realname'),
    PAYLOAD_SECRET: z.string().min(24),
    PUBLIC_STORAGE_MODE: z.enum(['local', 's3']).default('local'),
    REALNAME_DOCUMENT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(15).max(120).default(60),
    REALNAME_DOCUMENT_MASTER_KEYS: z.string().min(1).max(4_096),
    REALNAME_DOCUMENT_MASTER_KEY_VERSION: masterKeyVersion,
    REALNAME_DOCUMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(20 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ENDPOINT: z.url().optional(),
    S3_FORCE_PATH_STYLE: booleanFromString,
    S3_REGION: z.string().default('us-east-1'),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    SESSION_PEPPER: z.string().min(24),
    STEP_UP_GRANT_TTL_SECONDS: z.coerce.number().int().min(60).max(1_800).default(600),
    TLS_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(2_048),
    TLS_EMPTY_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
    TLS_HANDSHAKE_MAX_BYTES: z.coerce.number().int().positive().default(262_144),
    TLS_READ_BURST: z.coerce.number().int().positive().default(20),
    TLS_READ_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),
    TLS_READ_QUEUE_CAPACITY: z.coerce.number().int().positive().default(32),
    TLS_READ_QUEUE_WAIT_MS: z.coerce.number().int().positive().default(2_000),
    TLS_READ_RATE_PER_SECOND: z.coerce.number().positive().default(10),
    TLS_RESULT_CACHE_TTL_MS: z.coerce.number().int().positive().default(60_000),
    TLS_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    TOTP_ENCRYPTION_KEY: z.string().min(1),
    WESTDIGITAL_AVAILABILITY_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(5_000),
    WESTDIGITAL_AVAILABILITY_CACHE_TTL_MS: z.coerce.number().int().positive().default(45_000),
    WESTDIGITAL_PRICE_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(512),
    WESTDIGITAL_PRICE_CACHE_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
    WESTDIGITAL_READ_BURST: z.coerce.number().int().positive().default(4),
    WESTDIGITAL_READ_QUEUE_CAPACITY: z.coerce.number().int().positive().default(32),
    WESTDIGITAL_READ_QUEUE_WAIT_MS: z.coerce.number().int().positive().default(5_000),
    WESTDIGITAL_READ_RATE_PER_SECOND: z.coerce.number().positive().default(2),
    WESTDIGITAL_READ_RESPONSE_MAX_BYTES: z.coerce.number().int().positive().default(65_536),
    WESTDIGITAL_READ_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    WESTDIGITAL_API_PASSWORD: z.string().min(1).optional(),
    WESTDIGITAL_MODE: z.enum(['fixture', 'live']).default('fixture'),
    WESTDIGITAL_USERNAME: z.string().min(1).optional(),
    WESTDIGITAL_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN: z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .default(0),
    WESTDIGITAL_WRITE_DOMAIN_ALLOWLIST: z.string().default(''),
    WESTDIGITAL_WRITE_MAX_REGISTER_RENEW_OPERATIONS: z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .default(0),
    WESTDIGITAL_WRITE_SINGLE_AMOUNT_LIMIT_FEN: z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .default(0),
    WESTDIGITAL_WHOIS_FALLBACK_ENABLED: booleanFromString,
    WECHATPAY_API_V3_KEY: z.string().length(32).optional(),
    WECHATPAY_APP_ID: z.string().min(1).max(32).optional(),
    WECHATPAY_MERCHANT_CERTIFICATE_SERIAL: z.string().min(1).max(128).optional(),
    WECHATPAY_MERCHANT_ID: z.string().min(1).max(32).optional(),
    WECHATPAY_MERCHANT_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    WECHATPAY_MODE: z.enum(['fixture', 'live']).default('fixture'),
    WECHATPAY_NOTIFY_URL: z.url().optional(),
    WECHATPAY_PLATFORM_CERTIFICATE_SERIAL: z.string().min(1).max(128).optional(),
    WECHATPAY_PLATFORM_PUBLIC_KEY_PATH: z.string().min(1).optional(),
    WECHATPAY_RESPONSE_MAX_BYTES: z.coerce.number().int().positive().default(1_048_576),
    WECHATPAY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN: z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .default(0),
    WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_FEN: z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .default(0),
    WECHAT_OFFICIAL_APP_ID: z.string().min(1).max(64).optional(),
    WECHAT_OFFICIAL_APP_SECRET: z.string().min(1).max(256).optional(),
    WECHAT_OFFICIAL_CALLBACK_TOKEN: z.string().min(1).max(256).optional(),
    WECHAT_OFFICIAL_ENCODING_AES_KEY: z.string().length(43).optional(),
    WECHAT_OFFICIAL_MODE: z.enum(['fixture', 'live']).default('fixture'),
    WECHAT_OFFICIAL_OAUTH_DOMAIN: z.string().min(1).max(253).optional(),
    WECHAT_OFFICIAL_RESPONSE_MAX_BYTES: z.coerce.number().int().positive().default(262_144),
    WECHAT_OFFICIAL_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    WECHAT_QR_POLL_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(10_000).default(800),
    WECHAT_QR_TTL_SECONDS: z.coerce.number().int().min(60).max(1_800).default(300),
    WHO_DAT_AUTH_KEY: z.string().optional(),
    WHO_DAT_READ_BURST: z.coerce.number().int().positive().default(10),
    WHO_DAT_READ_QUEUE_CAPACITY: z.coerce.number().int().positive().default(32),
    WHO_DAT_READ_QUEUE_WAIT_MS: z.coerce.number().int().positive().default(3_000),
    WHO_DAT_READ_RATE_PER_SECOND: z.coerce.number().positive().default(5),
    WHO_DAT_RESPONSE_MAX_BYTES: z.coerce.number().int().positive().default(65_536),
    WHO_DAT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_500),
    WHO_DAT_URL: z.url().default('http://127.0.0.1:8080'),
  })
  .superRefine((env, context) => {
    if (env.CUSTOMER_AUTH_FLOW_COOKIE === env.CUSTOMER_SESSION_COOKIE) {
      context.addIssue({
        code: 'custom',
        message: 'customer auth-flow and session cookies must be distinct',
        path: ['CUSTOMER_AUTH_FLOW_COOKIE'],
      })
    }
    if (
      env.CUSTOMER_IDENTITY_ENCRYPTION_KEY &&
      !isBase64Aes256Key(env.CUSTOMER_IDENTITY_ENCRYPTION_KEY)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'customer identity encryption key must be a base64-encoded 32-byte key',
        path: ['CUSTOMER_IDENTITY_ENCRYPTION_KEY'],
      })
    }
    if (
      env.WECHAT_OFFICIAL_ENCODING_AES_KEY &&
      Buffer.from(`${env.WECHAT_OFFICIAL_ENCODING_AES_KEY}=`, 'base64').length !== 32
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Wechat Official callback AES key must decode to 32 bytes',
        path: ['WECHAT_OFFICIAL_ENCODING_AES_KEY'],
      })
    }
    try {
      const keys = parseRealnameDocumentMasterKeys(env.REALNAME_DOCUMENT_MASTER_KEYS)
      if (!keys.has(env.REALNAME_DOCUMENT_MASTER_KEY_VERSION)) {
        context.addIssue({
          code: 'custom',
          message: 'active real-name document master key version is missing from the key ring',
          path: ['REALNAME_DOCUMENT_MASTER_KEY_VERSION'],
        })
      }
    } catch {
      context.addIssue({
        code: 'custom',
        message:
          'real-name document master keys must be unique version:base64-encoded-32-byte-key entries',
        path: ['REALNAME_DOCUMENT_MASTER_KEYS'],
      })
    }
  })

export type WanmiEnv = z.infer<typeof schema>

let cached: WanmiEnv | undefined

export function getEnv(): WanmiEnv {
  if (
    /^(?:1|true)$/iu.test(process.env.CI ?? '') &&
    /^(?:1|true)$/iu.test(process.env.ALLOW_REAL_PROVIDER_WRITES ?? '')
  ) {
    throw new Error(
      'CI safety gate: ALLOW_REAL_PROVIDER_WRITES must remain false; real provider writes are forbidden in CI',
    )
  }
  cached ??= schema.parse(process.env)
  return cached
}

export function resetEnvForTests(): void {
  cached = undefined
}
