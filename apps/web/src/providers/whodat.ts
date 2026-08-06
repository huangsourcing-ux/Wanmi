import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { ProviderResult } from '@/lib/domain'
import { normalizeDomain } from '@/lib/domain-name'
import { getEnv } from '@/lib/env'
import { logger as defaultLogger } from '@/lib/logging'
import {
  ReadQueueFullError,
  TokenBucketReadLimiter,
  readBoundedBody,
} from '@/providers/read-control'
import type { PublicRegistrationProvider, PublicRegistrationRecord } from '@/providers/types'

const nullableShortString = z.string().max(2_048).nullable()
const contactSchema = z.strictObject({
  address: z.strictObject({
    city: nullableShortString,
    country: nullableShortString,
    postalCode: nullableShortString,
    state: nullableShortString,
    street: nullableShortString,
  }),
  email: nullableShortString,
  name: nullableShortString,
  organization: nullableShortString,
  phone: nullableShortString,
  redacted: z.boolean(),
})

const whoDatResponseSchema = z.strictObject({
  contacts: z.strictObject({
    admin: contactSchema,
    billing: contactSchema,
    registrant: contactSchema,
    tech: contactSchema,
  }),
  dates: z.strictObject({
    created: z.iso.datetime().nullable(),
    expires: z.iso.datetime().nullable(),
    updated: z.iso.datetime().nullable(),
  }),
  dnssec: z.strictObject({
    dsData: z
      .array(
        z.strictObject({
          algorithm: z.number().int().nonnegative(),
          digest: z.string().max(2_048),
          digestType: z.number().int().nonnegative(),
          keyTag: z.number().int().nonnegative(),
        }),
      )
      .max(64),
    signed: z.boolean(),
  }),
  domain: z.string().min(1).max(253),
  domainUnicode: z.string().min(1).max(253).nullable(),
  id: nullableShortString,
  isRegistered: z.boolean(),
  meta: z.strictObject({
    cached: z.boolean(),
    fetchedAt: z.iso.datetime(),
    server: nullableShortString,
    source: z.enum(['rdap', 'whois']),
  }),
  nameservers: z
    .array(
      z.strictObject({
        ipv4: z.array(z.string().max(64)).max(32),
        ipv6: z.array(z.string().max(128)).max(32),
        name: z.string().min(1).max(253),
      }),
    )
    .max(64),
  query: z.string().min(1).max(253),
  registrar: z.strictObject({
    abuseEmail: nullableShortString,
    abusePhone: nullableShortString,
    ianaId: nullableShortString,
    name: nullableShortString,
    reseller: nullableShortString,
    url: nullableShortString,
    whoisServer: nullableShortString,
  }),
  status: z.array(z.string().min(1).max(128)).max(64),
  tld: z.string().min(1).max(253),
})

type WhoDatConfig = {
  authKey?: string
  baseUrl: string
  burst: number
  maxResponseBytes: number
  queueCapacity: number
  queueWaitMs: number
  ratePerSecond: number
  timeoutMs: number
}

type WhoDatLogger = {
  info(fields: Record<string, unknown>): void
  warn(fields: Record<string, unknown>): void
}

type WhoDatProviderOptions = {
  config?: WhoDatConfig
  fetchImpl?: typeof fetch
  logger?: WhoDatLogger
  now?: () => number
  requestIdFactory?: () => string
}

const configSchema = z.strictObject({
  authKey: z.string().min(1).optional(),
  baseUrl: z.url(),
  burst: z.number().int().positive(),
  maxResponseBytes: z.number().int().positive(),
  queueCapacity: z.number().int().positive(),
  queueWaitMs: z.number().int().positive(),
  ratePerSecond: z.number().positive(),
  timeoutMs: z.number().int().positive(),
})

function configFromEnv(): WhoDatConfig {
  const env = getEnv()
  return {
    authKey: env.WHO_DAT_AUTH_KEY,
    baseUrl: env.WHO_DAT_URL,
    burst: env.WHO_DAT_READ_BURST,
    maxResponseBytes: env.WHO_DAT_RESPONSE_MAX_BYTES,
    queueCapacity: env.WHO_DAT_READ_QUEUE_CAPACITY,
    queueWaitMs: env.WHO_DAT_READ_QUEUE_WAIT_MS,
    ratePerSecond: env.WHO_DAT_READ_RATE_PER_SECOND,
    timeoutMs: env.WHO_DAT_TIMEOUT_MS,
  }
}

