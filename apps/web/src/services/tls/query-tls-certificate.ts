import { isIP } from 'node:net'

import { AppError, toProblemDetails } from '@/lib/errors'
import { normalizeDomain, type NormalizedDomain } from '@/lib/domain-name'
import { getEnv } from '@/lib/env'
import type { DnsReadProvider, TlsHandshakeProvider } from '@/providers/types'
import type { ResultMeta } from '@/schemas/api'
import type { DnsRecordSet } from '@/schemas/dns'
import {
  TLS_MAX_ADDRESSES,
  TLS_PORT,
  caaInspectionSchema,
  sslCheckDataSchema,
  sslCheckRequestSchema,
  sslCheckResultSchema,
  tlsInspectionSchema,
  type CaaInspection,
  type SslCheckRequest,
  type SslCheckResult,
  type TlsInspection,
} from '@/schemas/tls'
import {
  DnsResultCache,
  querySafeDnsRecordSet,
  type DnsCacheConfig,
  type ResolvedDnsRecordSet,
} from '@/services/dns/query-dns-records'

const DATA_SOURCE = '阿里公共 DNS + 直接 TLS 443 握手'
const DNS_SOURCE = '阿里公共 DNS（受控 DoH）'
const TLS_SOURCE = '直接 TLS 443 握手（Node.js 系统信任库）'
const FORBIDDEN_HOSTNAMES = new Set(['instance-data', 'metadata', 'metadata.google.internal'])
const FORBIDDEN_HOST_SUFFIXES = ['.home', '.internal', '.lan', '.local', '.localhost']
const FORBIDDEN_SYNTAX = /[\s/:@?#\\]/u
const CAA_MAX_LEVELS = 16

type TlsResultCacheConfig = {
  emptyTtlMs: number
  maxEntries: number
  resultTtlMs: number
}

type CacheEntry = {
  expiresAt: number
  result: Extract<SslCheckResult, { state: 'degraded' | 'empty' | 'ready' }>
}

type QueryTlsCertificateOptions = {
  cache?: TlsResultCache
  cacheConfig?: TlsResultCacheConfig
  dnsCache?: DnsResultCache
  dnsCacheConfig?: DnsCacheConfig
  dnsLookup?: typeof querySafeDnsRecordSet
  dnsProvider: DnsReadProvider
  now?: () => number
  tlsProvider: TlsHandshakeProvider
  traceId: string
}

export class TlsResultCache {
  private readonly values = new Map<string, CacheEntry>()

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  get(key: string, traceId: string): SslCheckResult | undefined {
    const entry = this.values.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.values.delete(key)
      return undefined
    }
    this.values.delete(key)
    this.values.set(key, entry)
    const result = structuredClone(entry.result)
    result.meta = { ...result.meta, cacheStatus: 'hit', traceId }
    result.data.tls.source.cacheStatus = 'hit'
    result.data.caa.source.cacheStatus = 'hit'
    if (result.state === 'degraded') result.problem.traceId = traceId
    return sslCheckResultSchema.parse(result)
  }

  set(key: string, result: SslCheckResult, ttlMs: number): void {
    if (
      ttlMs <= 0 ||
      (result.state !== 'degraded' && result.state !== 'empty' && result.state !== 'ready')
    )
      return
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
    this.values.set(key, {
      expiresAt: currentTime + ttlMs,
      result: structuredClone(result),
    })
  }
}

let sharedCache: TlsResultCache | undefined
const inFlight = new Map<string, Promise<SslCheckResult>>()

function resultForTrace(result: SslCheckResult, traceId: string): SslCheckResult {
  const cloned = structuredClone(result)
  cloned.meta = { ...cloned.meta, traceId }
  if ('problem' in cloned) cloned.problem.traceId = traceId
  return sslCheckResultSchema.parse(cloned)
}

function cacheConfigFromEnv(): TlsResultCacheConfig {
  const env = getEnv()
  return {
    emptyTtlMs: env.TLS_EMPTY_CACHE_TTL_MS,
    maxEntries: env.TLS_CACHE_MAX_ENTRIES,
    resultTtlMs: env.TLS_RESULT_CACHE_TTL_MS,
  }
}

