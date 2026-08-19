import { z } from 'zod'

const positiveFen = z.number().int().positive()
const persistedAccountLimitFen = z.number().int()

export const WALLET_POLICY_CURRENCY = 'CNY' as const
export const WALLET_POLICY_BALANCE_EXPIRATION = 'never' as const
export const WALLET_POLICY_FINANCIAL_TIMEZONE = 'Asia/Shanghai' as const
export const WALLET_POLICY_STATEMENT_CALCULATION =
  'ledger_entries_start_inclusive_end_exclusive' as const

export const walletFundsPolicySchema = z
  .strictObject({
    accountBalanceLimitFen: persistedAccountLimitFen,
    allowNegativeBalanceRecovery: z.boolean(),
    allowRestrictedAccountEmergencyRenewal: z.boolean(),
    balanceExpiration: z.literal(WALLET_POLICY_BALANCE_EXPIRATION),
    currency: z.literal(WALLET_POLICY_CURRENCY),
    financialDayCutTimezone: z.literal(WALLET_POLICY_FINANCIAL_TIMEZONE),
    schemaVersion: z.literal(1),
    singleSpendLimitFen: positiveFen,
    singleTopUpLimitFen: positiveFen,
    statementCalculation: z.literal(WALLET_POLICY_STATEMENT_CALCULATION),
    version: z.number().int().positive(),
  })
  .superRefine((value, context) => {
    if (value.singleTopUpLimitFen > value.accountBalanceLimitFen) {
      context.addIssue({
        code: 'custom',
        message: '单次充值上限不得高于账户余额上限',
        path: ['singleTopUpLimitFen'],
      })
    }
    if (value.singleSpendLimitFen > value.accountBalanceLimitFen) {
      context.addIssue({
        code: 'custom',
        message: '单笔消费上限不得高于账户余额上限',
        path: ['singleSpendLimitFen'],
      })
    }
  })

export const walletFundsPolicyUpdateSchema = z.strictObject({
  accountBalanceLimitFen: positiveFen,
  allowNegativeBalanceRecovery: z.boolean(),
  allowRestrictedAccountEmergencyRenewal: z.boolean(),
  balanceExpiration: z.literal(WALLET_POLICY_BALANCE_EXPIRATION),
  changeNote: z.string().trim().min(8).max(500),
  currency: z.literal(WALLET_POLICY_CURRENCY),
  expectedVersion: z.number().int().positive(),
  financialDayCutTimezone: z.literal(WALLET_POLICY_FINANCIAL_TIMEZONE),
  singleSpendLimitFen: positiveFen,
  singleTopUpLimitFen: positiveFen,
  statementCalculation: z.literal(WALLET_POLICY_STATEMENT_CALCULATION),
})

export const DEFAULT_WALLET_FUNDS_POLICY: WalletFundsPolicy = walletFundsPolicySchema.parse({
  accountBalanceLimitFen: 10_000_000,
  allowNegativeBalanceRecovery: true,
  allowRestrictedAccountEmergencyRenewal: false,
  balanceExpiration: WALLET_POLICY_BALANCE_EXPIRATION,
  currency: WALLET_POLICY_CURRENCY,
  financialDayCutTimezone: WALLET_POLICY_FINANCIAL_TIMEZONE,
  schemaVersion: 1,
  singleSpendLimitFen: 3_000_000,
  singleTopUpLimitFen: 5_000_000,
  statementCalculation: WALLET_POLICY_STATEMENT_CALCULATION,
  version: 1,
})

export type WalletFundsPolicy = z.infer<typeof walletFundsPolicySchema>
export type WalletFundsPolicyUpdate = z.infer<typeof walletFundsPolicyUpdateSchema>
