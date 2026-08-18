import { z } from 'zod'

import { createResultSchema } from '@/schemas/api'

export const domainAssetStatusSchema = z.enum(['active', 'expired', 'pending', 'unknown'])
export const domainLockStatusSchema = z.enum(['locked', 'unlocked', 'unknown'])
export const domainExpiryReminderChannelSchema = z.enum(['in_app', 'sms'])
export const renewalMandateScopeSchema = z.literal('renew_one_year')

const domainTagSchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)

const domainTagsSchema = z
  .array(domainTagSchema)
  .max(20)
  .superRefine((tags, context) => {
    if (new Set(tags).size !== tags.length) {
      context.addIssue({ code: 'custom', message: '域名标签不可重复' })
    }
  })

const reminderChannelsSchema = z
  .array(domainExpiryReminderChannelSchema)
  .min(1)
  .max(2)
  .superRefine((channels, context) => {
    if (new Set(channels).size !== channels.length) {
      context.addIssue({ code: 'custom', message: '提醒渠道不可重复' })
    }
  })

const reminderDaysSchema = z
  .array(z.number().int().min(0).max(365))
  .min(1)
  .max(12)
  .superRefine((days, context) => {
    if (new Set(days).size !== days.length) {
      context.addIssue({ code: 'custom', message: '提醒提前天数不可重复' })
    }
  })

export const domainAssetViewSchema = z.strictObject({
  domainAscii: z.string().min(1).max(253),
  domainLockStatus: domainLockStatusSchema,
  domainLockUpdatedAt: z.iso.datetime().optional(),
  expiresAt: z.iso.datetime(),
  expiryReminderChannels: reminderChannelsSchema,
  expiryReminderDays: reminderDaysSchema,
  id: z.string().min(1),
  lastSyncedAt: z.iso.datetime(),
  nameservers: z.array(z.string().min(1).max(253)).min(2).max(15),
  registeredAt: z.iso.datetime(),
  registrar: z.string().min(1).max(100),
  status: domainAssetStatusSchema,
  tags: domainTagsSchema,
})

export const domainExpiryReminderViewSchema = z.strictObject({
  channel: z.enum(['in_app', 'sms']),
  deliveredAt: z.iso.datetime().optional(),
  expiresAtSnapshot: z.iso.datetime(),
  id: z.string().min(1),
  status: z.enum(['pending', 'sending', 'delivered', 'failed', 'unknown']),
  thresholdDays: z.number().int().min(0).max(365),
})

export const nameserverChangeViewSchema = z.strictObject({
  completedAt: z.iso.datetime().optional(),
  confirmedNameservers: z.array(z.string().min(1).max(253)).max(15).optional(),
  id: z.string().min(1),
  previousNameservers: z.array(z.string().min(1).max(253)).min(2).max(15),
  requestedAt: z.iso.datetime(),
  requestedNameservers: z.array(z.string().min(1).max(253)).min(2).max(15),
  status: z.enum(['pending', 'succeeded', 'failed', 'manual_review']),
})

export const domainAssetListResultSchema = createResultSchema(
  z.strictObject({
    items: z.array(domainAssetViewSchema),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive().max(100),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
)

export const domainAssetListQuerySchema = z.strictObject({
  expiresWithinDays: z.coerce.number().int().min(0).max(3_650).optional(),
  lockStatus: domainLockStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  query: z.string().trim().max(253).optional(),
  sort: z.enum(['expiresAt', '-expiresAt', 'domainAscii', '-domainAscii']).default('expiresAt'),
  status: domainAssetStatusSchema.optional(),
  tag: domainTagSchema.optional(),
})

export const domainAssetTagsRequestSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  tags: domainTagsSchema,
})

export const domainExpiryReminderPreferencesRequestSchema = z.strictObject({
  assetIds: z
    .array(z.coerce.number().int().positive())
    .min(1)
    .max(200)
    .superRefine((assetIds, context) => {
      if (new Set(assetIds).size !== assetIds.length) {
        context.addIssue({ code: 'custom', message: '域名资产不可重复' })
      }
    }),
  batchKey: z.uuid(),
  channels: reminderChannelsSchema,
  thresholdDays: reminderDaysSchema,
})

export const domainAssetPreferenceResultSchema = createResultSchema(
  z.strictObject({
    assetIds: z.array(z.string().min(1)).min(1).max(200),
    updated: z.number().int().positive().max(200),
  }),
)

export const domainLockRequestSchema = z.discriminatedUnion('locked', [
  z.strictObject({
    idempotencyKey: z.uuid(),
    locked: z.literal(true),
  }),
  z.strictObject({
    deviceId: z.string().min(16).max(128),
    idempotencyKey: z.uuid(),
    locked: z.literal(false),
    stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  }),
])

export const domainLockResultSchema = createResultSchema(
  z.strictObject({
    idempotentReplay: z.boolean(),
    locked: z.boolean(),
    operationId: z.string().min(1),
    operationKey: z.string().min(1),
    status: z.enum(['failed', 'succeeded', 'unknown']),
  }),
)

const renewalMandateStepUpSchema = z.strictObject({
  confirmed: z.literal(true),
  deviceId: z.string().min(16).max(128),
  previewToken: z.string().min(80).max(4_096),
  stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
})

export const renewalMandatePreviewRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('authorize'),
    maxDebitFen: z.number().int().positive(),
    scope: renewalMandateScopeSchema,
    validUntil: z.iso.datetime(),
  }),
  z.strictObject({ action: z.literal('revoke') }),
])
export type RenewalMandatePreviewRequest = z.infer<typeof renewalMandatePreviewRequestSchema>

