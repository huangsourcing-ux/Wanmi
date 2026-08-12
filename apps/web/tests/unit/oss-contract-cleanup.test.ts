import { describe, expect, it, vi } from 'vitest'

import {
  deleteAllOssContractObjectVersions,
  type OssContractCleanupClient,
} from '@/services/realname/oss-contract-cleanup'

const allowedPrefix = 'private/realname'
const key = `${allowedPrefix}/contract-tests/d7-05/00000000-0000-4000-8000-000000000000.bin`

describe('OSS read-contract cleanup', () => {
  it('rejects keys outside the dedicated contract prefix before listing', async () => {
    const client: OssContractCleanupClient = {
      delete: vi.fn(),
      getBucketVersions: vi.fn(),
    }

    await expect(
      deleteAllOssContractObjectVersions({
        allowedPrefix,
        client,
        key: `${allowedPrefix}/customer-object.bin`,
      }),
    ).rejects.toThrow(/outside the dedicated prefix/u)
    expect(client.getBucketVersions).not.toHaveBeenCalled()
  })

  it('deletes every exact version across pages without touching prefix collisions', async () => {
    const deleteObject = vi.fn().mockResolvedValue(undefined)
    const getBucketVersions = vi
      .fn()
      .mockResolvedValueOnce({
        deleteMarker: [
          { name: key, versionId: 'marker-v2' },
          { name: `${key}.other`, versionId: 'other-marker' },
        ],
        isTruncated: true,
        nextKeyMarker: key,
        nextVersionIdMarker: 'object-v1',
        objects: [{ name: `${key}.other`, versionId: 'other-object' }],
      })
      .mockResolvedValueOnce({
        deleteMarker: [],
        isTruncated: false,
        objects: [{ name: key, versionId: 'object-v1' }],
      })
      .mockResolvedValueOnce({ deleteMarker: [], isTruncated: false, objects: [] })
    const client: OssContractCleanupClient = {
      delete: deleteObject,
      getBucketVersions,
    }

    await expect(
      deleteAllOssContractObjectVersions({ allowedPrefix, client, key }),
    ).resolves.toEqual({
      deleteMarkersRemoved: 1,
      objectVersionsRemoved: 1,
      remainingDeleteMarkers: 0,
      remainingObjectVersions: 0,
    })
    expect(deleteObject.mock.calls).toEqual([
      [key, { versionId: 'marker-v2' }],
      [key, { versionId: 'object-v1' }],
    ])
  })

  it('fails closed on invalid pagination or incomplete cleanup', async () => {
    const missingMarkerClient: OssContractCleanupClient = {
      delete: vi.fn(),
      getBucketVersions: vi.fn().mockResolvedValue({ isTruncated: true }),
    }
    await expect(
      deleteAllOssContractObjectVersions({
        allowedPrefix,
        client: missingMarkerClient,
        key,
      }),
    ).rejects.toThrow(/pagination marker/u)

    const remainingClient: OssContractCleanupClient = {
      delete: vi.fn().mockResolvedValue(undefined),
      getBucketVersions: vi
        .fn()
        .mockResolvedValueOnce({
          deleteMarker: [],
          isTruncated: false,
          objects: [{ name: key, versionId: 'object-v1' }],
        })
        .mockResolvedValueOnce({
          deleteMarker: [],
          isTruncated: false,
          objects: [{ name: key, versionId: 'object-v1' }],
        }),
    }
    await expect(
      deleteAllOssContractObjectVersions({ allowedPrefix, client: remainingClient, key }),
    ).rejects.toThrow(/verification failed/u)
  })
})
