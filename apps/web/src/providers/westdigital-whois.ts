import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { ProviderResult } from '@/lib/domain'
import { normalizeDomain } from '@/lib/domain-name'
import { getEnv } from '@/lib/env'
import { logger as defaultLogger } from '@/lib/logging'
import { ReadQueueFullError, TokenBucketReadLimiter } from '@/providers/read-control'
import { executeWestDigitalHttpRequest } from '@/providers/westdigital-http'
import type { PublicRegistrationProvider, PublicRegistrationRecord } from '@/providers/types'

const responseSchema = z.strictObject({
  clientid: z.string().min(1).max(128),
  data: z.strictObject({
    bizserver: z.string().max(2_048),
    body: z.string().max(64_000),
    code: z.literal(200),
    dom_em: z.string().max(2_048),
    dom_org: z.string().max(2_048),
    expdate: z.string().max(64),
    nameserver: z.string().max(16_384),
    registrar: z.string().max(512),
    regdate: z.string().max(64),
    status: z.string().max(16_384),
    updated: z.string().max(64),
  }),
  result: z.literal(200),
})

const envelopeSchema = z.object({ result: z.number().int() })

export type WestDigitalWhoisTransportRequest = {
  domainAscii: string
  requestId: string
  signal: AbortSignal
}

export type WestDigitalWhoisTransportResponse = {
  body: unknown
  headers?: Readonly<Record<string, string | undefined>>
  status: number
}

export interface WestDigitalWhoisTransport {
  execute(request: WestDigitalWhoisTransportRequest): Promise<WestDigitalWhoisTransportResponse>
}

type ProviderOptions = {
  config?: {
    burst: number
    queueCapacity: number
    queueWaitMs: number
    ratePerSecond: number
    timeoutMs: number
  }
  logger?: {
    info(fields: Record<string, unknown>): void
    warn(fields: Record<string, unknown>): void
  }
  now?: () => number
  requestIdFactory?: () => string
  transport: WestDigitalWhoisTransport
}

type ProviderLogger = NonNullable<ProviderOptions['logger']>

type LiveTransportOptions = {
  apiPassword: string
  fetchImpl?: typeof fetch
  maxResponseBytes: number
  now?: () => number
  username: string
}

function safeList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 64)
}

function safeValue(value: string): string | null {
  return value.trim() || null
}

function failure<T>(
  code: string,
  message: string,
  observedAt: string,
  requestId: string,
  retryable: boolean,
  retryAfterSeconds?: number,
): ProviderResult<T> {
  return {
    cache: { status: 'miss' },
    error: {
      code,
      message,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      retryable,
      statusKnown: false,
    },
    observedAt,
    ok: false,
    requestId,
  }
}

function retryAfter(response: WestDigitalWhoisTransportResponse): number | undefined {
  const value = response.headers?.['retry-after'] ?? response.headers?.['Retry-After']
  if (!value || !/^\d+$/u.test(value)) return undefined
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 3_600) : undefined
}

export class LiveWestDigitalWhoisTransport implements WestDigitalWhoisTransport {
  constructor(private readonly options: LiveTransportOptions) {
    if (!options.username || !options.apiPassword)
      throw new Error('West Digital credentials required')
  }

  async execute(
    request: WestDigitalWhoisTransportRequest,
  ): Promise<WestDigitalWhoisTransportResponse> {
    return executeWestDigitalHttpRequest(
      {
        body: { act: 'whois', domain: request.domainAscii },
        path: '/v2/domain/',
        requestId: request.requestId,
        signal: request.signal,
      },
      this.options,
    )
  }
}

export class WestDigitalWhoisProvider implements PublicRegistrationProvider {
  private readonly config: NonNullable<ProviderOptions['config']>
  private readonly inFlight = new Map<string, Promise<ProviderResult<PublicRegistrationRecord>>>()
  private readonly limiter: TokenBucketReadLimiter
  private readonly logger: NonNullable<ProviderOptions['logger']>
  private readonly now: () => number
  private readonly requestIdFactory: () => string

