import { AppError, toProblemDetails } from '@/lib/errors'
import { normalizeDomain, type NormalizedDomain } from '@/lib/domain-name'
import type { ProviderResult } from '@/lib/domain'
import { isWestDigitalRateLimitError } from '@/providers/westdigital'
import type { WestDigitalAvailability, WestDigitalReadProvider } from '@/providers/types'
import {
  DOMAIN_SEARCH_MAX_TLDS,
  domainSearchRequestSchema,
  domainSearchResultSchema,
  type DomainSearchData,
  type DomainSearchItem,
  type DomainSearchRequest,
  type DomainSearchResult,
} from '@/schemas/domain-search'
import type { ResultMeta } from '@/schemas/api'

export const DEFAULT_DOMAIN_SEARCH_TLDS = [
  'com',
  'cn',
  'net',
  'org',
  'top',
  'xyz',
  'vip',
  'cc',
  'tv',
  'com.cn',
] as const

export const WESTDIGITAL_FIXTURE_SOURCE = '西部数码 fixture（非实时）'
export const WANMI_FIXTURE_CATALOG_SOURCE = 'Wanmi fixture TLD 配置'

export type DomainSearchCatalog = {
  defaultTlds: readonly string[]
  supportedTlds: readonly string[]
  unavailableEvidence: Readonly<Record<string, 'registered' | 'restricted'>>
}

export const DEFAULT_DOMAIN_SEARCH_CATALOG: DomainSearchCatalog = {
  defaultTlds: DEFAULT_DOMAIN_SEARCH_TLDS,
  supportedTlds: DEFAULT_DOMAIN_SEARCH_TLDS,
  unavailableEvidence: {
    'reserved.net': 'restricted',
    'taken.cn': 'registered',
  },
}

type QueryAvailabilityOptions = {
  catalog?: DomainSearchCatalog
  now?: () => number
  provider: WestDigitalReadProvider
  traceId: string
}

type Target = {
  domain: NormalizedDomain
  tld: string
  supported: boolean
}

function invalidInput(code: string, message: string): AppError {
  return new AppError(code, message, 400, {
    action: '请检查域名和后缀后重试',
    retryable: false,
    title: '域名查询参数无效',
  })
}

function normalizeOrThrow(value: string): NormalizedDomain {
  const normalized = normalizeDomain(value)
  if (normalized.ok) return normalized.value
  throw invalidInput(normalized.error.code, normalized.error.message)
}

function normalizeTld(value: string): string {
  const trimmed = value.trim()
  const candidate = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed
  if (!candidate) throw invalidInput('DOMAIN_SEARCH_INVALID_TLD', '域名后缀不能为空')
  const normalized = normalizeOrThrow(`wanmi.${candidate}`)
  return normalized.ascii.slice('wanmi.'.length)
}

function normalizedTlds(values: readonly string[]): string[] {
  if (values.length > DOMAIN_SEARCH_MAX_TLDS) {
    throw invalidInput(
      'DOMAIN_SEARCH_TLD_LIMIT_EXCEEDED',
      `单次最多查询 ${DOMAIN_SEARCH_MAX_TLDS} 个域名后缀，当前提交了 ${values.length} 个`,
    )
  }
  const normalized = values.map(normalizeTld)
  if (new Set(normalized).size !== normalized.length) {
    throw invalidInput('DOMAIN_SEARCH_DUPLICATE_TLD', '域名后缀规范化后存在重复项')
  }
  return normalized
}

function cacheFor(result: ProviderResult<unknown>): DomainSearchItem['cache'] {
  return {
    ...(result.cache?.expiresAt ? { expiresAt: result.cache.expiresAt } : {}),
    status: result.cache?.status ?? 'miss',
  }
}

function providerFailureItem(
  target: Target,
  result: Extract<ProviderResult<WestDigitalAvailability>, { ok: false }>,
  traceId: string,
): DomainSearchItem {
  const rateLimited = isWestDigitalRateLimitError(result.error.code)
  const problem = toProblemDetails(
    new AppError(
      result.error.code,
      rateLimited ? '域名数据源请求过于频繁，请稍后重试' : '暂时无法确认该域名的可注册状态',
      rateLimited ? 429 : 503,
      {
        action: result.error.retryable ? '请稍后重试' : '请核对输入或稍后再试',
        dataSource: WESTDIGITAL_FIXTURE_SOURCE,
        observedAt: result.observedAt,
        retryable: result.error.retryable,
        retryAfterSeconds: result.error.retryAfterSeconds,
        title: rateLimited ? '查询请求过于频繁' : '可注册状态暂时未知',
      },
    ),
    traceId,
  )
  return {
    cache: cacheFor(result),
    dataSource: WESTDIGITAL_FIXTURE_SOURCE,
    domainAscii: target.domain.ascii,
    domainUnicode: target.domain.unicode,
    observedAt: result.observedAt,
    problem,
    status: 'query_failed',
    tld: target.tld,
  }
}

