import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { decodeBase64Aes256Key } from '@/lib/crypto'
import { getEnv, parseRealnameDocumentMasterKeys } from '@/lib/env'
import { AppError } from '@/lib/errors'

const WRAPPED_DATA_KEY_FORMAT = 'wanmi-rn-dk-v1'
const WRAPPED_DATA_KEY_BYTES = 32
const WRAPPING_IV_BYTES = 12
const WRAPPING_TAG_BYTES = 16

export type RealnameDocumentMasterKeyring = {
  activeVersion: string
  keyForVersion(version: string): Buffer | undefined
}

function documentKeyError(): never {
  throw new AppError('REALNAME_DOCUMENT_UNAVAILABLE', '证件文件暂时不可用', 503, {
    retryable: true,
  })
}

function decodeBase64Url(value: string, bytes: number): Buffer {
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength !== bytes || decoded.toString('base64url') !== value) {
    decoded.fill(0)
    documentKeyError()
  }
  return decoded
}

function wrappingAad(masterKeyVersion: string): Buffer {
  return Buffer.from(`${WRAPPED_DATA_KEY_FORMAT}\0${masterKeyVersion}`, 'utf8')
}

export function createRealnameDocumentMasterKeyring(): RealnameDocumentMasterKeyring {
  const env = getEnv()
  const encodedKeys = parseRealnameDocumentMasterKeys(env.REALNAME_DOCUMENT_MASTER_KEYS)
  return {
    activeVersion: env.REALNAME_DOCUMENT_MASTER_KEY_VERSION,
    keyForVersion(version) {
      const encoded = encodedKeys.get(version)
      return encoded ? decodeBase64Aes256Key(encoded) : undefined
    },
  }
}

export function wrapDocumentDataKey(
  plaintextKey: Uint8Array,
  keyring: RealnameDocumentMasterKeyring,
): { encryptedDataKey: string; masterKeyVersion: string } {
  if (plaintextKey.byteLength !== WRAPPED_DATA_KEY_BYTES) documentKeyError()
  const masterKeyVersion = keyring.activeVersion
  const masterKey = keyring.keyForVersion(masterKeyVersion)
  if (!masterKey) documentKeyError()
  try {
    const iv = randomBytes(WRAPPING_IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
    cipher.setAAD(wrappingAad(masterKeyVersion))
    const ciphertext = Buffer.concat([cipher.update(plaintextKey), cipher.final()])
    return {
      encryptedDataKey: [
        WRAPPED_DATA_KEY_FORMAT,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.'),
      masterKeyVersion,
    }
  } finally {
    masterKey.fill(0)
  }
}

export function unwrapDocumentDataKey(input: {
  encryptedDataKey: string
  keyring: RealnameDocumentMasterKeyring
  masterKeyVersion: string
}): Buffer {
  const masterKey = input.keyring.keyForVersion(input.masterKeyVersion)
  if (!masterKey) documentKeyError()
  let iv: Buffer | undefined
  let tag: Buffer | undefined
  let ciphertext: Buffer | undefined
  try {
    const [format, encodedIv, encodedTag, encodedCiphertext, extra] =
      input.encryptedDataKey.split('.')
    if (
      format !== WRAPPED_DATA_KEY_FORMAT ||
      !encodedIv ||
      !encodedTag ||
      !encodedCiphertext ||
      extra
    ) {
      documentKeyError()
    }
    iv = decodeBase64Url(encodedIv, WRAPPING_IV_BYTES)
    tag = decodeBase64Url(encodedTag, WRAPPING_TAG_BYTES)
    ciphertext = decodeBase64Url(encodedCiphertext, WRAPPED_DATA_KEY_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
    decipher.setAAD(wrappingAad(input.masterKeyVersion))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    if (plaintext.byteLength !== WRAPPED_DATA_KEY_BYTES) {
      plaintext.fill(0)
      documentKeyError()
    }
    return plaintext
  } catch {
    return documentKeyError()
  } finally {
    masterKey.fill(0)
    iv?.fill(0)
    tag?.fill(0)
    ciphertext?.fill(0)
  }
}
