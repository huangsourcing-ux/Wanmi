import { z } from 'zod'

import { PROBLEM_CODE_PATTERN } from '@/schemas/api'

export const FIRST_PARTY_EVENT_SCHEMA_VERSION = 1 as const

export const firstPartyPageTypeSchema = z.enum([
  'home',
  'tool_index',
  'tool',
  'pricing',
  'content_index',
  'help',
  'legal',
  'other',
])

export const firstPartySourceSchema = z.enum(['direct', 'internal', 'search', 'social', 'referral'])

export const firstPartyDeviceCategorySchema = z.enum(['mobile', 'tablet', 'desktop'])

export const FIRST_PARTY_TOOLS = [
  'domain-search',
  'whois',
  'dns',
  'ssl-check',
  'idn',
  'pricing',
] as const

export const firstPartyToolSchema = z.enum(FIRST_PARTY_TOOLS)

export const firstPartyInputTypeSchema = z.enum(['full_domain', 'keyword', 'unknown'])

export const firstPartyResultCategorySchema = z.enum(['ready', 'empty', 'partial', 'degraded'])

export const FIRST_PARTY_DURATION_BUCKETS = [
  'lt_100ms',
  '100_299ms',
  '300_999ms',
  '1000_2999ms',
  '3000_9999ms',
  'gte_10000ms',
] as const

export const firstPartyDurationBucketSchema = z.enum(FIRST_PARTY_DURATION_BUCKETS)

export const firstPartyDataSourceSchema = z.enum([
  'local',
  'cache',
  'westdigital',
  'whodat',
  'dns',
  'tls',
  'unknown',
])

export const analyticsTldSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(63)
  .regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/)

const version = z.literal(FIRST_PARTY_EVENT_SCHEMA_VERSION)

export const pageViewedEventSchema = z.strictObject({
  deviceCategory: firstPartyDeviceCategorySchema,
  event: z.literal('page_viewed'),
  pageType: firstPartyPageTypeSchema,
  schemaVersion: version,
  source: firstPartySourceSchema,
})

export const toolSubmittedEventSchema = z.strictObject({
  event: z.literal('tool_submitted'),
  fromLocalHistory: z.boolean(),
  inputType: firstPartyInputTypeSchema,
  schemaVersion: version,
  tld: analyticsTldSchema.optional(),
  tool: firstPartyToolSchema,
})

export const toolCompletedEventSchema = z.strictObject({
  dataSource: firstPartyDataSourceSchema,
  durationBucket: firstPartyDurationBucketSchema,
  event: z.literal('tool_completed'),
  resultCategory: firstPartyResultCategorySchema,
  schemaVersion: version,
  succeeded: z.boolean(),
  tld: analyticsTldSchema.optional(),
  tool: firstPartyToolSchema,
})

export const toolFailedEventSchema = z.strictObject({
  dataSource: firstPartyDataSourceSchema,
  durationBucket: firstPartyDurationBucketSchema,
  errorCode: z.string().regex(PROBLEM_CODE_PATTERN),
  event: z.literal('tool_failed'),
  schemaVersion: version,
  tld: analyticsTldSchema.optional(),
  tool: firstPartyToolSchema,
})

export const firstPartyEventSchema = z.discriminatedUnion('event', [
  pageViewedEventSchema,
  toolSubmittedEventSchema,
  toolCompletedEventSchema,
  toolFailedEventSchema,
])

export type FirstPartyEventInput = z.infer<typeof firstPartyEventSchema>
export type FirstPartyPageType = z.infer<typeof firstPartyPageTypeSchema>
export type FirstPartySource = z.infer<typeof firstPartySourceSchema>
export type FirstPartyDeviceCategory = z.infer<typeof firstPartyDeviceCategorySchema>
export type FirstPartyInputType = z.infer<typeof firstPartyInputTypeSchema>
export type FirstPartyDurationBucket = z.infer<typeof firstPartyDurationBucketSchema>
export type FirstPartyTool = z.infer<typeof firstPartyToolSchema>
