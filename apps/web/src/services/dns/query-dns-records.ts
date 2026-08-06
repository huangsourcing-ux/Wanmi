import { isIP } from 'node:net'

import ipaddr from 'ipaddr.js'

import type { ProviderResult } from '@/lib/domain'
import { AppError, toProblemDetails } from '@/lib/errors'
import { normalizeDomain, type NormalizedDomain } from '@/lib/domain-name'
import { getEnv } from '@/lib/env'
import type { DnsProviderAnswer, DnsReadProvider } from '@/providers/types'
import type { ResultMeta } from '@/schemas/api'
import {
  DNS_MAX_TOTAL_RECORDS,
  DNS_RECORD_TYPES,
  dnsLookupDataSchema,
  dnsLookupRequestSchema,
  dnsLookupResultSchema,
  dnsRecordSetSchema,
  type DnsLookupRequest,
  type DnsLookupResult,
  type DnsRecordSet,
  type DnsRecordType,
} from '@/schemas/dns'

const DATA_SOURCE = '阿里公共 DNS（受控 DoH）'
const FORBIDDEN_HOSTNAMES = new Set(['instance-data', 'metadata', 'metadata.google.internal'])
const FORBIDDEN_HOST_SUFFIXES = ['.home', '.internal', '.lan', '.local', '.localhost']
const FORBIDDEN_SYNTAX = /[\s/:@?#\\]/u
const METADATA_ADDRESSES = new Set(['100.100.100.200', '168.63.129.16', '169.254.169.254'])

export type DnsCacheConfig = {
  maxEntries: number
  maxNegativeTtlMs: number
  maxPositiveTtlMs: number
  maxTargets: number
}

export type ResolvedDnsRecordSet = {
  cacheTtlSeconds?: number
  fallbackUsed: boolean
  recordSet: DnsRecordSet
}

type CacheEntry = {
  expiresAt: number
  value: ResolvedDnsRecordSet
}

type QueryDnsRecordsOptions = {
  cache?: DnsResultCache
  cacheConfig?: DnsCacheConfig
  now?: () => number
  provider: DnsReadProvider
  traceId: string
}

function cacheConfigFromEnv(): DnsCacheConfig {
  const env = getEnv()
  return {
    maxEntries: env.DNS_CACHE_MAX_ENTRIES,
    maxNegativeTtlMs: env.DNS_NEGATIVE_CACHE_MAX_TTL_MS,
    maxPositiveTtlMs: env.DNS_CACHE_MAX_TTL_MS,
    maxTargets: env.DNS_MAX_TARGETS_PER_REQUEST,
  }
}

export class DnsResultCache {
  private readonly values = new Map<string, CacheEntry>()

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  get(key: string): ResolvedDnsRecordSet | undefined {
    const entry = this.values.get(key)
    const currentTime = this.now()
    if (!entry) return undefined
    if (entry.expiresAt <= currentTime) {
      this.values.delete(key)
      return undefined
    }
    this.values.delete(key)
    this.values.set(key, entry)
    return {
      ...entry.value,
      cacheTtlSeconds: Math.max(0, Math.floor((entry.expiresAt - currentTime) / 1_000)),
      recordSet: dnsRecordSetSchema.parse({ ...entry.value.recordSet, cacheStatus: 'hit' }),
    }
  }

  set(key: string, value: ResolvedDnsRecordSet, ttlMs: number): void {
    if (ttlMs <= 0) return
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
    this.values.set(key, { expiresAt: currentTime + ttlMs, value })
  }
}

let sharedCache: DnsResultCache | undefined

function invalidInput(code: string, message: string): AppError {
  return new AppError(code, message, 400, {
    action: '请输入不含协议、路径、端口或查询参数的完整域名',
    retryable: false,
    title: 'DNS 查询参数无效',
  })
}

function normalizedInput(query: string): NormalizedDomain {
  const candidate = query.trim()
  const literalCandidate =
    candidate.startsWith('[') && candidate.endsWith(']') ? candidate.slice(1, -1) : candidate
  if (isIP(literalCandidate) !== 0) {
    throw invalidInput('DOMAIN_TARGET_FORBIDDEN', 'DNS 查询不接受 IP 地址或受限网络目标')
  }
  if (FORBIDDEN_SYNTAX.test(candidate)) {
    throw invalidInput('DNS_DOMAIN_FORMAT_INVALID', 'DNS 查询只接受完整域名')
  }
  const normalized = normalizeDomain(candidate)
  if (!normalized.ok) throw invalidInput(normalized.error.code, normalized.error.message)
  if (!normalized.value.ascii.includes('.')) {
    throw invalidInput('DNS_FULL_DOMAIN_REQUIRED', 'DNS 查询需要完整域名，不能只输入单个标签')
  }
  if (isForbiddenHostname(normalized.value.ascii)) {
    throw invalidInput('DOMAIN_TARGET_FORBIDDEN', 'DNS 查询不接受本地或元数据网络目标')
  }
  return normalized.value
}

function isForbiddenHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/u, '')
  return (
    FORBIDDEN_HOSTNAMES.has(value) ||
    FORBIDDEN_HOST_SUFFIXES.some((suffix) => value.endsWith(suffix))
  )
}

