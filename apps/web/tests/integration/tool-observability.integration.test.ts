import config from '@payload-config'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AdminRole } from '@/lib/domain'
import {
  PayloadToolObservabilityStore,
  TOOL_OBSERVABILITY_BUCKET_MS,
} from '@/services/observability/tool-observability'
import { readToolOperationsSnapshot } from '@/services/operations/read-operations-views'

let payload: Payload
const createdIds: Array<number | string> = []

function admin(role: AdminRole, id: number, status: 'active' | 'disabled' = 'active') {
  return {
    collection: 'admins' as const,
    email: `${role}-${id}@example.test`,
    id,
    roles: [role],
    status,
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  for (const id of createdIds.reverse()) {
    await payload
      .delete({ collection: 'toolObservabilityBuckets', id, overrideAccess: true })
      .catch(() => undefined)
  }
  await payload.db.destroy?.()
})

describe('D2 tool observability persistence and access', () => {
  it('persists only hourly aggregate tool/provider metrics and preserves quantiles and controls', async () => {
    const store = new PayloadToolObservabilityStore(async () => payload)
    const toolObservedAt = new Date('2098-01-02T03:04:05.000Z')
    await store.record({
      durationBucket: 'lt_100ms',
      observedAt: toolObservedAt,
      scope: 'tool',
      succeeded: true,
      tool: 'idn',
    })
    await store.record({
      durationBucket: '300_999ms',
      observedAt: toolObservedAt,
      scope: 'tool',
      succeeded: false,
      tool: 'idn',
    })
    await store.record({
      durationBucket: 'gte_10000ms',
      observedAt: toolObservedAt,
      scope: 'tool',
      succeeded: false,
      tool: 'idn',
    })

    const providerObservedAt = new Date(toolObservedAt.getTime() + TOOL_OBSERVABILITY_BUCKET_MS)
    await store.record({
      observedAt: providerObservedAt,
      operation: 'dns',
      outcome: 'started',
      provider: 'alidns',
      queueDepth: 8,
      scope: 'provider',
    })
    await store.record({
      durationBucket: '1000_2999ms',
      errorCategory: 'timeout',
      observedAt: providerObservedAt,
      operation: 'dns',
      outcome: 'failed',
      provider: 'alidns',
      queueDepth: 7,
      rejected: false,
      scope: 'provider',
    })

    const aggregate = await payload.find({
      collection: 'toolObservabilityBuckets',
      limit: 10,
      overrideAccess: true,
      sort: 'bucketStart',
      where: {
        or: [
          { bucketStart: { equals: '2098-01-02T03:00:00.000Z' } },
          { bucketStart: { equals: '2098-01-02T04:00:00.000Z' } },
        ],
      },
    })
    createdIds.push(...aggregate.docs.map((document) => document.id))
    expect(aggregate.docs).toHaveLength(2)
    expect(aggregate.docs[0]).toMatchObject({
      failureCount: 2,
      p50Bucket: '300_999ms',
      p95Bucket: 'gte_10000ms',
      requestCount: 3,
      scope: 'tool',
      successCount: 1,
      successRateBasisPoints: 3333,
      tool: 'idn',
    })
    expect(aggregate.docs[1]).toMatchObject({
      failureCount: 1,
      lastQueueDepth: 7,
      maxQueueDepth: 8,
      provider: 'alidns',
      providerOperation: 'dns',
      requestCount: 1,
      timeoutErrorCount: 1,
    })
    for (const document of aggregate.docs) {
      const serialized = JSON.stringify(document)
      expect(serialized).not.toContain('domainAscii')
      expect(serialized).not.toContain('query')
      expect(serialized).not.toContain('traceId')
      expect(document).not.toHaveProperty('tld')
    }
  })

  it('allows analyst/system reads while denying raw events and every generic mutation', async () => {
    const analyst = admin('analyst', 3101)
    const systemAdmin = admin('system_admin', 3102)
    const allowedReaders = [analyst, systemAdmin]
    for (const user of allowedReaders) {
      const result = await payload.find({
        collection: 'toolObservabilityBuckets',
        overrideAccess: false,
        user: user as never,
        where: { bucketStart: { equals: '2098-01-02T03:00:00.000Z' } },
      })
      expect(result.docs).toHaveLength(1)
    }

    const deniedReaders = [
      undefined,
      { collection: 'customers', id: 3103 },
      admin('content_editor', 3104),
      admin('ad_operator', 3105),
      admin('analyst', 3106, 'disabled'),
    ]
    for (const user of deniedReaders) {
      await expect(
        payload.find({
          collection: 'toolObservabilityBuckets',
          overrideAccess: false,
          user: user as never,
        }),
      ).rejects.toThrow()
    }

    for (const user of allowedReaders) {
      await expect(
        payload.create({
          collection: 'toolObservabilityBuckets',
          data: {
            bucketEnd: '2098-01-02T06:00:00.000Z',
            bucketKey: `forbidden-${user.id}`,
            bucketStart: '2098-01-02T05:00:00.000Z',
            lastObservedAt: '2098-01-02T05:00:00.000Z',
            scope: 'tool',
            tool: 'idn',
          },
          overrideAccess: false,
          user: user as never,
        } as never),
      ).rejects.toThrow()
    }
  })

  it('builds the dashboard only from access-controlled hourly buckets', async () => {
    const analyst = admin('analyst', 3110)
    const snapshot = await readToolOperationsSnapshot(
      payload,
      analyst as never,
      new Date('2098-01-02T05:00:00.000Z'),
    )
    expect(snapshot.toolMetrics).toEqual([
      expect.objectContaining({
        failureCount: 2,
        p50Bucket: '300_999ms',
        p95Bucket: 'gte_10000ms',
        requestCount: 3,
        successRateBasisPoints: 3333,
        tool: 'idn',
      }),
    ])
    expect(snapshot.providerMetrics).toEqual([
      expect.objectContaining({
        lastQueueDepth: 7,
        maxQueueDepth: 8,
        operation: 'dns',
        provider: 'alidns',
        requestCount: 1,
        timeoutErrorCount: 1,
      }),
    ])
    expect(JSON.stringify(snapshot)).not.toMatch(/domain|query|traceId|userId|session/i)

    for (const denied of [admin('ad_operator', 3111), admin('content_editor', 3112)]) {
      await expect(
        readToolOperationsSnapshot(payload, denied as never, new Date('2098-01-02T05:00:00.000Z')),
      ).rejects.toThrow('OPERATIONS_VIEW_FORBIDDEN')
    }
  })
})
