import { createHash, randomUUID } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import type { ProviderResult } from '@/lib/domain'
import { normalizeDomain } from '@/lib/domain-name'
import { AppError, toProblemDetails } from '@/lib/errors'
import { isWestDigitalRateLimitError } from '@/providers/westdigital'
import type {
  WestDigitalAvailability,
  WestDigitalPrice,
  WestDigitalReadProvider,
} from '@/providers/types'
import type { Quote } from '@/payload-types'
import {
  quoteCreateRequestSchema,
  quoteCreationResultSchema,
  type PublicQuote,
  type QuoteCreateRequest,
  type QuoteCreationResult,
} from '@/schemas/quotes'
import { DEFAULT_DOMAIN_SEARCH_TLDS } from '@/services/domain-search/query-availability'
import {
  calculateRegistrationTotalFen,
  calculateTldPrice,
  PRICE_CALCULATION_VERSION,
  PRICE_SNAPSHOT_SCHEMA_VERSION,
  type PricingRule,
} from '@/services/pricing/price-calculation'
import {
  replayPriceSnapshot,
  type PriceSnapshotStore,
  type StoredPriceSnapshot,
} from '@/services/pricing/price-snapshots'

export const QUOTE_VALIDITY_MS = 5 * 60 * 1_000

type CustomerIdentity = { collection: 'customers'; id: number }

export type QuoteSnapshotInput = {
  availabilityObservedAt: string
  availabilityRequestId: string
  calculation: StoredPriceSnapshot['calculation']
  customerId: number
  domainAscii: string
  expiresAt: string
  providerCacheExpiresAt?: string
  providerCacheStatus: 'hit' | 'miss'
  providerObservedAt: string
  providerProductId: string
  providerRequestId: string
  quotedAt: string
  sourceCalculationHash: string
  sourcePriceSnapshotRef: string
  tld: string
  traceId: string
  upstreamCostMinor: number
  userPriceMinor: number
  years: number
}

export type StoredCustomerQuote = QuoteSnapshotInput & {
  quoteId: number
  quoteIntegrityHash: string
  quoteRef: string
}

export interface CustomerQuoteStore {
  findOwnedByRef(quoteRef: string): Promise<StoredCustomerQuote | undefined>
  record(input: QuoteSnapshotInput): Promise<StoredCustomerQuote>
}

function customerId(user: CustomerIdentity): string {
  return String(user.id)
}

function canonicalQuoteSnapshot(input: QuoteSnapshotInput) {
  const rule = input.calculation.rule
  return {
    availabilityObservedAt: input.availabilityObservedAt,
    availabilityRequestId: input.availabilityRequestId,
    calculation: {
      calculationFormula: input.calculation.calculationFormula,
      calculationVersion: input.calculation.calculationVersion,
      currency: input.calculation.currency,
      registrationPriceFen: input.calculation.registrationPriceFen,
      renewalPriceFen: input.calculation.renewalPriceFen,
      rule:
        rule.mode === 'fixed'
          ? {
              fixedAmountFen: rule.fixedAmountFen,
              key: rule.key,
              mode: rule.mode,
              source: rule.source,
              tld: rule.tld,
              version: rule.version,
            }
          : {
              key: rule.key,
              mode: rule.mode,
              percentageBasisPoints: rule.percentageBasisPoints,
              source: rule.source,
              tld: rule.tld,
              version: rule.version,
            },
      upstreamRegistrationPriceFen: input.calculation.upstreamRegistrationPriceFen,
      upstreamRenewalPriceFen: input.calculation.upstreamRenewalPriceFen,
    },
    customerId: String(input.customerId),
    domainAscii: input.domainAscii,
    expiresAt: input.expiresAt,
    providerCacheExpiresAt: input.providerCacheExpiresAt,
    providerCacheStatus: input.providerCacheStatus,
    providerObservedAt: input.providerObservedAt,
    providerProductId: input.providerProductId,
    providerRequestId: input.providerRequestId,
    quotedAt: input.quotedAt,
    schemaVersion: PRICE_SNAPSHOT_SCHEMA_VERSION,
    sourceCalculationHash: input.sourceCalculationHash,
    sourcePriceSnapshotRef: input.sourcePriceSnapshotRef,
    tld: input.tld,
    upstreamCostMinor: input.upstreamCostMinor,
    userPriceMinor: input.userPriceMinor,
    years: input.years,
  }
}

