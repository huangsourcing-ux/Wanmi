import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export const REAL_PROVIDER_GATE_KEYS = [
  'ALLOW_REAL_PROVIDER_WRITES',
  'ALLOW_REAL_ALIYUN_OSS_REALNAME',
  'ALLOW_REAL_ALIYUN_SMS_SENDS',
  'ALLOW_REAL_WECHAT_OFFICIAL_MESSAGES',
  'ALLOW_REAL_WECHATPAY',
  'ALLOW_REAL_WECHATPAY_PAYMENTS',
  'ALLOW_REAL_WECHATPAY_REFUNDS',
  'ALLOW_REAL_WESTDIGITAL',
  'ALLOW_REAL_WESTDIGITAL_DNS_WRITES',
  'ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES',
  'ALLOW_REAL_WESTDIGITAL_READS',
  'ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES',
  'ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES',
  'ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES',
]

export const BASE_RUNTIME_KEYS = [
  'DATABASE_URL',
  'NEXT_PUBLIC_SERVER_URL',
  'PAYLOAD_SECRET',
  'REALNAME_DOCUMENT_MASTER_KEYS',
  'REALNAME_DOCUMENT_MASTER_KEY_VERSION',
  'SESSION_PEPPER',
  'TOTP_ENCRYPTION_KEY',
  'WHO_DAT_AUTH_KEY',
  'WHO_DAT_URL',
]

export const PRODUCTION_PROVIDER_KEYS = [
  'ALIBABA_CLOUD_ACCESS_KEY_ID',
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  'ALIBABA_CLOUD_REGION_ID',
  'ALIBABA_CLOUD_SMS_DOMAIN_EXPIRY_TEMPLATE_CODE',
  'ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE',
  'ALIBABA_CLOUD_SMS_SECURITY_TEMPLATE_CODE',
  'ALIBABA_CLOUD_SMS_STEP_UP_TEMPLATE_CODE',
  'ALIBABA_CLOUD_SMS_SIGN_NAME',
  'ALIYUN_CAPTCHA_PREFIX',
  'ALIYUN_CAPTCHA_QRCODE_SCENE_ID',
  'ALIYUN_CAPTCHA_SMS_SCENE_ID',
  'CUSTOMER_IDENTITY_ENCRYPTION_KEY',
  'OSS_REALNAME_BUCKET',
  'OSS_REALNAME_ENDPOINT',
  'OSS_REALNAME_PREFIX',
  'WECHATPAY_API_V3_KEY',
  'WECHATPAY_APP_ID',
  'WECHATPAY_MERCHANT_CERTIFICATE_SERIAL',
  'WECHATPAY_MERCHANT_ID',
  'WECHATPAY_MERCHANT_PRIVATE_KEY_PATH',
  'WECHATPAY_NOTIFY_URL',
  'WECHATPAY_PLATFORM_CERTIFICATE_SERIAL',
  'WECHATPAY_PLATFORM_PUBLIC_KEY_PATH',
  'WECHAT_OFFICIAL_APP_ID',
  'WECHAT_OFFICIAL_APP_SECRET',
  'WECHAT_OFFICIAL_CALLBACK_TOKEN',
  'WECHAT_OFFICIAL_ENCODING_AES_KEY',
  'WECHAT_OFFICIAL_OAUTH_DOMAIN',
  'WESTDIGITAL_API_PASSWORD',
  'WESTDIGITAL_USERNAME',
]

export const RUNTIME_MODE_KEYS = [
  'ALIYUN_CAPTCHA_MODE',
  'ALIYUN_OSS_REALNAME_MODE',
  'ALIYUN_SMS_MODE',
  'PUBLIC_STORAGE_MODE',
  'WECHATPAY_MODE',
  'WECHAT_OFFICIAL_MODE',
  'WESTDIGITAL_MODE',
]

export const TRANSIENT_OVERRIDE_KEYS = new Set([
  'ALIYUN_SMS_MODE',
  'ALLOW_REAL_ALIYUN_SMS_SENDS',
  'ALLOW_REAL_PROVIDER_WRITES',
  'ALLOW_REAL_WECHATPAY',
  'ALLOW_REAL_WECHATPAY_PAYMENTS',
  'ALLOW_REAL_WECHATPAY_REFUNDS',
  'WANMI_CONTRACT_TEST_PHONE',
  'WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN',
  'WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_FEN',
])

const FORBIDDEN_PERSISTENT_KEYS = new Set([
  'HOSTNAME',
  'NODE_OPTIONS',
  'PATH',
  'WANMI_RUNTIME_ENV_FILE',
  'WANMI_RUNTIME_OVERRIDE_FILE',
  'WANMI_RUNTIME_PROFILE',
])

const productionRequiredKeys = [
  ...BASE_RUNTIME_KEYS,
  ...PRODUCTION_PROVIDER_KEYS,
  ...REAL_PROVIDER_GATE_KEYS,
  ...RUNTIME_MODE_KEYS,
]

const productionLiveModeKeys = ['ALIYUN_CAPTCHA_MODE', 'WECHAT_OFFICIAL_MODE']

