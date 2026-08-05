import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { ProviderError, ProviderResult } from '@/lib/domain'
import { normalizeDomain, type NormalizedDomain } from '@/lib/domain-name'
import { getEnv } from '@/lib/env'
import { logger as defaultLogger } from '@/lib/logging'

import { mockSuccess } from './mock'
import type {
  DomainProvider,
  WestDigitalAvailability,
  WestDigitalPrice,
  WestDigitalReadProvider,
} from './types'

export const WESTDIGITAL_ERROR_MESSAGES = {
  WESTDIGITAL_DOMAIN_SUFFIX_REQUIRED: '请输入包含后缀的完整域名',
  WESTDIGITAL_INVALID_YEARS: '域名价格查询年限必须为 1 至 10 年',
  WESTDIGITAL_INVALID_RESPONSE: '域名数据源返回异常，暂时无法确认结果',
  WESTDIGITAL_QUEUE_FULL: '当前域名查询请求较多，请稍后重试',
  WESTDIGITAL_QUEUE_TIMEOUT: '域名查询等待超时，请稍后重试',
  WESTDIGITAL_RATE_LIMITED: '域名数据源请求过于频繁，请稍后重试',
  WESTDIGITAL_REJECTED: '域名数据源未能完成查询',
  WESTDIGITAL_TIMEOUT: '域名数据源响应超时，请稍后重试',
  WESTDIGITAL_UNAVAILABLE: '暂时无法连接域名数据源，请稍后重试',
} as const

export type WestDigitalOperation = 'availability' | 'price'

export type WestDigitalTransportRequest = {
  body: Readonly<Record<string, string>>
  operation: WestDigitalOperation
  path: 'v2/domain/query/' | 'v2/info/'
  requestId: string
  signal: AbortSignal
}

export type WestDigitalTransportResponse = {
  body: unknown
  headers?: Readonly<Record<string, string | undefined>>
  status: number
}

export interface WestDigitalReadTransport {
  execute(request: WestDigitalTransportRequest): Promise<WestDigitalTransportResponse>
}

export type WestDigitalReadConfig = {
  availabilityCacheMaxEntries: number
  availabilityCacheTtlMs: number
  burst: number
  priceCacheMaxEntries: number
  priceCacheTtlMs: number
  queueCapacity: number
  queueWaitMs: number
  ratePerSecond: number
  transportTimeoutMs: number
}

export type WestDigitalLogger = {
  info(fields: Record<string, unknown>): void
  warn(fields: Record<string, unknown>): void
}

export type WestDigitalReadAdapterOptions = {
  config?: WestDigitalReadConfig
  logger?: WestDigitalLogger
  now?: () => number
  requestIdFactory?: () => string
  transport: WestDigitalReadTransport
}

const positiveInteger = z.number().int().positive()
const configSchema = z.object({
  availabilityCacheMaxEntries: positiveInteger,
  availabilityCacheTtlMs: positiveInteger,
  burst: positiveInteger,
  priceCacheMaxEntries: positiveInteger,
  priceCacheTtlMs: positiveInteger,
  queueCapacity: positiveInteger,
  queueWaitMs: positiveInteger,
  ratePerSecond: z.number().positive(),
  transportTimeoutMs: positiveInteger,
})

const wholeCnySchema = z
  .number()
  .int()
  .nonnegative()
  .refine(
    (value) => Number.isSafeInteger(value) && Number.isSafeInteger(value * 100),
    'price must convert safely to fen',
  )

const envelopeSchema = z.object({
  result: z.number().int(),
})

const availabilityResponseSchema = z.object({
  clientid: z.string().min(1),
  data: z
    .array(
      z.object({
        avail: z.union([z.literal(0), z.literal(1)]),
        name: z.string().min(1),
        price: wholeCnySchema.optional(),
        type: z.literal('premium').optional(),
      }),
    )
    .length(1),
  result: z.literal(200),
})

const priceResponseSchema = z.object({
  clientid: z.string().min(1),
  data: z.object({
    buyprice: wholeCnySchema,
    buyyear: z.string().regex(/^\d+$/u),
    proid: z.string().min(1),
    renewprice: wholeCnySchema,
  }),
  result: z.literal(200),
})

