type ObjectVersion = { name: string; versionId: string }

type VersionPage = {
  deleteMarker?: ObjectVersion[]
  isTruncated: boolean
  nextKeyMarker?: string | null
  nextVersionIdMarker?: string | null
  objects?: ObjectVersion[]
}

export type OssContractCleanupClient = {
  delete(name: string, options: { versionId: string }): Promise<unknown>
  getBucketVersions(query: {
    keyMarker?: string
    maxKeys: number
    prefix: string
    versionIdMarker?: string
  }): Promise<VersionPage>
}

export type OssContractCleanupResult = {
  deleteMarkersRemoved: number
  objectVersionsRemoved: number
  remainingDeleteMarkers: 0
  remainingObjectVersions: 0
}

function exactVersions(page: VersionPage, key: string): ObjectVersion[] {
  return [...(page.deleteMarker ?? []), ...(page.objects ?? [])].filter((item) => item.name === key)
}

async function listExactVersions(
  client: OssContractCleanupClient,
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
    const exact = new Set(exactVersions(page, key))
    deleteMarkers.push(...(page.deleteMarker ?? []).filter((item) => exact.has(item)))
    objects.push(...(page.objects ?? []).filter((item) => exact.has(item)))

    if (!page.isTruncated) break
    if (!page.nextKeyMarker) throw new Error('OSS contract cleanup pagination marker is missing')
    keyMarker = page.nextKeyMarker
    versionIdMarker = page.nextVersionIdMarker ?? undefined
  } while (keyMarker)

  return { deleteMarkers, objects }
}

export async function deleteAllOssContractObjectVersions(input: {
  allowedPrefix: string
  client: OssContractCleanupClient
  key: string
}): Promise<OssContractCleanupResult> {
  if (!input.key.startsWith(`${input.allowedPrefix}/contract-tests/d7-05/`)) {
    throw new Error('OSS contract cleanup key is outside the dedicated prefix')
  }

  const versions = await listExactVersions(input.client, input.key)
  for (const item of [...versions.deleteMarkers, ...versions.objects]) {
    await input.client.delete(input.key, { versionId: item.versionId })
  }

  const remaining = await listExactVersions(input.client, input.key)
  if (remaining.deleteMarkers.length > 0 || remaining.objects.length > 0) {
    throw new Error('OSS contract cleanup verification failed')
  }

  return {
    deleteMarkersRemoved: versions.deleteMarkers.length,
    objectVersionsRemoved: versions.objects.length,
    remainingDeleteMarkers: 0,
    remainingObjectVersions: 0,
  }
}