export function isPublicDnsAddress(value: string): boolean {
  try {
    const original = ipaddr.parse(value)
    if (original instanceof ipaddr.IPv6 && original.isIPv4MappedAddress()) return false
    const parsed = ipaddr.process(value)
    return parsed.range() === 'unicast' && !METADATA_ADDRESSES.has(parsed.toString())
  } catch {
    return false
  }
}

function issue(code: string, message: string, retryable: boolean) {
  return { code, message, retryable }
}

function failedSet(
  type: DnsRecordType,
  status: Extract<DnsRecordSet['status'], 'blocked' | 'failed' | 'rate_limited' | 'timeout'>,
  problem: ReturnType<typeof issue>,
  observedAt: string,
  resolverNode: DnsRecordSet['resolverNode'] = 'alidns_primary',
): DnsRecordSet {
  return dnsRecordSetSchema.parse({
    cacheStatus: 'miss',
    issue: problem,
    observedAt,
    records: [],
    resolverNode,
    status,
    type,
  })
}

function providerFailureSet(
  type: DnsRecordType,
  result: Extract<ProviderResult<DnsProviderAnswer>, { ok: false }>,
): DnsRecordSet {
  if (result.error.code === 'DNS_TIMEOUT') {
    return failedSet(
      type,
      'timeout',
      issue(result.error.code, result.error.message, true),
      result.observedAt,
    )
  }
  if (result.error.code === 'DNS_QUEUE_FULL' || result.error.code === 'DNS_QUEUE_TIMEOUT') {
    return failedSet(
      type,
      'rate_limited',
      issue(result.error.code, result.error.message, true),
      result.observedAt,
    )
  }
  return failedSet(
    type,
    'failed',
    issue(result.error.code, result.error.message, result.error.retryable),
    result.observedAt,
  )
}

function recordSetFromProvider(
  type: DnsRecordType,
  result: Extract<ProviderResult<DnsProviderAnswer>, { ok: true }>,
): ResolvedDnsRecordSet {
  if (result.data.status === 'servfail') {
    return {
      fallbackUsed: result.data.fallbackUsed,
      recordSet: dnsRecordSetSchema.parse({
        cacheStatus: 'miss',
        issue: issue('DNS_SERVFAIL', '递归解析器或权威 DNS 返回 SERVFAIL', true),
        observedAt: result.observedAt,
        records: [],
        resolverNode: result.data.resolverNode,
        status: 'servfail',
        type,
      }),
    }
  }
  const cacheTtlSeconds =
    result.data.status === 'records'
      ? Math.min(...result.data.records.map((record) => record.ttl))
      : result.data.negativeTtlSeconds
  return {
    cacheTtlSeconds,
    fallbackUsed: result.data.fallbackUsed,
    recordSet: dnsRecordSetSchema.parse({
      cacheStatus: 'miss',
      observedAt: result.observedAt,
      records: result.data.records,
      resolverNode: result.data.resolverNode,
      status: result.data.status,
      type,
    }),
  }
}

function directAddressBlocked(recordSet: DnsRecordSet): boolean {
  if (recordSet.status !== 'records') return false
  return recordSet.records.some(
    (record) =>
      (record.type === 'A' || record.type === 'AAAA') && !isPublicDnsAddress(record.address),
  )
}

function targetsFor(recordSet: DnsRecordSet): string[] {
  if (recordSet.status !== 'records') return []
  const targets: string[] = []
  for (const record of recordSet.records) {
    if (record.type === 'CNAME') targets.push(record.target)
    else if (record.type === 'MX' && record.exchange !== '.') targets.push(record.exchange)
    else if (record.type === 'NS') targets.push(record.host)
    else if (record.type === 'SOA') targets.push(record.primaryNameServer)
  }
  return [...new Set(targets)]
}

