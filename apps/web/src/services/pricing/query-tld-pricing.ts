import type { ProviderResult } from '@/lib/domain'
import { normalizeDomain } from '@/lib/domain-name'
import { AppError, toProblemDetails } from '@/lib/errors'
import type { WestDigitalPrice, WestDigitalReadProvider } from '@/providers/types'
import {
  PRICING_MAX_TLDS,
  pricingRequestSchema,
  pricingResultSchema,
  type PricingData,
  type PricingItem,
  type PricingRequest,
  type PricingResult,
} from '@/schemas/pricing'
import type { ResultMeta } from '@/schemas/api'
import { DEFAULT_DOMAIN_SEARCH_TLDS } from '@/services/domain-search/query-availability'
import {
  calculateTldPrice,
  FIXTURE_PRICING_RULES,
  type PricingRule,
} from '@/services/pricing/price-calculation'
import type { PriceSnapshotStore, StoredPriceSnapshot } from '@/services/pricing/price-snapshots'

export const WESTDIGITAL_PRICING_FIXTURE_SOURCE = '西部数码价格 fixture（非实时）'
export const WANMI_PRICING_FIXTURE_SOURCE = 'Wanmi fixture 加价规则目录'

const supportedTlds = new Set<string>(DEFAULT_DOMAIN_SEARCH_TLDS)

type PricingOptions = {
  now?: () => number
  provider: WestDigitalReadProvider
  rules?: Readonly<Record<string, PricingRule>>
  snapshots: PriceSnapshotStore
  supportedTlds?: ReadonlySet<string>
  traceId: string
}

type Target = {
  representativeDomainAscii: string
  rule?: PricingRule
  supported: boolean
  tld: string
}

function pricingInputError(code: string, message: string): AppError {
  return new AppError(code, message, 400, {
    action: '请检查域名后缀后重试',
    retryable: false,
    title: '价格查询参数无效',
  })
}

function normalizeTld(value: string): string {
  const trimmed = value.trim()
  const candidate = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed
  if (!candidate) throw pricingInputError('PRICING_INVALID_TLD', '域名后缀不能为空')
  const normalized = normalizeDomain(`wanmi.${candidate}`)
  if (!normalized.ok) throw pricingInputError(normalized.error.code, normalized.error.message)
  return normalized.value.ascii.slice('wanmi.'.length)
}

export function normalizePricingTlds(values: readonly string[]): string[] {
  if (values.length > PRICING_MAX_TLDS) {
    throw pricingInputError(
      'PRICING_TLD_LIMIT_EXCEEDED',
      `单次最多查询 ${PRICING_MAX_TLDS} 个域名后缀，当前提交了 ${values.length} 个`,
    )
  }
  const normalized = values.map(normalizeTld)
  if (new Set(normalized).size !== normalized.length) {
    throw pricingInputError('PRICING_DUPLICATE_TLD', '域名后缀规范化后存在重复项')
  }
  return normalized
}

function cacheFor(result: ProviderResult<unknown>): PricingItem['cache'] {
  return {
    ...(result.cache?.expiresAt ? { expiresAt: result.cache.expiresAt } : {}),
    status: result.cache?.status ?? 'miss',
  }
}

function providerFailureProblem(
  result: Extract<ProviderResult<WestDigitalPrice>, { ok: false }>,
  traceId: string,
) {
  const rateLimited = result.error.code === 'WESTDIGITAL_RATE_LIMITED'
  return toProblemDetails(
    new AppError(
      result.error.code,
      rateLimited ? '价格数据源请求过于频繁，请稍后重试' : '暂时无法取得最新 TLD 价格',
      rateLimited ? 429 : 503,
      {
        action: result.error.retryable ? '请稍后重试' : '请稍后再试',
        dataSource: WESTDIGITAL_PRICING_FIXTURE_SOURCE,
        observedAt: result.observedAt,
        retryable: result.error.retryable,
        retryAfterSeconds: result.error.retryAfterSeconds,
        title: rateLimited ? '价格查询请求过于频繁' : '最新价格暂时不可用',
      },
    ),
    traceId,
  )
}

