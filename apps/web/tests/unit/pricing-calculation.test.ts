import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { formatCnyFen } from '@/lib/money'
import { calculateTldPrice, type PricingRule } from '@/services/pricing/price-calculation'
import {
  createPriceCalculationHash,
  replayPriceSnapshot,
  type PriceSnapshotInput,
  type StoredPriceSnapshot,
} from '@/services/pricing/price-snapshots'

import { PRICING_RULE_FIXTURES } from '../fixtures/pricing'

const fixedRule = PRICING_RULE_FIXTURES.com as Extract<PricingRule, { mode: 'fixed' }>
const percentageRule = PRICING_RULE_FIXTURES.xyz as Extract<PricingRule, { mode: 'percentage' }>

function snapshotInput(): PriceSnapshotInput {
  return {
    calculation: calculateTldPrice({
      registrationPriceFen: 2_000,
      renewalPriceFen: 3_000,
      rule: fixedRule,
    }),
    providerCacheExpiresAt: '2026-08-06T13:00:00.000Z',
    providerCacheStatus: 'miss',
    providerObservedAt: '2026-08-06T12:00:00.000Z',
    providerProductId: 'fixture-domain-com',
    providerRequestId: 'fixture-request-com',
    representativeDomainAscii: 'wanmi.com',
    tld: 'com',
    traceId: 'trace-pricing-calculation',
  }
}

describe('D2-07 integer TLD price calculation', () => {
  it('applies fixed markup independently and calculates one- and three-year totals', () => {
    expect(
      calculateTldPrice({
        registrationPriceFen: 2_000,
        renewalPriceFen: 3_000,
        rule: fixedRule,
      }),
    ).toMatchObject({
      oneYearTotalFen: 2_500,
      registrationPriceFen: 2_500,
      renewalPriceFen: 3_500,
      threeYearTotalFen: 9_500,
      upstreamRegistrationPriceFen: 2_000,
      upstreamRenewalPriceFen: 3_000,
    })
  })

  it('uses BigInt basis-point arithmetic and rounds half up to the nearest fen', () => {
    expect(
      calculateTldPrice({ registrationPriceFen: 5, renewalPriceFen: 4, rule: percentageRule }),
    ).toMatchObject({
      registrationPriceFen: 6,
      renewalPriceFen: 4,
      threeYearTotalFen: 14,
    })
  })

  it('fails closed for fractional, negative and overflowing amounts', () => {
    expect(() =>
      calculateTldPrice({ registrationPriceFen: 1.2, renewalPriceFen: 100, rule: fixedRule }),
    ).toThrow(/整数分金额/u)
    expect(() =>
      calculateTldPrice({ registrationPriceFen: -1, renewalPriceFen: 100, rule: fixedRule }),
    ).toThrow(/整数分金额/u)
    expect(() =>
      calculateTldPrice({
        registrationPriceFen: Number.MAX_SAFE_INTEGER,
        renewalPriceFen: Number.MAX_SAFE_INTEGER,
        rule: { ...fixedRule, fixedAmountFen: 0 },
      }),
    ).toThrow(/安全金额范围/u)
  })

  it('formats integer fen without dividing by 100 or using floating amount math', () => {
    expect(formatCnyFen(0)).toBe('¥0.00')
    expect(formatCnyFen(2_505)).toBe('¥25.05')
    expect(formatCnyFen(Number.MAX_SAFE_INTEGER)).toMatch(/^¥[\d,]+\.91$/u)
    expect(() => formatCnyFen(2.5)).toThrow(/安全整数分/u)
  })

  it('replays every stored calculation exactly and keeps its hash stable across cache access', () => {
    const input = snapshotInput()
    const stored: StoredPriceSnapshot = {
      ...input,
      calculationHash: createPriceCalculationHash(input),
      createdAt: '2026-08-06T12:00:01.000Z',
      snapshotRef: randomUUID(),
    }
    expect(replayPriceSnapshot(stored)).toEqual(input.calculation)
    expect(
      createPriceCalculationHash({
        ...input,
        providerCacheExpiresAt: '2026-08-06T14:00:00.000Z',
        providerCacheStatus: 'hit',
        traceId: 'trace-pricing-cache-hit',
      }),
    ).toBe(stored.calculationHash)
    expect(
      createPriceCalculationHash({
        ...input,
        calculation: {
          ...input.calculation,
          rule: {
            tld: input.calculation.rule.tld,
            source: input.calculation.rule.source,
            mode: 'fixed',
            version: input.calculation.rule.version,
            key: input.calculation.rule.key,
            fixedAmountFen: fixedRule.fixedAmountFen,
          },
        },
      }),
    ).toBe(stored.calculationHash)
  })
})
