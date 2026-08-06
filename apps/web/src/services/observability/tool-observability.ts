import type { Payload } from 'payload'

import type { ToolObservabilityBucket } from '@/payload-types'
import {
  FIRST_PARTY_DURATION_BUCKETS,
  type FirstPartyDurationBucket,
  type FirstPartyTool,
} from '@/schemas/analytics'

export const TOOL_OBSERVABILITY_SCHEMA_VERSION = 1 as const
export const TOOL_OBSERVABILITY_BUCKET_MS = 60 * 60 * 1_000

export const TOOL_OBSERVABILITY_PROVIDERS = ['westdigital', 'whodat', 'alidns', 'node_tls'] as const

export const TOOL_OBSERVABILITY_PROVIDER_OPERATIONS = [
  'availability',
  'price',
  'whois',
  'dns',
  'tls',
] as const

export const TOOL_OBSERVABILITY_ERROR_CATEGORIES = [
  'timeout',
  'rate_limited',
  'upstream_error',
  'invalid_response',
] as const

export type ToolObservabilityProvider = (typeof TOOL_OBSERVABILITY_PROVIDERS)[number]
export type ToolObservabilityProviderOperation =
  (typeof TOOL_OBSERVABILITY_PROVIDER_OPERATIONS)[number]
export type ToolObservabilityErrorCategory = (typeof TOOL_OBSERVABILITY_ERROR_CATEGORIES)[number]

export type ToolOutcomeObservation = {
  durationBucket: FirstPartyDurationBucket
  observedAt?: Date
  scope: 'tool'
  succeeded: boolean
  tool: FirstPartyTool
}

export type ProviderObservation = {
  durationBucket?: FirstPartyDurationBucket
  errorCategory?: ToolObservabilityErrorCategory
  observedAt?: Date
  operation: ToolObservabilityProviderOperation
  outcome: 'failed' | 'started' | 'succeeded'
  provider: ToolObservabilityProvider
  queueDepth?: number
  rejected?: boolean
  scope: 'provider'
}

export type ToolObservabilityObservation = ProviderObservation | ToolOutcomeObservation

export interface ToolObservabilityStore {
  record(observation: ToolObservabilityObservation): Promise<void>
}

type LatencyCounts = Record<FirstPartyDurationBucket, number>

const durationFieldByBucket = {
  '100_299ms': 'latency100To299MsCount',
  '1000_2999ms': 'latency1000To2999MsCount',
  '3000_9999ms': 'latency3000To9999MsCount',
  '300_999ms': 'latency300To999MsCount',
  gte_10000ms: 'latencyGte10000MsCount',
  lt_100ms: 'latencyLt100MsCount',
} as const satisfies Record<FirstPartyDurationBucket, keyof ToolObservabilityBucket>

const errorFieldByCategory = {
  invalid_response: 'invalidResponseErrorCount',
  rate_limited: 'rateLimitedErrorCount',
  timeout: 'timeoutErrorCount',
  upstream_error: 'upstreamErrorCount',
} as const satisfies Record<ToolObservabilityErrorCategory, keyof ToolObservabilityBucket>

type CounterField =
  | (typeof durationFieldByBucket)[FirstPartyDurationBucket]
  | (typeof errorFieldByCategory)[ToolObservabilityErrorCategory]
  | 'failureCount'
  | 'rejectedCount'
  | 'requestCount'
  | 'successCount'

type AggregateData = Pick<ToolObservabilityBucket, CounterField> & {
  bucketEnd: string
  bucketKey: string
  bucketStart: string
  lastObservedAt: string
  lastQueueDepth: number
  maxQueueDepth: number
  p50Bucket?: FirstPartyDurationBucket | null
  p95Bucket?: FirstPartyDurationBucket | null
  provider?: ToolObservabilityProvider | null
  providerOperation?: ToolObservabilityProviderOperation | null
  schemaVersion: typeof TOOL_OBSERVABILITY_SCHEMA_VERSION
  scope: 'provider' | 'tool'
  successRateBasisPoints: number
  tool?: FirstPartyTool | null
}

function checkedCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('observability counter is not a safe non-negative integer')
  }
  return value
}

function checkedAdd(left: number, right: number): number {
  const total = checkedCount(left) + checkedCount(right)
  if (!Number.isSafeInteger(total)) throw new RangeError('observability counter overflow')
  return total
}

function latencyCounts(document?: ToolObservabilityBucket): LatencyCounts {
  return Object.fromEntries(
    FIRST_PARTY_DURATION_BUCKETS.map((bucket) => [
      bucket,
      checkedCount(document?.[durationFieldByBucket[bucket]] ?? 0),
    ]),
  ) as LatencyCounts
}

export function percentileBucket(
  counts: Readonly<LatencyCounts>,
  percentile: 50 | 95,
): FirstPartyDurationBucket | undefined {
  const total = FIRST_PARTY_DURATION_BUCKETS.reduce(
    (sum, bucket) => checkedAdd(sum, counts[bucket]),
    0,
  )
  if (total === 0) return undefined
  const rank = Number((BigInt(total) * BigInt(percentile) + 99n) / 100n)
  let cumulative = 0
  for (const bucket of FIRST_PARTY_DURATION_BUCKETS) {
    cumulative = checkedAdd(cumulative, counts[bucket])
    if (cumulative >= rank) return bucket
  }
  return FIRST_PARTY_DURATION_BUCKETS.at(-1)
}

function successRateBasisPoints(successCount: number, requestCount: number): number {
  if (requestCount === 0) return 0
  const numerator = BigInt(checkedCount(successCount)) * 10_000n
  const denominator = BigInt(checkedCount(requestCount))
  return Number((numerator + denominator / 2n) / denominator)
}

export function observabilityBucketStart(observedAt: Date): Date {
  const timestamp = observedAt.getTime()
  if (!Number.isFinite(timestamp)) throw new RangeError('invalid observability timestamp')
  return new Date(
    Math.floor(timestamp / TOOL_OBSERVABILITY_BUCKET_MS) * TOOL_OBSERVABILITY_BUCKET_MS,
  )
}

function identity(observation: ToolObservabilityObservation, bucketStart: string): string {
  const subject =
    observation.scope === 'tool'
      ? `tool:${observation.tool}`
      : `provider:${observation.provider}:${observation.operation}`
  return `v${TOOL_OBSERVABILITY_SCHEMA_VERSION}:${bucketStart}:${subject}`
}