function queryFailedItem(input: {
  cache?: PricingItem['cache']
  code: string
  message: string
  observedAt: string
  retryable: boolean
  status?: number
  tld: string
  traceId: string
}): PricingItem {
  return {
    cache: input.cache ?? { status: 'miss' },
    dataSource: WESTDIGITAL_PRICING_FIXTURE_SOURCE,
    observedAt: input.observedAt,
    problem: toProblemDetails(
      new AppError(input.code, input.message, input.status ?? 503, {
        action: input.retryable ? '请稍后重试' : '请稍后再试',
        dataSource: WESTDIGITAL_PRICING_FIXTURE_SOURCE,
        observedAt: input.observedAt,
        retryable: input.retryable,
        title: 'TLD 价格暂时不可用',
      }),
      input.traceId,
    ),
    purchaseBlockCode: 'PRICE_QUERY_FAILED',
    purchaseEligible: false,
    status: 'query_failed',
    tld: input.tld,
  }
}

function staleItem(snapshot: StoredPriceSnapshot): PricingItem {
  const calculation = snapshot.calculation
  return {
    cache: { status: 'not_used' },
    calculationFormula: calculation.calculationFormula,
    currency: 'CNY',
    dataSource: `${WESTDIGITAL_PRICING_FIXTURE_SOURCE}历史快照`,
    lastSuccessfulAt: snapshot.providerObservedAt,
    markupConfigured: true,
    minimumRegistrationYears: 1,
    observedAt: snapshot.providerObservedAt,
    oneYearTotalFen: calculation.oneYearTotalFen,
    priceClass: 'standard',
    purchaseBlockCode: 'PRICE_STALE',
    purchaseEligible: false,
    registrationPriceFen: calculation.registrationPriceFen,
    renewalPriceFen: calculation.renewalPriceFen,
    snapshotRef: snapshot.snapshotRef,
    status: 'stale',
    threeYearTotalFen: calculation.threeYearTotalFen,
    tld: snapshot.tld,
  }
}

async function latestOrFailure(input: {
  failure: PricingItem
  rule: PricingRule
  snapshots: PriceSnapshotStore
  tld: string
}): Promise<PricingItem> {
  try {
    const latest = await input.snapshots.findLatest({
      ruleKey: input.rule.key,
      ruleVersion: input.rule.version,
      tld: input.tld,
    })
    return latest ? staleItem(latest) : input.failure
  } catch {
    return input.failure
  }
}

