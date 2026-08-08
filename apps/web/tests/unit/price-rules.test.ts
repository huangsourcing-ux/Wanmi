import { describe, expect, it } from 'vitest'

import type { PriceRule } from '@/payload-types'
import {
  normalizePriceRuleTld,
  pricingRuleFromDocument,
  validatePriceRuleData,
} from '@/services/pricing/price-rules'

function document(overrides: Partial<PriceRule> = {}): PriceRule {
  return {
    createdAt: '2026-08-08T12:00:00.000Z',
    effectiveAt: '2026-08-08T12:00:00.000Z',
    enabled: true,
    fixedAmountMinor: 500,
    id: 17,
    mode: 'fixed',
    tld: 'com',
    updatedAt: '2026-08-08T12:00:00.000Z',
    ...overrides,
  }
}

describe('D5-05 price rule validation and mapping', () => {
  it('normalizes TLDs and maps a persisted revision to an immutable calculation rule key', () => {
    expect(normalizePriceRuleTld(' .COM.CN ')).toBe('com.cn')
    const first = pricingRuleFromDocument(document())
    const unchanged = pricingRuleFromDocument(document())
    const changed = pricingRuleFromDocument(
      document({ effectiveAt: '2026-08-08T12:01:00.000Z', fixedAmountMinor: 600 }),
    )
    expect(first).toMatchObject({
      fixedAmountFen: 500,
      mode: 'fixed',
      source: 'price_rule_collection',
      tld: 'com',
    })
    expect(unchanged.key).toBe(first.key)
    expect(changed.key).not.toBe(first.key)
  })

  it('accepts only non-negative integer values matching the selected mode', () => {
    expect(() =>
      validatePriceRuleData({
        enabled: true,
        fixedAmountMinor: 0,
        mode: 'fixed',
        tld: 'com',
      }),
    ).not.toThrow()
    expect(() =>
      validatePriceRuleData({
        enabled: true,
        mode: 'percentage',
        percentageBasisPoints: 1_000,
        tld: 'xyz',
      }),
    ).not.toThrow()
    for (const invalid of [
      { fixedAmountMinor: -1, mode: 'fixed', tld: 'com' },
      { fixedAmountMinor: 1.5, mode: 'fixed', tld: 'com' },
      { mode: 'percentage', percentageBasisPoints: 1.5, tld: 'xyz' },
      { mode: 'percentage', percentageBasisPoints: -1, tld: 'xyz' },
      { fixedAmountMinor: 500, mode: 'percentage', percentageBasisPoints: 100, tld: 'xyz' },
      { fixedAmountMinor: 500, mode: 'fixed', percentageBasisPoints: 100, tld: 'com' },
    ]) {
      expect(() => validatePriceRuleData(invalid as never)).toThrow()
    }
  })
})
