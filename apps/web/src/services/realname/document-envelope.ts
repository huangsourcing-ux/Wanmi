import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

import { AppError } from '@/lib/errors'

import {
  type RealnameDocumentMasterKeyring,
  unwrapDocumentDataKey,
  wrapDocumentDataKey,
} from './master-key'

const ENVELOPE_MAGIC = Buffer.from('WANMI-RN1', 'ascii')
const AUTH_TAG_BYTES = 16
const MAX_HEADER_BYTES = 32 * 1024

export type DocumentEnvelopeMetadata = {
  authTag: string
  contentType: string
  encryptedDataKey: string
  encryptionVersion: 'aes-256-gcm-v1'
  iv: string
  masterKeyVersion: string
  sha256: string
  sizeBytes: number
}

type EnvelopeHeader = Omit<DocumentEnvelopeMetadata, 'authTag' | 'encryptionVersion'> & {
  version: 1
}

function envelopeError(): never {
  throw new AppError('REALNAME_DOCUMENT_UNAVAILABLE', '证件文件暂时不可用', 503, {
    retryable: true,
  })
}

function equalText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export async function encryptDocumentEnvelope(input: {
  body: Uint8Array
  contentType: string
  keyring: RealnameDocumentMasterKeyring
  sha256: string
}): Promise<{ body: Uint8Array; metadata: DocumentEnvelopeMetadata }> {
  const plaintextKey = randomBytes(32)
  try {
    const wrapped = wrapDocumentDataKey(plaintextKey, input.keyring)
    const iv = randomBytes(12)
    const header: EnvelopeHeader = {
      contentType: input.contentType,
      encryptedDataKey: wrapped.encryptedDataKey,
      iv: iv.toString('base64url'),
      masterKeyVersion: wrapped.masterKeyVersion,
      sha256: input.sha256,
      sizeBytes: input.body.byteLength,
      version: 1,
    }
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
    if (headerBytes.byteLength > MAX_HEADER_BYTES) envelopeError()
    const cipher = createCipheriv('aes-256-gcm', plaintextKey, iv)
    cipher.setAAD(headerBytes)
    const ciphertext = Buffer.concat([cipher.update(input.body), cipher.final()])
    const authTag = cipher.getAuthTag()
    const headerLength = Buffer.allocUnsafe(4)
    headerLength.writeUInt32BE(headerBytes.byteLength)
    return {
      body: Buffer.concat([ENVELOPE_MAGIC, headerLength, headerBytes, authTag, ciphertext]),
      metadata: {
        authTag: authTag.toString('base64url'),
        contentType: input.contentType,
        encryptedDataKey: wrapped.encryptedDataKey,
        encryptionVersion: 'aes-256-gcm-v1',
        iv: header.iv,
        masterKeyVersion: wrapped.masterKeyVersion,
        sha256: input.sha256,
        sizeBytes: input.body.byteLength,
      },
    }
  } finally {
    plaintextKey.fill(0)
  }
}

function parseEnvelope(body: Uint8Array): {
  authTag: Buffer
  ciphertext: Buffer
  header: EnvelopeHeader
  headerBytes: Buffer
} {
  const buffer = Buffer.from(body)
  const fixedBytes = ENVELOPE_MAGIC.byteLength + 4 + AUTH_TAG_BYTES
  if (
    buffer.byteLength <= fixedBytes ||
    !buffer.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)
  ) {
    envelopeError()
  }
  const headerLength = buffer.readUInt32BE(ENVELOPE_MAGIC.byteLength)
  if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) envelopeError()
  const headerStart = ENVELOPE_MAGIC.byteLength + 4
  const tagStart = headerStart + headerLength
  if (tagStart + AUTH_TAG_BYTES >= buffer.byteLength) envelopeError()
  const headerBytes = buffer.subarray(headerStart, tagStart)
  try {
    const header = JSON.parse(headerBytes.toString('utf8')) as Partial<EnvelopeHeader>
    if (
      header.version !== 1 ||
      typeof header.contentType !== 'string' ||
      typeof header.encryptedDataKey !== 'string' ||
      typeof header.iv !== 'string' ||
      typeof header.masterKeyVersion !== 'string' ||
      typeof header.sha256 !== 'string' ||
      typeof header.sizeBytes !== 'number'
    ) {
      envelopeError()
    }
    return {
      authTag: buffer.subarray(tagStart, tagStart + AUTH_TAG_BYTES),
      ciphertext: buffer.subarray(tagStart + AUTH_TAG_BYTES),
      header: header as EnvelopeHeader,
      headerBytes,
    }
  } catch {
    envelopeError()
  }
}

export async function decryptDocumentEnvelope(input: {
  body: Uint8Array
  expected: DocumentEnvelopeMetadata
  keyring: RealnameDocumentMasterKeyring
}): Promise<Uint8Array> {
  const envelope = parseEnvelope(input.body)
  if (
    envelope.header.version !== 1 ||
    envelope.header.sizeBytes !== input.expected.sizeBytes ||
    !equalText(envelope.header.contentType, input.expected.contentType) ||
    !equalText(envelope.header.encryptedDataKey, input.expected.encryptedDataKey) ||
    !equalText(envelope.header.iv, input.expected.iv) ||
    !equalText(envelope.header.masterKeyVersion, input.expected.masterKeyVersion) ||
    !equalText(envelope.header.sha256, input.expected.sha256) ||
    !equalText(envelope.authTag.toString('base64url'), input.expected.authTag)
  ) {
    envelopeError()
  }
  const plaintextKey = unwrapDocumentDataKey({
    encryptedDataKey: envelope.header.encryptedDataKey,
    keyring: input.keyring,
    masterKeyVersion: envelope.header.masterKeyVersion,
  })
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      plaintextKey,
      Buffer.from(envelope.header.iv, 'base64url'),
    )
    decipher.setAAD(envelope.headerBytes)
    decipher.setAuthTag(envelope.authTag)
    const plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()])
    const digest = createHash('sha256').update(plaintext).digest('hex')
    if (
      plaintext.byteLength !== input.expected.sizeBytes ||
      !equalText(digest, input.expected.sha256)
    ) {
      envelopeError()
    }
    return plaintext
  } catch {
    envelopeError()
  } finally {
    plaintextKey.fill(0)
  }
}