async function queryTarget(
  target: Target,
  options: Required<Pick<PricingOptions, 'provider' | 'snapshots' | 'traceId'>> & {
    now: () => number
  },
): Promise<PricingItem> {
  const observedAt = new Date(options.now()).toISOString()
  if (!target.supported) {
    return {
      cache: { status: 'not_used' },
      dataSource: WANMI_PRICING_FIXTURE_SOURCE,
      observedAt,
      purchaseBlockCode: 'TLD_UNSUPPORTED',
      purchaseEligible: false,
      status: 'unsupported',
      tld: target.tld,
    }
  }
  if (!target.rule) {
    return {
      cache: { status: 'not_used' },
      dataSource: WANMI_PRICING_FIXTURE_SOURCE,
      markupConfigured: false,
      observedAt,
      purchaseBlockCode: 'PRICE_RULE_UNCONFIGURED',
      purchaseEligible: false,
      status: 'unconfigured',
      tld: target.tld,
    }
  }

  let result: ProviderResult<WestDigitalPrice>
  try {
    result = await options.provider.queryPrice({
      domain: target.representativeDomainAscii,
      traceId: options.traceId,
      years: 1,
    })
  } catch {
    const failure = queryFailedItem({
      code: 'WESTDIGITAL_UNAVAILABLE',
      message: '暂时无法取得最新 TLD 价格',
      observedAt,
      retryable: true,
      tld: target.tld,
      traceId: options.traceId,
    })
    return latestOrFailure({
      failure,
      rule: target.rule,
      snapshots: options.snapshots,
      tld: target.tld,
    })
  }

  if (!result.ok) {
    const failure: PricingItem = {
      cache: cacheFor(result),
      dataSource: WESTDIGITAL_PRICING_FIXTURE_SOURCE,
      observedAt: result.observedAt,
      problem: providerFailureProblem(result, options.traceId),
      purchaseBlockCode: 'PRICE_QUERY_FAILED',
      purchaseEligible: false,
      status: 'query_failed',
      tld: target.tld,
    }
    return latestOrFailure({
      failure,
      rule: target.rule,
      snapshots: options.snapshots,
      tld: target.tld,
    })
  }

  try {
    if (
      result.data.currency !== 'CNY' ||
      result.data.domainAscii !== target.representativeDomainAscii ||
      result.data.purchaseYears !== 1
    ) {
      throw new AppError('PRICING_PROVIDER_MISMATCH', '价格数据源返回的目标不一致', 503)
    }
    const calculation = calculateTldPrice({
      registrationPriceFen: result.data.registrationPriceFen,
      renewalPriceFen: result.data.renewalPriceFen,
      rule: target.rule,
    })
    const cacheStatus = result.cache?.status === 'hit' ? 'hit' : 'miss'
    const snapshot = await options.snapshots.record({
      calculation,
      ...(result.cache?.expiresAt ? { providerCacheExpiresAt: result.cache.expiresAt } : {}),
      providerCacheStatus: cacheStatus,
      providerObservedAt: result.observedAt,
      providerProductId: result.data.productId,
      providerRequestId: result.requestId,
      representativeDomainAscii: target.representativeDomainAscii,
      tld: target.tld,
      traceId: options.traceId,
    })
    return {
      cache: cacheFor(result),
      calculationFormula: calculation.calculationFormula,
      currency: 'CNY',
      dataSource: `${WESTDIGITAL_PRICING_FIXTURE_SOURCE} + ${WANMI_PRICING_FIXTURE_SOURCE}`,
      markupConfigured: true,
      minimumRegistrationYears: 1,
      observedAt: result.observedAt,
      oneYearTotalFen: calculation.oneYearTotalFen,
      priceClass: 'standard',
      purchaseBlockCode: 'PURCHASE_NOT_IMPLEMENTED',
      purchaseEligible: false,
      registrationPriceFen: calculation.registrationPriceFen,
      renewalPriceFen: calculation.renewalPriceFen,
      snapshotRef: snapshot.snapshotRef,
      status: 'priced',
      threeYearTotalFen: calculation.threeYearTotalFen,
      tld: target.tld,
    }
  } catch (error) {
    const appError = error instanceof AppError ? error : undefined
    return queryFailedItem({
      cache: cacheFor(result),
      code: appError?.code ?? 'PRICE_SNAPSHOT_UNAVAILABLE',
      message: appError?.message ?? '价格快照暂时无法保存',
      observedAt: result.observedAt,
      retryable: appError?.options.retryable ?? true,
      tld: target.tld,
      traceId: options.traceId,
    })
  }
}

function cacheStatus(items: PricingItem[]): ResultMeta['cacheStatus'] {
  if (items.length === 0) return 'not_used'
  const statuses = new Set(items.map((item) => item.cache.status))
  return statuses.size === 1 ? [...statuses][0] : 'mixed'
}

function aggregateMeta(items: PricingItem[], traceId: string): ResultMeta {
  const sources = [...new Set(items.map((item) => item.dataSource))]
  const observedAt = items
    .map((item) => item.observedAt)
    .sort()
    .at(-1)
  return {
    cacheStatus: cacheStatus(items),
    ...(sources.length ? { dataSource: sources.join(' + ') } : {}),
    ...(observedAt ? { observedAt } : {}),
    traceId,
  }
}

