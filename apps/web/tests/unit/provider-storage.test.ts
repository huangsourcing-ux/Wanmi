import { describe, expect, it } from 'vitest'

import { MockKmsProvider } from '@/providers/kms'
import { MockRealnameObjectProvider } from '@/providers/oss-realname'

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
    const kms = new MockKmsProvider()
    const generated = await kms.generateDataKey({ traceId: 'trace-kms-1' })
    expect(generated.ok).toBe(true)
    if (!generated.ok) return
    const decrypted = await kms.decryptDataKey({
      ciphertext: generated.data.ciphertext,
      traceId: 'trace-kms-2',
    })
    expect(decrypted.ok && decrypted.data.plaintext).toEqual(generated.data.plaintext)
  })
})