function invalidInput(code: string, message: string): AppError {
  return new AppError(code, message, 400, {
    action: '请输入不含协议、路径、端口或查询参数的完整公网域名',
    retryable: false,
    title: 'SSL 检查参数无效',
  })
}

function normalizedInput(query: string): NormalizedDomain {
  const candidate = query.trim()
  const literalCandidate =
    candidate.startsWith('[') && candidate.endsWith(']') ? candidate.slice(1, -1) : candidate
  if (isIP(literalCandidate) !== 0) {
    throw invalidInput('TLS_TARGET_FORBIDDEN', 'SSL 检查不接受 IP 地址或受限网络目标')
  }
  if (FORBIDDEN_SYNTAX.test(candidate)) {
    throw invalidInput('TLS_DOMAIN_FORMAT_INVALID', 'SSL 检查只接受完整域名')
  }
  const normalized = normalizeDomain(candidate)
  if (!normalized.ok) throw invalidInput(normalized.error.code, normalized.error.message)
  if (!normalized.value.ascii.includes('.')) {
    throw invalidInput('TLS_FULL_DOMAIN_REQUIRED', 'SSL 检查需要完整域名，不能只输入单个标签')
  }
  const hostname = normalized.value.ascii.toLowerCase().replace(/\.$/u, '')
  if (
    FORBIDDEN_HOSTNAMES.has(hostname) ||
    FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw invalidInput('TLS_TARGET_FORBIDDEN', 'SSL 检查不接受本地或元数据网络目标')
  }
  return normalized.value
}

function issue(code: string, message: string, retryable: boolean) {
  return { code, message, retryable }
}

function aggregateCacheStatus(values: Array<'hit' | 'miss' | 'mixed' | 'not_used'>) {
  const used = values.filter((value) => value !== 'not_used')
  if (used.length === 0) return 'not_used' as const
  if (used.every((value) => value === 'hit')) return 'hit' as const
  if (used.every((value) => value === 'miss')) return 'miss' as const
  return 'mixed' as const
}

function latestObservedAt(values: string[]): string {
  return values.reduce(
    (latest, value) => (value > latest ? value : latest),
    new Date(0).toISOString(),
  )
}

function resultProblem(
  code: string,
  message: string,
  traceId: string,
  meta: ResultMeta,
  options: { retryable: boolean; status?: number; title: string },
) {
  return toProblemDetails(
    new AppError(code, message, options.status ?? 503, {
      action: options.retryable ? '请稍后重试' : '请检查域名与证书配置后重试',
      dataSource: meta.dataSource,
      observedAt: meta.observedAt,
      retryable: options.retryable,
      title: options.title,
    }),
    traceId,
  )
}

function caaExplanation(tag: 'issue' | 'issuewild' | 'iodef', value: string, critical: boolean) {
  const prefix = critical ? '该属性设置了 critical 标志；无法理解它的 CA 必须拒绝签发。' : ''
  if (tag === 'issue' && value.trim() === '') {
    return `${prefix} issue 为空，表示不允许任何 CA 为普通域名证书签发。`.trim()
  }
  if (tag === 'issue') {
    return `${prefix} issue 指定可为普通域名证书签发的 CA；参数仅原样展示。`.trim()
  }
  if (tag === 'issuewild') {
    return `${prefix} issuewild 指定可为通配符证书签发的 CA；空值表示禁止通配符签发。`.trim()
  }
  return `${prefix} iodef 是违规签发报告地址；Wanmi 只解释记录，不会访问该地址。`.trim()
}

function failedCaa(recordSet: DnsRecordSet, checked: ResolvedDnsRecordSet[]): CaaInspection {
  const status =
    recordSet.status === 'servfail' ||
    recordSet.status === 'timeout' ||
    recordSet.status === 'rate_limited'
      ? recordSet.status
      : 'failed'
  return caaInspectionSchema.parse({
    effectiveOwnerName: null,
    inherited: false,
    issue:
      recordSet.status === 'timeout'
        ? issue('CAA_TIMEOUT', 'CAA 查询超时', true)
        : recordSet.status === 'rate_limited'
          ? issue('CAA_RATE_LIMITED', 'CAA 查询队列繁忙', true)
          : recordSet.status === 'servfail'
            ? issue('CAA_SERVFAIL', '权威 DNS 或递归解析器返回 CAA SERVFAIL', true)
            : 'issue' in recordSet && recordSet.issue.code === 'DNS_INVALID_RESPONSE'
              ? issue('CAA_INVALID_RESPONSE', 'CAA 响应格式无效，已停止父域继承', false)
              : issue('CAA_QUERY_FAILED', 'CAA 查询未能完成，已停止父域继承', true),
    records: [],
    source: {
      cacheStatus: aggregateCacheStatus(checked.map((item) => item.recordSet.cacheStatus)),
      dataSource: DNS_SOURCE,
      observedAt: latestObservedAt(checked.map((item) => item.recordSet.observedAt)),
    },
    status,
  })
}