type ProviderSuccess<T> = Extract<ProviderResult<T>, { ok: true }>

type CacheEntry<T> = {
  expiresAt: number
  value: ProviderSuccess<T>
}

type InFlightEntry<T> = {
  promise: Promise<ProviderResult<T>>
  requestId: string
}

class BoundedLruCache<T> {
  private readonly values = new Map<string, CacheEntry<T>>()

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: string): CacheEntry<T> | undefined {
    const entry = this.values.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.values.delete(key)
      return undefined
    }

    this.values.delete(key)
    this.values.set(key, entry)
    return entry
  }

  set(key: string, value: ProviderSuccess<T>): number {
    const currentTime = this.now()
    for (const [cachedKey, entry] of this.values) {
      if (entry.expiresAt <= currentTime) this.values.delete(cachedKey)
    }

    this.values.delete(key)
    while (this.values.size >= this.maxEntries) {
      const oldestKey = this.values.keys().next().value
      if (oldestKey === undefined) break
      this.values.delete(oldestKey)
    }

    const expiresAt = currentTime + this.ttlMs
    this.values.set(key, { expiresAt, value })
    return expiresAt
  }
}

class QueueFullError extends Error {}
class QueueTimeoutError extends Error {}
class TransportTimeoutError extends Error {}
class InvalidResponseError extends Error {}

type QueueEntry = {
  execute: () => Promise<unknown>
  reject: (error: unknown) => void
  resolve: (value: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

class TokenBucketLimiter {
  private lastRefillAt: number
  private queue: QueueEntry[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private tokens: number

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly queueCapacity: number,
    private readonly queueWaitMs: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst
    this.lastRefillAt = now()
  }

  get queueSize(): number {
    return this.queue.length
  }

  schedule<T>(execute: () => Promise<T>): Promise<T> {
    this.refill()
    if (this.queue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1
      return Promise.resolve().then(execute)
    }
    if (this.queue.length >= this.queueCapacity) return Promise.reject(new QueueFullError())

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        execute,
        reject,
        resolve: (value) => resolve(value as T),
        timeout: setTimeout(() => {
          const index = this.queue.indexOf(entry)
          if (index === -1) return
          this.queue.splice(index, 1)
          reject(new QueueTimeoutError())
          this.armTimer()
        }, this.queueWaitMs),
      }
      this.queue.push(entry)
      this.armTimer()
    })
  }

  private armTimer(): void {
    if (this.timer || this.queue.length === 0) return
    this.refill()
    const delay = this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1_000)
    this.timer = setTimeout(() => this.drain(), delay)
  }

  private drain(): void {
    this.timer = undefined
    this.refill()

    while (this.queue.length > 0 && this.tokens >= 1) {
      const entry = this.queue.shift()
      if (!entry) break
      clearTimeout(entry.timeout)
      this.tokens -= 1
      void Promise.resolve().then(entry.execute).then(entry.resolve, entry.reject)
    }

    this.armTimer()
  }

  private refill(): void {
    const currentTime = this.now()
    const elapsedMs = Math.max(0, currentTime - this.lastRefillAt)
    this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1_000) * this.ratePerSecond)
    this.lastRefillAt = currentTime
  }
}

function configFromEnv(): WestDigitalReadConfig {
  const env = getEnv()
  return {
    availabilityCacheMaxEntries: env.WESTDIGITAL_AVAILABILITY_CACHE_MAX_ENTRIES,
    availabilityCacheTtlMs: env.WESTDIGITAL_AVAILABILITY_CACHE_TTL_MS,
    burst: env.WESTDIGITAL_READ_BURST,
    priceCacheMaxEntries: env.WESTDIGITAL_PRICE_CACHE_MAX_ENTRIES,
    priceCacheTtlMs: env.WESTDIGITAL_PRICE_CACHE_TTL_MS,
    queueCapacity: env.WESTDIGITAL_READ_QUEUE_CAPACITY,
    queueWaitMs: env.WESTDIGITAL_READ_QUEUE_WAIT_MS,
    ratePerSecond: env.WESTDIGITAL_READ_RATE_PER_SECOND,
    transportTimeoutMs: env.WESTDIGITAL_READ_TIMEOUT_MS,
  }
}

