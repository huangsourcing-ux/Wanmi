import { randomUUID } from 'node:crypto'

import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import { isWestDigitalRateLimitError } from '@/providers/westdigital'
import type { WestDigitalAvailability, WestDigitalReadProvider } from '@/providers/types'
import {
  orderCreateRequestSchema,
  orderCreationResultSchema,
  type OrderCreateRequest,
  type OrderCreationResult,
} from '@/schemas/orders'
import { DEFAULT_DOMAIN_SEARCH_TLDS } from '@/services/domain-search/query-availability'
import {
  getUsableCustomerQuote,
  PayloadCustomerQuoteStore,
  type CustomerQuoteStore,
  type StoredCustomerQuote,
} from '@/services/pricing/customer-quotes'
import {
  calculateRegistrationTotalFen,
  calculateTldPrice,
  FIXTURE_PRICING_RULES,
  type PricingRule,
} from '@/services/pricing/price-calculation'
import { assertRealnameTemplateUsableForRegistration } from '@/services/realname/templates'

type CustomerIdentity = {
  collection: 'customers'
  id: number
  status?: string
}

type OrderCreationOptions = {
  customer: CustomerIdentity
  now?: () => number
  orderNumber?: () => string
  provider: WestDigitalReadProvider
  quoteStore?: CustomerQuoteStore
  rules?: Readonly<Record<string, PricingRule>>
  supportedTlds?: ReadonlySet<string>
  traceId: string
}

function assertCustomer(req: PayloadRequest, customer: CustomerIdentity): void {
  if (
    !isCustomerUser(req.user) ||
    (req.user as { status?: string }).status !== 'active' ||
    String(req.user.id) !== String(customer.id)
  ) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
}

function sameRule(left: PricingRule, right: PricingRule): boolean {
  if (
    left.key !== right.key ||
    left.mode !== right.mode ||
    left.source !== right.source ||
    left.tld !== right.tld ||
    left.version !== right.version
  ) {
    return false
  }
  return left.mode === 'fixed' && right.mode === 'fixed'
    ? left.fixedAmountFen === right.fixedAmountFen
    : left.mode === 'percentage' &&
        right.mode === 'percentage' &&
        left.percentageBasisPoints === right.percentageBasisPoints
}

export function assertQuoteAmountAndRuleUsableForOrder(
  quote: StoredCustomerQuote,
  options: {
    rules?: Readonly<Record<string, PricingRule>>
    supportedTlds?: ReadonlySet<string>
  } = {},
): void {
  const supportedTlds = options.supportedTlds ?? new Set(DEFAULT_DOMAIN_SEARCH_TLDS)
  if (!supportedTlds.has(quote.tld)) {
    throw new AppError('TLD_UNSUPPORTED', '该域名后缀当前不支持下单', 409)
  }
  const rule = (options.rules ?? FIXTURE_PRICING_RULES)[quote.tld]
  if (!rule) {
    throw new AppError('PRICE_RULE_UNCONFIGURED', '该域名后缀尚未配置加价规则', 409)
  }
  if (!sameRule(rule, quote.calculation.rule)) {
    throw new AppError('QUOTE_PRICE_CHANGED', '加价规则已变化，请重新获取报价', 409, {
      action: '请重新获取最新报价',
      retryable: false,
      title: '报价条件已变化',
    })
  }

  const calculation = calculateTldPrice({
    registrationPriceFen: quote.calculation.upstreamRegistrationPriceFen,
    renewalPriceFen: quote.calculation.upstreamRenewalPriceFen,
    rule,
  })
  const upstreamCostMinor = calculateRegistrationTotalFen({
    registrationPriceFen: calculation.upstreamRegistrationPriceFen,
    renewalPriceFen: calculation.upstreamRenewalPriceFen,
    years: quote.years,
  })
  const userPriceMinor = calculateRegistrationTotalFen({
    registrationPriceFen: calculation.registrationPriceFen,
    renewalPriceFen: calculation.renewalPriceFen,
    years: quote.years,
  })
  if (
    calculation.registrationPriceFen !== quote.calculation.registrationPriceFen ||
    calculation.renewalPriceFen !== quote.calculation.renewalPriceFen ||
    upstreamCostMinor !== quote.upstreamCostMinor ||
    userPriceMinor !== quote.userPriceMinor
  ) {
    throw new AppError('QUOTE_AMOUNT_MISMATCH', '报价快照金额校验失败', 500)
  }
}

function availabilityFailure(
  availability: Awaited<ReturnType<WestDigitalReadProvider['queryAvailability']>>,
): never {
  if (availability.ok) throw new Error('Expected provider failure')
  const rateLimited = isWestDigitalRateLimitError(availability.error.code)
  throw new AppError(
    rateLimited
      ? 'ORDER_DOMAIN_REVALIDATION_RATE_LIMITED'
      : 'ORDER_DOMAIN_REVALIDATION_UNAVAILABLE',
    rateLimited ? '域名状态确认请求过于频繁，请稍后重试' : '暂时无法确认域名是否仍可注册',
    rateLimited ? 429 : 503,
    {
      action: '请稍后重试',
      observedAt: availability.observedAt,
      retryable: true,
      retryAfterSeconds: availability.error.retryAfterSeconds,
      title: rateLimited ? '域名状态确认过于频繁' : '域名状态暂时不可用',
    },
  )
}

