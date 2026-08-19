import { z } from 'zod'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
const amount = z.string().regex(/^-?\d+$/u)

export const walletStatementQuerySchema = z
  .strictObject({ endDate: date, startDate: date })
  .superRefine((value, context) => {
    if (value.endDate < value.startDate) {
      context.addIssue({ code: 'custom', message: '结束日期不得早于开始日期', path: ['endDate'] })
    }
  })

const balance = z.strictObject({ availableFen: amount, heldFen: amount, postedFen: amount })

export const walletStatementSchema = z.strictObject({
  accountId: z.union([z.number().int().positive(), z.string().min(1)]),
  closing: balance,
  currency: z.literal('CNY'),
  entries: z.array(
    z.strictObject({
      amountFen: amount,
      createdAt: z.string().datetime(),
      entryKey: z.string().min(1),
      entryType: z.enum(['capture', 'credit', 'hold', 'recovery', 'release']),
      ledgerSequence: amount,
    }),
  ),
  opening: balance,
  period: z.strictObject({
    endExclusive: z.string().datetime(),
    endLocalDateInclusive: date,
    startInclusive: z.string().datetime(),
    startLocalDate: date,
  }),
  policyVersion: z.number().int().positive(),
  statementCalculation: z.literal('ledger_entries_start_inclusive_end_exclusive'),
  timezone: z.literal('Asia/Shanghai'),
  totals: z.strictObject({
    capturedFen: amount,
    creditedFen: amount,
    heldFen: amount,
    recoveredFen: amount,
    releasedFen: amount,
  }),
})

export type WalletStatement = z.infer<typeof walletStatementSchema>