function toFen(value: number): number {
  const fen = value * 100
  if (!Number.isSafeInteger(fen)) throw new InvalidResponseError()
  return fen
}

function retryAfterSeconds(response: WestDigitalTransportResponse): number {
  const raw = response.headers?.['retry-after'] ?? response.headers?.['Retry-After']
  if (!raw || !/^\d+$/u.test(raw)) return 1
  const seconds = Number(raw)
  return Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 3_600) : 1
}

function normalizedResponseDomain(value: string): NormalizedDomain {
  const normalized = normalizeDomain(value)
  if (!normalized.ok) throw new InvalidResponseError()
  return normalized.value
}

function parseAvailabilityResponse(body: unknown, expectedDomain: string): WestDigitalAvailability {
  const parsed = availabilityResponseSchema.safeParse(body)
  if (!parsed.success) throw new InvalidResponseError()
  const item = parsed.data.data[0]
  const responseDomain = normalizedResponseDomain(item.name)
  const premium = item.type === 'premium'

  if (responseDomain.ascii !== expectedDomain) throw new InvalidResponseError()
  if (premium && (item.avail !== 1 || item.price === undefined)) throw new InvalidResponseError()
  if (!premium && item.price !== undefined) throw new InvalidResponseError()

  return {
    available: item.avail === 1,
    currency: 'CNY',
    domainAscii: expectedDomain,
    premium,
    ...(item.price === undefined ? {} : { premiumRegistrationPriceFen: toFen(item.price) }),
  }
}

function parsePriceResponse(
  body: unknown,
  expectedDomain: string,
  expectedYears: number,
): WestDigitalPrice {
  const parsed = priceResponseSchema.safeParse(body)
  if (!parsed.success || Number(parsed.data.data.buyyear) !== expectedYears)
    throw new InvalidResponseError()

  return {
    currency: 'CNY',
    domainAscii: expectedDomain,
    productId: parsed.data.data.proid,
    purchaseYears: expectedYears,
    registrationPriceFen: toFen(parsed.data.data.buyprice),
    renewalPriceFen: toFen(parsed.data.data.renewprice),
  }
}

function createFailure<T>(
  code: keyof typeof WESTDIGITAL_ERROR_MESSAGES | string,
  message: string,
  observedAt: string,
  requestId: string,
  options: Pick<ProviderError, 'retryable' | 'statusKnown'> & { retryAfterSeconds?: number },
): Extract<ProviderResult<T>, { ok: false }> {
  return {
    cache: { status: 'miss' },
    error: {
      code,
      message,
      ...(options.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: options.retryAfterSeconds }),
      retryable: options.retryable,
      statusKnown: options.statusKnown,
    },
    observedAt,
    ok: false,
    requestId,
  }
}

export class WestDigitalReadAdapter implements WestDigitalReadProvider {
  private readonly availabilityCache: BoundedLruCache<WestDigitalAvailability>
  private readonly availabilityInFlight = new Map<string, InFlightEntry<WestDigitalAvailability>>()
  private readonly config: WestDigitalReadConfig
  private readonly limiter: TokenBucketLimiter
  private readonly logger: WestDigitalLogger
  private readonly now: () => number
  private readonly priceCache: BoundedLruCache<WestDigitalPrice>
  private readonly priceInFlight = new Map<string, InFlightEntry<WestDigitalPrice>>()
  private readonly requestIdFactory: () => string
  private readonly transport: WestDigitalReadTransport

  constructor(options: WestDigitalReadAdapterOptions) {
    this.config = configSchema.parse(options.config ?? configFromEnv())
    this.logger = options.logger ?? defaultLogger
    this.now = options.now ?? Date.now
    this.requestIdFactory = options.requestIdFactory ?? (() => `westdigital-${randomUUID()}`)
    this.transport = options.transport
    this.limiter = new TokenBucketLimiter(
      this.config.ratePerSecond,
      this.config.burst,
      this.config.queueCapacity,
      this.config.queueWaitMs,
      this.now,
    )
    this.availabilityCache = new BoundedLruCache(
      this.config.availabilityCacheMaxEntries,
      this.config.availabilityCacheTtlMs,
      this.now,
    )
    this.priceCache = new BoundedLruCache(
      this.config.priceCacheMaxEntries,
      this.config.priceCacheTtlMs,
      this.now,
    )
  }