function thrownFailureItem(target: Target, traceId: string, observedAt: string): DomainSearchItem {
  const problem = toProblemDetails(
    new AppError('WESTDIGITAL_UNAVAILABLE', '暂时无法确认该域名的可注册状态', 503, {
      action: '请稍后重试',
      dataSource: WESTDIGITAL_FIXTURE_SOURCE,
      observedAt,
      retryable: true,
      title: '可注册状态暂时未知',
    }),
    traceId,
  )
  return {
    cache: { status: 'miss' },
    dataSource: WESTDIGITAL_FIXTURE_SOURCE,
    domainAscii: target.domain.ascii,
    domainUnicode: target.domain.unicode,
    observedAt,
    problem,
    status: 'query_failed',
    tld: target.tld,
  }
}

function providerSuccessItem(
  target: Target,
  result: Extract<ProviderResult<WestDigitalAvailability>, { ok: true }>,
  catalog: DomainSearchCatalog,
  traceId: string,
): DomainSearchItem {
  const base = {
    cache: cacheFor(result),
    dataSource: WESTDIGITAL_FIXTURE_SOURCE,
    domainAscii: target.domain.ascii,
    domainUnicode: target.domain.unicode,
    observedAt: result.observedAt,
    tld: target.tld,
  }
  if (result.data.premium) {
    if (result.data.premiumRegistrationPriceFen === undefined) {
      return thrownFailureItem(target, traceId, result.observedAt)
    }
    return {
      ...base,
      currency: 'CNY',
      premiumRegistrationPriceFen: result.data.premiumRegistrationPriceFen,
      status: 'premium',
    }
  }
  if (result.data.available) return { ...base, status: 'available' }

  const evidence = catalog.unavailableEvidence[target.domain.ascii]
  if (evidence) return { ...base, status: evidence }

  const problem = toProblemDetails(
    new AppError(
      'WESTDIGITAL_STATUS_AMBIGUOUS',
      '数据源只确认当前不允许新注册，无法区分已注册与保留/限制',
      503,
      {
        action: '请稍后重试；不要依据该结果推断 WHOIS 注册状态',
        dataSource: WESTDIGITAL_FIXTURE_SOURCE,
        observedAt: result.observedAt,
        retryable: false,
        title: '可注册状态无法明确分类',
      },
    ),
    traceId,
  )
  return { ...base, problem, status: 'query_failed' }
}

function aggregateCacheStatus(items: readonly DomainSearchItem[]): ResultMeta['cacheStatus'] {
  const statuses = new Set(items.map((item) => item.cache.status))
  if (statuses.size === 0) return 'not_used'
  if (statuses.size > 1) return 'mixed'
  return statuses.values().next().value
}

function latestObservedAt(items: readonly DomainSearchItem[], fallback: string): string {
  return items.reduce(
    (latest, item) => (item.observedAt > latest ? item.observedAt : latest),
    fallback,
  )
}

function aggregateSource(items: readonly DomainSearchItem[]): string {
  const sources = new Set(items.map((item) => item.dataSource))
  if (sources.size === 0) return WANMI_FIXTURE_CATALOG_SOURCE
  return [...sources].join(' + ')
}

function aggregateProblem(
  code: string,
  message: string,
  status: number,
  meta: ResultMeta,
  traceId: string,
  retryable: boolean,
  retryAfterSeconds?: number,
) {
  const title =
    status === 429
      ? '查询请求过于频繁'
      : code === 'DOMAIN_SEARCH_UNAVAILABLE'
        ? '域名查询暂时不可用'
        : code === 'DOMAIN_SEARCH_DEGRADED'
          ? '查询结果已降级'
          : '部分域名状态无法确认'
  return toProblemDetails(
    new AppError(code, message, status, {
      action: retryable ? '请稍后重试' : '请检查结果说明后再试',
      dataSource: meta.dataSource,
      observedAt: meta.observedAt,
      retryable,
      retryAfterSeconds,
      title,
    }),
    traceId,
  )
}