function cacheTtlMs(value: ResolvedDnsRecordSet, config: DnsCacheConfig): number {
  if (!value.cacheTtlSeconds || value.cacheTtlSeconds <= 0) return 0
  const maximum =
    value.recordSet.status === 'records' ? config.maxPositiveTtlMs : config.maxNegativeTtlMs
  return Math.min(value.cacheTtlSeconds * 1_000, maximum)
}

function cacheKey(domainAscii: string, type: DnsRecordType): string {
  return `${domainAscii}:${type}`
}

async function providerSet(
  domainAscii: string,
  type: DnsRecordType,
  provider: DnsReadProvider,
  traceId: string,
): Promise<ResolvedDnsRecordSet> {
  const result = await provider.queryRecordSet({ domainAscii, recordType: type, traceId })
  if (!result.ok) return { fallbackUsed: false, recordSet: providerFailureSet(type, result) }
  return recordSetFromProvider(type, result)
}

async function validatedAddressSet(
  domainAscii: string,
  type: 'A' | 'AAAA',
  context: {
    cache: DnsResultCache
    config: DnsCacheConfig
    provider: DnsReadProvider
    traceId: string
  },
): Promise<ResolvedDnsRecordSet> {
  const key = cacheKey(domainAscii, type)
  const cached = context.cache.get(key)
  if (cached) return cached
  const result = await providerSet(domainAscii, type, context.provider, context.traceId)
  if (directAddressBlocked(result.recordSet)) {
    return {
      fallbackUsed: result.fallbackUsed,
      recordSet: failedSet(
        type,
        'blocked',
        issue('DNS_TARGET_BLOCKED', 'DNS 记录指向受限或非公网地址，结果已阻断', false),
        result.recordSet.observedAt,
        result.recordSet.resolverNode,
      ),
    }
  }
  if (
    result.recordSet.status === 'records' ||
    result.recordSet.status === 'no_record' ||
    result.recordSet.status === 'nxdomain'
  ) {
    context.cache.set(key, result, cacheTtlMs(result, context.config))
  }
  return result
}

function validationFailed(sets: ResolvedDnsRecordSet[]): boolean {
  const hasFailure = sets.some(
    ({ recordSet }) =>
      recordSet.status !== 'records' &&
      recordSet.status !== 'no_record' &&
      recordSet.status !== 'nxdomain',
  )
  return hasFailure || !sets.some(({ recordSet }) => recordSet.status === 'records')
}

function aggregateCacheStatus(recordSets: DnsRecordSet[]): ResultMeta['cacheStatus'] {
  const hits = recordSets.filter((recordSet) => recordSet.cacheStatus === 'hit').length
  if (hits === recordSets.length) return 'hit'
  if (hits === 0) return 'miss'
  return 'mixed'
}

function aggregateObservedAt(recordSets: DnsRecordSet[]): string {
  return recordSets.reduce(
    (latest, recordSet) => (recordSet.observedAt > latest ? recordSet.observedAt : latest),
    recordSets[0]?.observedAt ?? new Date(0).toISOString(),
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
      action: options.retryable ? '请稍后重试' : '请检查域名配置或改用其他公开工具',
      dataSource: meta.dataSource,
      observedAt: meta.observedAt,
      retryable: options.retryable,
      title: options.title,
    }),
    traceId,
  )
}

export async function querySafeDnsRecordSet(
  domainAscii: string,
  type: 'A' | 'AAAA' | 'CAA',
  options: QueryDnsRecordsOptions,
): Promise<ResolvedDnsRecordSet> {
  const normalized = normalizeDomain(domainAscii)
  if (
    !normalized.ok ||
    (type !== 'CAA' && !normalized.value.ascii.includes('.')) ||
    isForbiddenHostname(normalized.ok ? normalized.value.ascii : domainAscii)
  ) {
    return {
      fallbackUsed: false,
      recordSet: failedSet(
        type,
        'blocked',
        issue('DNS_TARGET_BLOCKED', 'DNS 查询目标未通过安全校验', false),
        new Date((options.now ?? Date.now)()).toISOString(),
      ),
    }
  }

  const now = options.now ?? Date.now
  const config = options.cacheConfig ?? cacheConfigFromEnv()
  const cache = options.cache ?? (sharedCache ??= new DnsResultCache(config.maxEntries, now))
  const key = cacheKey(normalized.value.ascii, type)
  const cached = cache.get(key)
  if (cached) return cached

  if (type === 'A' || type === 'AAAA') {
    return validatedAddressSet(normalized.value.ascii, type, {
      cache,
      config,
      provider: options.provider,
      traceId: options.traceId,
    })
  }

  const result = await providerSet(normalized.value.ascii, type, options.provider, options.traceId)
  if (
    result.recordSet.status === 'records' ||
    result.recordSet.status === 'no_record' ||
    result.recordSet.status === 'nxdomain'
  ) {
    cache.set(key, result, cacheTtlMs(result, config))
  }
  return result
}