function aggregateResult(data: PricingData, traceId: string): PricingResult {
  const fresh = data.items.filter((item) => item.status === 'priced')
  const stale = data.items.filter((item) => item.status === 'stale')
  const failed = data.items.filter((item) => item.status === 'query_failed')
  const meta = aggregateMeta(data.items, traceId)

  if (
    data.items.length === 0 ||
    (fresh.length === 0 && stale.length === 0 && failed.length === 0)
  ) {
    return { data, meta, state: 'empty' }
  }
  if (failed.length === 0 && stale.length === 0) return { data, meta, state: 'ready' }

  if (fresh.length > 0) {
    return {
      data,
      meta,
      problem: toProblemDetails(
        new AppError('PRICING_PARTIAL', '部分 TLD 暂时无法取得最新价格', 503, {
          action: '可查看明确结果，并稍后重试失败项目',
          retryable: true,
          title: '部分价格结果不可用',
        }),
        traceId,
      ),
      state: 'partial',
    }
  }

  if (stale.length > 0) {
    const lastSuccessfulAt = stale
      .map((item) => item.lastSuccessfulAt)
      .sort()
      .at(-1)
    return {
      data,
      meta: { ...meta, ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}), stale: true },
      problem: toProblemDetails(
        new AppError('PRICING_STALE_DATA', '当前仅能展示历史价格快照，不能用于购买', 503, {
          action: '请稍后重试以获取最新价格',
          ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}),
          retryable: true,
          title: '最新价格暂时不可用',
        }),
        traceId,
      ),
      state: 'degraded',
    }
  }

  const allRateLimited = failed.every((item) => item.problem.status === 429)
  const error = new AppError(
    allRateLimited ? 'PRICING_RATE_LIMITED' : 'PRICING_UNAVAILABLE',
    allRateLimited ? '价格查询请求过于频繁，请稍后重试' : 'TLD 价格服务暂时不可用',
    allRateLimited ? 429 : 503,
    {
      action: '请稍后重试',
      retryable: true,
      title: allRateLimited ? '价格查询请求过于频繁' : '价格服务暂时不可用',
    },
  )
  return {
    meta,
    problem: toProblemDetails(error, traceId),
    state: allRateLimited ? 'rate_limited' : 'error',
  }
}

export async function queryTldPricing(
  candidate: PricingRequest,
  options: PricingOptions,
): Promise<PricingResult> {
  const input = pricingRequestSchema.parse(candidate)
  const tlds = normalizePricingTlds(input.tlds ?? DEFAULT_DOMAIN_SEARCH_TLDS)
  const catalog = options.supportedTlds ?? supportedTlds
  const rules = options.rules ?? FIXTURE_PRICING_RULES
  const now = options.now ?? Date.now
  const targets = tlds.map<Target>((tld) => ({
    representativeDomainAscii: `wanmi.${tld}`,
    rule: rules[tld],
    supported: catalog.has(tld),
    tld,
  }))
  const settled = await Promise.allSettled(
    targets.map((target) =>
      queryTarget(target, {
        now,
        provider: options.provider,
        snapshots: options.snapshots,
        traceId: options.traceId,
      }),
    ),
  )
  const observedAt = new Date(now()).toISOString()
  const items = settled.map<PricingItem>((result, index) => {
    if (result.status === 'fulfilled') return result.value
    return queryFailedItem({
      code: 'PRICING_ITEM_UNAVAILABLE',
      message: '该 TLD 价格暂时不可用',
      observedAt,
      retryable: true,
      tld: targets[index]?.tld ?? 'unknown',
      traceId: options.traceId,
    })
  })
  return pricingResultSchema.parse(
    aggregateResult({ items, priceClass: 'standard', tlds }, options.traceId),
  )
}