function resultFromItems(
  data: DomainSearchData,
  traceId: string,
  startedAt: string,
): DomainSearchResult {
  const items = data.items
  const meta: ResultMeta = {
    cacheStatus: aggregateCacheStatus(items),
    dataSource: aggregateSource(items),
    observedAt: latestObservedAt(items, startedAt),
    traceId,
  }
  if (items.length === 0) return domainSearchResultSchema.parse({ data, meta, state: 'empty' })

  const failures = items.filter((item) => item.status === 'query_failed')
  if (failures.length === 0) return domainSearchResultSchema.parse({ data, meta, state: 'ready' })

  const providerConclusions = items.filter(
    (item) => item.status !== 'query_failed' && item.status !== 'unsupported',
  )
  const localConclusions = items.filter((item) => item.status === 'unsupported')
  if (providerConclusions.length > 0) {
    return domainSearchResultSchema.parse({
      data,
      meta,
      problem: aggregateProblem(
        'DOMAIN_SEARCH_PARTIAL',
        `${failures.length} 个域名暂时无法确认，其余结果仍可查看`,
        503,
        meta,
        traceId,
        failures.some((item) => item.problem.retryable),
      ),
      state: 'partial',
    })
  }
  if (localConclusions.length > 0) {
    return domainSearchResultSchema.parse({
      data,
      meta,
      problem: aggregateProblem(
        'DOMAIN_SEARCH_DEGRADED',
        '只能确认本地 TLD 支持范围，provider 状态暂时不可用',
        503,
        meta,
        traceId,
        true,
      ),
      state: 'degraded',
    })
  }

  const allRateLimited = failures.every((item) => item.problem.status === 429)
  const retryAfterSeconds = allRateLimited
    ? Math.max(...failures.map((item) => item.problem.retryAfterSeconds ?? 1))
    : undefined
  return domainSearchResultSchema.parse({
    meta,
    problem: aggregateProblem(
      allRateLimited ? 'WESTDIGITAL_RATE_LIMITED' : 'DOMAIN_SEARCH_UNAVAILABLE',
      allRateLimited ? '域名查询请求过于频繁，请稍后重试' : '本次域名查询未能得到明确结果',
      allRateLimited ? 429 : 503,
      meta,
      traceId,
      true,
      retryAfterSeconds,
    ),
    state: allRateLimited ? 'rate_limited' : 'error',
  })
}

function createTargets(
  input: DomainSearchRequest,
  catalog: DomainSearchCatalog,
): { data: Omit<DomainSearchData, 'items'>; targets: Target[] } {
  const query = normalizeOrThrow(input.query)
  const supportedTlds = new Set(normalizedTlds(catalog.supportedTlds))
  const mode = query.ascii.includes('.') ? 'full_domain' : 'keyword'

  if (mode === 'full_domain' && input.tlds !== undefined) {
    throw invalidInput('DOMAIN_SEARCH_TLDS_NOT_ALLOWED', '输入完整域名时不能再指定额外域名后缀')
  }

  let targets: Target[]
  if (mode === 'full_domain') {
    const separator = query.ascii.indexOf('.')
    const tld = query.ascii.slice(separator + 1)
    targets = [{ domain: query, supported: supportedTlds.has(tld), tld }]
  } else {
    const tlds = normalizedTlds(input.tlds ?? catalog.defaultTlds)
    targets = tlds.map((tld) => ({
      domain: normalizeOrThrow(`${query.ascii}.${tld}`),
      supported: supportedTlds.has(tld),
      tld,
    }))
  }

  return {
    data: {
      mode,
      normalizedQueryAscii: query.ascii,
      normalizedQueryUnicode: query.unicode,
      risks: query.risks,
      tlds: targets.map((target) => target.tld),
    },
    targets,
  }
}

export async function queryDomainAvailability(
  candidate: DomainSearchRequest,
  options: QueryAvailabilityOptions,
): Promise<DomainSearchResult> {
  const input = domainSearchRequestSchema.parse(candidate)
  const catalog = options.catalog ?? DEFAULT_DOMAIN_SEARCH_CATALOG
  const now = options.now ?? Date.now
  const startedAt = new Date(now()).toISOString()
  const { data, targets } = createTargets(input, catalog)

  const settled = await Promise.allSettled(
    targets.map(async (target): Promise<DomainSearchItem> => {
      if (!target.supported) {
        return {
          cache: { status: 'not_used' },
          dataSource: WANMI_FIXTURE_CATALOG_SOURCE,
          domainAscii: target.domain.ascii,
          domainUnicode: target.domain.unicode,
          observedAt: new Date(now()).toISOString(),
          status: 'unsupported',
          tld: target.tld,
        }
      }
      const result = await options.provider.queryAvailability({
        domain: target.domain.ascii,
        traceId: options.traceId,
      })
      return result.ok
        ? providerSuccessItem(target, result, catalog, options.traceId)
        : providerFailureItem(target, result, options.traceId)
    }),
  )

  const items = settled.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : thrownFailureItem(targets[index], options.traceId, new Date(now()).toISOString()),
  )
  return resultFromItems({ ...data, items }, options.traceId, startedAt)
}
