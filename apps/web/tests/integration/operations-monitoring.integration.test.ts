import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { SiteSetting } from '@/payload-types'
import {
  DEFAULT_OPERATIONS_MONITORING_THRESHOLDS,
  operationsMonitoringThresholdsSchema,
} from '@/schemas/operations-monitoring'
import {
  OPERATIONS_MONITORING_STATE_KEY,
  readRealnameDocumentAccessTrail,
  runOperationsMonitoring,
} from '@/services/operations/monitoring'
import {
  COMMERCE_WORKER_HEARTBEAT_KEY,
  recordCommerceWorkerHeartbeat,
} from '@/services/operations/worker-heartbeat'

import {
  ensureAnchorSystemAdmin,
  findOrCreateUniqueFixture,
  ignorePayloadNotFound,
} from '../test-cleanup'

let payload: Payload
const fixturePrefix = `d7-monitoring-${randomUUID()}`
const created: Array<{
  collection: 'auditLogs' | 'reconciliations' | 'toolObservabilityBuckets'
  id: number | string
}> = []
const windowEndMs = Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000
const windowStart = new Date(windowEndMs - 3_600_000).toISOString()
const windowEnd = new Date(windowEndMs).toISOString()
const monitoringNow = new Date(windowEndMs + 5 * 60_000)
let monitoringStateFixture:
  | {
      created: boolean
      id: number | string
      original?: { description?: null | string; value: SiteSetting['value'] }
    }
  | undefined
let heartbeatFixture:
  | {
      created: boolean
      id: number | string
      original?: { description?: null | string; value: SiteSetting['value'] }
    }
  | undefined

