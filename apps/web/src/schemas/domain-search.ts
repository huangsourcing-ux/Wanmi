import { z } from 'zod'

import { createResultSchema, problemDetailsSchema } from '@/schemas/api'

export const DOMAIN_SEARCH_MAX_TLDS = 10

export const domainSearchStatusSchema = z.enum([
  'available',
  'premium',
  'registered',
  'restricted',
  'unsupported',
  'query_failed',
])

export const domainSearchRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(253),
  tlds: z.array(z.string().trim().min(1).max(253)).min(1).max(DOMAIN_SEARCH_MAX_TLDS).optional(),
})

const domainRiskSchema = z.strictObject({
  code: z.literal('DOMAIN_MIXED_SCRIPT_RISK'),
  labelAscii: z.string().min(1),
  message: z.string().min(1),
  scripts: z.array(z.string().min(1)),
})

const itemCacheSchema = z.strictObject({
  expiresAt: z.iso.datetime().optional(),
  status: z.enum(['hit', 'miss', 'not_used']),
})

const itemBaseSchema = z.strictObject({
  cache: itemCacheSchema,
  dataSource: z.string().min(1),
  domainAscii: z.string().min(1).max(253),
  domainUnicode: z.string().min(1),
  observedAt: z.iso.datetime(),
  tld: z.string().min(1).max(253),
})

export const domainSearchItemSchema = z.discriminatedUnion('status', [
  itemBaseSchema.extend({ status: z.literal('available') }),
  itemBaseSchema.extend({
    currency: z.literal('CNY'),
    premiumRegistrationPriceFen: z.number().int().nonnegative(),
    status: z.literal('premium'),
  }),
  itemBaseSchema.extend({ status: z.literal('registered') }),
  itemBaseSchema.extend({ status: z.literal('restricted') }),
  itemBaseSchema.extend({ status: z.literal('unsupported') }),
  itemBaseSchema.extend({
    problem: problemDetailsSchema,
    status: z.literal('query_failed'),
  }),
])

export const domainSearchDataSchema = z.strictObject({
  items: z.array(domainSearchItemSchema).max(DOMAIN_SEARCH_MAX_TLDS),
  mode: z.enum(['full_domain', 'keyword']),
  normalizedQueryAscii: z.string().min(1).max(253),
  normalizedQueryUnicode: z.string().min(1),
  risks: z.array(domainRiskSchema),
  tlds: z.array(z.string().min(1).max(253)).max(DOMAIN_SEARCH_MAX_TLDS),
})

export const domainSearchResultSchema = createResultSchema(domainSearchDataSchema)

export type DomainSearchRequest = z.infer<typeof domainSearchRequestSchema>
export type DomainSearchItem = z.infer<typeof domainSearchItemSchema>
export type DomainSearchData = z.infer<typeof domainSearchDataSchema>
export type DomainSearchResult = z.infer<typeof domainSearchResultSchema>
