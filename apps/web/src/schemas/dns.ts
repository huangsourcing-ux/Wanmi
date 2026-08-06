import { z } from 'zod'

import { createResultSchema, resultCacheStatusSchema } from '@/schemas/api'

export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA'] as const

export const DNS_MAX_RECORDS_PER_TYPE = 32
export const DNS_MAX_TOTAL_RECORDS = 128

export const dnsRecordTypeSchema = z.enum(DNS_RECORD_TYPES)
export const dnsLookupRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(253),
})

const ownerAndTtlSchema = z.strictObject({
  ownerName: z.string().min(1).max(253),
  ttl: z.number().int().nonnegative().max(4_294_967_295),
})

const addressRecordSchema = ownerAndTtlSchema.extend({
  address: z.string().min(1).max(64),
})

export const dnsRecordSchema = z.discriminatedUnion('type', [
  addressRecordSchema.extend({ type: z.literal('A') }),
  addressRecordSchema.extend({ type: z.literal('AAAA') }),
  ownerAndTtlSchema.extend({
    target: z.string().min(1).max(253),
    type: z.literal('CNAME'),
  }),
  ownerAndTtlSchema.extend({
    exchange: z.string().min(1).max(253),
    priority: z.number().int().nonnegative().max(65_535),
    type: z.literal('MX'),
  }),
  ownerAndTtlSchema.extend({
    type: z.literal('TXT'),
    value: z.string().max(4_096),
  }),
  ownerAndTtlSchema.extend({
    host: z.string().min(1).max(253),
    type: z.literal('NS'),
  }),
  ownerAndTtlSchema.extend({
    expire: z.number().int().nonnegative().max(4_294_967_295),
    minimum: z.number().int().nonnegative().max(4_294_967_295),
    primaryNameServer: z.string().min(1).max(253),
    refresh: z.number().int().nonnegative().max(4_294_967_295),
    responsibleMailbox: z.string().min(1).max(253),
    retry: z.number().int().nonnegative().max(4_294_967_295),
    serial: z.number().int().nonnegative().max(4_294_967_295),
    type: z.literal('SOA'),
  }),
  ownerAndTtlSchema.extend({
    flags: z.number().int().nonnegative().max(255),
    tag: z.enum(['issue', 'issuewild', 'iodef']),
    type: z.literal('CAA'),
    value: z.string().max(4_096),
  }),
])

const domainRiskSchema = z.strictObject({
  code: z.literal('DOMAIN_MIXED_SCRIPT_RISK'),
  labelAscii: z.string().min(1),
  message: z.string().min(1),
  scripts: z.array(z.string().min(1)),
})

const recordSetBaseSchema = z.strictObject({
  cacheStatus: resultCacheStatusSchema,
  observedAt: z.iso.datetime(),
  records: z.array(dnsRecordSchema).max(DNS_MAX_RECORDS_PER_TYPE),
  resolverNode: z.enum(['alidns_primary', 'alidns_secondary']),
  type: dnsRecordTypeSchema,
})

const recordSetIssueSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1),
  retryable: z.boolean(),
})

export const dnsRecordSetSchema = z
  .discriminatedUnion('status', [
    recordSetBaseSchema.extend({
      records: z.array(dnsRecordSchema).min(1).max(DNS_MAX_RECORDS_PER_TYPE),
      status: z.literal('records'),
    }),
    recordSetBaseSchema.extend({
      records: z.array(dnsRecordSchema).length(0),
      status: z.literal('no_record'),
    }),
    recordSetBaseSchema.extend({
      records: z.array(dnsRecordSchema).length(0),
      status: z.literal('nxdomain'),
    }),
    recordSetBaseSchema.extend({
      issue: recordSetIssueSchema,
      records: z.array(dnsRecordSchema).length(0),
      status: z.literal('servfail'),
    }),
    recordSetBaseSchema.extend({
      issue: recordSetIssueSchema,
      records: z.array(dnsRecordSchema).length(0),
      status: z.literal('timeout'),
    }),
    recordSetBaseSchema.extend({
      issue: recordSetIssueSchema,
      records: z.array(dnsRecordSchema).length(0),
      status: z.literal('blocked'),
    }),
    recordSetBaseSchema.extend({
      issue: recordSetIssueSchema,
      records: z.array(dnsRecordSchema).length(0),
      status: z.literal('failed'),
    }),
    recordSetBaseSchema.extend({
      issue: recordSetIssueSchema,
      records: z.array(dnsRecordSchema).length(0),
      status: z.literal('rate_limited'),
    }),
  ])
  .superRefine((recordSet, context) => {
    for (const [index, record] of recordSet.records.entries()) {
      if (record.type !== recordSet.type) {
        context.addIssue({
          code: 'custom',
          message: 'record type must match its record set',
          path: ['records', index, 'type'],
        })
      }
    }
  })

export const dnsLookupDataSchema = z
  .strictObject({
    normalizedQueryAscii: z.string().min(1).max(253),
    normalizedQueryUnicode: z.string().min(1).max(253),
    recordSets: z.array(dnsRecordSetSchema).length(DNS_RECORD_TYPES.length),
    risks: z.array(domainRiskSchema),
  })
  .superRefine((data, context) => {
    const types = data.recordSets.map((recordSet) => recordSet.type)
    if (types.some((type, index) => type !== DNS_RECORD_TYPES[index])) {
      context.addIssue({
        code: 'custom',
        message: 'record sets must use the canonical order',
        path: ['recordSets'],
      })
    }
    const recordCount = data.recordSets.reduce((total, set) => total + set.records.length, 0)
    if (recordCount > DNS_MAX_TOTAL_RECORDS) {
      context.addIssue({
        code: 'custom',
        message: 'DNS result exceeds total record limit',
        path: ['recordSets'],
      })
    }
  })

export const dnsLookupResultSchema = createResultSchema(dnsLookupDataSchema)

export type DnsRecordType = z.infer<typeof dnsRecordTypeSchema>
export type DnsRecord = z.infer<typeof dnsRecordSchema>
export type DnsRecordSet = z.infer<typeof dnsRecordSetSchema>
export type DnsLookupRequest = z.infer<typeof dnsLookupRequestSchema>
export type DnsLookupData = z.infer<typeof dnsLookupDataSchema>
export type DnsLookupResult = z.infer<typeof dnsLookupResultSchema>