export function createQuoteIntegrityHash(input: QuoteSnapshotInput): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalQuoteSnapshot(input)))
    .digest('hex')
}

function ruleFromQuote(doc: Quote): PricingRule {
  if (doc.ruleVersion !== 1) {
    throw new AppError('QUOTE_VERSION_UNSUPPORTED', '报价规则版本不受支持', 500)
  }
  if (doc.ruleMode === 'fixed') {
    if (doc.ruleFixedAmountMinor === null || doc.ruleFixedAmountMinor === undefined) {
      throw new AppError('QUOTE_SNAPSHOT_INCOMPLETE', '报价缺少固定加价金额', 500)
    }
    return {
      fixedAmountFen: doc.ruleFixedAmountMinor,
      key: doc.ruleKey,
      mode: 'fixed',
      source: doc.ruleSource,
      tld: doc.tld,
      version: 1,
    }
  }
  if (doc.rulePercentageBasisPoints === null || doc.rulePercentageBasisPoints === undefined) {
    throw new AppError('QUOTE_SNAPSHOT_INCOMPLETE', '报价缺少比例加价基点', 500)
  }
  return {
    key: doc.ruleKey,
    mode: 'percentage',
    percentageBasisPoints: doc.rulePercentageBasisPoints,
    source: doc.ruleSource,
    tld: doc.tld,
    version: 1,
  }
}

function fromDocument(doc: Quote): StoredCustomerQuote {
  if (
    doc.schemaVersion !== PRICE_SNAPSHOT_SCHEMA_VERSION ||
    doc.calculationVersion !== PRICE_CALCULATION_VERSION
  ) {
    throw new AppError('QUOTE_VERSION_UNSUPPORTED', '报价快照版本不受支持', 500)
  }
  const owner = typeof doc.customer === 'object' ? doc.customer.id : doc.customer
  return {
    availabilityObservedAt: doc.availabilityObservedAt,
    availabilityRequestId: doc.availabilityRequestId,
    calculation: {
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      currency: 'CNY',
      oneYearTotalFen: doc.registrationPriceMinor,
      registrationPriceFen: doc.registrationPriceMinor,
      renewalPriceFen: doc.renewalPriceMinor,
      rule: ruleFromQuote(doc),
      threeYearTotalFen: calculateRegistrationTotalFen({
        registrationPriceFen: doc.registrationPriceMinor,
        renewalPriceFen: doc.renewalPriceMinor,
        years: 3,
      }),
      upstreamRegistrationPriceFen: doc.upstreamRegistrationPriceMinor,
      upstreamRenewalPriceFen: doc.upstreamRenewalPriceMinor,
    },
    customerId: owner,
    domainAscii: doc.domainAscii,
    expiresAt: doc.expiresAt,
    ...(doc.providerCacheExpiresAt ? { providerCacheExpiresAt: doc.providerCacheExpiresAt } : {}),
    providerCacheStatus: doc.providerCacheStatus,
    providerObservedAt: doc.providerObservedAt,
    providerProductId: doc.providerProductId,
    providerRequestId: doc.providerRequestId,
    quoteId: doc.id,
    quoteIntegrityHash: doc.quoteIntegrityHash,
    quotedAt: doc.quotedAt,
    quoteRef: doc.quoteRef,
    sourceCalculationHash: doc.sourceCalculationHash,
    sourcePriceSnapshotRef: doc.sourcePriceSnapshotRef,
    tld: doc.tld,
    traceId: doc.createdTraceId,
    upstreamCostMinor: doc.upstreamCostMinor,
    userPriceMinor: doc.userPriceMinor,
    years: doc.years,
  }
}

export class PayloadCustomerQuoteStore implements CustomerQuoteStore {
  constructor(
    private readonly req: PayloadRequest,
    private readonly user: CustomerIdentity,
  ) {}

