import { Buffer } from 'node:buffer'
import { randomInt, randomUUID } from 'node:crypto'

import * as dnsPacket from 'dns-packet'
import { z } from 'zod'

import type { ProviderError, ProviderResult } from '@/lib/domain'
import { normalizeDomain } from '@/lib/domain-name'
import { getEnv } from '@/lib/env'
import { logger as defaultLogger } from '@/lib/logging'
import {
  BoundedReadConcurrency,
  ReadConcurrencyFullError,
  ReadConcurrencyTimeoutError,
  ReadQueueFullError,
  ReadQueueTimeoutError,
  TokenBucketReadLimiter,
  readBoundedBody,
} from '@/providers/read-control'
import type { DnsProviderAnswer, DnsReadProvider } from '@/providers/types'
import {
  DNS_MAX_RECORDS_PER_TYPE,
  dnsRecordSchema,
  type DnsRecord,
  type DnsRecordType,
} from '@/schemas/dns'

const ALIDNS_ENDPOINTS = [
  { node: 'alidns_primary', url: 'https://223.5.5.5/dns-query' },
  { node: 'alidns_secondary', url: 'https://223.6.6.6/dns-query' },
] as const

const configSchema = z.strictObject({
  burst: z.number().int().positive(),
  maxConcurrency: z.number().int().positive(),
  maxResponseBytes: z.number().int().positive(),
  queueCapacity: z.number().int().positive(),
  queueWaitMs: z.number().int().positive(),
  ratePerSecond: z.number().positive(),
  timeoutMs: z.number().int().positive(),
})

export type AliDnsConfig = z.infer<typeof configSchema>

type AliDnsLogger = {
  info(fields: Record<string, unknown>): void
  warn(fields: Record<string, unknown>): void
}

type AliDnsProviderOptions = {
  config?: AliDnsConfig
  fetchImpl?: typeof fetch
  logger?: AliDnsLogger
  now?: () => number
  requestIdFactory?: () => string
  transactionIdFactory?: () => number
}

type DecodedPacket = ReturnType<typeof dnsPacket.decode> & { rcode?: string }
type Endpoint = (typeof ALIDNS_ENDPOINTS)[number]

class DnsAttemptTimeoutError extends Error {}
class DnsInvalidResponseError extends Error {}
class DnsResponseTooLargeError extends Error {}
class DnsUnavailableError extends Error {}

function configFromEnv(): AliDnsConfig {
  const env = getEnv()
  return {
    burst: env.DNS_READ_BURST,
    maxConcurrency: env.DNS_READ_MAX_CONCURRENCY,
    maxResponseBytes: env.DNS_RESPONSE_MAX_BYTES,
    queueCapacity: env.DNS_READ_QUEUE_CAPACITY,
    queueWaitMs: env.DNS_READ_QUEUE_WAIT_MS,
    ratePerSecond: env.DNS_READ_RATE_PER_SECOND,
    timeoutMs: env.DNS_TIMEOUT_MS,
  }
}

function failure<T>(
  code: string,
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
      ...(options.retryAfterSeconds ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
      retryable: options.retryable,
      statusKnown: options.statusKnown,
    },
    observedAt,
    ok: false,
    requestId,
  }
}

function canonicalName(value: string): string {
  const normalized = normalizeDomain(value)
  if (!normalized.ok || !normalized.value.ascii.includes('.')) throw new DnsInvalidResponseError()
  return normalized.value.ascii
}

function displayDnsName(value: string): string {
  const candidate = value.endsWith('.') ? value.slice(0, -1) : value
  if (!candidate || candidate.length > 253 || /[\s\u0000-\u001f\u007f]/u.test(candidate)) {
    throw new DnsInvalidResponseError()
  }
  return candidate.toLowerCase()
}

function hostnameTarget(value: string, allowRoot = false): string {
  if (allowRoot && value === '.') return '.'
  return canonicalName(value)
}

function safeTtl(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value < 0 || value > 4_294_967_295) {
    throw new DnsInvalidResponseError()
  }
  return value
}

function safeUint32(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value < 0 || value > 4_294_967_295) {
    throw new DnsInvalidResponseError()
  }
  return value
}

function txtValue(data: dnsPacket.TxtData): string {
  const chunks = Array.isArray(data) ? data : [data]
  const value = chunks
    .map((chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new DnsInvalidResponseError()
      }
    })
    .join('')
  if (Buffer.byteLength(value, 'utf8') > 4_096) throw new DnsInvalidResponseError()
  return value
}

