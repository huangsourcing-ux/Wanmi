import { createHash, timingSafeEqual } from 'node:crypto'

import {
  decryptDocumentEnvelope,
  encryptDocumentEnvelope,
  type DocumentEnvelopeMetadata,
} from './document-envelope'
import type { RealnameDocumentMasterKeyring } from './master-key'

type LifecycleRule = {
  noncurrentVersionExpiration?: { noncurrentDays?: number | string }
  prefix?: string
  status?: string
  tag?: unknown
}

type ObjectVersion = { name: string; versionId: string }
type VersionPage = {
  deleteMarker?: ObjectVersion[]
  isTruncated: boolean
  nextKeyMarker?: string | null
  nextVersionIdMarker?: string | null
  objects?: ObjectVersion[]
}

export type OssVersionRecoveryClient = {
  delete(name: string, options?: { versionId?: string }): Promise<unknown>
  get(name: string, options?: { versionId?: string }): Promise<{ content: Uint8Array }>
  getBucketLifecycle(bucket: string): Promise<{ rules?: LifecycleRule[] | null }>
  getBucketVersioning(bucket: string): Promise<{ versionStatus?: string }>
  getBucketVersions(query: {
    keyMarker?: string
    maxKeys?: number
    prefix: string
    versionIdMarker?: string
  }): Promise<VersionPage>
  put(
    name: string,
    body: Uint8Array,
    options?: { meta?: Record<string, string>; mime?: string },
  ): Promise<{ res: { headers?: Record<string, unknown> } }>
}

export type OssVersionRecoveryResult = {
  cleanupVerified: true
  contentSha256: string
  decryptedWithOriginalMasterKeyVersion: true
  masterKeyVersion: string
  noncurrentRetentionDays: number
  restoredCurrentVersion: true
  versioningStatus: 'Enabled'
}

export type OssVersionRecoveryErrorCode =
  | 'CLEANUP_FAILED'
  | 'CURRENT_OBJECT_STILL_READABLE'
  | 'DELETE_MARKER_NOT_FOUND'
  | 'HISTORICAL_VERSION_NOT_FOUND'
  | 'LIFECYCLE_RETENTION_INSUFFICIENT'
  | 'OBJECT_KEY_COLLISION'
  | 'OBJECT_KEY_OUT_OF_SCOPE'
  | 'OBJECT_UPLOAD_VERSION_MISSING'
  | 'RESTORED_CONTENT_MISMATCH'
  | 'RESTORED_DECRYPTION_FAILED'
  | 'VERSIONING_NOT_ENABLED'

export class OssVersionRecoveryError extends Error {
  constructor(readonly code: OssVersionRecoveryErrorCode) {
    super(code)
    this.name = 'OssVersionRecoveryError'
  }
}

function fail(code: OssVersionRecoveryErrorCode): never {
  throw new OssVersionRecoveryError(code)
}

function exactVersions(
  page: VersionPage,
  key: string,
): {
  deleteMarkers: ObjectVersion[]
  objects: ObjectVersion[]
} {
  return {
    deleteMarkers: (page.deleteMarker ?? []).filter((item) => item.name === key),
    objects: (page.objects ?? []).filter((item) => item.name === key),
  }
}

async function listExactVersions(
  client: OssVersionRecoveryClient,
  key: string,
): Promise<{ deleteMarkers: ObjectVersion[]; objects: ObjectVersion[] }> {
  const deleteMarkers: ObjectVersion[] = []
  const objects: ObjectVersion[] = []
  let keyMarker: string | undefined
  let versionIdMarker: string | undefined
  do {
    const page = await client.getBucketVersions({
      ...(keyMarker ? { keyMarker } : {}),
      maxKeys: 100,
      prefix: key,
      ...(versionIdMarker ? { versionIdMarker } : {}),
    })
    const exact = exactVersions(page, key)
    deleteMarkers.push(...exact.deleteMarkers)
    objects.push(...exact.objects)
    if (!page.isTruncated) break
    if (!page.nextKeyMarker) fail('CLEANUP_FAILED')
    keyMarker = page.nextKeyMarker
    versionIdMarker = page.nextVersionIdMarker ?? undefined
  } while (keyMarker)
  return { deleteMarkers, objects }
}

function lifecycleRetentionDays(rules: LifecycleRule[] | null | undefined, key: string): number {
  const eligible = (rules ?? [])
    .filter((rule) => {
      const prefix = rule.prefix ?? ''
      const noTagFilter =
        rule.tag === undefined || (Array.isArray(rule.tag) && rule.tag.length === 0)
      return (
        (rule.status === undefined || rule.status === 'Enabled') &&
        key.startsWith(prefix) &&
        noTagFilter
      )
    })
    .map((rule) => Number(rule.noncurrentVersionExpiration?.noncurrentDays))
    .filter((days) => Number.isFinite(days) && days >= 30)
  if (eligible.length === 0) fail('LIFECYCLE_RETENTION_INSUFFICIENT')
  return Math.min(...eligible)
}

