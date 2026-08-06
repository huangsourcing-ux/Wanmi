import { z } from 'zod'

import { createResultSchema, problemDetailsSchema } from '@/schemas/api'

export const PRICING_MAX_TLDS = 10
export const PRICING_CALCULATION_FORMULA = 'registration_price_plus_annual_renewal_price' as const

export const pricingRequestSchema = z.strictObject({
  tlds: z.array(z.string().trim().min(1).max(253)).min(1).max(PRICING_MAX_TLDS).optional(),
})

const moneyFenSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const pricingCacheSchema = z.strictObject({
  expiresAt: z.iso.datetime().optional(),
  status: z.enum(['hit', 'miss', 'not_used']),
})

const pricingItemBaseSchema = z.strictObject({
  cache: pricingCacheSchema,
  dataSource: z.string().min(1),
  observedAt: z.iso.datetime(),
  purchaseEligible: z.literal(false),
  tld: z.string().min(1).max(253),
})

const publicPriceFields = {
  calculationFormula: z.literal(PRICING_CALCULATION_FORMULA),
  currency: z.literal('CNY'),
  markupConfigured: z.literal(true),
  minimumRegistrationYears: z.literal(1),
  oneYearTotalFen: moneyFenSchema,
  priceClass: z.literal('standard'),
  registrationPriceFen: moneyFenSchema,
  renewalPriceFen: moneyFenSchema,
  snapshotRef: z.string().uuid(),
  threeYearTotalFen: moneyFenSchema,
} as const

export const pricingItemSchema = z.discriminatedUnion('status', [
  pricingItemBaseSchema.extend({
    ...publicPriceFields,
    purchaseBlockCode: z.literal('PURCHASE_NOT_IMPLEMENTED'),
    status: z.literal('priced'),
  }),
  pricingItemBaseSchema.extend({
    ...publicPriceFields,
    lastSuccessfulAt: z.iso.datetime(),
    purchaseBlockCode: z.literal('PRICE_STALE'),
    status: z.literal('stale'),
  }),
  pricingItemBaseSchema.extend({
    markupConfigured: z.literal(false),
    purchaseBlockCode: z.literal('PRICE_RULE_UNCONFIGURED'),
    status: z.literal('unconfigured'),
  }),
  pricingItemBaseSchema.extend({
    purchaseBlockCode: z.literal('TLD_UNSUPPORTED'),
    status: z.literal('unsupported'),
  }),
  pricingItemBaseSchema.extend({
    problem: problemDetailsSchema,
    purchaseBlockCode: z.literal('PRICE_QUERY_FAILED'),
    status: z.literal('query_failed'),
  }),
])

export const pricingDataSchema = z.strictObject({
  items: z.array(pricingItemSchema).max(PRICING_MAX_TLDS),
  priceClass: z.literal('standard'),
  tlds: z.array(z.string().min(1).max(253)).max(PRICING_MAX_TLDS),
})

export const pricingResultSchema = createResultSchema(pricingDataSchema)

export type PricingRequest = z.infer<typeof pricingRequestSchema>
export type PricingItem = z.infer<typeof pricingItemSchema>
export type PricingData = z.infer<typeof pricingDataSchema>
export type PricingResult = z.infer<typeof pricingResultSchema>
