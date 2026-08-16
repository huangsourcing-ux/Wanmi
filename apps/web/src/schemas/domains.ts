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

export type DomainAssetDetailResult = z.infer<typeof domainAssetDetailResultSchema>
export type DomainAssetListResult = z.infer<typeof domainAssetListResultSchema>
export type DomainAssetView = z.infer<typeof domainAssetViewSchema>
export type NameserverChangeRequest = z.infer<typeof nameserverChangeRequestSchema>
export type NameserverChangeView = z.infer<typeof nameserverChangeViewSchema>
