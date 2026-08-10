import { createHash, randomBytes } from 'node:crypto'

import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetEnvForTests } from '@/lib/env'
import { createKmsProvider, MockKmsProvider } from '@/providers/kms'
import { AliOssRealnameProvider, createRealnameObjectProvider } from '@/providers/oss-realname'
import {
  decryptDocumentEnvelope,
  encryptDocumentEnvelope,
} from '@/services/realname/document-envelope'
import { validateRealnameFile } from '@/services/realname/file-validation'

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
  it('uses independent KMS data keys, authenticates metadata and clears plaintext from storage', async () => {
    const kms = new MockKmsProvider()
    const plaintext = Buffer.from('unique-private-identity-document-content')
    const sha256 = createHash('sha256').update(plaintext).digest('hex')
    const first = await encryptDocumentEnvelope({
      body: plaintext,
      contentType: 'application/pdf',
      kms,
      sha256,
      traceId: 'envelope-first',
    })
    const second = await encryptDocumentEnvelope({
      body: plaintext,
      contentType: 'application/pdf',
      kms,
      sha256,
      traceId: 'envelope-second',
    })
    expect(first.metadata.encryptedDataKey).not.toBe(second.metadata.encryptedDataKey)
    expect(Buffer.from(first.body).includes(plaintext)).toBe(false)
    await expect(
      decryptDocumentEnvelope({ body: first.body, expected: first.metadata, kms, traceId: 'read' }),
    ).resolves.toEqual(plaintext)

    const tampered = Uint8Array.from(first.body)
    tampered[tampered.length - 1] ^= 1
    await expect(
      decryptDocumentEnvelope({
        body: tampered,
        expected: first.metadata,
        kms,
        traceId: 'tampered',
      }),
    ).rejects.toMatchObject({ code: 'REALNAME_DOCUMENT_UNAVAILABLE' })
  })

  it('does not construct live OSS or KMS clients while real provider access is disabled', async () => {
    vi.stubEnv('ALIYUN_KMS_MODE', 'live')
    vi.stubEnv('ALIYUN_OSS_REALNAME_MODE', 'live')
    vi.stubEnv('ALLOW_REAL_PROVIDER_WRITES', 'true')
    vi.stubEnv('ALLOW_REAL_ALIYUN_KMS', 'false')
    vi.stubEnv('ALLOW_REAL_ALIYUN_OSS_REALNAME', 'false')
    vi.stubEnv('CI', 'false')
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_ID', '')
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_SECRET', '')
    resetEnvForTests()

    const kms = createKmsProvider()
    const objects = createRealnameObjectProvider()
    await expect(kms.generateDataKey({ traceId: 'disabled-kms' })).resolves.toMatchObject({
      error: { code: 'PROVIDER_WRITE_DISABLED' },
      ok: false,
    })
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
