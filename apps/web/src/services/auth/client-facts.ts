import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'

export function clientIp(headers: Headers): string {
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown'
  )
}

export function clientHashes(headers: Headers, deviceId: string) {
  const pepper = getEnv().SESSION_PEPPER
  return {
    deviceHash: hmac(deviceId, pepper),
    ipHash: hmac(clientIp(headers), pepper),
  }
}

export function normalizeChinesePhone(input: string): string {
  const compact = input.replace(/[\s-]/g, '')
  const normalized = compact.startsWith('+86') ? compact : `+86${compact}`
  if (!/^\+861[3-9]\d{9}$/.test(normalized)) throw new Error('INVALID_PHONE')
  return normalized
}

export function maskPhone(phone: string): string {
  return `${phone.slice(0, 6)}****${phone.slice(-4)}`
}

export function maskedClientIp(headers: Headers): string {
  const ip = clientIp(headers)
  const ipv4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u)
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.0/24`
  if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/64`
  return 'unknown'
}

export function userAgentSummary(headers: Headers): string {
  const value = headers.get('user-agent') ?? ''
  const browser = /MicroMessenger/iu.test(value)
    ? 'WeChat'
    : /Firefox/iu.test(value)
      ? 'Firefox'
      : /Edg/iu.test(value)
        ? 'Edge'
        : /Chrome/iu.test(value)
          ? 'Chrome'
          : /Safari/iu.test(value)
            ? 'Safari'
            : 'Other'
  const device = /Mobile|Android|iPhone|iPad/iu.test(value) ? 'mobile' : 'desktop'
  return `${browser}/${device}`
}
