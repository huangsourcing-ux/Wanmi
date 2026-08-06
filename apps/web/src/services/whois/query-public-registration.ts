import { isIP } from 'node:net'

import { AppError, toProblemDetails } from '@/lib/errors'
import { normalizeDomain, type NormalizedDomain } from '@/lib/domain-name'
import type { ProviderResult } from '@/lib/domain'
import type { PublicRegistrationProvider, PublicRegistrationRecord } from '@/providers/types'
import {
  whoisLookupRequestSchema,
  whoisLookupDataSchema,
  whoisLookupResultSchema,
  type WhoisLookupData,
  type WhoisLookupRequest,
  type WhoisLookupResult,
} from '@/schemas/whois'
import type { ResultMeta } from '@/schemas/api'

const WHODAT_RATE_LIMIT_CODES = new Set([
  'WHODAT_RATE_LIMITED',
  'WHODAT_QUEUE_FULL',
  'WHODAT_QUEUE_TIMEOUT',
])

const WHODAT_FALLBACK_CODES = new Set([
  'WHODAT_REDIRECT_REJECTED',
  'WHODAT_UNSUPPORTED_TLD',
  'WHODAT_UPSTREAM_ERROR',
  'WHODAT_TIMEOUT',
  'WHODAT_UNAVAILABLE',
  'WHODAT_RESPONSE_TOO_LARGE',
  'WHODAT_INVALID_RESPONSE',
])

const WESTDIGITAL_RATE_LIMIT_CODES = new Set([
  'WESTDIGITAL_RATE_LIMITED',
  'WESTDIGITAL_QUEUE_FULL',
  'WESTDIGITAL_QUEUE_TIMEOUT',
])