async function req(traceSuffix: string) {
  return createLocalReq(
    {
      req: {
        headers: new Headers({ 'x-request-id': `${fixturePrefix}-${traceSuffix}` }),
      },
    },
    payload,
  )
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const state = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'siteSettings',
        data: {
          description: 'D7 operations monitoring integration fixture',
          key: OPERATIONS_MONITORING_STATE_KEY,
          value: {
            lastWindowEnd: windowStart,
            schemaVersion: 1,
            updatedAt: windowStart,
          },
        },
        overrideAccess: true,
      }),
    find: async () => {
      const found = await payload.find({
        collection: 'siteSettings',
        limit: 1,
        overrideAccess: true,
        where: { key: { equals: OPERATIONS_MONITORING_STATE_KEY } },
      })
      return found.docs[0]
    },
    path: 'key',
    tableName: 'site_settings',
  })
  monitoringStateFixture = {
    created: state.created,
    id: state.value.id,
    ...(state.created
      ? {}
      : {
          original: {
            description: state.value.description,
            value: state.value.value,
          },
        }),
  }
  await payload.update({
    collection: 'siteSettings',
    data: {
      description: 'D7 operations monitoring integration fixture',
      value: { lastWindowEnd: windowStart, schemaVersion: 1, updatedAt: windowStart },
    },
    id: state.value.id,
    overrideAccess: true,
  })

  const heartbeat = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'siteSettings',
        data: {
          description: 'D7 commerce Worker heartbeat integration fixture',
          key: COMMERCE_WORKER_HEARTBEAT_KEY,
          value: { lastSeenAt: windowEnd, role: 'commerce', schemaVersion: 1 },
        },
        overrideAccess: true,
      }),
    find: async () => {
      const found = await payload.find({
        collection: 'siteSettings',
        limit: 1,
        overrideAccess: true,
        where: { key: { equals: COMMERCE_WORKER_HEARTBEAT_KEY } },
      })
      return found.docs[0]
    },
    path: 'key',
    tableName: 'site_settings',
  })
  heartbeatFixture = {
    created: heartbeat.created,
    id: heartbeat.value.id,
    ...(heartbeat.created
      ? {}
      : {
          original: {
            description: heartbeat.value.description,
            value: heartbeat.value.value,
          },
        }),
  }
  await payload.update({
    collection: 'siteSettings',
    data: {
      description: 'D7 commerce Worker heartbeat integration fixture',
      value: { lastSeenAt: windowEnd, role: 'commerce', schemaVersion: 1 },
    },
    id: heartbeat.value.id,
    overrideAccess: true,
  })

  const bucket = await payload.create({
    collection: 'toolObservabilityBuckets',
    data: {
      bucketEnd: windowEnd,
      bucketKey: `${fixturePrefix}:tool:idn`,
      bucketStart: windowStart,
      failureCount: 1,
      lastObservedAt: new Date(windowEndMs - 5 * 60_000).toISOString(),
      requestCount: 1,
      scope: 'tool',
      successCount: 0,
      successRateBasisPoints: 0,
      timeoutErrorCount: 1,
      tool: 'idn',
    },
    overrideAccess: true,
  } as never)
  created.push({ collection: 'toolObservabilityBuckets', id: bucket.id })

  const balance = await payload.create({
    collection: 'reconciliations',
    data: {
      currency: 'CNY',
      differenceMinor: 0,
      kind: 'westdigital',
      ledger: 'westdigital_prepaid',
      periodEnd: new Date(windowEndMs - 5 * 60_000).toISOString(),
      periodStart: new Date(windowEndMs - 5 * 60_000 - 1).toISOString(),
      reconciliationKey: `${fixturePrefix}-balance`,
      recordKey: `balance-observation:${fixturePrefix}`,
      status: 'matched',
      summary: { correctionApplied: false, source: 'local-fixture' },
      traceId: `${fixturePrefix}-balance`,
    },
    overrideAccess: true,
  })
  created.push({ collection: 'reconciliations', id: balance.id })

  for (const [index, action] of [
    'realname.document.viewed',
    'realname.document.downloaded',
  ].entries()) {
    const audit = await payload.create({
      collection: 'auditLogs',
      data: {
        action,
        actorId: `admin-${index}`,
        actorType: 'admin',
        targetId: `document-${index}`,
        targetType: 'realname-document',
        traceId: `${fixturePrefix}-document-${index}`,
      },
      overrideAccess: true,
    })
    created.push({ collection: 'auditLogs', id: audit.id })
  }
})

afterAll(async () => {
  if (heartbeatFixture?.created) {
    await ignorePayloadNotFound(() =>
      payload.delete({
        collection: 'siteSettings',
        id: heartbeatFixture!.id,
        overrideAccess: true,
      }),
    )
  } else if (heartbeatFixture?.original) {
    await payload.update({
      collection: 'siteSettings',
      data: heartbeatFixture.original,
      id: heartbeatFixture.id,
      overrideAccess: true,
    })
  }
  if (monitoringStateFixture?.created) {
    await ignorePayloadNotFound(() =>
      payload.delete({
        collection: 'siteSettings',
        id: monitoringStateFixture!.id,
        overrideAccess: true,
      }),
    )
  } else if (monitoringStateFixture?.original) {
    await payload.update({
      collection: 'siteSettings',
      data: monitoringStateFixture.original,
      id: monitoringStateFixture.id,
      overrideAccess: true,
    })
  }
  const generatedAudits = await payload.find({
    collection: 'auditLogs',
    overrideAccess: true,
    pagination: false,
    where: { traceId: { contains: fixturePrefix } },
  })
  for (const audit of generatedAudits.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true }),
    )
  }
  for (const item of created.reverse()) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: item.collection, id: item.id, overrideAccess: true } as never),
    )
  }
  await payload.db.destroy?.()
}, 30_000)