function cnameChain(packet: DecodedPacket, query: string): Set<string> {
  const answers = packet.answers ?? []
  const cnames = answers.filter(
    (answer): answer is dnsPacket.StringAnswer => answer.type === 'CNAME',
  )
  const allowed = new Set([query])
  const remaining = new Set(cnames)

  for (let pass = 0; pass <= cnames.length; pass += 1) {
    let changed = false
    for (const answer of remaining) {
      const owner = canonicalName(answer.name)
      if (!allowed.has(owner)) continue
      allowed.add(canonicalName(answer.data))
      remaining.delete(answer)
      changed = true
    }
    if (!changed) break
  }
  if (remaining.size > 0) throw new DnsInvalidResponseError()
  return allowed
}

function parseRecord(answer: dnsPacket.Answer, type: DnsRecordType): DnsRecord {
  const ownerName = canonicalName(answer.name)
  const ttl = safeTtl('ttl' in answer ? answer.ttl : undefined)

  if (type === 'A' && answer.type === 'A') {
    return dnsRecordSchema.parse({ address: answer.data, ownerName, ttl, type })
  }
  if (type === 'AAAA' && answer.type === 'AAAA') {
    return dnsRecordSchema.parse({ address: answer.data, ownerName, ttl, type })
  }
  if (type === 'CNAME' && answer.type === 'CNAME') {
    return dnsRecordSchema.parse({ ownerName, target: hostnameTarget(answer.data), ttl, type })
  }
  if (type === 'MX' && answer.type === 'MX') {
    return dnsRecordSchema.parse({
      exchange: hostnameTarget(answer.data.exchange, true),
      ownerName,
      priority: answer.data.preference ?? 0,
      ttl,
      type,
    })
  }
  if (type === 'TXT' && answer.type === 'TXT') {
    return dnsRecordSchema.parse({ ownerName, ttl, type, value: txtValue(answer.data) })
  }
  if (type === 'NS' && answer.type === 'NS') {
    return dnsRecordSchema.parse({ host: hostnameTarget(answer.data), ownerName, ttl, type })
  }
  if (type === 'SOA' && answer.type === 'SOA') {
    return dnsRecordSchema.parse({
      expire: safeUint32(answer.data.expire),
      minimum: safeUint32(answer.data.minimum),
      ownerName,
      primaryNameServer: hostnameTarget(answer.data.mname),
      refresh: safeUint32(answer.data.refresh),
      responsibleMailbox: displayDnsName(answer.data.rname),
      retry: safeUint32(answer.data.retry),
      serial: safeUint32(answer.data.serial),
      ttl,
      type,
    })
  }
  if (type === 'CAA' && answer.type === 'CAA') {
    return dnsRecordSchema.parse({
      flags: answer.data.flags ?? (answer.data.issuerCritical ? 128 : 0),
      ownerName,
      tag: answer.data.tag,
      ttl,
      type,
      value: answer.data.value,
    })
  }
  throw new DnsInvalidResponseError()
}

function negativeTtl(packet: DecodedPacket): number | undefined {
  const values = (packet.authorities ?? [])
    .filter((answer): answer is dnsPacket.SoaAnswer => answer.type === 'SOA')
    .map((answer) => Math.min(safeTtl(answer.ttl), safeUint32(answer.data.minimum)))
  return values.length > 0 ? Math.min(...values) : undefined
}

function parsePacket(
  bytes: Uint8Array,
  input: { domainAscii: string; recordType: DnsRecordType; transactionId: number },
  endpoint: Endpoint,
  fallbackUsed: boolean,
): DnsProviderAnswer {
  let packet: DecodedPacket
  try {
    packet = dnsPacket.decode(Buffer.from(bytes)) as DecodedPacket
  } catch {
    throw new DnsInvalidResponseError()
  }
  const question = packet.questions?.[0]
  if (
    packet.type !== 'response' ||
    packet.id !== input.transactionId ||
    !packet.flag_rd ||
    !packet.flag_ra ||
    packet.flag_tc ||
    packet.questions?.length !== 1 ||
    !question ||
    question.class !== 'IN' ||
    question.type !== input.recordType ||
    canonicalName(question.name) !== input.domainAscii
  ) {
    throw new DnsInvalidResponseError()
  }

  const rcode = packet.rcode ?? 'NOERROR'
  if (rcode === 'NXDOMAIN') {
    return {
      fallbackUsed,
      negativeTtlSeconds: negativeTtl(packet),
      records: [],
      resolverNode: endpoint.node,
      status: 'nxdomain',
    }
  }
  if (rcode === 'SERVFAIL') {
    return {
      fallbackUsed,
      records: [],
      resolverNode: endpoint.node,
      status: 'servfail',
    }
  }
  if (rcode !== 'NOERROR') throw new DnsUnavailableError()

  const allowedOwners = cnameChain(packet, input.domainAscii)
  const answers = (packet.answers ?? []).filter((answer) => answer.type === input.recordType)
  if (answers.length > DNS_MAX_RECORDS_PER_TYPE) throw new DnsInvalidResponseError()
  const records = answers.map((answer) => {
    const owner = canonicalName(answer.name)
    if (!allowedOwners.has(owner)) throw new DnsInvalidResponseError()
    return parseRecord(answer, input.recordType)
  })
  return {
    fallbackUsed,
    ...(records.length === 0 ? { negativeTtlSeconds: negativeTtl(packet) } : {}),
    records,
    resolverNode: endpoint.node,
    status: records.length > 0 ? 'records' : 'no_record',
  }
}

