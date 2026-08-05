export const REDACTED_VALUE = '[REDACTED]'

const safeDerivedKey = /(?:digest|hash|hashed|last4|masked|sha256)$/i
const sensitiveKey =
  /(?:apikey|authorization|certificateno|certificatenumber|cookie|credential|documentno|documentnumber|encryptionkey|idcard|idnumber|identitycard|identityno|identitynumber|mobile|onetimepassword|otp|passphrase|passportno|passportnumber|password|paymentkey|phone|privatekey|recoverycode|secret|sessionid|sessiontoken|setcookie|signingkey|smscode|telephone|token|totp|verificationcode)/i
const chineseMobile = /(?:\+?86[-\s]?)?1[3-9]\d{9}/g
const chineseIdentityNumber = /(?<![0-9A-Za-z])\d{17}[0-9Xx](?![0-9A-Za-z])/g
const credentialHeader = /(?:authorization\s*:|cookie\s*:|set-cookie\s*:|bearer\s+)/i

function normalizedKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '')
}

function shouldRedactKey(key: string): boolean {
  const normalized = normalizedKey(key)
  return !safeDerivedKey.test(normalized) && sensitiveKey.test(normalized)
}

function sanitizeString(value: string): string {
  if (/^\d{6}$/.test(value) || credentialHeader.test(value)) return REDACTED_VALUE
  return value.replace(chineseIdentityNumber, REDACTED_VALUE).replace(chineseMobile, REDACTED_VALUE)
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value !== 'object' || value === null) return value
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return REDACTED_VALUE
  seen.add(value)
  const sanitized = Array.isArray(value)
    ? value.map((item) => sanitizeValue(item, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          shouldRedactKey(key) ? REDACTED_VALUE : sanitizeValue(nested, seen),
        ]),
      )
  seen.delete(value)
  return sanitized
}

export function sanitizeSensitiveData<T>(value: T): T {
  return sanitizeValue(value, new WeakSet()) as T
}
