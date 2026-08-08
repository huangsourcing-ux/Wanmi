import { z } from 'zod'

import { createResultSchema } from '@/schemas/api'

const moneyMinorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const quoteCreateRequestSchema = z.strictObject({
  domain: z.string().trim().min(1).max(253),
  years: z.number().int().min(1).max(10),
})

export const publicQuoteSchema = z.strictObject({
  currency: z.literal('CNY'),
  domainAscii: z.string().min(1).max(253),
  expiresAt: z.iso.datetime(),
  priceClass: z.literal('standard'),
  providerObservedAt: z.iso.datetime(),
  quoteRef: z.string().uuid(),
  quotedAt: z.iso.datetime(),
  sourcePriceSnapshotRef: z.string().uuid(),
  userPriceMinor: moneyMinorSchema,
  years: z.number().int().min(1).max(10),
})

export const quoteBlockCodeSchema = z.enum([
  'DOMAIN_UNAVAILABLE',
  'PREMIUM_UNSUPPORTED',
  'PRICE_RULE_UNCONFIGURED',
  'TLD_UNSUPPORTED',
])

export const quoteCreationDataSchema = z
  .strictObject({
    blockCode: quoteBlockCodeSchema.optional(),
    quote: publicQuoteSchema.nullable(),
  })
  .superRefine((value, context) => {
    if ((value.quote === null) !== (value.blockCode !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: '无报价时必须提供阻止原因，有报价时不得提供阻止原因',
      })
    }
  })

export const quoteCreationResultSchema = createResultSchema(quoteCreationDataSchema)

export type PublicQuote = z.infer<typeof publicQuoteSchema>
export type QuoteCreateRequest = z.infer<typeof quoteCreateRequestSchema>
export type QuoteCreationResult = z.infer<typeof quoteCreationResultSchema>