export const renewalMandateChangeRequestSchema = renewalMandateStepUpSchema

export const renewalMandateViewSchema = z.strictObject({
  authorizedAt: z.iso.datetime(),
  currency: z.literal('CNY'),
  domainAscii: z.string().min(1).max(253),
  eventType: z.enum(['authorized', 'revoked']),
  id: z.string().min(1),
  maxDebitFen: z.number().int().positive().safe(),
  revision: z.number().int().positive(),
  revokedAt: z.iso.datetime().optional(),
  rulesVersion: z.string().min(1).max(64),
  scope: renewalMandateScopeSchema,
  validUntil: z.iso.datetime(),
})

export const renewalMandatePreviewResultSchema = createResultSchema(
  z.strictObject({
    action: z.enum(['authorize', 'revoke']),
    domainAscii: z.string().min(1).max(253),
    firstAttemptDays: z.number().int().positive().max(365),
    maxDebitFen: z.number().int().positive().safe().optional(),
    previewExpiresAt: z.iso.datetime(),
    previewToken: z.string().min(80),
    reminderLimit: z.number().int().min(1).max(5),
    retryDays: z.array(z.number().int().min(0).max(365)).max(10),
    rulesVersion: z.string().min(1).max(64),
    scope: renewalMandateScopeSchema.optional(),
    validUntil: z.iso.datetime().optional(),
    warning: z.string().min(1).max(500),
  }),
)

export const renewalMandateResultSchema = createResultSchema(
  z.strictObject({ mandate: renewalMandateViewSchema.nullable() }),
)

export const domainAssetDetailResultSchema = createResultSchema(
  z.strictObject({
    asset: domainAssetViewSchema,
    nameserverChanges: z.array(nameserverChangeViewSchema),
    reminders: z.array(domainExpiryReminderViewSchema),
  }),
)

export const nameserverChangeRequestSchema = z.strictObject({
  confirmed: z.literal(true),
  deviceId: z.string().min(16).max(128),
  nameservers: z.array(z.string().trim().min(1).max(253)).min(2).max(15),
  stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
})

export const nameserverChangeResultSchema = createResultSchema(nameserverChangeViewSchema)

const nameserverBatchAssetIdsSchema = z.array(z.number().int().positive()).min(2).max(20)
const nameserverBatchNameserversSchema = z.array(z.string().trim().min(1).max(253)).min(2).max(15)

export const nameserverBatchPreviewRequestSchema = z.strictObject({
  assetIds: nameserverBatchAssetIdsSchema,
  batchKey: z.uuid(),
  nameservers: nameserverBatchNameserversSchema,
})

export const nameserverBatchRequestSchema = z.strictObject({
  assetIds: nameserverBatchAssetIdsSchema,
  batchKey: z.uuid(),
  confirmed: z.boolean().optional(),
  deviceId: z.string().min(16).max(128).optional(),
  nameservers: nameserverBatchNameserversSchema,
  previewToken: z.string().min(80).max(8_192),
  stepUpToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/u)
    .optional(),
})

export const nameserverBatchPreviewItemSchema = z.strictObject({
  assetId: z.string().min(1),
  currentNameservers: z.array(z.string().min(1).max(253)).min(2).max(15),
  domainAscii: z.string().min(1).max(253),
  requestedNameservers: z.array(z.string().min(1).max(253)).min(2).max(15),
})

export const nameserverBatchItemSchema = z.strictObject({
  assetId: z.string().min(1),
  changeId: z.string().min(1).optional(),
  domainAscii: z.string().min(1).max(253),
  itemKey: z.string().min(1),
  reasonCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/u)
    .optional(),
  status: z.enum(['failed', 'pending_query', 'succeeded']),
})

export const nameserverBatchPreviewResultSchema = createResultSchema(
  z.strictObject({
    batchKey: z.uuid(),
    expiresAt: z.iso.datetime(),
    items: z.array(nameserverBatchPreviewItemSchema).min(2).max(20),
    previewToken: z.string().min(80).max(8_192),
  }),
)

export const nameserverBatchResultSchema = createResultSchema(
  z.strictObject({
    batchKey: z.uuid(),
    items: z.array(nameserverBatchItemSchema).min(1).max(20),
  }),
)

export type DomainAssetDetailResult = z.infer<typeof domainAssetDetailResultSchema>
export type DomainAssetListResult = z.infer<typeof domainAssetListResultSchema>
export type DomainAssetListQuery = z.infer<typeof domainAssetListQuerySchema>
export type DomainAssetPreferenceResult = z.infer<typeof domainAssetPreferenceResultSchema>
export type DomainAssetTagsRequest = z.infer<typeof domainAssetTagsRequestSchema>
export type DomainAssetView = z.infer<typeof domainAssetViewSchema>
export type DomainExpiryReminderPreferencesRequest = z.infer<
  typeof domainExpiryReminderPreferencesRequestSchema
>
export type DomainLockRequest = z.infer<typeof domainLockRequestSchema>
export type DomainLockResult = z.infer<typeof domainLockResultSchema>
export type NameserverChangeRequest = z.infer<typeof nameserverChangeRequestSchema>
export type NameserverChangeView = z.infer<typeof nameserverChangeViewSchema>
export type NameserverBatchPreviewRequest = z.infer<typeof nameserverBatchPreviewRequestSchema>
export type NameserverBatchRequest = z.infer<typeof nameserverBatchRequestSchema>
