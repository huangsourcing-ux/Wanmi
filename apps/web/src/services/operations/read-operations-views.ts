import type { Payload, PayloadRequest } from 'payload'

import { countAsUser, findAsUser } from '@/access/local-api'
import { hasRole } from '@/access/roles'
import type {
  AuditLog,
  FormSubmission,
  PriceSnapshot,
  TldPage,
  ToolObservabilityBucket,
} from '@/payload-types'
import {
  FIRST_PARTY_DURATION_BUCKETS,
  type FirstPartyDurationBucket,
  type FirstPartyTool,
} from '@/schemas/analytics'
import {
  percentileBucket,
  type ToolObservabilityProvider,
  type ToolObservabilityProviderOperation,
} from '@/services/observability/tool-observability'

type AdminUser = NonNullable<PayloadRequest['user']>

const DURATION_FIELDS = {
  '100_299ms': 'latency100To299MsCount',
  '1000_2999ms': 'latency1000To2999MsCount',
  '3000_9999ms': 'latency3000To9999MsCount',
  '300_999ms': 'latency300To999MsCount',
  gte_10000ms: 'latencyGte10000MsCount',
  lt_100ms: 'latencyLt100MsCount',
} as const satisfies Record<FirstPartyDurationBucket, keyof ToolObservabilityBucket>

const CONTENT_COLLECTIONS = [
  ['articles', '文章'],
  ['topics', '专题'],
  ['helpPages', '帮助'],
  ['tldPages', 'TLD 页面'],
] as const

const CONTENT_STATUSES = ['draft', 'in_review', 'published', 'unpublished', 'archived'] as const
const ADVERTISING_STATUSES = {
  adCreatives: ['draft', 'pending_review', 'approved', 'rejected', 'disabled'],
  adSchedules: ['draft', 'scheduled', 'active', 'paused', 'ended', 'disabled'],
  advertisers: ['draft', 'active', 'paused', 'disabled'],
} as const

export type OperationsCountGroup = {
  href: string
  label: string
  statuses: Array<{ count: number; status: string }>
  total: number
}

export type AggregatedToolMetric = {
  failureCount: number
  p50Bucket?: FirstPartyDurationBucket
  p95Bucket?: FirstPartyDurationBucket
  requestCount: number
  successCount: number
  successRateBasisPoints: number
  tool: FirstPartyTool
}

export type AggregatedProviderMetric = {
  invalidResponseErrorCount: number
  lastQueueDepth: number
  maxQueueDepth: number
  operation: ToolObservabilityProviderOperation
  provider: ToolObservabilityProvider
  rateLimitedErrorCount: number
  rejectedCount: number
  requestCount: number
  timeoutErrorCount: number
  upstreamErrorCount: number
}

export type ToolOperationsSnapshot = {
  bucketCount: number
  generatedAt: string
  providerMetrics: AggregatedProviderMetric[]
  since: string
  toolMetrics: AggregatedToolMetric[]
  totals: Omit<AggregatedToolMetric, 'tool'>
}

function checkedAdd(left: number, right: unknown): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    Number(right) < 0
  ) {
    throw new RangeError('运营聚合桶包含无效计数')
  }
  const total = left + Number(right)
  if (!Number.isSafeInteger(total)) throw new RangeError('运营聚合计数溢出')
  return total
}

function successRateBasisPoints(successCount: number, requestCount: number): number {
  if (!requestCount) return 0
  return Number((BigInt(successCount) * 10_000n + BigInt(requestCount) / 2n) / BigInt(requestCount))
}

function emptyLatencyCounts(): Record<FirstPartyDurationBucket, number> {
  return Object.fromEntries(FIRST_PARTY_DURATION_BUCKETS.map((bucket) => [bucket, 0])) as Record<
    FirstPartyDurationBucket,
    number
  >
}

function mergeLatency(
  counts: Record<FirstPartyDurationBucket, number>,
  bucket: ToolObservabilityBucket,
) {
  for (const duration of FIRST_PARTY_DURATION_BUCKETS) {
    counts[duration] = checkedAdd(counts[duration], bucket[DURATION_FIELDS[duration]])
  }
}

function assertRole(user: AdminUser, roles: Parameters<typeof hasRole>[1]) {
  if (!hasRole(user, roles)) throw new Error('OPERATIONS_VIEW_FORBIDDEN')
}

