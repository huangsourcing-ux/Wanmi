import { createHash, randomBytes } from 'node:crypto'

import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getEnv, resetEnvForTests } from '@/lib/env'
import { AliOssRealnameProvider, createRealnameObjectProvider } from '@/providers/oss-realname'
import {
  decryptDocumentEnvelope,
  encryptDocumentEnvelope,
} from '@/services/realname/document-envelope'
import { validateRealnameFile } from '@/services/realname/file-validation'
import {
  type RealnameDocumentMasterKeyring,
  unwrapDocumentDataKey,
} from '@/services/realname/master-key'

import { createTestRealnameDocumentMasterKeyring } from '../fixtures/realname-master-key'

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvForTests()
})

describe('real-name document file safety', () => {
  it('derives allowed image types from magic bytes and ignores forged filename/content-type claims', async () => {
    const png = await sharp({
      create: { background: '#ffffff', channels: 3, height: 128, width: 128 },
    })
      .png()
      .toBuffer()
    const validated = await validateRealnameFile(png, 1024 * 1024)
    expect(validated).toMatchObject({ contentType: 'image/png', fileKind: 'png' })
    expect(validated.sha256).toMatch(/^[a-f0-9]{64}$/u)

    const forged = new File([Buffer.concat([Buffer.from('MZ'), randomBytes(64)])], 'identity.png', {
      type: 'image/png',
    })
    await expect(
      validateRealnameFile(new Uint8Array(await forged.arrayBuffer()), 1024 * 1024),
    ).rejects.toMatchObject({ code: 'REALNAME_DOCUMENT_MALICIOUS' })

    const disguisedText = new File(
      [Buffer.from('not an image despite forged metadata'.repeat(2))],
      'identity.jpg',
      { type: 'image/jpeg' },
    )
    await expect(
      validateRealnameFile(new Uint8Array(await disguisedText.arrayBuffer()), 1024 * 1024),
    ).rejects.toMatchObject({ code: 'REALNAME_DOCUMENT_TYPE_NOT_ALLOWED' })

    await expect(validateRealnameFile(Buffer.from('fake.png'), 1024 * 1024)).rejects.toMatchObject({
      code: 'REALNAME_DOCUMENT_INVALID',
    })
    await expect(
      validateRealnameFile(Buffer.concat([png, Buffer.from('trailing-polyglot')]), 1024 * 1024),
    ).rejects.toMatchObject({ code: 'REALNAME_DOCUMENT_INVALID' })

    const invalidLength = Buffer.from(png)
    invalidLength.writeUInt32BE(0xffff_ffff, 8)
    await expect(validateRealnameFile(invalidLength, 1024 * 1024)).rejects.toMatchObject({
      code: 'REALNAME_DOCUMENT_INVALID',
    })
    const invalidChunkType = Buffer.from(png)
    invalidChunkType.write('IH1R', 12, 'ascii')
    await expect(validateRealnameFile(invalidChunkType, 1024 * 1024)).rejects.toMatchObject({
      code: 'REALNAME_DOCUMENT_INVALID',
    })

    const jpeg = await sharp({
      create: { background: '#ffffff', channels: 3, height: 128, width: 128 },
    })
      .jpeg()
      .toBuffer()
    await expect(validateRealnameFile(jpeg.subarray(0, -2), 1024 * 1024)).rejects.toMatchObject({
      code: 'REALNAME_DOCUMENT_INVALID',
    })
  })

  it('rejects active PDF content, known malware signatures, executables and oversized input', async () => {
    for (const token of ['/OpenAction', '/JavaScript', '/JS', '/Launch', '/EmbeddedFile']) {
      const activePdf = Buffer.from(`%PDF-1.4\n1 0 obj << ${token} 2 0 R >> endobj\n%%EOF\n`)
      await expect(validateRealnameFile(activePdf, 1024 * 1024)).rejects.toMatchObject({
        code: 'REALNAME_DOCUMENT_MALICIOUS',
      })
    }
    const eicarPdf = Buffer.from(
      '%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF\n',
    )
    await expect(validateRealnameFile(eicarPdf, 1024 * 1024)).rejects.toMatchObject({
      code: 'REALNAME_DOCUMENT_MALICIOUS',
    })
    for (const magic of [
      Buffer.from('MZ'),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    ]) {
      await expect(
        validateRealnameFile(Buffer.concat([magic, randomBytes(64)]), 1024 * 1024),
      ).rejects.toMatchObject({ code: 'REALNAME_DOCUMENT_MALICIOUS' })
    }
    await expect(validateRealnameFile(randomBytes(2048), 1024)).rejects.toMatchObject({
      code: 'REALNAME_DOCUMENT_TOO_LARGE',
    })
  })
})