export class AliDnsProvider implements DnsReadProvider {
  private readonly concurrency: BoundedReadConcurrency
  private readonly config: AliDnsConfig
  private readonly fetchImpl: typeof fetch
  private readonly inFlight = new Map<string, Promise<ProviderResult<DnsProviderAnswer>>>()
  private readonly limiter: TokenBucketReadLimiter
  private readonly logger: AliDnsLogger
  private readonly now: () => number
  private readonly requestIdFactory: () => string
  private readonly transactionIdFactory: () => number

  constructor(options: AliDnsProviderOptions = {}) {
    this.config = configSchema.parse(options.config ?? configFromEnv())
    this.fetchImpl = options.fetchImpl ?? fetch
    this.logger = options.logger ?? defaultLogger
    this.now = options.now ?? Date.now
    this.requestIdFactory = options.requestIdFactory ?? (() => `dns-${randomUUID()}`)
    this.transactionIdFactory = options.transactionIdFactory ?? (() => randomInt(0, 65_536))
    this.limiter = new TokenBucketReadLimiter(
      this.config.ratePerSecond,
      this.config.burst,
      this.config.queueCapacity,
      this.config.queueWaitMs,
      this.now,
    )
    this.concurrency = new BoundedReadConcurrency(
      this.config.maxConcurrency,
      this.config.queueCapacity,
      this.config.queueWaitMs,
    )
  }

  async health(): Promise<ProviderResult<{ healthy: boolean }>> {
    const result = await this.queryRecordSet({
      domainAscii: 'example.com',
      recordType: 'A',
      traceId: 'dns-health-check',
    })
    if (!result.ok) return result
    return {
      cache: result.cache,
      data: { healthy: result.data.status === 'records' },
      observedAt: result.observedAt,
      ok: true,
      requestId: result.requestId,
    }
  }

  async queryRecordSet(input: {
    domainAscii: string
    recordType: DnsRecordType
    traceId: string
  }): Promise<ProviderResult<DnsProviderAnswer>> {
    const normalized = normalizeDomain(input.domainAscii)
    if (!normalized.ok || !normalized.value.ascii.includes('.')) {
      return failure(
        'DNS_INVALID_DOMAIN',
        'DNS 查询域名格式无效',
        this.observedAt(),
        this.requestIdFactory(),
        { retryable: false, statusKnown: true },
      )
    }
    const key = `${normalized.value.ascii}:${input.recordType}`
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const requestId = this.requestIdFactory()
    const promise = this.execute(
      normalized.value.ascii,
      input.recordType,
      input.traceId,
      requestId,
    ).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }

  private async execute(
    domainAscii: string,
    recordType: DnsRecordType,
    traceId: string,
    requestId: string,
  ): Promise<ProviderResult<DnsProviderAnswer>> {
    const startedAt = this.now()
    const transactionId = this.transactionIdFactory()
    const query = dnsPacket.encode({
      flags: dnsPacket.RECURSION_DESIRED,
      id: transactionId,
      questions: [{ class: 'IN', name: domainAscii, type: recordType }],
      type: 'query',
    })
    const deadline = this.now() + this.config.timeoutMs
    let semanticFallback: DnsProviderAnswer | undefined
    const attemptErrors: unknown[] = []

    for (const [index, endpoint] of ALIDNS_ENDPOINTS.entries()) {
      try {
        const remaining = Math.max(1, deadline - this.now())
        const attemptsLeft = ALIDNS_ENDPOINTS.length - index
        const attemptTimeoutMs = Math.max(1, Math.floor(remaining / attemptsLeft))
        const bytes = await this.limiter.schedule(() =>
          this.concurrency.schedule(() =>
            this.fetchPacket(query, endpoint, attemptTimeoutMs, {
              recordType,
              requestId,
              traceId,
            }),
          ),
        )
        const data = parsePacket(
          bytes,
          { domainAscii, recordType, transactionId },
          endpoint,
          index > 0,
        )
        if (data.status === 'servfail' && index === 0) {
          semanticFallback = data
          continue
        }
        this.logger.info({
          cacheStatus: 'miss',
          durationMs: Math.max(0, this.now() - startedAt),
          event: 'dns.request_succeeded',
          fallbackUsed: data.fallbackUsed,
          provider: 'alidns',
          queueDepth: this.limiter.queueSize + this.concurrency.queueSize,
          recordCount: data.records.length,
          recordType,
          requestId,
          resolverNode: data.resolverNode,
          traceId,
        })
        return {
          cache: { status: 'miss' },
          data,
          observedAt: this.observedAt(),
          ok: true,
          requestId,
        }
      } catch (error) {
        if (this.isControlError(error))
          return this.controlFailure(error, recordType, traceId, requestId)
        attemptErrors.push(error)
      }
    }

    if (semanticFallback) {
      return {
        cache: { status: 'miss' },
        data: semanticFallback,
        observedAt: this.observedAt(),
        ok: true,
        requestId,
      }
    }
    const mapped = this.attemptFailure(attemptErrors, requestId)
    this.logger.warn({
      cacheStatus: 'miss',
      durationMs: Math.max(0, this.now() - startedAt),
      errorCode: mapped.error.code,
      event: 'dns.request_failed',
      provider: 'alidns',
      queueDepth: this.limiter.queueSize + this.concurrency.queueSize,
      recordType,
      requestId,
      retryable: mapped.error.retryable,
      traceId,
    })
    return mapped
  }