async function countStatuses(
  payload: Payload,
  user: AdminUser,
  collection: string,
  statuses: readonly string[],
): Promise<Array<{ count: number; status: string }>> {
  return Promise.all(
    statuses.map(async (status) => ({
      count: (
        await countAsUser(payload, {
          collection,
          user,
          where: { status: { equals: status } },
        })
      ).totalDocs,
      status,
    })),
  )
}

async function countFieldValues(
  payload: Payload,
  user: AdminUser,
  collection: string,
  field: string,
  values: ReadonlyArray<{ label: string; value: boolean | string }>,
): Promise<Array<{ count: number; status: string }>> {
  return Promise.all(
    values.map(async ({ label, value }) => ({
      count: (
        await countAsUser(payload, {
          collection,
          user,
          where: { [field]: { equals: value } },
        })
      ).totalDocs,
      status: label,
    })),
  )
}

export async function readToolOperationsSnapshot(
  payload: Payload,
  user: AdminUser,
  now = new Date(),
): Promise<ToolOperationsSnapshot> {
  assertRole(user, ['analyst', 'system_admin'])
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1_000)
  const result = await findAsUser(payload, {
    collection: 'toolObservabilityBuckets',
    depth: 0,
    limit: 1_000,
    select: {
      bucketStart: true,
      failureCount: true,
      invalidResponseErrorCount: true,
      lastObservedAt: true,
      lastQueueDepth: true,
      latency1000To2999MsCount: true,
      latency100To299MsCount: true,
      latency3000To9999MsCount: true,
      latency300To999MsCount: true,
      latencyGte10000MsCount: true,
      latencyLt100MsCount: true,
      maxQueueDepth: true,
      provider: true,
      providerOperation: true,
      rateLimitedErrorCount: true,
      rejectedCount: true,
      requestCount: true,
      scope: true,
      successCount: true,
      timeoutErrorCount: true,
      tool: true,
      upstreamErrorCount: true,
    },
    sort: 'bucketStart',
    user,
    where: { bucketStart: { greater_than_equal: since.toISOString() } },
  })
  const buckets = result.docs as ToolObservabilityBucket[]
  const toolMap = new Map<
    FirstPartyTool,
    {
      failureCount: number
      latency: Record<FirstPartyDurationBucket, number>
      requestCount: number
      successCount: number
    }
  >()
  const providerMap = new Map<string, AggregatedProviderMetric & { lastObservedAt: string }>()
  const totalLatency = emptyLatencyCounts()
  let totalRequests = 0
  let totalSuccesses = 0
  let totalFailures = 0

  for (const bucket of buckets) {
    if (bucket.scope === 'tool' && bucket.tool) {
      const aggregate = toolMap.get(bucket.tool) ?? {
        failureCount: 0,
        latency: emptyLatencyCounts(),
        requestCount: 0,
        successCount: 0,
      }
      aggregate.requestCount = checkedAdd(aggregate.requestCount, bucket.requestCount)
      aggregate.successCount = checkedAdd(aggregate.successCount, bucket.successCount)
      aggregate.failureCount = checkedAdd(aggregate.failureCount, bucket.failureCount)
      mergeLatency(aggregate.latency, bucket)
      mergeLatency(totalLatency, bucket)
      totalRequests = checkedAdd(totalRequests, bucket.requestCount)
      totalSuccesses = checkedAdd(totalSuccesses, bucket.successCount)
      totalFailures = checkedAdd(totalFailures, bucket.failureCount)
      toolMap.set(bucket.tool, aggregate)
      continue
    }
    if (bucket.scope !== 'provider' || !bucket.provider || !bucket.providerOperation) continue
    const key = `${bucket.provider}:${bucket.providerOperation}`
    const aggregate = providerMap.get(key) ?? {
      invalidResponseErrorCount: 0,
      lastObservedAt: '',
      lastQueueDepth: 0,
      maxQueueDepth: 0,
      operation: bucket.providerOperation,
      provider: bucket.provider,
      rateLimitedErrorCount: 0,
      rejectedCount: 0,
      requestCount: 0,
      timeoutErrorCount: 0,
      upstreamErrorCount: 0,
    }
    aggregate.requestCount = checkedAdd(aggregate.requestCount, bucket.requestCount)
    aggregate.timeoutErrorCount = checkedAdd(aggregate.timeoutErrorCount, bucket.timeoutErrorCount)
    aggregate.rateLimitedErrorCount = checkedAdd(
      aggregate.rateLimitedErrorCount,
      bucket.rateLimitedErrorCount,
    )
    aggregate.upstreamErrorCount = checkedAdd(
      aggregate.upstreamErrorCount,
      bucket.upstreamErrorCount,
    )
    aggregate.invalidResponseErrorCount = checkedAdd(
      aggregate.invalidResponseErrorCount,
      bucket.invalidResponseErrorCount,
    )
    aggregate.rejectedCount = checkedAdd(aggregate.rejectedCount, bucket.rejectedCount)
    aggregate.maxQueueDepth = Math.max(aggregate.maxQueueDepth, bucket.maxQueueDepth)
    if (!aggregate.lastObservedAt || bucket.lastObservedAt > aggregate.lastObservedAt) {
      aggregate.lastObservedAt = bucket.lastObservedAt
      aggregate.lastQueueDepth = bucket.lastQueueDepth
    }
    providerMap.set(key, aggregate)
  }

  const toolMetrics = [...toolMap.entries()]
    .map(([tool, aggregate]) => ({
      failureCount: aggregate.failureCount,
      p50Bucket: percentileBucket(aggregate.latency, 50),
      p95Bucket: percentileBucket(aggregate.latency, 95),
      requestCount: aggregate.requestCount,
      successCount: aggregate.successCount,
      successRateBasisPoints: successRateBasisPoints(
        aggregate.successCount,
        aggregate.requestCount,
      ),
      tool,
    }))
    .sort((left, right) => left.tool.localeCompare(right.tool))

  return {
    bucketCount: buckets.length,
    generatedAt: now.toISOString(),
    providerMetrics: [...providerMap.values()]
      .map((metric) => ({
        invalidResponseErrorCount: metric.invalidResponseErrorCount,
        lastQueueDepth: metric.lastQueueDepth,
        maxQueueDepth: metric.maxQueueDepth,
        operation: metric.operation,
        provider: metric.provider,
        rateLimitedErrorCount: metric.rateLimitedErrorCount,
        rejectedCount: metric.rejectedCount,
        requestCount: metric.requestCount,
        timeoutErrorCount: metric.timeoutErrorCount,
        upstreamErrorCount: metric.upstreamErrorCount,
      }))
      .sort((left, right) =>
        `${left.provider}:${left.operation}`.localeCompare(`${right.provider}:${right.operation}`),
      ),
    since: since.toISOString(),
    toolMetrics,
    totals: {
      failureCount: totalFailures,
      p50Bucket: percentileBucket(totalLatency, 50),
      p95Bucket: percentileBucket(totalLatency, 95),
      requestCount: totalRequests,
      successCount: totalSuccesses,
      successRateBasisPoints: successRateBasisPoints(totalSuccesses, totalRequests),
    },
  }
}