async function inspectCaa(
  domainAscii: string,
  options: QueryTlsCertificateOptions,
): Promise<{ inspection: CaaInspection; ttlSeconds?: number }> {
  const labels = domainAscii.split('.')
  const checked: ResolvedDnsRecordSet[] = []
  const dnsLookup = options.dnsLookup ?? querySafeDnsRecordSet

  for (let index = 0; index < Math.min(labels.length, CAA_MAX_LEVELS); index += 1) {
    const owner = labels.slice(index).join('.')
    const resolved = await dnsLookup(owner, 'CAA', {
      ...(options.dnsCache ? { cache: options.dnsCache } : {}),
      ...(options.dnsCacheConfig ? { cacheConfig: options.dnsCacheConfig } : {}),
      ...(options.now ? { now: options.now } : {}),
      provider: options.dnsProvider,
      traceId: options.traceId,
    })
    checked.push(resolved)
    const set = resolved.recordSet
    if (set.status === 'records') {
      const records = set.records.flatMap((record) => {
        if (record.type !== 'CAA') return []
        const critical = (record.flags & 128) !== 0
        return [
          {
            critical,
            explanation: caaExplanation(record.tag, record.value, critical),
            flags: record.flags,
            ownerName: record.ownerName,
            tag: record.tag,
            ttl: record.ttl,
            value: record.value,
          },
        ]
      })
      return {
        inspection: caaInspectionSchema.parse({
          effectiveOwnerName: records[0]?.ownerName ?? owner,
          inherited: owner !== domainAscii,
          records,
          source: {
            cacheStatus: aggregateCacheStatus(checked.map((item) => item.recordSet.cacheStatus)),
            dataSource: DNS_SOURCE,
            observedAt: latestObservedAt(checked.map((item) => item.recordSet.observedAt)),
          },
          status: 'records',
        }),
        ttlSeconds: checked
          .map((item) => item.cacheTtlSeconds)
          .filter((value): value is number => value !== undefined)
          .reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY),
      }
    }
    if (set.status !== 'no_record' && set.status !== 'nxdomain') {
      return { inspection: failedCaa(set, checked) }
    }
  }

  const observedAt = latestObservedAt(checked.map((item) => item.recordSet.observedAt))
  const cacheStatus = aggregateCacheStatus(checked.map((item) => item.recordSet.cacheStatus))
  if (labels.length > CAA_MAX_LEVELS) {
    return {
      inspection: caaInspectionSchema.parse({
        effectiveOwnerName: null,
        inherited: false,
        issue: issue('CAA_LOOKUP_LIMIT_EXCEEDED', 'CAA 父域查询超过 16 层安全上限', false),
        records: [],
        source: { cacheStatus, dataSource: DNS_SOURCE, observedAt },
        status: 'limit_exceeded',
      }),
    }
  }
  const allNxdomain =
    checked.length > 0 && checked.every((item) => item.recordSet.status === 'nxdomain')
  return {
    inspection: caaInspectionSchema.parse({
      effectiveOwnerName: null,
      inherited: false,
      records: [],
      source: { cacheStatus, dataSource: DNS_SOURCE, observedAt },
      status: allNxdomain ? 'nxdomain' : 'no_record',
    }),
    ttlSeconds: checked
      .map((item) => item.cacheTtlSeconds)
      .filter((value): value is number => value !== undefined)
      .reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY),
  }
}