  async health(): Promise<ProviderResult<{ healthy: boolean }>> {
    return {
      data: { healthy: true },
      observedAt: this.observedAt(),
      ok: true,
      requestId: this.requestIdFactory(),
    }
  }

  async queryAvailability(input: {
    domain: string
    traceId: string
  }): Promise<ProviderResult<WestDigitalAvailability>> {
    const normalized = normalizeDomain(input.domain)
    if (!normalized.ok)
      return this.validationFailure(normalized.error.code, normalized.error.message, input.traceId)

    const separator = normalized.value.ascii.indexOf('.')
    if (separator <= 0 || separator === normalized.value.ascii.length - 1)
      return this.validationFailure(
        'WESTDIGITAL_DOMAIN_SUFFIX_REQUIRED',
        WESTDIGITAL_ERROR_MESSAGES.WESTDIGITAL_DOMAIN_SUFFIX_REQUIRED,
        input.traceId,
      )

    const key = normalized.value.ascii
    const cached = this.availabilityCache.get(key)
    if (cached) {
      this.logger.info({
        cacheStatus: 'hit',
        event: 'westdigital.cache_hit',
        operation: 'availability',
        provider: 'westdigital',
        requestId: cached.value.requestId,
        traceId: input.traceId,
      })
      return {
        ...cached.value,
        cache: { expiresAt: new Date(cached.expiresAt).toISOString(), status: 'hit' },
      }
    }

    const existing = this.availabilityInFlight.get(key)
    if (existing) {
      this.logger.info({
        cacheStatus: 'miss',
        event: 'westdigital.inflight_join',
        operation: 'availability',
        provider: 'westdigital',
        requestId: existing.requestId,
        traceId: input.traceId,
      })
      return existing.promise
    }

    const requestId = this.requestIdFactory()
    const promise = this.executeAvailability(normalized.value, separator, input.traceId, requestId)
      .then((result) => {
        if (!result.ok) return result
        const expiresAt = this.availabilityCache.set(key, result)
        return {
          ...result,
          cache: { expiresAt: new Date(expiresAt).toISOString(), status: 'miss' as const },
        }
      })
      .finally(() => this.availabilityInFlight.delete(key))
    this.availabilityInFlight.set(key, { promise, requestId })
    return promise
  }

  async queryPrice(input: {
    domain: string
    traceId: string
    years: number
  }): Promise<ProviderResult<WestDigitalPrice>> {
    const normalized = normalizeDomain(input.domain)
    if (!normalized.ok)
      return this.validationFailure(normalized.error.code, normalized.error.message, input.traceId)
    if (!Number.isInteger(input.years) || input.years < 1 || input.years > 10)
      return this.validationFailure(
        'WESTDIGITAL_INVALID_YEARS',
        WESTDIGITAL_ERROR_MESSAGES.WESTDIGITAL_INVALID_YEARS,
        input.traceId,
      )

    const key = `${normalized.value.ascii}:${input.years}`
    const cached = this.priceCache.get(key)
    if (cached) {
      this.logger.info({
        cacheStatus: 'hit',
        event: 'westdigital.cache_hit',
        operation: 'price',
        provider: 'westdigital',
        requestId: cached.value.requestId,
        traceId: input.traceId,
      })
      return {
        ...cached.value,
        cache: { expiresAt: new Date(cached.expiresAt).toISOString(), status: 'hit' },
      }
    }

    const existing = this.priceInFlight.get(key)
    if (existing) {
      this.logger.info({
        cacheStatus: 'miss',
        event: 'westdigital.inflight_join',
        operation: 'price',
        provider: 'westdigital',
        requestId: existing.requestId,
        traceId: input.traceId,
      })
      return existing.promise
    }

    const requestId = this.requestIdFactory()
    const promise = this.executePrice(normalized.value, input.years, input.traceId, requestId)
      .then((result) => {
        if (!result.ok) return result
        const expiresAt = this.priceCache.set(key, result)
        return {
          ...result,
          cache: { expiresAt: new Date(expiresAt).toISOString(), status: 'miss' as const },
        }
      })
      .finally(() => this.priceInFlight.delete(key))
    this.priceInFlight.set(key, { promise, requestId })
    return promise
  }