const booleanKeys = new Set(REAL_PROVIDER_GATE_KEYS)
const modeValues = new Map([
  ['ALIYUN_CAPTCHA_MODE', new Set(['fixture', 'live'])],
  ['ALIYUN_OSS_REALNAME_MODE', new Set(['mock', 'live'])],
  ['ALIYUN_SMS_MODE', new Set(['mock', 'live'])],
  ['PUBLIC_STORAGE_MODE', new Set(['local', 's3'])],
  ['WECHATPAY_MODE', new Set(['fixture', 'live'])],
  ['WECHAT_OFFICIAL_MODE', new Set(['fixture', 'live'])],
  ['WESTDIGITAL_MODE', new Set(['fixture', 'live'])],
])

function invalidNames(environment, keys) {
  return keys.filter((key) => {
    const value = environment[key]?.trim()
    if (!value) return true
    if (booleanKeys.has(key)) return value !== 'true' && value !== 'false'
    const allowed = modeValues.get(key)
    return allowed ? !allowed.has(value) : false
  })
}

export function assertRuntimeEnvironment(environment, profile = environment.WANMI_RUNTIME_PROFILE) {
  if (!['production', 'validation'].includes(profile)) {
    throw new Error('Invalid runtime setting: WANMI_RUNTIME_PROFILE')
  }
  const required = profile === 'production' ? productionRequiredKeys : BASE_RUNTIME_KEYS
  const invalid = invalidNames(environment, required)
  if (profile === 'production') {
    invalid.push(
      ...productionLiveModeKeys.filter(
        (key) => environment[key]?.trim() && environment[key]?.trim() !== 'live',
      ),
    )
  }
  if (invalid.length > 0) {
    throw new Error(
      `${profile === 'production' ? 'Production' : 'Validation'} runtime configuration missing or invalid: ${invalid.join(', ')}`,
    )
  }
}

function parseLine(line, lineNumber) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return undefined
  const separator = trimmed.indexOf('=')
  if (separator < 1)
    throw new Error(`Runtime environment file has an invalid entry at line ${lineNumber}`)
  const name = trimmed.slice(0, separator).trim()
  if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
    throw new Error(`Runtime environment file has an invalid name at line ${lineNumber}`)
  }
  let value = trimmed.slice(separator + 1).trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1)
  }
  return [name, value]
}

export function parseRuntimeEnvironmentFile(content) {
  const parsed = new Map()
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const entry = parseLine(line, index + 1)
    if (!entry) continue
    const [name, value] = entry
    if (parsed.has(name)) throw new Error(`Runtime environment file repeats setting: ${name}`)
    parsed.set(name, value)
  }
  return parsed
}

function safeRuntimeFile(path, repositoryRoot, label) {
  const absolute = resolve(path)
  const real = realpathSync(absolute)
  const repository = realpathSync(repositoryRoot)
  if (real === repository || real.startsWith(`${repository}${sep}`)) {
    throw new Error(`${label} must be outside the repository checkout`)
  }
  const metadata = lstatSync(absolute)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`)
  }
  if (process.platform !== 'win32' && (metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o600)) {
    throw new Error(`${label} must be root-owned with mode 0600`)
  }
  return real
}

export function applyEntries(environment, entries, allowedNames, label) {
  for (const [name, value] of entries) {
    if (allowedNames && !allowedNames.has(name)) {
      throw new Error(`${label} contains a setting that cannot be overridden: ${name}`)
    }
    environment[name] = value
  }
}

export function loadRuntimeEnvironmentFiles(environment, repositoryRoot) {
  const persistentPath = environment.WANMI_RUNTIME_ENV_FILE?.trim()
  const requestedProfile = environment.WANMI_RUNTIME_PROFILE?.trim()
  if (persistentPath) {
    const real = safeRuntimeFile(persistentPath, repositoryRoot, 'WANMI_RUNTIME_ENV_FILE')
    const entries = parseRuntimeEnvironmentFile(readFileSync(real, 'utf8'))
    const forbidden = [...entries.keys()].filter((name) => FORBIDDEN_PERSISTENT_KEYS.has(name))
    if (forbidden.length > 0) {
      throw new Error(
        `Persistent runtime environment contains forbidden setting: ${forbidden.join(', ')}`,
      )
    }
    if (requestedProfile === 'production') {
      assertRuntimeEnvironment(Object.fromEntries(entries), 'production')
    }
    applyEntries(environment, entries, undefined, 'Persistent runtime environment')
  }
  const overridePath = environment.WANMI_RUNTIME_OVERRIDE_FILE?.trim()
  if (overridePath) {
    const real = safeRuntimeFile(overridePath, repositoryRoot, 'WANMI_RUNTIME_OVERRIDE_FILE')
    applyEntries(
      environment,
      parseRuntimeEnvironmentFile(readFileSync(real, 'utf8')),
      TRANSIENT_OVERRIDE_KEYS,
      'Transient runtime override',
    )
  }
  if (requestedProfile === 'production' && !persistentPath) {
    throw new Error('Production runtime configuration missing or invalid: WANMI_RUNTIME_ENV_FILE')
  }
  assertRuntimeEnvironment(environment, requestedProfile)
}