describe('D7 operations monitoring persistence', () => {
  it('records a commerce Worker heartbeat without business or credential dimensions', async () => {
    const heartbeatReq = await req('commerce-worker-heartbeat')
    await recordCommerceWorkerHeartbeat(heartbeatReq, new Date(windowEndMs - 60_000))
    const stored = await payload.find({
      collection: 'siteSettings',
      limit: 1,
      overrideAccess: true,
      where: { key: { equals: COMMERCE_WORKER_HEARTBEAT_KEY } },
    })
    expect(stored.docs[0]?.value).toEqual({
      lastSeenAt: new Date(windowEndMs - 60_000).toISOString(),
      role: 'commerce',
      schemaVersion: 1,
    })
    expect(JSON.stringify(stored.docs[0]?.value)).not.toMatch(
      /phone|domain|customer|order|provider|credential|secret/iu,
    )
    await recordCommerceWorkerHeartbeat(heartbeatReq, new Date(windowEnd))
  })

  it('uses a PostgreSQL CAS so five concurrent executions emit one alert for one closed window', async () => {
    const thresholds = operationsMonitoringThresholdsSchema.parse({
      ...DEFAULT_OPERATIONS_MONITORING_THRESHOLDS,
      balance: { alertCount: 100, maximumObservationAgeMinutes: 30 },
      documents: { accessCount: 100, distinctDocumentCount: 100 },
      fulfillment: {
        failedOrUnknownCount: 100,
        staleSubmittedCount: 100,
        staleSubmittedMinutes: 30,
      },
      orders: { maximumOpenAgeMinutes: 30 * 24 * 60, openManualReviewCount: 100 },
      payments: { openManualReviewCount: 100 },
      reconciliation: { differenceCount: 100 },
      refunds: {
        failedOrUnknownCount: 100,
        staleSubmittedCount: 100,
        staleSubmittedMinutes: 30,
      },
      sms: { failureRateBasisPoints: 10_000, minimumAttempts: 100, unknownCount: 100 },
      tools: {
        failureRateBasisPoints: 10_000,
        firstPartyFailureCount: 100,
        minimumRequests: 100,
        rejectedCount: 100,
        timeoutCount: 1,
      },
    })
    const results = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        runOperationsMonitoring(await req(`concurrent-${index}`), {
          now: monitoringNow,
          thresholds,
        }),
      ),
    )
    expect(results.filter((result) => result.idempotentReplay)).toHaveLength(4)
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1)
    expect(results.reduce((total, result) => total + result.alertCount, 0)).toBe(1)

    const alerts = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'operations.monitoring.alerted' } },
          { targetId: { contains: ':tools:timeout_count' } },
          { traceId: { contains: fixturePrefix } },
        ],
      },
    })
    expect(alerts.totalDocs).toBe(1)
    expect(alerts.docs[0]?.metadata).toMatchObject({
      category: 'tools',
      condition: 'timeout_count',
      observed: 1,
      threshold: 1,
      windowEnd,
      windowStart,
    })
    expect(JSON.stringify(alerts.docs[0])).not.toMatch(
      /phone|documentContent|domainAscii|customerId|upstreamCost|markup|credential/iu,
    )
  })

  it('reconstructs who accessed which document and when without exposing document content', async () => {
    const admin = await ensureAnchorSystemAdmin(payload)
    const adminReq = await req('document-investigation')
    adminReq.user = { ...admin, collection: 'admins' } as never
    const trail = await readRealnameDocumentAccessTrail(adminReq, {
      end: windowEnd,
      start: windowStart,
    })
    const fixtures = trail.filter((event) => event.traceId.startsWith(fixturePrefix))
    expect(fixtures).toHaveLength(2)
    expect(fixtures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          access: 'view',
          actorId: 'admin-0',
          actorType: 'admin',
          documentId: 'document-0',
        }),
        expect.objectContaining({
          access: 'download',
          actorId: 'admin-1',
          actorType: 'admin',
          documentId: 'document-1',
        }),
      ]),
    )
    expect(JSON.stringify(fixtures)).not.toMatch(
      /body|content|objectKey|encrypted|identityNumber/iu,
    )
  })
})
