import { z } from 'zod'

import { createResultSchema } from '@/schemas/api'

export const whoisLookupRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(253),
})

const domainRiskSchema = z.strictObject({
  code: z.literal('DOMAIN_MIXED_SCRIPT_RISK'),
  labelAscii: z.string().min(1),
  message: z.string().min(1),
  scripts: z.array(z.string().min(1)),
})

const sourceSchema = z.strictObject({
  protocol: z.enum(['rdap', 'whois']),
  provider: z.enum(['whodat', 'westdigital']),
})

export const whoisLookupDataSchema = z.strictObject({
  dates: z.strictObject({
    created: z.string().min(1).max(64).nullable(),
    expires: z.string().min(1).max(64).nullable(),
    updated: z.string().min(1).max(64).nullable(),
  }),
  domainAscii: z.string().min(1).max(253),
  domainUnicode: z.string().min(1).max(253),
  nameServers: z.array(z.string().min(1).max(253)).max(64),
  normalizedQueryAscii: z.string().min(1).max(253),
  normalizedQueryUnicode: z.string().min(1).max(253),
  recordStatus: z.enum(['record_found', 'no_public_record']),
  registrar: z.string().min(1).max(512).nullable(),
  risks: z.array(domainRiskSchema),
  source: sourceSchema,
  statuses: z.array(z.string().min(1).max(128)).max(64),
})

export const whoisLookupResultSchema = createResultSchema(whoisLookupDataSchema)

export type WhoisLookupRequest = z.infer<typeof whoisLookupRequestSchema>
export type WhoisLookupData = z.infer<typeof whoisLookupDataSchema>
export type WhoisLookupResult = z.infer<typeof whoisLookupResultSchema>