export async function readContentOperationsSnapshot(payload: Payload, user: AdminUser) {
  assertRole(user, ['content_editor', 'system_admin'])
  return Promise.all(
    CONTENT_COLLECTIONS.map(async ([collection, label]) => {
      const statuses = await Promise.all(
        CONTENT_STATUSES.map(async (status) => ({
          count: (
            await countAsUser(payload, {
              collection,
              draft: true,
              user,
              where: { workflowStatus: { equals: status } },
            })
          ).totalDocs,
          status,
        })),
      )
      return {
        href: `/admin/collections/${collection}`,
        label,
        statuses,
        total: statuses.reduce((sum, entry) => sum + entry.count, 0),
      } satisfies OperationsCountGroup
    }),
  )
}

export async function readAdvertisingOperationsSnapshot(payload: Payload, user: AdminUser) {
  assertRole(user, ['ad_operator', 'analyst', 'system_admin'])
  const statusDefinitions = [
    ['advertisers', '广告主'],
    ['adCreatives', '素材'],
    ['adSchedules', '排期'],
  ] as const
  const statusGroups = await Promise.all(
    statusDefinitions.map(async ([collection, label]) => {
      const statuses = await countStatuses(
        payload,
        user,
        collection,
        ADVERTISING_STATUSES[collection],
      )
      return {
        href: `/admin/collections/${collection}`,
        label,
        statuses,
        total: statuses.reduce((sum, entry) => sum + entry.count, 0),
      } satisfies OperationsCountGroup
    }),
  )
  const booleanDefinitions = [
    [
      'adMedia',
      '广告媒体',
      'reviewed',
      [
        { label: 'reviewed', value: true },
        { label: 'pending', value: false },
      ],
    ],
    [
      'adPlacements',
      '广告位',
      'enabled',
      [
        { label: 'enabled', value: true },
        { label: 'disabled', value: false },
      ],
    ],
  ] as const
  const booleanGroups = await Promise.all(
    booleanDefinitions.map(async ([collection, label, field, values]) => {
      const statuses = await countFieldValues(payload, user, collection, field, values)
      return {
        href: `/admin/collections/${collection}`,
        label,
        statuses,
        total: statuses.reduce((sum, entry) => sum + entry.count, 0),
      } satisfies OperationsCountGroup
    }),
  )
  return [...statusGroups, ...booleanGroups]
}

