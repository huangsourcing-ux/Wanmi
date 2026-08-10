import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

import { AppError } from './errors'

export function hmac(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex')
}

export function safeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function randomOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

type EncryptedValue = { ciphertext: string; iv: string; tag: string; version: 1 }

export function decodeBase64Aes256Key(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    key.fill(0)
    throw new AppError('INVALID_ENCRYPTION_CONFIG', '加密配置无效', 500)
  }
  return key
}

export function isBase64Aes256Key(encoded: string): boolean {
  try {
    decodeBase64Aes256Key(encoded).fill(0)
    return true
  } catch {
    return false
  }
}

export function encryptSecret(value: string, encodedKey: string): string {
  const iv = randomBytes(12)
  const key = decodeBase64Aes256Key(encodedKey)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const encrypted: EncryptedValue = {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      version: 1,
    }
    return Buffer.from(JSON.stringify(encrypted)).toString('base64url')
  } finally {
    key.fill(0)
  }
}

export function decryptSecret(value: string, encodedKey: string): string {
  const encrypted = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as EncryptedValue
  if (encrypted.version !== 1)
    throw new AppError('UNSUPPORTED_ENCRYPTION_VERSION', '加密版本无效', 500)
  const key = decodeBase64Aes256Key(encodedKey)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } finally {
    key.fill(0)
  }
}