  private async fetchPacket(
    query: Uint8Array,
    endpoint: Endpoint,
    timeoutMs: number,
    context: { recordType: DnsRecordType; requestId: string; traceId: string },
  ): Promise<Uint8Array> {
    this.logger.info({
      activeQueries: this.concurrency.activeCount,
      event: 'dns.request_started',
      provider: 'alidns',
      queueDepth: this.limiter.queueSize + this.concurrency.queueSize,
      recordType: context.recordType,
      requestId: context.requestId,
      resolverNode: endpoint.node,
      traceId: context.traceId,
    })
    let response: Response
    try {
      response = await this.fetchImpl(endpoint.url, {
        body: query,
        cache: 'no-store',
        headers: {
          accept: 'application/dns-message',
          'content-type': 'application/dns-message',
        },
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new DnsAttemptTimeoutError()
      }
      throw new DnsUnavailableError()
    }
    if (!response.ok) throw new DnsUnavailableError()
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('application/dns-message')) throw new DnsInvalidResponseError()
    try {
      return await readBoundedBody(response, this.config.maxResponseBytes)
    } catch (error) {
      if (error instanceof RangeError) throw new DnsResponseTooLargeError()
      throw new DnsInvalidResponseError()
    }
  }

  private isControlError(error: unknown): boolean {
    return (
      error instanceof ReadQueueFullError ||
      error instanceof ReadQueueTimeoutError ||
      error instanceof ReadConcurrencyFullError ||
      error instanceof ReadConcurrencyTimeoutError
    )
  }

  private controlFailure(
    error: unknown,
    recordType: DnsRecordType,
    traceId: string,
    requestId: string,
  ): Extract<ProviderResult<DnsProviderAnswer>, { ok: false }> {
    const queueFull =
      error instanceof ReadQueueFullError || error instanceof ReadConcurrencyFullError
    const result = failure<DnsProviderAnswer>(
      queueFull ? 'DNS_QUEUE_FULL' : 'DNS_QUEUE_TIMEOUT',
      queueFull ? 'DNS 查询队列已满' : 'DNS 查询排队超时',
      this.observedAt(),
      requestId,
      { retryAfterSeconds: 1, retryable: true, statusKnown: false },
    )
    this.logger.warn({
      errorCode: result.error.code,
      event: 'dns.request_failed',
      provider: 'alidns',
      queueDepth: this.limiter.queueSize + this.concurrency.queueSize,
      recordType,
      requestId,
      retryable: true,
      traceId,
    })
    return result
  }

  private attemptFailure(
    errors: unknown[],
    requestId: string,
  ): Extract<ProviderResult<DnsProviderAnswer>, { ok: false }> {
    const observedAt = this.observedAt()
    if (errors.length > 0 && errors.every((error) => error instanceof DnsAttemptTimeoutError)) {
      return failure('DNS_TIMEOUT', 'DNS 查询超时', observedAt, requestId, {
        retryable: true,
        statusKnown: false,
      })
    }
    if (errors.some((error) => error instanceof DnsResponseTooLargeError)) {
      return failure('DNS_RESPONSE_TOO_LARGE', 'DNS 响应超过安全上限', observedAt, requestId, {
        retryable: false,
        statusKnown: false,
      })
    }
    if (errors.some((error) => error instanceof DnsInvalidResponseError)) {
      return failure(
        'DNS_INVALID_RESPONSE',
        'DNS 解析器返回了无法识别的响应',
        observedAt,
        requestId,
        {
          retryable: false,
          statusKnown: false,
        },
      )
    }
    return failure('DNS_UNAVAILABLE', '暂时无法连接 DNS 解析器', observedAt, requestId, {
      retryable: true,
      statusKnown: false,
    })
  }

  private observedAt(): string {
    return new Date(this.now()).toISOString()
  }
}
