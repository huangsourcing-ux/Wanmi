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
    invoiceStatus: z.enum(['processing', 'completed', 'cancelled']).optional(),
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
    if (value.actionType === 'invoice_note' && value.invoiceStatus === undefined) {
      context.addIssue({
        code: 'custom',
        message: '发票记录必须填写处理状态',
        path: ['invoiceStatus'],
      })
    }
    if (value.actionType === 'special_refund' && value.invoiceStatus !== undefined) {
      context.addIssue({
        code: 'custom',
        message: '特殊退款不得填写发票处理状态',
        path: ['invoiceStatus'],
      })
    }
  })