  async findOwnedByRef(quoteRef: string): Promise<StoredCustomerQuote | undefined> {
    const result = await this.req.payload.find({
      collection: 'quotes',
      depth: 0,
      limit: 1,
      overrideAccess: false,
      req: this.req,
      user: this.user,
      where: { quoteRef: { equals: quoteRef } },
    })
    const authorized = result.docs[0]
    if (!authorized) return undefined
    const internal = await this.req.payload.findByID({
      collection: 'quotes',
      depth: 0,
      id: authorized.id,
      overrideAccess: true,
      req: this.req,
    })
    return fromDocument(internal)
  }

  async record(input: QuoteSnapshotInput): Promise<StoredCustomerQuote> {
    if (customerId(this.user) !== String(input.customerId)) {
      throw new AppError('QUOTE_CUSTOMER_MISMATCH', '报价客户不一致', 403)
    }
    const rule = input.calculation.rule
    const quoteIntegrityHash = createQuoteIntegrityHash(input)
    const created = await this.req.payload.create({
      collection: 'quotes',
      data: {
        availabilityObservedAt: input.availabilityObservedAt,
        availabilityRequestId: input.availabilityRequestId,
        calculationFormula: input.calculation.calculationFormula,
        calculationVersion: PRICE_CALCULATION_VERSION,
        createdTraceId: input.traceId,
        currency: 'CNY',
        customer: input.customerId,
        domainAscii: input.domainAscii,
        expiresAt: input.expiresAt,
        priceClass: 'standard',
        provider: 'westdigital_fixture',
        ...(input.providerCacheExpiresAt
          ? { providerCacheExpiresAt: input.providerCacheExpiresAt }
          : {}),
        providerCacheStatus: input.providerCacheStatus,
        providerObservedAt: input.providerObservedAt,
        providerProductId: input.providerProductId,
        providerRequestId: input.providerRequestId,
        quotedAt: input.quotedAt,
        quoteIntegrityHash,
        quoteRef: randomUUID(),
        registrationPriceMinor: input.calculation.registrationPriceFen,
        renewalPriceMinor: input.calculation.renewalPriceFen,
        ...(rule.mode === 'fixed'
          ? { ruleFixedAmountMinor: rule.fixedAmountFen }
          : { rulePercentageBasisPoints: rule.percentageBasisPoints }),
        ruleKey: rule.key,
        ruleMode: rule.mode,
        ruleSource: rule.source,
        ruleVersion: rule.version,
        roundingMode: 'half_up_to_fen',
        schemaVersion: PRICE_SNAPSHOT_SCHEMA_VERSION,
        sourceCalculationHash: input.sourceCalculationHash,
        sourcePriceSnapshotRef: input.sourcePriceSnapshotRef,
        tld: input.tld,
        upstreamCostMinor: input.upstreamCostMinor,
        upstreamRegistrationPriceMinor: input.calculation.upstreamRegistrationPriceFen,
        upstreamRenewalPriceMinor: input.calculation.upstreamRenewalPriceFen,
        userPriceMinor: input.userPriceMinor,
        years: input.years,
      },
      overrideAccess: true,
      req: this.req,
    })
    return fromDocument(created)
  }
}

function publicQuote(quote: StoredCustomerQuote): PublicQuote {
  return {
    currency: 'CNY',
    domainAscii: quote.domainAscii,
    expiresAt: quote.expiresAt,
    priceClass: 'standard',
    providerObservedAt: quote.providerObservedAt,
    quotedAt: quote.quotedAt,
    quoteRef: quote.quoteRef,
    sourcePriceSnapshotRef: quote.sourcePriceSnapshotRef,
    userPriceMinor: quote.userPriceMinor,
    years: quote.years,
  }
}

function resultProblem(input: {
  code: string
  message: string
  observedAt?: string
  rateLimited?: boolean
  retryAfterSeconds?: number
  traceId: string
}): QuoteCreationResult {
  const error = new AppError(input.code, input.message, input.rateLimited ? 429 : 503, {
    action: '请稍后重试',
    observedAt: input.observedAt,
    retryable: true,
    retryAfterSeconds: input.retryAfterSeconds,
    title: input.rateLimited ? '报价请求过于频繁' : '报价暂时不可用',
  })
  return {
    meta: { ...(input.observedAt ? { observedAt: input.observedAt } : {}), traceId: input.traceId },
    problem: toProblemDetails(error, input.traceId),
    state: input.rateLimited ? 'rate_limited' : 'error',
  }
}