function failure<T>(
  code: string,
  message: string,
  observedAt: string,
  requestId: string,
  options: { retryAfterSeconds?: number; retryable: boolean; statusKnown: boolean },
): ProviderResult<T> {
  return {
    cache: { status: 'miss' },
    error: {
      code,
      message,
      ...(options.retryAfterSeconds ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
      retryable: options.retryable,
      statusKnown: options.statusKnown,
    },
    observedAt,
    ok: false,
    requestId,
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value || !/^\d+$/u.test(value)) return undefined
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 3_600) : undefined
}

export class WhoDatProvider implements PublicRegistrationProvider {
  private readonly config: WhoDatConfig
  private readonly fetchImpl: typeof fetch
  private readonly inFlight = new Map<string, Promise<ProviderResult<PublicRegistrationRecord>>>()
  private readonly limiter: TokenBucketReadLimiter
  private readonly logger: WhoDatLogger
  private readonly now: () => number
  private readonly requestIdFactory: () => string

  constructor(options: WhoDatProviderOptions = {}) {
    this.config = configSchema.parse(options.config ?? configFromEnv())
    this.fetchImpl = options.fetchImpl ?? fetch
    this.logger = options.logger ?? defaultLogger
    this.now = options.now ?? Date.now
    this.requestIdFactory = options.requestIdFactory ?? (() => `whodat-${randomUUID()}`)
    this.limiter = new TokenBucketReadLimiter(
      this.config.ratePerSecond,
      this.config.burst,
      this.config.queueCapacity,
      this.config.queueWaitMs,
      this.now,
    )
  }