  private async executeAvailability(
    domain: NormalizedDomain,
    separator: number,
    traceId: string,
    requestId: string,
  ): Promise<ProviderResult<WestDigitalAvailability>> {
    return this.executeRequest({
      body: {
        act: 'query',
        domain: domain.ascii.slice(0, separator),
        suffix: domain.ascii.slice(separator),
      },
      operation: 'availability',
      parse: (body) => parseAvailabilityResponse(body, domain.ascii),
      path: 'v2/domain/query/',
      requestId,
      traceId,
    })
  }

  private async executePrice(
    domain: NormalizedDomain,
    years: number,
    traceId: string,
    requestId: string,
  ): Promise<ProviderResult<WestDigitalPrice>> {
    return this.executeRequest({
      body: { act: 'getprice', type: 'domain', value: domain.ascii, year: String(years) },
      operation: 'price',
      parse: (body) => parsePriceResponse(body, domain.ascii, years),
      path: 'v2/info/',
      requestId,
      traceId,
    })
  }

  private async executeRequest<T>(input: {
    body: Readonly<Record<string, string>>
    operation: WestDigitalOperation
    parse: (body: unknown) => T
    path: WestDigitalTransportRequest['path']
    requestId: string
    traceId: string
  }): Promise<ProviderResult<T>> {
    const logicalStartedAt = this.now()

    try {
      const response = await this.limiter.schedule(async () => {
        this.logger.info({
          attempt: 1,
          cacheStatus: 'miss',
          event: 'westdigital.request_started',
          operation: input.operation,
          provider: 'westdigital',
          queueDepth: this.limiter.queueSize,
          requestId: input.requestId,
          traceId: input.traceId,
        })
        return this.executeTransport({
          body: input.body,
          operation: input.operation,
          path: input.path,
          requestId: input.requestId,
        })
      })
      const observedAt = this.observedAt()
      const envelope = envelopeSchema.safeParse(response.body)

      if (response.status === 429 || (envelope.success && envelope.data.result === 429)) {
        const failure = createFailure<T>(
          'WESTDIGITAL_RATE_LIMITED',
          WESTDIGITAL_ERROR_MESSAGES.WESTDIGITAL_RATE_LIMITED,
          observedAt,
          input.requestId,
          {
            retryAfterSeconds: retryAfterSeconds(response),
            retryable: true,
            statusKnown: false,
          },
        )
        this.logFailure(failure.error, input, logicalStartedAt)
        return failure
      }
      if (response.status < 200 || response.status >= 300) {
        const failure = createFailure<T>(
          'WESTDIGITAL_REJECTED',
          WESTDIGITAL_ERROR_MESSAGES.WESTDIGITAL_REJECTED,
          observedAt,
          input.requestId,
          {
            retryable: response.status >= 500,
            statusKnown: false,
          },
        )
        this.logFailure(failure.error, input, logicalStartedAt)
        return failure
      }
      if (!envelope.success) throw new InvalidResponseError()
      if (envelope.data.result !== 200) {
        const failure = createFailure<T>(
          'WESTDIGITAL_REJECTED',
          WESTDIGITAL_ERROR_MESSAGES.WESTDIGITAL_REJECTED,
          observedAt,
          input.requestId,
          {
            retryable: envelope.data.result >= 500,
            statusKnown: false,
          },
        )
        this.logFailure(failure.error, input, logicalStartedAt)
        return failure
      }

      const data = input.parse(response.body)
      this.logger.info({
        attempt: 1,
        cacheStatus: 'miss',
        durationMs: Math.max(0, this.now() - logicalStartedAt),
        event: 'westdigital.request_succeeded',
        operation: input.operation,
        provider: 'westdigital',
        requestId: input.requestId,
        traceId: input.traceId,
      })
      return { data, observedAt, ok: true, requestId: input.requestId }
    } catch (error) {
      const observedAt = this.observedAt()
      const mapped = this.mapThrownError<T>(error, observedAt, input.requestId)
      this.logFailure(mapped.error, input, logicalStartedAt)
      return mapped
    }
  }

