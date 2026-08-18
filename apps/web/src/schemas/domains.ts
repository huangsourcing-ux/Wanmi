import { z } from 'zod'

import { createResultSchema } from '@/schemas/api'

export const domainAssetStatusSchema = z.enum(['active', 'expired', 'pending', 'unknown'])

export const domainAssetViewSchema = z.strictObject({
  domainAscii: z.string().min(1).max(253),
  expiresAt: z.iso.datetime(),
  id: z.string().min(1),
  lastSyncedAt: z.iso.datetime(),
  nameservers: z.array(z.string().min(1).max(253)).min(2).max(15),
  registeredAt: z.iso.datetime(),
  registrar: z.string().min(1).max(100),
  status: domainAssetStatusSchema,
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
    total: z.number().int().nonnegative(),
  }),
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
export type DomainAssetView = z.infer<typeof domainAssetViewSchema>
export type NameserverChangeRequest = z.infer<typeof nameserverChangeRequestSchema>
export type NameserverChangeView = z.infer<typeof nameserverChangeViewSchema>
export type NameserverBatchPreviewRequest = z.infer<typeof nameserverBatchPreviewRequestSchema>
export type NameserverBatchRequest = z.infer<typeof nameserverBatchRequestSchema>
