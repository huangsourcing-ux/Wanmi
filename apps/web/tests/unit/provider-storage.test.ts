import { describe, expect, it } from 'vitest'

import { MockRealnameObjectProvider } from '@/providers/oss-realname'
import { unwrapDocumentDataKey, wrapDocumentDataKey } from '@/services/realname/master-key'

import { createTestRealnameDocumentMasterKeyring } from '../fixtures/realname-master-key'

describe('private realname storage prototype', () => {
  it('uploads, reads, signs and deletes without touching public Media storage', async () => {
    const provider = new MockRealnameObjectProvider()
    const key = 'realname/customer-hash/document-hash'
    const body = new TextEncoder().encode('encrypted-fixture-only')
    const uploaded = await provider.upload({ body, key, traceId: 'trace-private-1' })
    expect(uploaded.ok && uploaded.data.etag).toHaveLength(64)
    const read = await provider.read({ key, traceId: 'trace-private-2' })
    expect(read.ok && new TextDecoder().decode(read.data.body)).toBe('encrypted-fixture-only')
    const signed = await provider.signRead({ expiresSeconds: 60, key, traceId: 'trace-private-3' })
    expect(signed.ok && signed.data.url).toContain('mock-oss://private/')
    await provider.deleteObject({ key, traceId: 'trace-private-4' })
    expect((await provider.read({ key, traceId: 'trace-private-5' })).ok).toBe(false)
  })

  it('keeps plaintext data keys out of the persisted ciphertext representation', async () => {
    const keyring = createTestRealnameDocumentMasterKeyring()
    const plaintext = new Uint8Array(32).fill(7)
    const wrapped = wrapDocumentDataKey(plaintext, keyring)
    expect(wrapped.encryptedDataKey).not.toContain(Buffer.from(plaintext).toString('base64url'))
    const decrypted = unwrapDocumentDataKey({
      encryptedDataKey: wrapped.encryptedDataKey,
      keyring,
      masterKeyVersion: wrapped.masterKeyVersion,
    })
    expect(decrypted).toEqual(Buffer.from(plaintext))
    decrypted.fill(0)
    plaintext.fill(0)
  })
})
