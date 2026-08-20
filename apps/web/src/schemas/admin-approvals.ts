import { z } from 'zod'

import {
  ADMIN_HIGH_RISK_OPERATION_TYPES,
  CUSTOMER_CAPABILITY_RESTRICTIONS,
  MARKETING_NOTIFICATION_TYPES,
  TRANSACTIONAL_NOTIFICATION_TYPES,
} from '@/lib/domain'

const customerId = z.coerce.number().int().positive()
const safeId = z.union([z.coerce.number().int().positive(), z.string().trim().min(1).max(128)])
const note = z.string().trim().min(8).max(1_000)
const reference = z.string().trim().min(8).max(128)

export const adminApprovalPolicySchema = z
  .object({
    cooldownSeconds: z.number().int().min(1).max(604_800),
    requiresDifferentApprover: z.boolean(),
    schemaVersion: z.literal(1),
    updatedAt: z.iso.datetime(),
    updatedBy: z.string().min(1).max(128),
  })
  .strict()

export const adminApprovalPolicyUpdateSchema = z
  .object({
    changeNote: note,
    cooldownSeconds: z.number().int().min(1).max(604_800),
    requiresDifferentApprover: z.boolean(),
  })
  .strict()

export const adminHighRiskOperationTypeSchema = z.enum(ADMIN_HIGH_RISK_OPERATION_TYPES)

export const adminApprovalCreateSchema = z.discriminatedUnion('operationType', [
  z
    .object({
      accountId: safeId,
      adjustment: z.enum(['credit', 'recovery']),
      allowNegativeBalance: z.boolean().default(false),
      amountFen: z.number().int().positive().safe(),
      customerId,
      operationType: z.literal('large_balance_adjustment'),
      reasonNote: note,
      transactionKey: reference,
    })
    .strict(),
  z
    .object({
      customerId,
      operationType: z.literal('original_refund'),
      orderId: safeId,
      reasonNote: note,
    })
    .strict(),
  z
    .object({
      customerId,
      decision: z.enum(['approved', 'rejected']),
      operationType: z.literal('account_recovery'),
      reasonNote: note,
      reviewId: z.coerce.number().int().positive(),
    })
    .strict(),
  z
    .object({
      customerId,
      operationType: z.literal('identity_conflict_resolution'),
      reasonNote: note,
      resolution: z.enum(['keep_existing_binding', 'reject_claim']),
      reviewId: z.coerce.number().int().positive(),
    })
    .strict(),
  z
    .object({
      correctionReference: reference,
      correctionSource: z.enum(['data_correction', 'fraud_reversal']),
      customerId,
      operationType: z.literal('vip_fraud_correction'),
      reasonNote: note,
      spendReversalFen: z.number().int().nonnegative().safe(),
      targetTierCode: z
        .string()
        .trim()
        .regex(/^[a-z][a-z0-9_]{1,31}$/u)
        .nullable(),
    })
    .strict(),
  z
    .object({
      customerId,
      evidenceReference: reference,
      expectedRestrictions: z
        .array(z.enum(CUSTOMER_CAPABILITY_RESTRICTIONS))
        .transform((values) => [...new Set(values)].sort()),
      expectedStatus: z.enum(['restricted', 'suspended']),
      operationType: z.literal('high_risk_account_unfreeze'),
      reasonNote: note,
    })
    .strict(),
  z
    .object({
      action: z.enum(['read', 'rotate']),
      assetId: safeId,
      customerId,
      operationType: z.literal('domain_management_credential_disposition'),
      providerOperationReference: reference,
      reasonNote: note,
    })
    .strict(),
  z
    .object({
      batchKind: z.enum(['dns_batch_delete', 'nameserver_batch_change', 'domain_asset_sync']),
      batchReference: reference,
      customerId,
      operationType: z.literal('bulk_customer_asset_operation'),
      reasonNote: note,
    })
    .strict(),
])

export const adminApprovalDecisionSchema = z
  .object({ decision: z.enum(['approve', 'reject']), note })
  .strict()

export const adminApprovalRequestIdSchema = z.object({
  requestId: z.coerce.number().int().positive(),
})

export const notificationPreferenceUpdateSchema = z
  .object({
    category: z.enum(['transactional', 'marketing']),
    enabled: z.boolean(),
    notificationType: z.enum([
      ...TRANSACTIONAL_NOTIFICATION_TYPES,
      ...MARKETING_NOTIFICATION_TYPES,
    ]),
  })
  .strict()

export type AdminApprovalCreateInput = z.infer<typeof adminApprovalCreateSchema>
export type AdminApprovalPolicy = z.infer<typeof adminApprovalPolicySchema>
export type AdminApprovalPolicyUpdateInput = z.infer<typeof adminApprovalPolicyUpdateSchema>
