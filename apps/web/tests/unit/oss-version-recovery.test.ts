import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  type OssVersionRecoveryClient,
  runOssVersionRecoveryDrill,
} from '@/services/realname/oss-version-recovery'

import { createTestRealnameDocumentMasterKeyring } from '../fixtures/realname-master-key'

type StoredVersion = {
  body?: Uint8Array
  deleteMarker: boolean
  id: string
  name: string
}

class VersionedOssFixture implements OssVersionRecoveryClient {
  readonly deleteCalls: Array<{ name: string; versionId?: string }> = []
  readonly versions: StoredVersion[] = []
  putCount = 0
  tamperRestoredRead = false
  versioningStatus = 'Enabled'
  lifecycleDays = 30
  private nextVersion = 1
  private restored = false

  async getBucketVersioning() {
    return { versionStatus: this.versioningStatus }
  }

  async getBucketLifecycle() {
    return {
      rules: [
        {
          noncurrentVersionExpiration: { noncurrentDays: this.lifecycleDays },
          prefix: 'private/realname',
          status: 'Enabled',
        },
      ],
    }
  }

  async getBucketVersions(input: { prefix: string }) {
    const matches = this.versions.filter((item) => item.name.startsWith(input.prefix))
    return {
      deleteMarker: matches
        .filter((item) => item.deleteMarker)
        .map((item) => ({ name: item.name, versionId: item.id })),
      isTruncated: false,
      objects: matches
        .filter((item) => !item.deleteMarker)
        .map((item) => ({ name: item.name, versionId: item.id })),
    }
  }

  async put(name: string, body: Uint8Array) {
    this.putCount += 1
    const id = `version-${this.nextVersion++}`
    this.versions.push({ body: new Uint8Array(body), deleteMarker: false, id, name })
    return { res: { headers: { 'x-oss-version-id': id } } }
  }

  async delete(name: string, options?: { versionId?: string }) {
    this.deleteCalls.push({ name, ...options })
    if (options?.versionId) {
      const index = this.versions.findIndex(
        (item) => item.name === name && item.id === options.versionId,
      )
      if (index >= 0) {
        const [removed] = this.versions.splice(index, 1)
        if (removed.deleteMarker) this.restored = true
      }
      return {}
    }
    this.versions.push({
      deleteMarker: true,
      id: `version-${this.nextVersion++}`,
      name,
    })
    return {}
  }

  async get(name: string) {
    const versions = this.versions.filter((item) => item.name === name)
    const latest = versions.at(-1)
    if (!latest || latest.deleteMarker || !latest.body) {
      throw Object.assign(new Error('missing'), { code: 'NoSuchKey', status: 404 })
    }
    const content = new Uint8Array(latest.body)
    if (this.tamperRestoredRead && this.restored) content[content.length - 1] ^= 1
    return { content }
  }
}

const key = 'private/realname/recovery-drills/d7-09/test.wrn'
const plaintext = new TextEncoder().encode('approved synthetic identity fixture')
const sha256 = createHash('sha256').update(plaintext).digest('hex')

function execute(client: VersionedOssFixture) {
  return runOssVersionRecoveryDrill({
    allowedPrefix: 'private/realname',
    bucket: 'private-fixture',
    client,
    contentType: 'image/png',
    key,
    keyring: createTestRealnameDocumentMasterKeyring(),
    plaintext,
    sha256,
  })
}

describe('D7-09 OSS version recovery drill', () => {
  it('stops before every object mutation when versioning is not enabled', async () => {
    const client = new VersionedOssFixture()
    client.versioningStatus = 'Suspended'
    await expect(execute(client)).rejects.toMatchObject({
      code: 'VERSIONING_NOT_ENABLED',
    })
    expect(client.putCount).toBe(0)
    expect(client.deleteCalls).toEqual([])
  })

  it('stops before every object mutation when noncurrent retention is under 30 days', async () => {
    const client = new VersionedOssFixture()
    client.lifecycleDays = 29
    await expect(execute(client)).rejects.toMatchObject({
      code: 'LIFECYCLE_RETENTION_INSUFFICIENT',
    })
    expect(client.putCount).toBe(0)
    expect(client.deleteCalls).toEqual([])
  })

  it('removes the delete marker, decrypts with the upload-time version and cleans only its key', async () => {
    const client = new VersionedOssFixture()
    client.versions.push({
      body: new TextEncoder().encode('unrelated'),
      deleteMarker: false,
      id: 'unrelated-version',
      name: `${key}-unrelated`,
    })
    const result = await execute(client)
    expect(result).toMatchObject({
      cleanupVerified: true,
      contentSha256: sha256,
      decryptedWithOriginalMasterKeyVersion: true,
      masterKeyVersion: 'test-v1',
      noncurrentRetentionDays: 30,
      restoredCurrentVersion: true,
      versioningStatus: 'Enabled',
    })
    expect(client.versions).toEqual([
      expect.objectContaining({ id: 'unrelated-version', name: `${key}-unrelated` }),
    ])
    expect(client.deleteCalls.every((call) => call.name === key)).toBe(true)
  })

  it('fails the core assertion when restored ciphertext cannot be decrypted and still cleans up', async () => {
    const client = new VersionedOssFixture()
    client.tamperRestoredRead = true
    await expect(execute(client)).rejects.toMatchObject({
      code: 'RESTORED_DECRYPTION_FAILED',
    })
    expect(client.versions.filter((item) => item.name === key)).toEqual([])
  })
})