function providerFailure<T>(
  result: Extract<ProviderResult<T>, { ok: false }>,
  traceId: string,
): QuoteCreationResult {
  const rateLimited = isWestDigitalRateLimitError(result.error.code)
  return resultProblem({
    code: rateLimited ? 'QUOTE_RATE_LIMITED' : 'QUOTE_PROVIDER_UNAVAILABLE',
    message: rateLimited ? '报价请求过于频繁，请稍后重试' : '暂时无法取得最新报价',
    observedAt: result.observedAt,
    rateLimited,
    retryAfterSeconds: result.error.retryAfterSeconds,
    traceId,
  })
}

function blocked(
  blockCode:
    | 'DOMAIN_UNAVAILABLE'
    | 'PREMIUM_UNSUPPORTED'
    | 'PRICE_RULE_UNCONFIGURED'
    | 'TLD_UNSUPPORTED',
  traceId: string,
  observedAt?: string,
): QuoteCreationResult {
  return {
    data: { blockCode, quote: null },
    meta: { ...(observedAt ? { observedAt } : {}), traceId },
    state: 'empty',
  }
}

function resolveTld(domainAscii: string, supportedTlds: ReadonlySet<string>): string | undefined {
  return [...supportedTlds]
    .sort((a, b) => b.length - a.length)
    .find((tld) => domainAscii.endsWith(`.${tld}`))
}

