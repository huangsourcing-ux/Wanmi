import type { PricingRule } from '@/services/pricing/price-calculation'

const fixedRuleTlds = ['com', 'cn', 'net', 'org', 'top'] as const
const percentageRuleTlds = ['xyz', 'vip', 'cc', 'com.cn'] as const

export const PRICING_RULE_FIXTURES: Readonly<Record<string, PricingRule>> = Object.freeze({
  ...Object.fromEntries(
    fixedRuleTlds.map((tld) => [
      tld,
      {
        fixedAmountFen: 500,
        key: `fixture-${tld.replaceAll('.', '-')}-fixed-v1`,
        mode: 'fixed' as const,
        source: 'wanmi_fixture' as const,
        tld,
        version: 1 as const,
      },
    ]),
  ),
  ...Object.fromEntries(
    percentageRuleTlds.map((tld) => [
      tld,
      {
        key: `fixture-${tld.replaceAll('.', '-')}-percentage-v1`,
        mode: 'percentage' as const,
        percentageBasisPoints: 1_000,
        source: 'wanmi_fixture' as const,
        tld,
        version: 1 as const,
      },
    ]),
  ),
})