const FORBIDDEN_HOSTNAMES = new Set(['instance-data', 'metadata', 'metadata.google.internal'])
const FORBIDDEN_HOST_SUFFIXES = ['.home', '.internal', '.lan', '.local', '.localhost']
const FORBIDDEN_SYNTAX = /[\s/:@?#\\]/u

type QueryPublicRegistrationOptions = {
  fallback?: PublicRegistrationProvider
  primary: PublicRegistrationProvider
  traceId: string
}

function invalidInput(code: string, message: string): AppError {
  return new AppError(code, message, 400, {
    action: '请输入不含协议、路径、端口或查询参数的完整域名',
    retryable: false,
    title: 'WHOIS 查询参数无效',
  })
}

function normalizedInput(query: string): NormalizedDomain {
  const candidate = query.trim()
  const literalCandidate =
    candidate.startsWith('[') && candidate.endsWith(']') ? candidate.slice(1, -1) : candidate
  if (isIP(literalCandidate) !== 0) {
    throw invalidInput('DOMAIN_TARGET_FORBIDDEN', 'WHOIS 查询不接受 IP 地址或受限网络目标')
  }
  if (FORBIDDEN_SYNTAX.test(candidate)) {
    throw invalidInput('WHOIS_DOMAIN_FORMAT_INVALID', 'WHOIS 查询只接受完整域名')
  }

  const normalized = normalizeDomain(candidate)
  if (!normalized.ok) throw invalidInput(normalized.error.code, normalized.error.message)
  if (!normalized.value.ascii.includes('.')) {
    throw invalidInput('WHOIS_FULL_DOMAIN_REQUIRED', 'WHOIS 查询需要完整域名，不能只输入单个标签')
  }

  const hostname = normalized.value.ascii.toLowerCase()
  if (
    FORBIDDEN_HOSTNAMES.has(hostname) ||
    FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw invalidInput('DOMAIN_TARGET_FORBIDDEN', 'WHOIS 查询不接受本地或元数据网络目标')
  }
  return normalized.value
}

function sourceLabel(record: PublicRegistrationRecord): string {
  if (record.source.provider === 'westdigital') return '西部数码 WHOIS'
  return record.source.protocol === 'rdap' ? 'Who-Dat RDAP' : 'Who-Dat WHOIS'
}

function dataFor(record: PublicRegistrationRecord, query: NormalizedDomain): WhoisLookupData {
  return whoisLookupDataSchema.parse({
    ...record,
    normalizedQueryAscii: query.ascii,
    normalizedQueryUnicode: query.unicode,
    risks: query.risks,
  })
}

function metaFor(result: ProviderResult<unknown>, traceId: string, dataSource: string): ResultMeta {
  return {
    cacheStatus: result.cache?.status ?? 'miss',
    dataSource,
    observedAt: result.observedAt,
    traceId,
  }
}

function problemForProvider(
  result: Extract<ProviderResult<unknown>, { ok: false }>,
  traceId: string,
  options: {
    code?: string
    dataSource: string
    message?: string
    status?: number
    title?: string
  },
) {
  const status = options.status ?? (WHODAT_RATE_LIMIT_CODES.has(result.error.code) ? 429 : 503)
  return toProblemDetails(
    new AppError(
      options.code ?? result.error.code,
      options.message ?? result.error.message,
      status,
      {
        action: status === 429 ? '请按提示等待后重试' : '请稍后重试；不要据此推断域名是否可注册',
        dataSource: options.dataSource,
        observedAt: result.observedAt,
        retryable: result.error.retryable,
        retryAfterSeconds: result.error.retryAfterSeconds,
        title:
          options.title ?? (status === 429 ? 'WHOIS 查询请求过于频繁' : 'WHOIS 查询暂时不可用'),
      },
    ),
    traceId,
  )
}

function successResult(
  providerResult: Extract<ProviderResult<PublicRegistrationRecord>, { ok: true }>,
  query: NormalizedDomain,
  traceId: string,
): WhoisLookupResult {
  const data = dataFor(providerResult.data, query)
  return whoisLookupResultSchema.parse({
    data,
    meta: metaFor(providerResult, traceId, sourceLabel(providerResult.data)),
    state: data.recordStatus === 'no_public_record' ? 'empty' : 'ready',
  })
}

function rateLimitedResult(
  result: Extract<ProviderResult<PublicRegistrationRecord>, { ok: false }>,
  traceId: string,
  dataSource: string,
): WhoisLookupResult {
  const meta = metaFor(result, traceId, dataSource)
  return whoisLookupResultSchema.parse({
    meta,
    problem: problemForProvider(result, traceId, { dataSource, status: 429 }),
    state: 'rate_limited',
  })
}

export async function queryPublicRegistration(
  candidate: WhoisLookupRequest,
  options: QueryPublicRegistrationOptions,
): Promise<WhoisLookupResult> {
  const input = whoisLookupRequestSchema.parse(candidate)
  const query = normalizedInput(input.query)
  const primary = await options.primary.queryPublicRegistration({
    domainAscii: query.ascii,
    traceId: options.traceId,
  })

  if (primary.ok) return successResult(primary, query, options.traceId)
  if (WHODAT_RATE_LIMIT_CODES.has(primary.error.code)) {
    return rateLimitedResult(primary, options.traceId, 'Who-Dat RDAP/WHOIS')
  }

  if (!options.fallback || !WHODAT_FALLBACK_CODES.has(primary.error.code)) {
    const meta = metaFor(primary, options.traceId, 'Who-Dat RDAP/WHOIS')
    return whoisLookupResultSchema.parse({
      meta,
      problem: problemForProvider(primary, options.traceId, { dataSource: 'Who-Dat RDAP/WHOIS' }),
      state: 'error',
    })
  }

  const fallback = await options.fallback.queryPublicRegistration({
    domainAscii: query.ascii,
    traceId: options.traceId,
  })
  if (fallback.ok) {
    const data = dataFor(fallback.data, query)
    const dataSource = `${sourceLabel(fallback.data)}（Who-Dat 降级）`
    const meta = metaFor(fallback, options.traceId, dataSource)
    return whoisLookupResultSchema.parse({
      data,
      meta,
      problem: problemForProvider(primary, options.traceId, {
        code: 'WHOIS_FALLBACK_USED',
        dataSource,
        message: 'Who-Dat 暂时不可用，当前展示西部数码 WHOIS 降级结果',
        status: 503,
        title: '当前使用降级数据源',
      }),
      state: 'degraded',
    })
  }

  const combinedSource = 'Who-Dat RDAP/WHOIS + 西部数码 WHOIS'
  if (WESTDIGITAL_RATE_LIMIT_CODES.has(fallback.error.code)) {
    return rateLimitedResult(fallback, options.traceId, combinedSource)
  }
  const observedAt =
    fallback.observedAt > primary.observedAt ? fallback.observedAt : primary.observedAt
  const meta: ResultMeta = {
    cacheStatus: 'miss',
    dataSource: combinedSource,
    observedAt,
    traceId: options.traceId,
  }
  return whoisLookupResultSchema.parse({
    meta,
    problem: problemForProvider(fallback, options.traceId, {
      code: 'WHOIS_SOURCES_UNAVAILABLE',
      dataSource: combinedSource,
      message: '两个公开注册数据源均未能完成本次查询',
      status: 503,
      title: 'WHOIS 查询暂时不可用',
    }),
    state: 'error',
  })
}
