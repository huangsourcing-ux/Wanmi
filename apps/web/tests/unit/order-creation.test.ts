import { describe, expect, it } from 'vitest'

import { AppError } from '@/lib/errors'
import { assertQuoteAmountAndRuleUsableForOrder } from '@/services/commerce/order-creation'
import {
  calculateTldPrice,
  FIXTURE_PRICING_RULES,
  type PricingRule,
} from '@/services/pricing/price-calculation'
import type { StoredCustomerQuote } from '@/services/pricing/customer-quotes'

function quote(): StoredCustomerQuote {
  const rule = FIXTURE_PRICING_RULES.com!
  const calculation = calculateTldPrice({
    registrationPriceFen: 2_500,
    renewalPriceFen: 2_750,
    rule,
  })
  return {
    availabilityObservedAt: '2026-08-07T15:00:00.000Z',
    availabilityRequestId: 'availability-request',
    calculation,
    customerId: 101,
    domainAscii: 'example.com',
    expiresAt: '2026-08-07T15:05:00.000Z',
    providerCacheStatus: 'miss',
    providerObservedAt: '2026-08-07T15:00:00.000Z',
    providerProductId: 'domcom',
    providerRequestId: 'price-request',
    quoteId: 11,
    quoteIntegrityHash: '0'.repeat(64),
    quotedAt: '2026-08-07T15:00:00.000Z',
    quoteRef: '11111111-1111-4111-8111-111111111111',
    sourceCalculationHash: '1'.repeat(64),
    sourcePriceSnapshotRef: '22222222-2222-4222-8222-222222222222',
    tld: 'com',
    traceId: 'trace-order-creation',
    upstreamCostMinor: 8_000,
    userPriceMinor: 9_500,
    years: 3,
  }
}

describe('D5-02 order quote revalidation', () => {
  it('recomputes integer-fen totals and requires the current configured rule', () => {
    expect(() => assertQuoteAmountAndRuleUsableForOrder(quote())).not.toThrow()

    const missingRule = {} as Readonly<Record<string, PricingRule>>
    expect(() =>
      assertQuoteAmountAndRuleUsableForOrder(quote(), { rules: missingRule }),
    ).toThrowError(expect.objectContaining({ code: 'PRICE_RULE_UNCONFIGURED' }) as AppError)

    const currentRule = FIXTURE_PRICING_RULES.com!
    if (currentRule.mode !== 'fixed') throw new Error('Expected fixed fixture rule')
    const changedRule: PricingRule = {
      ...currentRule,
      fixedAmountFen: 600,
      key: 'changed-rule',
    }
    expect(() =>
      assertQuoteAmountAndRuleUsableForOrder(quote(), { rules: { com: changedRule } }),
    ).toThrowError(expect.objectContaining({ code: 'QUOTE_PRICE_CHANGED' }) as AppError)
  })

  it('rejects a quote whose order amount does not replay from its snapshot', () => {
    const mismatched = quote()
    mismatched.userPriceMinor += 1
    expect(() => assertQuoteAmountAndRuleUsableForOrder(mismatched)).toThrowError(
      expect.objectContaining({ code: 'QUOTE_AMOUNT_MISMATCH' }) as AppError,
    )
  })
})