describe('real-name document envelope encryption', () => {
  it('uses independent per-object data keys and keeps plaintext out of storage', async () => {
    const keyring = createTestRealnameDocumentMasterKeyring()
    const plaintext = Buffer.from('unique-private-identity-document-content')
    const sha256 = createHash('sha256').update(plaintext).digest('hex')
    const first = await encryptDocumentEnvelope({
      body: plaintext,
      contentType: 'application/pdf',
      keyring,
      sha256,
    })
    const second = await encryptDocumentEnvelope({
      body: plaintext,
      contentType: 'application/pdf',
      keyring,
      sha256,
    })
    expect(first.metadata.encryptedDataKey).not.toBe(second.metadata.encryptedDataKey)
    const firstDataKey = unwrapDocumentDataKey({
      encryptedDataKey: first.metadata.encryptedDataKey,
      keyring,
      masterKeyVersion: first.metadata.masterKeyVersion,
    })
    const secondDataKey = unwrapDocumentDataKey({
      encryptedDataKey: second.metadata.encryptedDataKey,
      keyring,
      masterKeyVersion: second.metadata.masterKeyVersion,
    })
    expect(firstDataKey).not.toEqual(secondDataKey)
    firstDataKey.fill(0)
    secondDataKey.fill(0)
    expect(Buffer.from(first.body).includes(plaintext)).toBe(false)
    await expect(
      decryptDocumentEnvelope({ body: first.body, expected: first.metadata, keyring }),
    ).resolves.toEqual(plaintext)
  })

  it('requires GCM final authentication instead of trusting a matching metadata copy', async () => {
    const keyring = createTestRealnameDocumentMasterKeyring()
    const plaintext = Buffer.from('authenticated-private-document')
    const encrypted = await encryptDocumentEnvelope({
      body: plaintext,
      contentType: 'application/pdf',
      keyring,
      sha256: createHash('sha256').update(plaintext).digest('hex'),
    })
    const tampered = Buffer.from(encrypted.body)
    const headerLength = tampered.readUInt32BE(Buffer.byteLength('WANMI-RN1'))
    const tagStart = Buffer.byteLength('WANMI-RN1') + 4 + headerLength
    tampered[tagStart] ^= 1
    const expected = {
      ...encrypted.metadata,
      authTag: tampered.subarray(tagStart, tagStart + 16).toString('base64url'),
    }
    await expect(
      decryptDocumentEnvelope({
        body: tampered,
        expected,
        keyring,
      }),
    ).rejects.toMatchObject({ code: 'REALNAME_DOCUMENT_UNAVAILABLE' })
  })

  it('keeps objects readable after active master-key rotation while the old version remains', async () => {
    const oldKey = randomBytes(32)
    const newKey = randomBytes(32)
    const oldKeyring = createTestRealnameDocumentMasterKeyring({
      activeVersion: 'v1',
      keys: new Map([['v1', oldKey]]),
    })
    const plaintext = Buffer.from('rotation-safe-private-document')
    const encrypted = await encryptDocumentEnvelope({
      body: plaintext,
      contentType: 'application/pdf',
      keyring: oldKeyring,
      sha256: createHash('sha256').update(plaintext).digest('hex'),
    })
    const rotatedKeyring = createTestRealnameDocumentMasterKeyring({
      activeVersion: 'v2',
      keys: new Map([
        ['v1', oldKey],
        ['v2', newKey],
      ]),
    })
    await expect(
      decryptDocumentEnvelope({
        body: encrypted.body,
        expected: encrypted.metadata,
        keyring: rotatedKeyring,
      }),
    ).resolves.toEqual(plaintext)
    oldKey.fill(0)
    newKey.fill(0)
  })

  it('rejects a missing master-key version without falling back to the active key', async () => {
    const oldKey = randomBytes(32)
    const oldKeyring = createTestRealnameDocumentMasterKeyring({
      activeVersion: 'v1',
      keys: new Map([['v1', oldKey]]),
    })
    const plaintext = Buffer.from('no-master-key-version-fallback')
    const encrypted = await encryptDocumentEnvelope({
      body: plaintext,
      contentType: 'application/pdf',
      keyring: oldKeyring,
      sha256: createHash('sha256').update(plaintext).digest('hex'),
    })
    const activeKey = randomBytes(32)
    const keyForVersion = vi.fn((version: string) =>
      version === 'v2' ? Buffer.from(activeKey) : undefined,
    )
    const rotatedWithoutOldKey: RealnameDocumentMasterKeyring = {
      activeVersion: 'v2',
      keyForVersion,
    }
    await expect(
      decryptDocumentEnvelope({
        body: encrypted.body,
        expected: encrypted.metadata,
        keyring: rotatedWithoutOldKey,
      }),
    ).rejects.toMatchObject({ code: 'REALNAME_DOCUMENT_UNAVAILABLE' })
    expect(keyForVersion).toHaveBeenCalledTimes(1)
    expect(keyForVersion).toHaveBeenCalledWith('v1')
    oldKey.fill(0)
    activeKey.fill(0)
  })

  it('validates master-key encoding, length and active version during startup parsing', () => {
    vi.stubEnv('REALNAME_DOCUMENT_MASTER_KEYS', 'v1:not-base64')
    vi.stubEnv('REALNAME_DOCUMENT_MASTER_KEY_VERSION', 'v1')
    resetEnvForTests()
    expect(() => getEnv()).toThrow(/base64-encoded-32-byte-key/u)

    vi.stubEnv('REALNAME_DOCUMENT_MASTER_KEYS', `v1:${Buffer.alloc(31, 1).toString('base64')}`)
    resetEnvForTests()
    expect(() => getEnv()).toThrow(/base64-encoded-32-byte-key/u)

    vi.stubEnv('REALNAME_DOCUMENT_MASTER_KEYS', `v1:${Buffer.alloc(32, 1).toString('base64')}`)
    vi.stubEnv('REALNAME_DOCUMENT_MASTER_KEY_VERSION', 'v2')
    resetEnvForTests()
    expect(() => getEnv()).toThrow(/active real-name document master key version/u)
  })

  it('does not construct a live OSS client while real provider access is disabled', async () => {
    vi.stubEnv('ALIYUN_OSS_REALNAME_MODE', 'live')
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_ALIYUN_OSS_REALNAME', 'false')
    vi.stubEnv('CI', 'false')
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_ID', '')
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_SECRET', '')
    resetEnvForTests()

    const objects = createRealnameObjectProvider()
    await expect(
      objects.upload({
        body: randomBytes(32),
        key: 'private/realname/test',
        traceId: 'disabled-oss',
      }),
    ).resolves.toMatchObject({ error: { code: 'PROVIDER_WRITE_DISABLED' }, ok: false })
  })

  it('keeps live OSS operations inside the private prefix and caps provider signatures', async () => {
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    resetEnvForTests()
    const put = vi.fn()
    const signatureUrl = vi.fn()
    const provider = new AliOssRealnameProvider(
      { delete: vi.fn(), get: vi.fn(), put, signatureUrl } as never,
      'private/realname',
    )
    await expect(
      provider.upload({ body: randomBytes(32), key: 'public/media/leak', traceId: 'scope' }),
    ).resolves.toMatchObject({ error: { code: 'OSS_KEY_OUT_OF_SCOPE' }, ok: false })
    await expect(
      provider.signRead({ expiresSeconds: 121, key: 'private/realname/object', traceId: 'ttl' }),
    ).resolves.toMatchObject({ error: { code: 'OSS_SIGN_SCOPE_INVALID' }, ok: false })
    expect(put).not.toHaveBeenCalled()
    expect(signatureUrl).not.toHaveBeenCalled()
  })
})
