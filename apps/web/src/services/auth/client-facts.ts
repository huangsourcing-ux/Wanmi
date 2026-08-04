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