function tlsFailureInspection(
  error: Extract<Awaited<ReturnType<TlsHandshakeProvider['inspectCertificate']>>, { ok: false }>,
): TlsInspection {
  const status =
    error.error.code === 'TLS_TIMEOUT'
      ? 'timeout'
      : error.error.code === 'TLS_HANDSHAKE_TOO_LARGE'
        ? 'handshake_too_large'
        : error.error.code === 'TLS_HANDSHAKE_FAILED'
          ? 'handshake_failed'
          : error.error.code === 'TLS_QUEUE_FULL' || error.error.code === 'TLS_QUEUE_TIMEOUT'
            ? 'rate_limited'
            : 'connection_failed'
  return tlsInspectionSchema.parse({
    certificate: null,
    cipherSuite: null,
    findings: [],
    issue: issue(error.error.code, error.error.message, error.error.retryable),
    port: TLS_PORT,
    protocol: null,
    source: {
      cacheStatus: error.cache?.status ?? 'miss',
      dataSource: TLS_SOURCE,
      observedAt: error.observedAt,
    },
    status,
  })
}

async function executeQuery(
  query: NormalizedDomain,
  options: QueryTlsCertificateOptions,
  cache: TlsResultCache,
  cacheConfig: TlsResultCacheConfig,
): Promise<SslCheckResult> {
  const dnsLookup = options.dnsLookup ?? querySafeDnsRecordSet
  const dnsOptions = {
    ...(options.dnsCache ? { cache: options.dnsCache } : {}),
    ...(options.dnsCacheConfig ? { cacheConfig: options.dnsCacheConfig } : {}),
    ...(options.now ? { now: options.now } : {}),
    provider: options.dnsProvider,
    traceId: options.traceId,
  }
  const [ipv4, ipv6, caaResult] = await Promise.all([
    dnsLookup(query.ascii, 'A', dnsOptions),
    dnsLookup(query.ascii, 'AAAA', dnsOptions),
    inspectCaa(query.ascii, options),
  ])
  const addressSets = [ipv4, ipv6]
  const blocked = addressSets.find((item) => item.recordSet.status === 'blocked')
  const preliminaryObservedAt = latestObservedAt([
    ...addressSets.map((item) => item.recordSet.observedAt),
    caaResult.inspection.source.observedAt,
  ])
  const preliminaryMeta: ResultMeta = {
    cacheStatus: aggregateCacheStatus([
      ...addressSets.map((item) => item.recordSet.cacheStatus),
      caaResult.inspection.source.cacheStatus,
    ]),
    dataSource: DATA_SOURCE,
    observedAt: preliminaryObservedAt,
    traceId: options.traceId,
  }
  if (blocked) {
    return sslCheckResultSchema.parse({
      meta: preliminaryMeta,
      problem: resultProblem(
        'TLS_TARGET_BLOCKED',
        'DNS 返回了受限或非公网地址，TLS 连接已在建立前阻断',
        options.traceId,
        preliminaryMeta,
        { retryable: false, title: 'TLS 目标已安全阻断' },
      ),
      state: 'error',
    })
  }

  const addresses = addressSets.flatMap(({ recordSet }) =>
    recordSet.status === 'records'
      ? recordSet.records.flatMap((record) =>
          record.type === 'A' || record.type === 'AAAA' ? [record.address] : [],
        )
      : [],
  )
  const uniqueAddresses = [...new Set(addresses)].slice(0, TLS_MAX_ADDRESSES)
  const addressFailures = addressSets.filter(
    ({ recordSet }) =>
      recordSet.status !== 'records' &&
      recordSet.status !== 'no_record' &&
      recordSet.status !== 'nxdomain',
  )
  const noAddressTls = tlsInspectionSchema.parse({
    certificate: null,
    cipherSuite: null,
    findings: [],
    port: TLS_PORT,
    protocol: null,
    source: {
      cacheStatus: aggregateCacheStatus(addressSets.map((item) => item.recordSet.cacheStatus)),
      dataSource: TLS_SOURCE,
      observedAt: latestObservedAt(addressSets.map((item) => item.recordSet.observedAt)),
    },
    status: 'no_address',
  })

  if (uniqueAddresses.length === 0) {
    if (addressFailures.length === addressSets.length) {
      const allRateLimited = addressFailures.every(
        (item) => item.recordSet.status === 'rate_limited',
      )
      return sslCheckResultSchema.parse({
        meta: preliminaryMeta,
        problem: resultProblem(
          allRateLimited ? 'TLS_RATE_LIMITED' : 'TLS_DNS_FAILED',
          allRateLimited ? 'DNS 查询队列繁忙，未能解析 TLS 目标' : '无法解析 TLS 目标地址',
          options.traceId,
          preliminaryMeta,
          {
            retryable: true,
            status: allRateLimited ? 429 : 503,
            title: allRateLimited ? 'SSL 检查请求受限' : 'TLS 目标解析失败',
          },
        ),
        state: allRateLimited ? 'rate_limited' : 'error',
      })
    }
    const data = sslCheckDataSchema.parse({
      caa: caaResult.inspection,
      normalizedQueryAscii: query.ascii,
      normalizedQueryUnicode: query.unicode,
      risks: query.risks,
      tls: noAddressTls,
    })
    const caaComplete = ['records', 'no_record', 'nxdomain'].includes(caaResult.inspection.status)
    if (addressFailures.length > 0 || !caaComplete) {
      return sslCheckResultSchema.parse({
        data,
        meta: preliminaryMeta,
        problem: resultProblem(
          caaResult.inspection.issue?.code ?? 'TLS_DNS_PARTIAL',
          '没有找到可连接的公网地址，且部分 DNS 或 CAA 检查未能完成',
          options.traceId,
          preliminaryMeta,
          { retryable: true, title: 'SSL 检查仅部分完成' },
        ),
        state: 'partial',
      })
    }
    const result = sslCheckResultSchema.parse({ data, meta: preliminaryMeta, state: 'empty' })
    const dnsTtls = addressSets
      .map((item) => item.cacheTtlSeconds)
      .filter((value): value is number => Number.isFinite(value))
    const ttlMs = Math.min(
      cacheConfig.emptyTtlMs,
      ...(dnsTtls.length > 0 ? dnsTtls.map((value) => value * 1_000) : [cacheConfig.emptyTtlMs]),
    )
    cache.set(query.ascii, result, ttlMs)
    return result
  }

  const tlsResult = await options.tlsProvider.inspectCertificate({
    addresses: uniqueAddresses,
    domainAscii: query.ascii,
    traceId: options.traceId,
  })
  const tls = tlsResult.ok
    ? tlsInspectionSchema.parse({
        certificate: tlsResult.data.certificate,
        cipherSuite: tlsResult.data.cipherSuite,
        findings: tlsResult.data.findings,
        port: TLS_PORT,
        protocol: tlsResult.data.protocol,
        source: {
          cacheStatus: tlsResult.cache?.status ?? 'miss',
          dataSource: TLS_SOURCE,
          observedAt: tlsResult.observedAt,
        },
        status: 'connected',
      })
    : tlsFailureInspection(tlsResult)
  const meta: ResultMeta = {
    cacheStatus: aggregateCacheStatus([
      ...addressSets.map((item) => item.recordSet.cacheStatus),
      caaResult.inspection.source.cacheStatus,
      tls.source.cacheStatus,
    ]),
    dataSource: DATA_SOURCE,
    observedAt: latestObservedAt([preliminaryObservedAt, tls.source.observedAt]),
    traceId: options.traceId,
  }

  if (
    !tlsResult.ok &&
    (tlsResult.error.code === 'TLS_TARGET_BLOCKED' || tlsResult.error.code === 'TLS_TARGET_CHANGED')
  ) {
    return sslCheckResultSchema.parse({
      meta,
      problem: resultProblem(tlsResult.error.code, tlsResult.error.message, options.traceId, meta, {
        retryable: false,
        title: 'TLS 连接已安全阻断',
      }),
      state: 'error',
    })
  }
  if (!tlsResult.ok && tlsResult.error.code === 'TLS_HANDSHAKE_TOO_LARGE') {
    return sslCheckResultSchema.parse({
      meta,
      problem: resultProblem(tlsResult.error.code, tlsResult.error.message, options.traceId, meta, {
        retryable: false,
        title: 'TLS 握手超过安全上限',
      }),
      state: 'error',
    })
  }

  const data = sslCheckDataSchema.parse({
    caa: caaResult.inspection,
    normalizedQueryAscii: query.ascii,
    normalizedQueryUnicode: query.unicode,
    risks: query.risks,
    tls,
  })
  const caaComplete = ['records', 'no_record', 'nxdomain'].includes(caaResult.inspection.status)
  if (!tlsResult.ok || !caaComplete || addressFailures.length > 0) {
    const allRateLimited =
      !tlsResult.ok &&
      tls.status === 'rate_limited' &&
      caaResult.inspection.status === 'rate_limited' &&
      addressFailures.every((item) => item.recordSet.status === 'rate_limited')
    if (allRateLimited) {
      return sslCheckResultSchema.parse({
        meta,
        problem: resultProblem(
          'TLS_RATE_LIMITED',
          'TLS 与 DNS 查询队列当前繁忙',
          options.traceId,
          meta,
          { retryable: true, status: 429, title: 'SSL 检查请求受限' },
        ),
        state: 'rate_limited',
      })
    }
    if (!tlsResult.ok && !caaComplete) {
      return sslCheckResultSchema.parse({
        meta,
        problem: resultProblem(
          'SSL_CHECK_UNAVAILABLE',
          'TLS 与 CAA 均未能取得可用诊断数据',
          options.traceId,
          meta,
          { retryable: true, title: 'SSL 检查暂时不可用' },
        ),
        state: 'error',
      })
    }
    return sslCheckResultSchema.parse({
      data,
      meta,
      problem: resultProblem(
        !tlsResult.ok
          ? tlsResult.error.code
          : (caaResult.inspection.issue?.code ?? 'SSL_CHECK_PARTIAL'),
        !tlsResult.ok
          ? `${tlsResult.error.message}；CAA 结果仍可查看`
          : 'TLS、CAA 或一个地址族仅完成了部分检查',
        options.traceId,
        meta,
        { retryable: true, title: 'SSL 检查仅部分完成' },
      ),
      state: 'partial',
    })
  }

  if (tls.findings.length > 0) {
    const result = sslCheckResultSchema.parse({
      data,
      meta,
      problem: resultProblem(
        tls.findings[0]?.code ?? 'TLS_CERTIFICATE_INVALID',
        'TLS 握手已完成，但证书存在需要处理的问题',
        options.traceId,
        meta,
        { retryable: false, title: '证书检查发现问题' },
      ),
      state: 'degraded',
    })
    const ttlMs = Math.min(
      cacheConfig.resultTtlMs,
      ...addressSets.flatMap((item) =>
        item.cacheTtlSeconds ? [item.cacheTtlSeconds * 1_000] : [],
      ),
      caaResult.ttlSeconds && Number.isFinite(caaResult.ttlSeconds)
        ? caaResult.ttlSeconds * 1_000
        : cacheConfig.resultTtlMs,
    )
    cache.set(query.ascii, result, ttlMs)
    return result
  }

  const result = sslCheckResultSchema.parse({ data, meta, state: 'ready' })
  const ttlCandidates = [
    cacheConfig.resultTtlMs,
    ...addressSets.flatMap((item) => (item.cacheTtlSeconds ? [item.cacheTtlSeconds * 1_000] : [])),
    ...(caaResult.ttlSeconds && Number.isFinite(caaResult.ttlSeconds)
      ? [caaResult.ttlSeconds * 1_000]
      : []),
  ]
  cache.set(query.ascii, result, Math.min(...ttlCandidates))
  return result
}

export async function queryTlsCertificate(
  candidate: SslCheckRequest,
  options: QueryTlsCertificateOptions,
): Promise<SslCheckResult> {
  const input = sslCheckRequestSchema.parse(candidate)
  const query = normalizedInput(input.query)
  const now = options.now ?? Date.now
  const cacheConfig = options.cacheConfig ?? cacheConfigFromEnv()
  const cache = options.cache ?? (sharedCache ??= new TlsResultCache(cacheConfig.maxEntries, now))
  const cached = cache.get(query.ascii, options.traceId)
  if (cached) return cached

  const existing = inFlight.get(query.ascii)
  if (existing) return resultForTrace(await existing, options.traceId)
  const promise = executeQuery(query, options, cache, cacheConfig).finally(() =>
    inFlight.delete(query.ascii),
  )
  inFlight.set(query.ascii, promise)
  return promise
}
