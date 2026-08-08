import { AppError } from '@/lib/errors'
import { PRICING_CALCULATION_FORMULA } from '@/schemas/pricing'

export const PRICE_CALCULATION_VERSION = 1 as const
export const PRICE_SNAPSHOT_SCHEMA_VERSION = 1 as const

type RuleBase = {
  key: string
  source: 'wanmi_fixture'
  tld: string
  version: 1
}

export type PricingRule =
  | (RuleBase & { fixedAmountFen: number; mode: 'fixed' })
  | (RuleBase & { mode: 'percentage'; percentageBasisPoints: number })

export type PriceCalculation = {
  calculationFormula: typeof PRICING_CALCULATION_FORMULA
  calculationVersion: typeof PRICE_CALCULATION_VERSION
  currency: 'CNY'
  oneYearTotalFen: number
  registrationPriceFen: number
  renewalPriceFen: number
  rule: PricingRule
  threeYearTotalFen: number
  upstreamRegistrationPriceFen: number
  upstreamRenewalPriceFen: number
}

const fixedRuleTlds = ['com', 'cn', 'net', 'org', 'top'] as const
const percentageRuleTlds = ['xyz', 'vip', 'cc', 'com.cn'] as const

export const FIXTURE_PRICING_RULES: Readonly<Record<string, PricingRule>> = Object.freeze({
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

function safeMoney(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('PRICE_CALCULATION_INVALID', `${label}不是有效的整数分金额`, 503, {
      action: '请稍后重试',
      retryable: true,
      title: '价格计算失败',
    })
  }
  return value
}

function toSafeMoney(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('PRICE_CALCULATION_OVERFLOW', `${label}超出安全金额范围`, 503, {
      action: '请稍后重试',
      retryable: false,
      title: '价格超出可处理范围',
    })
  }
  return Number(value)
}

export function calculateRegistrationTotalFen(input: {
  registrationPriceFen: number
  renewalPriceFen: number
  years: number
}): number {
  if (!Number.isSafeInteger(input.years) || input.years < 1 || input.years > 10) {
    throw new AppError('PRICE_YEARS_INVALID', '注册年限必须是 1 到 10 的整数', 400, {
      action: '请选择 1 到 10 年的注册年限',
      retryable: false,
      title: '注册年限无效',
    })
  }
  const registration = BigInt(safeMoney(input.registrationPriceFen, '注册价'))
  const renewal = BigInt(safeMoney(input.renewalPriceFen, '续费价'))
  return toSafeMoney(registration + renewal * BigInt(input.years - 1), `${input.years} 年总成本`)
}

function markupFor(upstreamFen: number, rule: PricingRule): bigint {
  const upstream = BigInt(safeMoney(upstreamFen, '上游价格'))
  if (rule.mode === 'fixed') {
    return BigInt(safeMoney(rule.fixedAmountFen, '固定加价'))
  }
  if (!Number.isSafeInteger(rule.percentageBasisPoints) || rule.percentageBasisPoints < 0) {
    throw new AppError('PRICE_RULE_INVALID', '比例加价规则不是有效的非负整数基点', 503)
  }
  const numerator = upstream * BigInt(rule.percentageBasisPoints)
  return (numerator + 5_000n) / 10_000n
}

export function calculateTldPrice(input: {
  registrationPriceFen: number
  renewalPriceFen: number
  rule: PricingRule
}): PriceCalculation {
  const upstreamRegistration = BigInt(safeMoney(input.registrationPriceFen, '上游注册价'))
  const upstreamRenewal = BigInt(safeMoney(input.renewalPriceFen, '上游续费价'))
  const registration = upstreamRegistration + markupFor(input.registrationPriceFen, input.rule)
  const renewal = upstreamRenewal + markupFor(input.renewalPriceFen, input.rule)
  const registrationPriceFen = toSafeMoney(registration, '注册终价')
  const renewalPriceFen = toSafeMoney(renewal, '续费终价')

  return {
    calculationFormula: PRICING_CALCULATION_FORMULA,
    calculationVersion: PRICE_CALCULATION_VERSION,
    currency: 'CNY',
    oneYearTotalFen: calculateRegistrationTotalFen({
      registrationPriceFen,
      renewalPriceFen,
      years: 1,
    }),
    registrationPriceFen,
    renewalPriceFen,
    rule: input.rule,
    threeYearTotalFen: calculateRegistrationTotalFen({
      registrationPriceFen,
      renewalPriceFen,
      years: 3,
    }),
    upstreamRegistrationPriceFen: Number(upstreamRegistration),
    upstreamRenewalPriceFen: Number(upstreamRenewal),
  }
}