export async function readTldPricingOperationsSnapshot(payload: Payload, user: AdminUser) {
  assertRole(user, ['content_editor', 'system_admin'])
  const pricingVisible = hasRole(user, ['system_admin'])
  const [tldResult, priceResult] = await Promise.all([
    findAsUser(payload, {
      collection: 'tldPages',
      depth: 0,
      draft: true,
      limit: 100,
      select: { slug: true, title: true, workflowStatus: true },
      sort: 'slug',
      user,
    }),
    pricingVisible
      ? findAsUser(payload, {
          collection: 'priceSnapshots',
          depth: 0,
          limit: 100,
          select: {
            currency: true,
            providerObservedAt: true,
            registrationPriceMinor: true,
            renewalPriceMinor: true,
            tld: true,
          },
          sort: '-providerObservedAt',
          user,
        })
      : Promise.resolve(undefined),
  ])
  const tlds = (tldResult.docs as TldPage[]).map((document) => ({
    id: document.id,
    slug: document.slug,
    status: document.workflowStatus,
    title: document.title,
  }))
  if (!priceResult) return { latestPrices: [], pricingVisible: false, tlds }
  const seen = new Set<string>()
  const latestPrices = (priceResult.docs as PriceSnapshot[])
    .filter((snapshot) => {
      if (seen.has(snapshot.tld)) return false
      seen.add(snapshot.tld)
      return true
    })
    .map((snapshot) => ({
      currency: snapshot.currency,
      observedAt: snapshot.providerObservedAt,
      registrationPriceMinor: snapshot.registrationPriceMinor,
      renewalPriceMinor: snapshot.renewalPriceMinor,
      tld: snapshot.tld,
    }))
  return { latestPrices, pricingVisible: true, tlds }
}

export async function readFeedbackOperationsSnapshot(payload: Payload, user: AdminUser) {
  assertRole(user, ['ad_operator', 'analyst', 'system_admin'])
  const result = await findAsUser(payload, {
    collection: 'form-submissions',
    depth: 0,
    limit: 50,
    select: {
      contactMasked: true,
      createdAt: true,
      purpose: true,
      status: true,
      summary: true,
      tool: true,
    },
    sort: '-createdAt',
    user,
  })
  return (result.docs as FormSubmission[]).map((submission) => ({
    contactMasked: submission.contactMasked,
    createdAt: submission.createdAt,
    id: submission.id,
    purpose: submission.purpose,
    status: submission.status,
    summary: submission.summary,
    tool: submission.tool,
  }))
}

export async function readAuditOperationsSnapshot(payload: Payload, user: AdminUser) {
  assertRole(user, ['ad_operator', 'system_admin'])
  const result = await findAsUser(payload, {
    collection: 'auditLogs',
    depth: 0,
    limit: 50,
    select: {
      action: true,
      actorType: true,
      createdAt: true,
      targetId: true,
      targetType: true,
    },
    sort: '-createdAt',
    user,
  })
  return (result.docs as AuditLog[]).map((entry) => ({
    action: entry.action,
    actorType: entry.actorType,
    createdAt: entry.createdAt,
    id: entry.id,
    targetId: entry.targetId,
    targetType: entry.targetType,
  }))
}
