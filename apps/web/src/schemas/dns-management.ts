import { z } from 'zod'

import { createResultSchema } from '@/schemas/api'

export const managedDnsRecordTypeSchema = z.enum(['A', 'CNAME', 'MX', 'TXT', 'AAAA', 'SRV'])

export const westDigitalDnsLineCodeSchema = z.enum([
  '',
  'LTEL',
  'LCNC',
  'LMOB',
  'LEDU',
  'LSEO',
  'LFOR',
])

export const westDigitalDnsLineLabelSchema = z.enum([
  '默认',
  '电信',
  '联通',
  '移动',
  '教育',
  '教育网',
  'SEO',
  '搜索引擎',
  '境外',
])

export const managedDnsRecordSchema = z.strictObject({
  host: z.string().max(253),
  id: z.string().regex(/^\d+$/u),
  lineCode: westDigitalDnsLineCodeSchema,
  lineLabel: z.enum(['默认', '电信', '联通', '移动', '教育网', '搜索引擎', '境外']),
  paused: z.boolean(),
  priority: z.number().int().min(1).max(100),
  ttl: z.number().int().min(60).max(86_400),
  type: managedDnsRecordTypeSchema,
  value: z.string().max(2_048),
})

const conditionalStepUpFields = {
  confirmed: z.boolean().optional(),
  deviceId: z.string().min(16).max(128).optional(),
  stepUpToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .optional(),
}

const idempotencyKeyField = {
  idempotencyKey: z.uuid(),
}

const dnsRecordInputFields = {
  host: z
    .string()
    .trim()
    .max(253)
    .transform((value) => value || '@'),
  line: westDigitalDnsLineLabelSchema.default('默认'),
  priority: z.number().int().min(1).max(100).default(10),
  ttl: z.number().int().min(60).max(86_400).default(900),
  type: managedDnsRecordTypeSchema,
  value: z.string().trim().min(1).max(2_048),
}

export const dnsRecordAddRequestSchema = z.strictObject({
  ...idempotencyKeyField,
  ...conditionalStepUpFields,
  ...dnsRecordInputFields,
})

export const dnsRecordModifyRequestSchema = z.strictObject({
  ...idempotencyKeyField,
  ...conditionalStepUpFields,
  priority: z.number().int().min(1).max(100),
  ttl: z.number().int().min(60).max(86_400),
  value: z.string().trim().min(1).max(2_048),
})

export const dnsRecordDeleteRequestSchema = z.strictObject({
  ...idempotencyKeyField,
  ...conditionalStepUpFields,
})

export const dnsRecordStatusRequestSchema = z.strictObject({
  ...idempotencyKeyField,
  ...conditionalStepUpFields,
  paused: z.boolean(),
})

const providerRecordIdSchema = z.string().regex(/^\d+$/u)

export const dnsRecordBatchPreviewRequestSchema = z.strictObject({
  recordIds: z.array(providerRecordIdSchema).min(2).max(20),
})

export const dnsRecordBatchDeleteRequestSchema = z.strictObject({
  deviceId: z.string().min(16).max(128).optional(),
  previewToken: z.string().min(80).max(4_096),
  recordIds: z.array(providerRecordIdSchema).min(2).max(20),
  stepUpToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .optional(),
})

export const dnsRecordListResultSchema = createResultSchema(
  z.strictObject({
    items: z.array(managedDnsRecordSchema),
    page: z.number().int().positive(),
    pageCount: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
)

export const dnsRecordDetailResultSchema = createResultSchema(managedDnsRecordSchema)

export const dnsRecordMutationViewSchema = z.strictObject({
  changeEventId: z.string().min(1),
  idempotentReplay: z.boolean(),
  operationId: z.string().min(1),
  operationKey: z.string().min(1),
  providerRecordId: providerRecordIdSchema.optional(),
  providerTaskKey: z.string().min(1).max(128).optional(),
  reasonCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/u)
    .optional(),
  reasonMessage: z.string().min(1).max(1_024).optional(),
  status: z.enum(['failed', 'pending_query', 'succeeded']),
})

export const dnsRecordMutationResultSchema = createResultSchema(dnsRecordMutationViewSchema)

export const dnsRecordBatchPreviewResultSchema = createResultSchema(
  z.strictObject({
    expiresAt: z.iso.datetime(),
    items: z.array(managedDnsRecordSchema).min(2).max(20),
    previewToken: z.string().min(80).max(4_096),
  }),
)

export const dnsRecordBatchDeleteResultSchema = createResultSchema(
  z.strictObject({
    batchKey: z.string().regex(/^[a-f0-9]{64}$/u),
    items: z.array(dnsRecordMutationViewSchema).min(1).max(20),
  }),
)

export type DnsRecordAddRequest = z.infer<typeof dnsRecordAddRequestSchema>
export type DnsRecordBatchDeleteRequest = z.infer<typeof dnsRecordBatchDeleteRequestSchema>
export type DnsRecordBatchPreviewRequest = z.infer<typeof dnsRecordBatchPreviewRequestSchema>
export type DnsRecordDeleteRequest = z.infer<typeof dnsRecordDeleteRequestSchema>
export type DnsRecordModifyRequest = z.infer<typeof dnsRecordModifyRequestSchema>
export type DnsRecordMutationView = z.infer<typeof dnsRecordMutationViewSchema>
export type DnsRecordStatusRequest = z.infer<typeof dnsRecordStatusRequestSchema>
export type ManagedDnsRecord = z.infer<typeof managedDnsRecordSchema>
export type ManagedDnsRecordType = z.infer<typeof managedDnsRecordTypeSchema>
export type WestDigitalDnsLineCode = z.infer<typeof westDigitalDnsLineCodeSchema>
export type WestDigitalDnsLineLabel = z.infer<typeof westDigitalDnsLineLabelSchema>