export async function createCustomerQuote(
  candidate: QuoteCreateRequest,
  options: {
    customer: CustomerIdentity
    now?: () => number
    provider: WestDigitalReadProvider
    quoteStore: CustomerQuoteStore
    rules: Readonly<Record<string, PricingRule>>
    snapshots: PriceSnapshotStore
    supportedTlds?: ReadonlySet<string>
    traceId: string
  },
): Promise<QuoteCreationResult> {
  const input = quoteCreateRequestSchema.parse(candidate)
  const normalized = normalizeDomain(input.domain)
  if (!normalized.ok) {
    throw new AppError(normalized.error.code, normalized.error.message, 400)
  }
  const supportedTlds = options.supportedTlds ?? new Set(DEFAULT_DOMAIN_SEARCH_TLDS)
  const tld = resolveTld(normalized.value.ascii, supportedTlds)
  if (!tld) return blocked('TLD_UNSUPPORTED', options.traceId)
  const rule = options.rules[tld]
  if (!rule) return blocked('PRICE_RULE_UNCONFIGURED', options.traceId)

  let availability: ProviderResult<WestDigitalAvailability>
  try {
    availability = await options.provider.queryAvailability({
      domain: normalized.value.ascii,
      traceId: options.traceId,
    })
  } catch {
    return resultProblem({
      code: 'QUOTE_PROVIDER_UNAVAILABLE',
      message: '暂时无法确认域名状态',
      traceId: options.traceId,
    })
  }
  if (!availability.ok) return providerFailure(availability, options.traceId)
  if (!availability.data.available) {
    return blocked('DOMAIN_UNAVAILABLE', options.traceId, availability.observedAt)
  }
  if (availability.data.premium) {
    return blocked('PREMIUM_UNSUPPORTED', options.traceId, availability.observedAt)
  }

  let price: ProviderResult<WestDigitalPrice>
  try {
    price = await options.provider.queryPrice({
      domain: normalized.value.ascii,
      traceId: options.traceId,
      years: 1,
    })
  } catch {
    return resultProblem({
      code: 'QUOTE_PROVIDER_UNAVAILABLE',
      message: '暂时无法取得最新报价',
      traceId: options.traceId,
    })
  }
  if (!price.ok) return providerFailure(price, options.traceId)
  if (
    price.data.currency !== 'CNY' ||
    price.data.domainAscii !== normalized.value.ascii ||
    price.data.purchaseYears !== 1
  ) {
    return resultProblem({
      code: 'QUOTE_PROVIDER_MISMATCH',
      message: '价格数据源返回的目标不一致',
      observedAt: price.observedAt,
      traceId: options.traceId,
    })
  }

  try {
    const calculation = calculateTldPrice({
      registrationPriceFen: price.data.registrationPriceFen,
      renewalPriceFen: price.data.renewalPriceFen,
      rule,
    })
    const sourceSnapshot = await options.snapshots.record({
      calculation,
      ...(price.cache?.expiresAt ? { providerCacheExpiresAt: price.cache.expiresAt } : {}),
      providerCacheStatus: price.cache?.status === 'hit' ? 'hit' : 'miss',
      providerObservedAt: price.observedAt,
      providerProductId: price.data.productId,
      providerRequestId: price.requestId,
      representativeDomainAscii: normalized.value.ascii,
      tld,
      traceId: options.traceId,
    })
    replayPriceSnapshot(sourceSnapshot)
    const upstreamCostMinor = calculateRegistrationTotalFen({
      registrationPriceFen: calculation.upstreamRegistrationPriceFen,
      renewalPriceFen: calculation.upstreamRenewalPriceFen,
      years: input.years,
    })
    const userPriceMinor = calculateRegistrationTotalFen({
      registrationPriceFen: calculation.registrationPriceFen,
      renewalPriceFen: calculation.renewalPriceFen,
      years: input.years,
    })
    const quotedAt = new Date((options.now ?? Date.now)()).toISOString()
    const quote = await options.quoteStore.record({
      availabilityObservedAt: availability.observedAt,
      availabilityRequestId: availability.requestId,
      calculation,
      customerId: options.customer.id,
      domainAscii: normalized.value.ascii,
      expiresAt: new Date(Date.parse(quotedAt) + QUOTE_VALIDITY_MS).toISOString(),
      ...(price.cache?.expiresAt ? { providerCacheExpiresAt: price.cache.expiresAt } : {}),
      providerCacheStatus: price.cache?.status === 'hit' ? 'hit' : 'miss',
      providerObservedAt: price.observedAt,
      providerProductId: price.data.productId,
      providerRequestId: price.requestId,
      quotedAt,
      sourceCalculationHash: sourceSnapshot.calculationHash,
      sourcePriceSnapshotRef: sourceSnapshot.snapshotRef,
      tld,
      traceId: options.traceId,
      upstreamCostMinor,
      userPriceMinor,
      years: input.years,
    })
    return quoteCreationResultSchema.parse({
      data: { quote: publicQuote(quote) },
      meta: {
        cacheStatus: price.cache?.status ?? 'miss',
        observedAt: price.observedAt,
        traceId: options.traceId,
      },
      state: 'ready',
    })
  } catch {
    return resultProblem({
      code: 'QUOTE_SNAPSHOT_UNAVAILABLE',
      message: '报价快照暂时无法安全保存',
      observedAt: price.observedAt,
      traceId: options.traceId,
    })
  }
}

export async function getUsableCustomerQuote(input: {
  customer: CustomerIdentity
  now?: () => number
  quoteRef: string
  store: CustomerQuoteStore
}): Promise<StoredCustomerQuote> {
  const quote = await input.store.findOwnedByRef(input.quoteRef)
  if (!quote || String(quote.customerId) !== String(input.customer.id)) {
    throw new AppError('QUOTE_NOT_FOUND', '未找到可用报价', 404)
  }
  if (Date.parse(quote.expiresAt) <= (input.now ?? Date.now)()) {
    throw new AppError('QUOTE_EXPIRED', '报价已过期，请重新获取', 409, {
      action: '请重新获取最新报价',
      retryable: false,
      title: '报价已过期',
    })
  }
  if (createQuoteIntegrityHash(quote) !== quote.quoteIntegrityHash) {
    throw new AppError('QUOTE_INTEGRITY_MISMATCH', '报价快照完整性校验失败', 500)
  }
  return quote
}

export function assertCustomerIdentity(user: unknown): asserts user is CustomerIdentity {
  if (!isCustomerUser(user)) throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
}