  private async executeTransport(
    input: Omit<WestDigitalTransportRequest, 'signal'>,
  ): Promise<WestDigitalTransportResponse> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new TransportTimeoutError())
      }, this.config.transportTimeoutMs)
    })

    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          this.transport.execute({ ...input, signal: controller.signal }),
        ),
        timedOut,
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private logFailure(
    error: ProviderError,
    input: Pick<WestDigitalTransportRequest, 'operation' | 'requestId'> & { traceId: string },
    startedAt: number,
  ): void {
    this.logger.warn({
      attempt: 1,
      cacheStatus: 'miss',
      durationMs: Math.max(0, this.now() - startedAt),
      errorCode: error.code,
      event: 'westdigital.request_failed',
      operation: input.operation,
      provider: 'westdigital',
      queueDepth: this.limiter.queueSize,
      requestId: input.requestId,
      retryable: error.retryable,
      traceId: input.traceId,
    })
  }

  private mapThrownError<T>(
    error: unknown,
    observedAt: string,
    requestId: string,
  ): Extract<ProviderResult<T>, { ok: false }> {
    if (error instanceof QueueFullError)
      return createFailure<T>(
        'WESTDIGITAL_QUEUE_FULL',
        WESTDIGITAL_ERROR_MESSAGES.WESTDIGITAL_QUEUE_FULL,
        observedAt,
        requestId,
        { retryAfterSeconds: 1, retryable: true, statusKnown: false },
      )
    if (error instanceof QueueTimeoutError)
      return createFailure<T>(
        'WESTDIGITAL_QUEUE_TIMEOUT',
        WESTDIGITAL_ERROR_MESSAGES.WESTDIGITAL_QUEUE_TIMEOUT,
        observedAt,
        requestId,
        { retryAfterSeconds: 1, retryable: true, statusKnown: false },
      )
    if (error instanceof TransportTimeoutError)
      return createFailure<T>(
        'WESTDIGITAL_TIMEOUT',
        WESTDIGITAL_ERROR_MESSAGES.WESTDIGITAL_TIMEOUT,
        observedAt,
        requestId,
        { retryable: true, statusKnown: false },
      )
    if (error instanceof InvalidResponseError)
      return createFailure<T>(
        'WESTDIGITAL_INVALID_RESPONSE',
        WESTDIGITAL_ERROR_MESSAGES.WESTDIGITAL_INVALID_RESPONSE,
        observedAt,
        requestId,
        { retryable: false, statusKnown: false },
      )

    return createFailure<T>(
      'WESTDIGITAL_UNAVAILABLE',
      WESTDIGITAL_ERROR_MESSAGES.WESTDIGITAL_UNAVAILABLE,
      observedAt,
      requestId,
      { retryable: true, statusKnown: false },
    )
  }

  private observedAt(): string {
    return new Date(this.now()).toISOString()
  }

  private validationFailure<T>(code: string, message: string, traceId: string): ProviderResult<T> {
    const requestId = this.requestIdFactory()
    const result = createFailure<T>(code, message, this.observedAt(), requestId, {
      retryable: false,
      statusKnown: true,
    })
    this.logger.warn({
      errorCode: code,
      event: 'westdigital.validation_failed',
      provider: 'westdigital',
      requestId,
      traceId,
    })
    return result
  }
}

export class MockWestDigitalProvider implements DomainProvider {
  async health() {
    return mockSuccess({ healthy: true })
  }

  async queryRegistration() {
    return mockSuccess({ registered: false })
  }

  async submitOperation(input: { operationKey: string; traceId: string }) {
    return mockSuccess({ providerRequestId: `mock-${input.operationKey}` })
  }
}