  constructor(private readonly options: ProviderOptions) {
    if (options.config) this.config = options.config
    else {
      const env = getEnv()
      this.config = {
        burst: env.WESTDIGITAL_READ_BURST,
        queueCapacity: env.WESTDIGITAL_READ_QUEUE_CAPACITY,
        queueWaitMs: env.WESTDIGITAL_READ_QUEUE_WAIT_MS,
        ratePerSecond: env.WESTDIGITAL_READ_RATE_PER_SECOND,
        timeoutMs: env.WESTDIGITAL_READ_TIMEOUT_MS,
      }
    }
    this.logger = options.logger ?? defaultLogger
    this.now = options.now ?? Date.now
    this.requestIdFactory = options.requestIdFactory ?? (() => `westdigital-whois-${randomUUID()}`)
    this.limiter = new TokenBucketReadLimiter(
      this.config.ratePerSecond,
      this.config.burst,
      this.config.queueCapacity,
      this.config.queueWaitMs,
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

  async queryPublicRegistration(input: {
    domainAscii: string
    traceId: string
  }): Promise<ProviderResult<PublicRegistrationRecord>> {
    const normalized = normalizeDomain(input.domainAscii)
    if (!normalized.ok)
      return failure(
        normalized.error.code,
        normalized.error.message,
        this.observedAt(),
        this.requestIdFactory(),
        false,
      )
    const key = normalized.value.ascii
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const requestId = this.requestIdFactory()
    const promise = this.limiter
      .schedule(() =>
        this.execute(normalized.value.ascii, normalized.value.unicode, input.traceId, requestId),
      )
      .catch((error: unknown) =>
        this.providerFailure(
          error instanceof ReadQueueFullError
            ? 'WESTDIGITAL_QUEUE_FULL'
            : 'WESTDIGITAL_QUEUE_TIMEOUT',
          error instanceof ReadQueueFullError
            ? '西部数码 WHOIS 查询队列已满'
            : '西部数码 WHOIS 查询排队超时',
          this.observedAt(),
          requestId,
          input.traceId,
          true,
          1,
        ),
      )
      .finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }

  private async execute(
    domainAscii: string,
    domainUnicode: string,
    traceId: string,
    requestId: string,
  ): Promise<ProviderResult<PublicRegistrationRecord>> {
    const startedAt = this.now()
    const observedAt = this.observedAt()
    try {
      this.logger.info({
        event: 'westdigital_whois.request_started',
        provider: 'westdigital',
        queueDepth: this.limiter.queueSize,
        requestId,
        traceId,
      })
      const response = await this.options.transport.execute({
        domainAscii,
        requestId,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
      const envelope = envelopeSchema.safeParse(response.body)
      if (response.status === 429 || (envelope.success && envelope.data.result === 429))
        return this.providerFailure(
          'WESTDIGITAL_RATE_LIMITED',
          '西部数码 WHOIS 请求过于频繁',
          observedAt,
          requestId,
          traceId,
          true,
          retryAfter(response),
        )
      if (response.status < 200 || response.status >= 300 || !envelope.success)
        return this.providerFailure(
          'WESTDIGITAL_WHOIS_INVALID_RESPONSE',
          '西部数码 WHOIS 返回异常',
          observedAt,
          requestId,
          traceId,
          response.status >= 500,
        )
      if (envelope.data.result !== 200)
        return this.providerFailure(
          'WESTDIGITAL_WHOIS_REJECTED',
          '西部数码 WHOIS 未能完成查询',
          observedAt,
          requestId,
          traceId,
          envelope.data.result >= 500,
        )

      const parsed = responseSchema.safeParse(response.body)
      if (!parsed.success)
        return this.providerFailure(
          'WESTDIGITAL_WHOIS_INVALID_RESPONSE',
          '西部数码 WHOIS 返回异常',
          observedAt,
          requestId,
          traceId,
          false,
        )
      const data = parsed.data.data
      const registrar = safeValue(data.registrar)
      const statuses = safeList(data.status)
      const nameServers = safeList(data.nameserver)
      const dates = {
        created: safeValue(data.regdate),
        expires: safeValue(data.expdate),
        updated: safeValue(data.updated),
      }
      if (
        !registrar &&
        !dates.created &&
        !dates.expires &&
        !dates.updated &&
        statuses.length === 0 &&
        nameServers.length === 0
      )
        return this.providerFailure(
          'WESTDIGITAL_WHOIS_STATUS_UNKNOWN',
          '西部数码 WHOIS 未返回可确认的公开注册字段',
          observedAt,
          requestId,
          traceId,
          false,
        )

      this.logger.info({
        cacheStatus: 'miss',
        durationMs: Math.max(0, this.now() - startedAt),
        event: 'westdigital_whois.request_succeeded',
        provider: 'westdigital',
        queueDepth: this.limiter.queueSize,
        requestId,
        traceId,
      })
      return {
        cache: { status: 'miss' },
        data: {
          dates,
          domainAscii,
          domainUnicode,
          nameServers,
          recordStatus: 'record_found',
          registrar,
          source: { protocol: 'whois', provider: 'westdigital' },
          statuses,
        },
        observedAt,
        ok: true,
        requestId,
      }
    } catch (error) {
      const timeout =
        error instanceof DOMException &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      const tooLarge = error instanceof RangeError
      return this.providerFailure(
        tooLarge
          ? 'WESTDIGITAL_RESPONSE_TOO_LARGE'
          : timeout
            ? 'WESTDIGITAL_TIMEOUT'
            : 'WESTDIGITAL_UNAVAILABLE',
        tooLarge
          ? '西部数码 WHOIS 返回数据超过安全上限'
          : timeout
            ? '西部数码 WHOIS 查询超时'
            : '暂时无法连接西部数码 WHOIS',
        observedAt,
        requestId,
        traceId,
        !tooLarge,
      )
    }
  }

  private providerFailure(
    code: string,
    message: string,
    observedAt: string,
    requestId: string,
    traceId: string,
    retryable: boolean,
    retryAfterSeconds?: number,
  ): ProviderResult<PublicRegistrationRecord> {
    this.logger.warn({
      errorCode: code,
      event: 'westdigital_whois.request_failed',
      provider: 'westdigital',
      queueDepth: this.limiter.queueSize,
      requestId,
      traceId,
    })
    return failure(code, message, observedAt, requestId, retryable, retryAfterSeconds)
  }

  private observedAt(): string {
    return new Date(this.now()).toISOString()
  }
}

export function createConfiguredWestDigitalWhoisProvider(
  options: { logger?: ProviderLogger } = {},
): PublicRegistrationProvider | undefined {
  const env = getEnv()
  if (!env.WESTDIGITAL_WHOIS_FALLBACK_ENABLED) return undefined
  if (!env.WESTDIGITAL_USERNAME || !env.WESTDIGITAL_API_PASSWORD)
    throw new Error('West Digital WHOIS fallback credentials are missing')
  return new WestDigitalWhoisProvider({
    ...(options.logger ? { logger: options.logger } : {}),
    transport: new LiveWestDigitalWhoisTransport({
      apiPassword: env.WESTDIGITAL_API_PASSWORD,
      maxResponseBytes: env.WESTDIGITAL_READ_RESPONSE_MAX_BYTES,
      username: env.WESTDIGITAL_USERNAME,
    }),
  })
}
