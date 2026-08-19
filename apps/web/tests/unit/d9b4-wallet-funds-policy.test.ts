import { describe, expect, it } from 'vitest'

import { Refunds } from '@/collections/commerce'
import { WalletPolicyVersions } from '@/collections/wallet'
import {
  DEFAULT_WALLET_FUNDS_POLICY,
  walletFundsPolicySchema,
  walletFundsPolicyUpdateSchema,
} from '@/schemas/wallet-policy'
import { walletStatementQuerySchema } from '@/schemas/wallet-statement'
import {
  assertAccountBalanceLimit,
  assertSingleSpendLimit,
  assertSingleTopUpLimit,
  assertWalletCurrency,
} from '@/services/wallet/policy'

function policyUpdate(overrides: Record<string, unknown> = {}) {
  return {
    accountBalanceLimitFen: 10_000_000,
    allowNegativeBalanceRecovery: true,
    allowRestrictedAccountEmergencyRenewal: false,
    balanceExpiration: 'never',
    changeNote: 'D9-B-4 policy fixture change note',
    currency: 'CNY',
    expectedVersion: 1,
    financialDayCutTimezone: 'Asia/Shanghai',
    singleSpendLimitFen: 3_000_000,
    singleTopUpLimitFen: 5_000_000,
    statementCalculation: 'ledger_entries_start_inclusive_end_exclusive',
    ...overrides,
  }
}