function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function uploadedVersionId(result: {
  res: { headers?: Record<string, unknown> }
}): string | undefined {
  const value = result.res.headers?.['x-oss-version-id']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function currentObjectMissing(
  client: OssVersionRecoveryClient,
  key: string,
): Promise<boolean> {
  try {
    await client.get(key)
    return false
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : ''
    const status =
      error && typeof error === 'object' && 'status' in error
        ? Number((error as { status: unknown }).status)
        : undefined
    return code === 'NoSuchKey' || status === 404
  }
}

async function deleteAllExactVersions(
  client: OssVersionRecoveryClient,
  key: string,
): Promise<void> {
  const versions = await listExactVersions(client, key)
  for (const item of [...versions.deleteMarkers, ...versions.objects]) {
    await client.delete(key, { versionId: item.versionId })
  }
  const remaining = await listExactVersions(client, key)
  if (remaining.deleteMarkers.length > 0 || remaining.objects.length > 0) {
    fail('CLEANUP_FAILED')
  }
}

export async function runOssVersionRecoveryDrill(input: {
  allowedPrefix: string
  bucket: string
  client: OssVersionRecoveryClient
  contentType: string
  key: string
  keyring: RealnameDocumentMasterKeyring
  plaintext: Uint8Array
  sha256: string
}): Promise<OssVersionRecoveryResult> {
  if (!input.key.startsWith(`${input.allowedPrefix}/recovery-drills/d7-09/`)) {
    fail('OBJECT_KEY_OUT_OF_SCOPE')
  }

  const versioning = await input.client.getBucketVersioning(input.bucket)
  if (versioning.versionStatus !== 'Enabled') fail('VERSIONING_NOT_ENABLED')
  const lifecycle = await input.client.getBucketLifecycle(input.bucket)
  const noncurrentRetentionDays = lifecycleRetentionDays(lifecycle.rules, input.key)

  const existing = await listExactVersions(input.client, input.key)
  if (existing.deleteMarkers.length > 0 || existing.objects.length > 0) {
    fail('OBJECT_KEY_COLLISION')
  }

  let mayHaveCreatedObject = false
  let primaryError: unknown
  let result: Omit<OssVersionRecoveryResult, 'cleanupVerified'> | undefined
  try {
    const encrypted = await encryptDocumentEnvelope({
      body: input.plaintext,
      contentType: input.contentType,
      keyring: input.keyring,
      sha256: input.sha256,
    })
    mayHaveCreatedObject = true
    const uploaded = await input.client.put(input.key, encrypted.body, {
      meta: {
        'master-key-version': encrypted.metadata.masterKeyVersion,
        sha256: encrypted.metadata.sha256,
      },
      mime: 'application/octet-stream',
    })
    const historicalVersionId = uploadedVersionId(uploaded)
    if (!historicalVersionId) fail('OBJECT_UPLOAD_VERSION_MISSING')

    await input.client.delete(input.key)
    if (!(await currentObjectMissing(input.client, input.key))) {
      fail('CURRENT_OBJECT_STILL_READABLE')
    }

    const afterDelete = await listExactVersions(input.client, input.key)
    const historicalVersion = afterDelete.objects.find(
      (item) => item.versionId === historicalVersionId,
    )
    if (!historicalVersion) fail('HISTORICAL_VERSION_NOT_FOUND')
    if (afterDelete.deleteMarkers.length !== 1) fail('DELETE_MARKER_NOT_FOUND')

    await input.client.delete(input.key, { versionId: afterDelete.deleteMarkers[0].versionId })
    const restored = await input.client.get(input.key)
    let decrypted: Uint8Array
    try {
      decrypted = await decryptDocumentEnvelope({
        body: restored.content,
        expected: encrypted.metadata as DocumentEnvelopeMetadata,
        keyring: input.keyring,
      })
    } catch {
      fail('RESTORED_DECRYPTION_FAILED')
    }
    try {
      const restoredSha256 = createHash('sha256').update(decrypted).digest('hex')
      if (restoredSha256 !== input.sha256 || !sameBytes(decrypted, input.plaintext)) {
        fail('RESTORED_CONTENT_MISMATCH')
      }
    } finally {
      decrypted.fill(0)
    }

    result = {
      contentSha256: input.sha256,
      decryptedWithOriginalMasterKeyVersion: true,
      masterKeyVersion: encrypted.metadata.masterKeyVersion,
      noncurrentRetentionDays,
      restoredCurrentVersion: true,
      versioningStatus: 'Enabled',
    }
  } catch (error) {
    primaryError = error
  } finally {
    if (mayHaveCreatedObject) {
      try {
        await deleteAllExactVersions(input.client, input.key)
      } catch {
        primaryError = new OssVersionRecoveryError('CLEANUP_FAILED')
      }
    }
  }

  if (primaryError) throw primaryError
  if (!result) fail('RESTORED_DECRYPTION_FAILED')
  return { ...result, cleanupVerified: true }
}
