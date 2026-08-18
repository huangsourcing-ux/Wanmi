import { z } from 'zod'

import { createResultSchema } from '@/schemas/api'

const stepUpFields = {
  confirmed: z.literal(true),
  deviceId: z.string().min(16).max(128),
  stepUpToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
} as const

export const domainManagementPasswordRevealRequestSchema = z.strictObject({
  deviceId: stepUpFields.deviceId,
  stepUpToken: stepUpFields.stepUpToken,
})

export const domainManagementPasswordModifyRequestSchema = z.strictObject({
  deviceId: stepUpFields.deviceId,
  idempotencyKey: z.uuid(),
  managementPassword: z.string().min(8).max(128),
  stepUpToken: stepUpFields.stepUpToken,
})

export const domainContactUpdateRequestSchema = z.strictObject({
  ...stepUpFields,
  contactType: z.enum(['dom_id', 'admin_id', 'tech_id', 'bill_id']),
  idempotencyKey: z.uuid(),
  templateId: z.coerce.number().int().positive(),
})

export const domainTemplateTransferRequestSchema = z.strictObject({
  ...stepUpFields,
  idempotencyKey: z.uuid(),
  templateId: z.coerce.number().int().positive(),
})

export const domainManagementPasswordResultSchema = createResultSchema(
  z.strictObject({ managementPassword: z.string().min(1).max(128) }),
)

export const domainManagementMutationResultSchema = createResultSchema(
  z.strictObject({
    idempotentReplay: z.boolean(),
    operationId: z.string().min(1),
    operationKey: z.string().min(1),
    status: z.enum(['failed', 'succeeded', 'unknown']),
  }),
)

export const domainCapabilityItemSchema = z.strictObject({
  name: z.enum([
    'asset_sync',
    'certificate_download',
    'contact_information_update',
    'domain_lock_status',
    'management_password_read',
    'management_password_write',
    'realtime_transfer',
    'template_transfer',
  ]),
  supported: z.boolean(),
  unsupportedCode: z
    .string()
    .regex(/^DOMAIN_CAPABILITY_[A-Z0-9_]+_UNSUPPORTED$/u)
    .optional(),
})

export const domainCapabilitiesResultSchema = createResultSchema(
  z.strictObject({ capabilities: z.array(domainCapabilityItemSchema).length(8) }),
)

export type DomainContactUpdateRequest = z.infer<typeof domainContactUpdateRequestSchema>
export type DomainManagementPasswordModifyRequest = z.infer<
  typeof domainManagementPasswordModifyRequestSchema
>
export type DomainManagementPasswordRevealRequest = z.infer<
  typeof domainManagementPasswordRevealRequestSchema
>
export type DomainTemplateTransferRequest = z.infer<typeof domainTemplateTransferRequestSchema>