describe('D9-B-4 wallet funds policy schemas and collection guards', () => {
  it('pins the P1 defaults to CNY, no expiration, Shanghai cut-off and enabled negative recovery', () => {
    expect(DEFAULT_WALLET_FUNDS_POLICY).toMatchObject({
      allowNegativeBalanceRecovery: true,
      allowRestrictedAccountEmergencyRenewal: false,
      balanceExpiration: 'never',
      currency: 'CNY',
      financialDayCutTimezone: 'Asia/Shanghai',
      statementCalculation: 'ledger_entries_start_inclusive_end_exclusive',
    })
  })

  it.each([
    ['currency', 'USD'],
    ['balanceExpiration', 'expires_after_one_year'],
    ['financialDayCutTimezone', 'UTC'],
    ['statementCalculation', 'mutable_balance_cache'],
  ])('rejects unsupported fixed policy value %s independently', (field, value) => {
    expect(walletFundsPolicyUpdateSchema.safeParse(policyUpdate({ [field]: value })).success).toBe(
      false,
    )
  })

  it.each([
    ['currency', 'USD'],
    ['balanceExpiration', 'expires_after_one_year'],
    ['financialDayCutTimezone', 'UTC'],
    ['statementCalculation', 'mutable_balance_cache'],
    ['schemaVersion', 2],
  ])('rejects corrupted persisted policy value %s independently', (field, value) => {
    expect(
      walletFundsPolicySchema.safeParse({ ...DEFAULT_WALLET_FUNDS_POLICY, [field]: value }).success,
    ).toBe(false)
  })

  it.each(['accountBalanceLimitFen', 'singleSpendLimitFen', 'singleTopUpLimitFen'])(
    'validates persisted amount field %s at every numeric boundary',
    (field) => {
      const invalidValues =
        field === 'accountBalanceLimitFen'
          ? [10_000_000.5, Number.MAX_SAFE_INTEGER + 1]
          : [1.5, 0, Number.MAX_SAFE_INTEGER + 1]
      for (const value of invalidValues) {
        expect(
          walletFundsPolicySchema.safeParse({
            ...DEFAULT_WALLET_FUNDS_POLICY,
            [field]: value,
          }).success,
        ).toBe(false)
      }
    },
  )

  it.each(['accountBalanceLimitFen', 'singleSpendLimitFen', 'singleTopUpLimitFen'])(
    'validates policy update amount field %s at every numeric boundary',
    (field) => {
      for (const value of [1.5, 0, Number.MAX_SAFE_INTEGER + 1]) {
        expect(
          walletFundsPolicyUpdateSchema.safeParse(policyUpdate({ [field]: value })).success,
        ).toBe(false)
      }
    },
  )

  it('validates persisted and expected policy versions independently', () => {
    for (const value of [1.5, 0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        walletFundsPolicySchema.safeParse({ ...DEFAULT_WALLET_FUNDS_POLICY, version: value })
          .success,
      ).toBe(false)
      expect(
        walletFundsPolicyUpdateSchema.safeParse(policyUpdate({ expectedVersion: value })).success,
      ).toBe(false)
    }
  })

  it('requires bounded policy notes and boolean switches at both schema callpoints', () => {
    expect(
      walletFundsPolicyUpdateSchema.safeParse(policyUpdate({ changeNote: '1234567' })).success,
    ).toBe(false)
    expect(
      walletFundsPolicyUpdateSchema.safeParse(policyUpdate({ changeNote: 'x'.repeat(501) }))
        .success,
    ).toBe(false)
    for (const field of [
      'allowNegativeBalanceRecovery',
      'allowRestrictedAccountEmergencyRenewal',
    ]) {
      expect(
        walletFundsPolicySchema.safeParse({
          ...DEFAULT_WALLET_FUNDS_POLICY,
          [field]: 'not-a-boolean',
        }).success,
      ).toBe(false)
      expect(
        walletFundsPolicyUpdateSchema.safeParse(policyUpdate({ [field]: 'not-a-boolean' })).success,
      ).toBe(false)
    }
  })

  it('rejects a top-up maximum above the account maximum independently', () => {
    expect(
      walletFundsPolicySchema.safeParse({
        ...DEFAULT_WALLET_FUNDS_POLICY,
        accountBalanceLimitFen: 100,
        singleSpendLimitFen: 100,
        singleTopUpLimitFen: 101,
      }).success,
    ).toBe(false)
  })

  it('rejects a spend maximum above the account maximum independently', () => {
    expect(
      walletFundsPolicySchema.safeParse({
        ...DEFAULT_WALLET_FUNDS_POLICY,
        accountBalanceLimitFen: 100,
        singleSpendLimitFen: 101,
        singleTopUpLimitFen: 100,
      }).success,
    ).toBe(false)
  })

  it('kills each runtime amount and currency guard independently at its exact boundary', () => {
    expect(() => assertWalletCurrency('USD')).toThrowError(
      expect.objectContaining({ code: 'WALLET_CURRENCY_UNSUPPORTED' }),
    )
    expect(() => assertSingleTopUpLimit(DEFAULT_WALLET_FUNDS_POLICY, 5_000_001n)).toThrowError(
      expect.objectContaining({ code: 'WALLET_TOP_UP_LIMIT_EXCEEDED' }),
    )
    expect(() => assertSingleSpendLimit(DEFAULT_WALLET_FUNDS_POLICY, 3_000_001n)).toThrowError(
      expect.objectContaining({ code: 'WALLET_SPEND_LIMIT_EXCEEDED' }),
    )
    expect(() =>
      assertAccountBalanceLimit(DEFAULT_WALLET_FUNDS_POLICY, 9_000_000n, 1_000_001n),
    ).toThrowError(expect.objectContaining({ code: 'WALLET_ACCOUNT_BALANCE_LIMIT_EXCEEDED' }))
  })

  it('keeps both local dates strict and rejects reversed statement periods', () => {
    expect(
      walletStatementQuerySchema.parse({ endDate: '2026-08-18', startDate: '2026-08-18' }),
    ).toEqual({ endDate: '2026-08-18', startDate: '2026-08-18' })
    expect(
      walletStatementQuerySchema.safeParse({ endDate: '2026-08-17', startDate: '2026-08-18' })
        .success,
    ).toBe(false)
    expect(
      walletStatementQuerySchema.safeParse({
        endDate: '2026-08-18',
        startDate: '2026-8-18',
      }).success,
    ).toBe(false)
  })

  it('makes policy versions append-only even for override-access update and delete calls', () => {
    const beforeChange = WalletPolicyVersions.hooks?.beforeChange?.[0]
    const beforeDelete = WalletPolicyVersions.hooks?.beforeDelete?.[0]
    expect(() => beforeChange?.({ operation: 'update' } as never)).toThrowError(
      expect.objectContaining({ code: 'WALLET_POLICY_APPEND_ONLY' }),
    )
    expect(() => beforeDelete?.({} as never)).toThrowError(
      expect.objectContaining({ code: 'WALLET_POLICY_APPEND_ONLY' }),
    )
    expect(WalletPolicyVersions.access?.create?.({} as never)).toBe(false)
    expect(WalletPolicyVersions.access?.update?.({} as never)).toBe(false)
    expect(WalletPolicyVersions.access?.delete?.({} as never)).toBe(false)
  })

  it('requires every refund fact to target exactly one order kind at collection validation', () => {
    const hook = Refunds.hooks?.beforeChange?.[0]
    expect(() =>
      hook?.({ data: { order: 1, walletTopUpOrder: 2 }, operation: 'create' } as never),
    ).toThrowError(expect.objectContaining({ code: 'REFUND_TARGET_INVALID' }))
    expect(() => hook?.({ data: {}, operation: 'create' } as never)).toThrowError(
      expect.objectContaining({ code: 'REFUND_TARGET_INVALID' }),
    )
    expect(hook?.({ data: { order: 1 }, operation: 'create' } as never)).toMatchObject({ order: 1 })
    expect(hook?.({ data: { walletTopUpOrder: 2 }, operation: 'create' } as never)).toMatchObject({
      walletTopUpOrder: 2,
    })
  })
})
