import { describe, expect, it, vi } from 'vitest'

import { FIRST_PARTY_TOOLS } from '@/schemas/analytics'
import {
  classifyProviderErrorCode,
  createProviderObservabilityLogger,
  providerObservationFromLog,
} from '@/services/observability/provider-metrics-logger'
import {
  observabilityBucketStart,
  PayloadToolObservabilityStore,
  percentileBucket,
  type ToolObservabilityObservation,
} from '@/services/observability/tool-observability'

function memoryPayload() {
  let document: Record<string, unknown> | undefined
  return {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      document = { ...data, createdAt: '2026-08-06T00:00:00.000Z', id: 1 }
      return document
    }),
    document: () => document,
    find: vi.fn(async () => ({ docs: document ? [document] : [] })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      document = { ...document, ...data }
      return document
    }),
  }
}

describe('D2 tool observability aggregation', () => {
  it('keeps request and success counts for all six tool identities', async () => {
    const recorded: string[] = []
    for (const tool of FIRST_PARTY_TOOLS) {
      const payload = memoryPayload()
      const store = new PayloadToolObservabilityStore(async () => payload as never)
      await store.record({
        durationBucket: '100_299ms',
        observedAt: new Date('2026-08-06T06:00:00.000Z'),
        scope: 'tool',
        succeeded: true,
        tool,
      })
      expect(payload.document()).toMatchObject({
        requestCount: 1,
        successCount: 1,
        successRateBasisPoints: 10_000,
        tool,
      })
      recorded.push(tool)
    }
    expect(recorded).toEqual([...FIRST_PARTY_TOOLS])
  })

  it('uses stable hour buckets and derives bucketed P50/P95 without raw durations', () => {
    expect(observabilityBucketStart(new Date('2026-08-06T07:59:59.999Z')).toISOString()).toBe(
      '2026-08-06T07:00:00.000Z',
    )
    expect(
      percentileBucket(
        {
          '100_299ms': 0,
          '1000_2999ms': 0,
          '3000_9999ms': 0,
          '300_999ms': 2,
          gte_10000ms: 1,
          lt_100ms: 1,
        },
        50,
      ),
    ).toBe('300_999ms')
    expect(
      percentileBucket(
        {
          '100_299ms': 0,
          '1000_2999ms': 0,
          '3000_9999ms': 0,
          '300_999ms': 2,
          gte_10000ms: 1,
          lt_100ms: 1,
        },
        95,
      ),
    ).toBe('gte_10000ms')
  })

  it('serializes concurrent tool updates into one aggregate-only bucket', async () => {
    const payload = memoryPayload()
    const store = new PayloadToolObservabilityStore(async () => payload as never)
    const observedAt = new Date('2026-08-06T07:15:00.000Z')
    const observations: ToolObservabilityObservation[] = [
      {
        durationBucket: 'lt_100ms',
        observedAt,
        scope: 'tool',
        succeeded: true,
        tool: 'idn',
      },
      {
        durationBucket: '300_999ms',
        observedAt,
        scope: 'tool',
        succeeded: true,
        tool: 'idn',
      },
      {
        durationBucket: 'gte_10000ms',
        observedAt,
        scope: 'tool',
        succeeded: false,
        tool: 'idn',
      },
    ]
    await Promise.all(observations.map((observation) => store.record(observation)))

    expect(payload.document()).toMatchObject({
      bucketEnd: '2026-08-06T08:00:00.000Z',
      bucketStart: '2026-08-06T07:00:00.000Z',
      failureCount: 1,
      latency300To999MsCount: 1,
      latencyGte10000MsCount: 1,
      latencyLt100MsCount: 1,
      p50Bucket: '300_999ms',
      p95Bucket: 'gte_10000ms',
      requestCount: 3,
      scope: 'tool',
      successCount: 2,
      successRateBasisPoints: 6667,
      tool: 'idn',
    })
    const serialized = JSON.stringify(payload.document())
    expect(serialized).not.toContain('domain')
    expect(serialized).not.toContain('query')
    expect(serialized).not.toContain('traceId')
  })

  it('tracks provider queue depth, rejected count and one of four error categories', async () => {
    const payload = memoryPayload()
    const store = new PayloadToolObservabilityStore(async () => payload as never)
    const observedAt = new Date('2026-08-06T08:01:00.000Z')
    await store.record({
      observedAt,
      operation: 'dns',
      outcome: 'started',
      provider: 'alidns',
      queueDepth: 7,
      scope: 'provider',
    })
    await store.record({
      durationBucket: '1000_2999ms',
      errorCategory: 'rate_limited',
      observedAt,
      operation: 'dns',
      outcome: 'failed',
      provider: 'alidns',
      queueDepth: 6,
      rejected: true,
      scope: 'provider',
    })

    expect(payload.document()).toMatchObject({
      failureCount: 1,
      lastQueueDepth: 6,
      maxQueueDepth: 7,
      p50Bucket: '1000_2999ms',
      p95Bucket: '1000_2999ms',
      provider: 'alidns',
      providerOperation: 'dns',
      rateLimitedErrorCount: 1,
      rejectedCount: 1,
      requestCount: 1,
      successCount: 0,
    })
  })
})

describe('D2 provider log observations', () => {
  it.each([
    ['WHODAT_TIMEOUT', 'timeout'],
    ['WESTDIGITAL_RATE_LIMITED', 'rate_limited'],
    ['DNS_QUEUE_FULL', 'rate_limited'],
    ['DNS_INVALID_RESPONSE', 'invalid_response'],
    ['WESTDIGITAL_RESPONSE_TOO_LARGE', 'invalid_response'],
    ['WHODAT_UPSTREAM_ERROR', 'upstream_error'],
    ['TLS_UNAVAILABLE', 'upstream_error'],
  ] as const)('classifies %s as %s', (code, category) => {
    expect(classifyProviderErrorCode(code)).toBe(category)
  })

  it('whitelists provider outcome dimensions and ignores query values', () => {
    expect(
      providerObservationFromLog(
        {
          domain: 'private.example',
          durationMs: 438,
          errorCode: 'WHODAT_TIMEOUT',
          event: 'whodat.request_failed',
          provider: 'whodat',
          query: 'private.example',
          queueDepth: 3,
          traceId: 'trace-private',
        },
        new Date('2026-08-06T09:00:00.000Z'),
      ),
    ).toEqual({
      durationBucket: '300_999ms',
      errorCategory: 'timeout',
      observedAt: new Date('2026-08-06T09:00:00.000Z'),
      operation: 'whois',
      outcome: 'failed',
      provider: 'whodat',
      queueDepth: 3,
      rejected: false,
      scope: 'provider',
    })
  })

  it('forwards existing structured logs and persists observations asynchronously', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const baseLogger = { info: vi.fn(), warn: vi.fn() }
    const observed = createProviderObservabilityLogger(
      { record },
      { baseLogger, now: () => new Date('2026-08-06T10:00:00.000Z') },
    )
    observed.logger.warn({
      errorCode: 'TLS_QUEUE_TIMEOUT',
      event: 'tls.request_failed',
      provider: 'node_tls',
      queueDepth: 4,
    })
    await observed.drain()

    expect(baseLogger.warn).toHaveBeenCalledOnce()
    expect(record).toHaveBeenCalledWith({
      errorCategory: 'rate_limited',
      observedAt: new Date('2026-08-06T10:00:00.000Z'),
      operation: 'tls',
      outcome: 'failed',
      provider: 'node_tls',
      queueDepth: 4,
      rejected: true,
      scope: 'provider',
    })
  })
})
