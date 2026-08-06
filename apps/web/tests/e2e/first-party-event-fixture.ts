import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { ToolObservabilityBucket } from '@/payload-types'
import { TOOL_OBSERVABILITY_BUCKET_MS } from '@/services/observability/tool-observability'

import { getFixturePayload } from './redirect-fixture'

const statePath = resolve(process.cwd(), 'test-results/first-party-event-fixture.json')

type FixtureState = {
  observabilityBuckets: ToolObservabilityBucket[]
  observabilitySince: string
  startedAt: string
}

export async function createFirstPartyEventFixture() {
  const startedAt = new Date(Date.now() - 1_000).toISOString()
  const observabilitySince = new Date(
    Math.floor(Date.now() / TOOL_OBSERVABILITY_BUCKET_MS) * TOOL_OBSERVABILITY_BUCKET_MS - 1,
  ).toISOString()
  const payload = await getFixturePayload()
  const observabilityBuckets = await payload.find({
    collection: 'toolObservabilityBuckets',
    limit: 1_000,
    overrideAccess: true,
    pagination: false,
    where: { bucketStart: { greater_than: observabilitySince } },
  })
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(
    statePath,
    JSON.stringify({
      observabilityBuckets: observabilityBuckets.docs,
      observabilitySince,
      startedAt,
    }),
    'utf8',
  )
}

export async function removeFirstPartyEventFixture() {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as FixtureState
  const payload = await getFixturePayload()
  while (true) {
    const events = await payload.find({
      collection: 'firstPartyEvents',
      limit: 100,
      overrideAccess: true,
      where: { createdAt: { greater_than: state.startedAt } },
    })
    if (!events.docs.length) break
    for (const event of events.docs) {
      await payload.delete({ collection: 'firstPartyEvents', id: event.id, overrideAccess: true })
    }
  }
  const baseline = new Map(
    state.observabilityBuckets.map((document) => [String(document.id), document]),
  )
  const current = await payload.find({
    collection: 'toolObservabilityBuckets',
    limit: 1_000,
    overrideAccess: true,
    pagination: false,
    where: { bucketStart: { greater_than: state.observabilitySince } },
  })
  for (const document of current.docs) {
    const previous = baseline.get(String(document.id))
    if (!previous) {
      await payload.delete({
        collection: 'toolObservabilityBuckets',
        id: document.id,
        overrideAccess: true,
      })
      continue
    }
    const data = Object.fromEntries(
      Object.entries(previous).filter(([key]) => !['createdAt', 'id', 'updatedAt'].includes(key)),
    )
    await payload.update({
      collection: 'toolObservabilityBuckets',
      data: data as never,
      id: document.id,
      overrideAccess: true,
    })
    baseline.delete(String(document.id))
  }
  await unlink(statePath).catch(() => undefined)
}
