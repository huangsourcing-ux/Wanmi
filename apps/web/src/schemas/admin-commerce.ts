import { z } from 'zod'

export const manualCommerceEvidenceSchema = z
  .object({
    observedAt: z.iso.datetime(),
    reference: z.string().trim().min(3).max(256),
    source: z.enum(['provider_console', 'provider_query', 'written_confirmation']),
  })
  .strict()

export type ManualCommerceEvidence = z.infer<typeof manualCommerceEvidenceSchema>

export const paymentRecoveryRequestSchema = z
  .object({
    evidence: manualCommerceEvidenceSchema,
    note: z.string().trim().min(3).max(1000),
  })
  .strict()

export const manualOrderActionRequestSchema = z
  .object({
    actionType: z.enum(['special_refund', 'invoice_note']),
    amountMinor: z.number().int().positive().safe().optional(),
    evidence: manualCommerceEvidenceSchema,
    reason: z.string().trim().min(3).max(1000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actionType === 'special_refund' && value.amountMinor === undefined) {
      context.addIssue({
        code: 'custom',
        message: '特殊退款必须填写正整数分金额',
        path: ['amountMinor'],
      })
    }
    if (value.actionType === 'invoice_note' && value.amountMinor !== undefined) {
      context.addIssue({
        code: 'custom',
        message: '发票备注不得填写退款金额',
        path: ['amountMinor'],
      })
    }
  })