export async function queryDnsRecords(
  candidate: DnsLookupRequest,
  options: QueryDnsRecordsOptions,
): Promise<DnsLookupResult> {
  const input = dnsLookupRequestSchema.parse(candidate)
  const query = normalizedInput(input.query)
  const now = options.now ?? Date.now
  const config = options.cacheConfig ?? cacheConfigFromEnv()
  const cache = options.cache ?? (sharedCache ??= new DnsResultCache(config.maxEntries, now))
  const context = { cache, config, provider: options.provider, traceId: options.traceId }

  const rawSets = await Promise.all(
    DNS_RECORD_TYPES.map(async (type): Promise<ResolvedDnsRecordSet> => {
      if (type === 'A' || type === 'AAAA') {
        return validatedAddressSet(query.ascii, type, context)
      }
      const key = cacheKey(query.ascii, type)
      return cache.get(key) ?? providerSet(query.ascii, type, options.provider, options.traceId)
    }),
  )

  const uncachedTargets = new Set<string>()
  for (const resolved of rawSets) {
    if (resolved.recordSet.cacheStatus === 'hit') continue
    for (const target of targetsFor(resolved.recordSet)) uncachedTargets.add(target)
  }

  const targetLimitExceeded = uncachedTargets.size > config.maxTargets
  const targetResults = new Map<string, ResolvedDnsRecordSet[]>()
  if (!targetLimitExceeded) {
    await Promise.all(
      [...uncachedTargets].map(async (target) => {
        if (isForbiddenHostname(target)) return
        targetResults.set(
          target,
          await Promise.all([
            validatedAddressSet(target, 'A', context),
            validatedAddressSet(target, 'AAAA', context),
          ]),
        )
      }),
    )
  }

  const resolvedSets = rawSets.map((resolved) => {
    const type = resolved.recordSet.type
    if (resolved.recordSet.cacheStatus === 'hit' || type === 'A' || type === 'AAAA') return resolved
    const targets = targetsFor(resolved.recordSet)
    if (targets.length === 0) {
      if (
        resolved.recordSet.status === 'records' ||
        resolved.recordSet.status === 'no_record' ||
        resolved.recordSet.status === 'nxdomain'
      ) {
        cache.set(cacheKey(query.ascii, type), resolved, cacheTtlMs(resolved, config))
      }
      return resolved
    }
    if (
      targetLimitExceeded ||
      targets.some((target) => isForbiddenHostname(target)) ||
      targets.some((target) => !targetResults.has(target)) ||
      targets.some((target) => validationFailed(targetResults.get(target) ?? []))
    ) {
      return {
        fallbackUsed: resolved.fallbackUsed,
        recordSet: failedSet(
          type,
          'blocked',
          issue(
            targetLimitExceeded ? 'DNS_TARGET_LIMIT_EXCEEDED' : 'DNS_TARGET_VALIDATION_FAILED',
            targetLimitExceeded
              ? 'DNS 记录目标数量超过安全上限，结果已阻断'
              : 'DNS 记录目标无法完成公网地址安全校验，结果已阻断',
            false,
          ),
          resolved.recordSet.observedAt,
          resolved.recordSet.resolverNode,
        ),
      } satisfies ResolvedDnsRecordSet
    }

    const validations = targets.flatMap((target) => targetResults.get(target) ?? [])
    const validationTtls = validations
      .map((item) => item.cacheTtlSeconds)
      .filter((value): value is number => value !== undefined)
    const cacheTtlSeconds =
      validations.length > 0 &&
      validationTtls.length === validations.length &&
      resolved.cacheTtlSeconds !== undefined
        ? Math.min(resolved.cacheTtlSeconds, ...validationTtls)
        : undefined
    const validated: ResolvedDnsRecordSet = {
      cacheTtlSeconds,
      fallbackUsed: resolved.fallbackUsed || validations.some((item) => item.fallbackUsed),
      recordSet: dnsRecordSetSchema.parse({
        ...resolved.recordSet,
        cacheStatus: validations.some((item) => item.recordSet.cacheStatus === 'hit')
          ? 'mixed'
          : resolved.recordSet.cacheStatus,
      }),
    }
    cache.set(cacheKey(query.ascii, type), validated, cacheTtlMs(validated, config))
    return validated
  })

  const recordSets = resolvedSets.map(({ recordSet }) => recordSet)
  const totalRecords = recordSets.reduce((total, recordSet) => total + recordSet.records.length, 0)
  const meta: ResultMeta = {
    cacheStatus: aggregateCacheStatus(recordSets),
    dataSource: DATA_SOURCE,
    observedAt: aggregateObservedAt(recordSets),
    traceId: options.traceId,
  }
  if (totalRecords > DNS_MAX_TOTAL_RECORDS) {
    return dnsLookupResultSchema.parse({
      meta,
      problem: resultProblem(
        'DNS_RECORD_LIMIT_EXCEEDED',
        'DNS 记录总数超过安全上限',
        options.traceId,
        meta,
        { retryable: false, title: 'DNS 响应已被限制' },
      ),
      state: 'error',
    })
  }

  const data = dnsLookupDataSchema.parse({
    normalizedQueryAscii: query.ascii,
    normalizedQueryUnicode: query.unicode,
    recordSets,
    risks: query.risks,
  })
  const failedStatuses = new Set(['blocked', 'failed', 'rate_limited', 'servfail', 'timeout'])
  const failed = recordSets.filter((recordSet) => failedStatuses.has(recordSet.status))
  const usable = recordSets.filter((recordSet) => !failedStatuses.has(recordSet.status))
  const fallbackUsed = resolvedSets.some((resolved) => resolved.fallbackUsed)

  if (failed.length > 0 && usable.length > 0) {
    return dnsLookupResultSchema.parse({
      data,
      meta,
      problem: resultProblem(
        'DNS_PARTIAL_RESULT',
        '部分 DNS 记录类型未能完成查询，其余结果仍可查看',
        options.traceId,
        meta,
        { retryable: true, title: '部分 DNS 记录暂时无法确认' },
      ),
      state: 'partial',
    })
  }
  if (failed.length === recordSets.length) {
    const statuses = new Set(failed.map((recordSet) => recordSet.status))
    const allRateLimited = statuses.size === 1 && statuses.has('rate_limited')
    const allTimedOut = statuses.size === 1 && statuses.has('timeout')
    const allServfail = statuses.size === 1 && statuses.has('servfail')
    const allBlocked = statuses.size === 1 && statuses.has('blocked')
    const code = allRateLimited
      ? 'DNS_RATE_LIMITED'
      : allTimedOut
        ? 'DNS_TIMEOUT'
        : allServfail
          ? 'DNS_SERVFAIL'
          : allBlocked
            ? 'DNS_TARGET_BLOCKED'
            : 'DNS_UNAVAILABLE'
    const message = allRateLimited
      ? '当前 DNS 查询请求较多，请稍后重试'
      : allTimedOut
        ? 'DNS 查询超时'
        : allServfail
          ? '递归解析器或权威 DNS 返回 SERVFAIL'
          : allBlocked
            ? 'DNS 结果未通过公网目标安全校验，已阻断'
            : 'DNS 查询暂时不可用'
    return dnsLookupResultSchema.parse({
      meta,
      problem: resultProblem(code, message, options.traceId, meta, {
        retryable: !allBlocked,
        status: allRateLimited ? 429 : 503,
        title: allBlocked ? 'DNS 结果已安全阻断' : 'DNS 查询暂时不可用',
      }),
      state: allRateLimited ? 'rate_limited' : 'error',
    })
  }
  if (fallbackUsed) {
    return dnsLookupResultSchema.parse({
      data,
      meta,
      problem: resultProblem(
        'DNS_FALLBACK_USED',
        '主 DNS 解析节点未完成查询，当前展示备用节点结果',
        options.traceId,
        meta,
        { retryable: true, title: '当前使用备用 DNS 解析节点' },
      ),
      state: 'degraded',
    })
  }
  const hasRecords = recordSets.some((recordSet) => recordSet.status === 'records')
  return dnsLookupResultSchema.parse({ data, meta, state: hasRecords ? 'ready' : 'empty' })
}