function latestIso(left: string | undefined, right: string): string {
  if (!left) return right
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function aggregateData(
  observation: ToolObservabilityObservation,
  bucketKey: string,
  bucketStart: Date,
  document?: ToolObservabilityBucket,
): AggregateData {
  const observedAt = (observation.observedAt ?? new Date()).toISOString()
  const requestIncrement = observation.scope === 'tool' || observation.outcome !== 'started' ? 1 : 0
  const successIncrement =
    observation.scope === 'tool'
      ? Number(observation.succeeded)
      : Number(observation.outcome === 'succeeded')
  const failureIncrement = requestIncrement - successIncrement
  const requestCount = checkedAdd(document?.requestCount ?? 0, requestIncrement)
  const successCount = checkedAdd(document?.successCount ?? 0, successIncrement)
  const failureCount = checkedAdd(document?.failureCount ?? 0, failureIncrement)
  const counts = latencyCounts(document)
  if (observation.durationBucket) {
    counts[observation.durationBucket] = checkedAdd(counts[observation.durationBucket], 1)
  }

  const errors = Object.fromEntries(
    TOOL_OBSERVABILITY_ERROR_CATEGORIES.map((category) => {
      const field = errorFieldByCategory[category]
      const increment =
        observation.scope === 'provider' && observation.errorCategory === category ? 1 : 0
      return [field, checkedAdd(document?.[field] ?? 0, increment)]
    }),
  ) as Pick<AggregateData, (typeof errorFieldByCategory)[ToolObservabilityErrorCategory]>

  const queueDepth =
    observation.scope === 'provider' && observation.queueDepth !== undefined
      ? checkedCount(observation.queueDepth)
      : checkedCount(document?.lastQueueDepth ?? 0)
  const rejectedIncrement =
    observation.scope === 'provider' && observation.outcome === 'failed' && observation.rejected
      ? 1
      : 0

  return {
    bucketEnd: new Date(bucketStart.getTime() + TOOL_OBSERVABILITY_BUCKET_MS).toISOString(),
    bucketKey,
    bucketStart: bucketStart.toISOString(),
    failureCount,
    ...errors,
    lastObservedAt: latestIso(document?.lastObservedAt, observedAt),
    lastQueueDepth: queueDepth,
    latency100To299MsCount: counts['100_299ms'],
    latency1000To2999MsCount: counts['1000_2999ms'],
    latency3000To9999MsCount: counts['3000_9999ms'],
    latency300To999MsCount: counts['300_999ms'],
    latencyGte10000MsCount: counts.gte_10000ms,
    latencyLt100MsCount: counts.lt_100ms,
    maxQueueDepth: Math.max(checkedCount(document?.maxQueueDepth ?? 0), queueDepth),
    p50Bucket: percentileBucket(counts, 50),
    p95Bucket: percentileBucket(counts, 95),
    ...(observation.scope === 'provider'
      ? { provider: observation.provider, providerOperation: observation.operation }
      : { tool: observation.tool }),
    rejectedCount: checkedAdd(document?.rejectedCount ?? 0, rejectedIncrement),
    requestCount,
    schemaVersion: TOOL_OBSERVABILITY_SCHEMA_VERSION,
    scope: observation.scope,
    successCount,
    successRateBasisPoints: successRateBasisPoints(successCount, requestCount),
  }
}

export class PayloadToolObservabilityStore implements ToolObservabilityStore {
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly getPayload: () => Promise<Payload>) {}

  async record(observation: ToolObservabilityObservation): Promise<void> {
    const observedAt = observation.observedAt ?? new Date()
    const bucketStart = observabilityBucketStart(observedAt)
    const bucketKey = identity(observation, bucketStart.toISOString())
    const previous = this.chains.get(bucketKey) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => this.persist({ ...observation, observedAt }, bucketKey, bucketStart))
    this.chains.set(bucketKey, current)
    try {
      await current
    } finally {
      if (this.chains.get(bucketKey) === current) this.chains.delete(bucketKey)
    }
  }

  private async find(bucketKey: string): Promise<ToolObservabilityBucket | undefined> {
    const payload = await this.getPayload()
    const result = await payload.find({
      collection: 'toolObservabilityBuckets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { bucketKey: { equals: bucketKey } },
    })
    return result.docs[0]
  }

  private async persist(
    observation: ToolObservabilityObservation,
    bucketKey: string,
    bucketStart: Date,
  ): Promise<void> {
    const payload = await this.getPayload()
    const existing = await this.find(bucketKey)
    const data = aggregateData(observation, bucketKey, bucketStart, existing)
    if (existing) {
      await payload.update({
        collection: 'toolObservabilityBuckets',
        data,
        id: existing.id,
        overrideAccess: true,
      })
      return
    }

    try {
      await payload.create({
        collection: 'toolObservabilityBuckets',
        data,
        overrideAccess: true,
      })
    } catch (error) {
      const concurrent = await this.find(bucketKey)
      if (!concurrent) throw error
      await payload.update({
        collection: 'toolObservabilityBuckets',
        data: aggregateData(observation, bucketKey, bucketStart, concurrent),
        id: concurrent.id,
        overrideAccess: true,
      })
    }
  }
}

const stores = new WeakMap<Payload, PayloadToolObservabilityStore>()

export function payloadToolObservabilityStore(payload: Payload): PayloadToolObservabilityStore {
  const existing = stores.get(payload)
  if (existing) return existing
  const created = new PayloadToolObservabilityStore(async () => payload)
  stores.set(payload, created)
  return created
}