  async health(): Promise<ProviderResult<{ healthy: boolean }>> {
    const requestId = this.requestIdFactory()
    const observedAt = this.observedAt()
    try {
      const response = await this.fetchImpl(new URL('/health', this.config.baseUrl), {
        headers: this.headers(),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(this.config.timeoutMs, 2_000)),
      })
      return {
        data: { healthy: response.ok },
        observedAt,
        ok: true,
        requestId,
      }
    } catch {
      return failure('WHODAT_UNAVAILABLE', 'Who-Dat 服务暂时不可用', observedAt, requestId, {
        retryable: true,
        statusKnown: false,
      })
    }
  }

  async queryPublicRegistration(input: {
    domainAscii: string
    traceId: string
  }): Promise<ProviderResult<PublicRegistrationRecord>> {
    const normalized = normalizeDomain(input.domainAscii)
    if (!normalized.ok) {
      return failure(
        normalized.error.code,
        normalized.error.message,
        this.observedAt(),
        this.requestIdFactory(),
        { retryable: false, statusKnown: true },
      )
    }

    const key = normalized.value.ascii
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const requestId = this.requestIdFactory()
    const promise = this.limiter
      .schedule(() => this.execute(key, input.traceId, requestId))
      .catch((error: unknown) => this.controlFailure(error, input.traceId, requestId))
      .finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }

  private async execute(
    domainAscii: string,
    traceId: string,
    requestId: string,
  ): Promise<ProviderResult<PublicRegistrationRecord>> {
    const startedAt = this.now()
    const observedAt = this.observedAt()
    try {
      this.logger.info({
        event: 'whodat.request_started',
        provider: 'whodat',
        queueDepth: this.limiter.queueSize,
        requestId,
        traceId,
      })
      const baseUrl = this.config.baseUrl.endsWith('/')
        ? this.config.baseUrl
        : `${this.config.baseUrl}/`
      const response = await this.fetchImpl(
        new URL(`v1/whois/${encodeURIComponent(domainAscii)}`, baseUrl),
        {
          headers: this.headers(),
          redirect: 'error',
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
      )

      if (!response.ok) return this.httpFailure(response, observedAt, requestId, traceId)
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.includes('application/json'))
        return this.invalidResponse(observedAt, requestId, traceId)

      let candidate: unknown
      try {
        const bytes = await readBoundedBody(response, this.config.maxResponseBytes)
        candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
      } catch (error) {
        if (error instanceof RangeError)
          return this.providerFailure(
            'WHODAT_RESPONSE_TOO_LARGE',
            'Who-Dat 返回数据超过安全上限',
            observedAt,
            requestId,
            traceId,
            false,
          )
        return this.invalidResponse(observedAt, requestId, traceId)
      }

      const parsed = whoDatResponseSchema.safeParse(candidate)
      if (!parsed.success || parsed.data.query.toLowerCase() !== domainAscii)
        return this.invalidResponse(observedAt, requestId, traceId)
      const responseDomain = normalizeDomain(parsed.data.domain)
      if (!responseDomain.ok) return this.invalidResponse(observedAt, requestId, traceId)

      const record: PublicRegistrationRecord = {
        dates: parsed.data.dates,
        domainAscii: responseDomain.value.ascii,
        domainUnicode: parsed.data.domainUnicode ?? responseDomain.value.unicode,
        nameServers: [...new Set(parsed.data.nameservers.map((item) => item.name.toLowerCase()))],
        recordStatus: parsed.data.isRegistered ? 'record_found' : 'no_public_record',
        registrar: parsed.data.registrar.name,
        source: { protocol: parsed.data.meta.source, provider: 'whodat' },
        statuses: [...new Set(parsed.data.status)],
      }
      this.logger.info({
        cacheStatus: parsed.data.meta.cached ? 'hit' : 'miss',
        durationMs: Math.max(0, this.now() - startedAt),
        event: 'whodat.request_succeeded',
        provider: 'whodat',
        queueDepth: this.limiter.queueSize,
        requestId,
        traceId,
      })
      return {
        cache: { status: parsed.data.meta.cached ? 'hit' : 'miss' },
        data: record,
        observedAt: parsed.data.meta.fetchedAt,
        ok: true,
        requestId,
      }
    } catch (error) {
      const timeout = error instanceof DOMException && error.name === 'TimeoutError'
      return this.providerFailure(
        timeout ? 'WHODAT_TIMEOUT' : 'WHODAT_UNAVAILABLE',
        timeout ? 'Who-Dat 查询超时' : '暂时无法连接 Who-Dat',
        observedAt,
        requestId,
        traceId,
        true,
      )
    }
  }

  private controlFailure(
    error: unknown,
    traceId: string,
    requestId: string,
  ): ProviderResult<PublicRegistrationRecord> {
    const code = error instanceof ReadQueueFullError ? 'WHODAT_QUEUE_FULL' : 'WHODAT_QUEUE_TIMEOUT'
    const message =
      error instanceof ReadQueueFullError ? 'Who-Dat 查询队列已满' : 'Who-Dat 查询排队超时'
    return this.providerFailure(code, message, this.observedAt(), requestId, traceId, true, 1)
  }

  private headers(): HeadersInit {
    return {
      accept: 'application/json',
      ...(this.config.authKey ? { authorization: `Bearer ${this.config.authKey}` } : {}),
    }
  }

  private httpFailure(
    response: Response,
    observedAt: string,
    requestId: string,
    traceId: string,
  ): ProviderResult<PublicRegistrationRecord> {
    if (response.status >= 300 && response.status < 400) {
      return this.providerFailure(
        'WHODAT_REDIRECT_REJECTED',
        'Who-Dat 返回了不允许的重定向',
        observedAt,
        requestId,
        traceId,
        false,
      )
    }
    const mapped = {
      400: ['WHODAT_INVALID_DOMAIN', 'Who-Dat 无法识别该域名', false, true],
      401: ['WHODAT_AUTH_FAILED', 'Who-Dat 鉴权失败', false, true],
      403: ['WHODAT_AUTH_FAILED', 'Who-Dat 鉴权失败', false, true],
      429: ['WHODAT_RATE_LIMITED', 'Who-Dat 请求过于频繁', true, false],
      501: ['WHODAT_UNSUPPORTED_TLD', 'Who-Dat 暂不支持该域名后缀', false, true],
      502: ['WHODAT_UPSTREAM_ERROR', 'Who-Dat 上游注册数据源异常', true, false],
      504: ['WHODAT_TIMEOUT', 'Who-Dat 上游注册数据源超时', true, false],
    } as const
    const entry = mapped[response.status as keyof typeof mapped]
    const [code, message, retryable, statusKnown] = entry ?? [
      'WHODAT_QUERY_FAILED',
      'Who-Dat 未能完成查询',
      response.status >= 500,
      false,
    ]
    return this.providerFailure(
      code,
      message,
      observedAt,
      requestId,
      traceId,
      retryable,
      response.status === 429 ? retryAfterSeconds(response) : undefined,
      statusKnown,
    )
  }

  private invalidResponse(
    observedAt: string,
    requestId: string,
    traceId: string,
  ): ProviderResult<PublicRegistrationRecord> {
    return this.providerFailure(
      'WHODAT_INVALID_RESPONSE',
      'Who-Dat 返回了无法识别的数据',
      observedAt,
      requestId,
      traceId,
      false,
    )
  }

  private providerFailure(
    code: string,
    message: string,
    observedAt: string,
    requestId: string,
    traceId: string,
    retryable: boolean,
    retryAfter?: number,
    statusKnown = false,
  ): ProviderResult<PublicRegistrationRecord> {
    this.logger.warn({
      errorCode: code,
      event: 'whodat.request_failed',
      provider: 'whodat',
      queueDepth: this.limiter.queueSize,
      requestId,
      traceId,
    })
    return failure(code, message, observedAt, requestId, {
      retryAfterSeconds: retryAfter,
      retryable,
      statusKnown,
    })
  }

  private observedAt(): string {
    return new Date(this.now()).toISOString()
  }
}