function assertDomainStillAvailable(
  quote: StoredCustomerQuote,
  availability: WestDigitalAvailability,
): void {
  if (availability.domainAscii !== quote.domainAscii || availability.currency !== 'CNY') {
    throw new AppError('ORDER_DOMAIN_REVALIDATION_MISMATCH', '域名状态返回目标不一致', 503)
  }
  if (!availability.available) {
    throw new AppError('DOMAIN_UNAVAILABLE', '该域名已不可注册，请重新查询', 409)
  }
  if (availability.premium) {
    throw new AppError('PREMIUM_UNSUPPORTED', '该域名已识别为溢价域名，当前不可下单', 409)
  }
}

function quoteSnapshot(
  quote: StoredCustomerQuote,
  orderAvailability: { observedAt: string; requestId: string },
) {
  return {
    availabilityObservedAt: quote.availabilityObservedAt,
    availabilityRequestId: quote.availabilityRequestId,
    calculation: quote.calculation,
    createdTraceId: quote.traceId,
    currency: 'CNY' as const,
    customerId: String(quote.customerId),
    domainAscii: quote.domainAscii,
    expiresAt: quote.expiresAt,
    orderAvailability,
    ...(quote.providerCacheExpiresAt
      ? { providerCacheExpiresAt: quote.providerCacheExpiresAt }
      : {}),
    providerCacheStatus: quote.providerCacheStatus,
    providerObservedAt: quote.providerObservedAt,
    providerProductId: quote.providerProductId,
    providerRequestId: quote.providerRequestId,
    quoteId: quote.quoteId,
    quoteIntegrityHash: quote.quoteIntegrityHash,
    quoteRef: quote.quoteRef,
    quotedAt: quote.quotedAt,
    schemaVersion: 1,
    sourceCalculationHash: quote.sourceCalculationHash,
    sourcePriceSnapshotRef: quote.sourcePriceSnapshotRef,
    tld: quote.tld,
    upstreamCostMinor: quote.upstreamCostMinor,
    userPriceMinor: quote.userPriceMinor,
    years: quote.years,
  }
}

export async function createCustomerOrder(
  req: PayloadRequest,
  candidate: OrderCreateRequest,
  options: OrderCreationOptions,
): Promise<OrderCreationResult> {
  assertCustomer(req, options.customer)
  const input = orderCreateRequestSchema.parse(candidate)
  const startedTransaction = await initTransaction(req)
  try {
    const quote = await getUsableCustomerQuote({
      customer: options.customer,
      now: options.now,
      quoteRef: input.quoteRef,
      store: options.quoteStore ?? new PayloadCustomerQuoteStore(req, options.customer),
    })
    await assertRealnameTemplateUsableForRegistration(req, {
      customerId: options.customer.id,
      templateId: input.realnameTemplateId,
    })
    assertQuoteAmountAndRuleUsableForOrder(quote, options)

    let availability: Awaited<ReturnType<WestDigitalReadProvider['queryAvailability']>>
    try {
      availability = await options.provider.queryAvailability({
        domain: quote.domainAscii,
        traceId: options.traceId,
      })
    } catch {
      throw new AppError(
        'ORDER_DOMAIN_REVALIDATION_UNAVAILABLE',
        '暂时无法确认域名是否仍可注册',
        503,
      )
    }
    if (!availability.ok) availabilityFailure(availability)
    assertDomainStillAvailable(quote, availability.data)

    const orderNumber = (options.orderNumber ?? (() => `WM-${randomUUID()}`))()
    const order = await req.payload.create({
      collection: 'orders',
      data: {
        amountMinor: quote.userPriceMinor,
        currency: 'CNY',
        customer: options.customer.id,
        domainAscii: quote.domainAscii,
        orderNumber,
        quote: quote.quoteId,
        quoteSnapshot: quoteSnapshot(quote, {
          observedAt: availability.observedAt,
          requestId: availability.requestId,
        }),
        realnameTemplate: input.realnameTemplateId,
        status: 'pending_payment',
      },
      overrideAccess: true,
      req,
    })
    await req.payload.create({
      collection: 'orderEvents',
      data: {
        actorId: String(options.customer.id),
        actorType: 'customer',
        customer: options.customer.id,
        evidence: {
          availabilityObservedAt: availability.observedAt,
          availabilityRequestId: availability.requestId,
          quoteIntegrityHash: quote.quoteIntegrityHash,
          quoteRef: quote.quoteRef,
          realnameTemplateId: input.realnameTemplateId,
        },
        order: order.id,
        reasonCode: 'order.created',
        toStatus: 'pending_payment',
      },
      overrideAccess: true,
      req,
    })

    if (startedTransaction) await commitTransaction(req)
    return orderCreationResultSchema.parse({
      data: {
        amountMinor: quote.userPriceMinor,
        currency: 'CNY',
        domainAscii: quote.domainAscii,
        orderNumber,
        quoteExpiresAt: quote.expiresAt,
        quoteRef: quote.quoteRef,
        status: 'pending_payment',
        years: quote.years,
      },
      meta: { observedAt: availability.observedAt, traceId: options.traceId },
      state: 'ready',
    })
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    throw error
  }
}
