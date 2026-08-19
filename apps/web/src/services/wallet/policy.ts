import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { hasRole, isActiveAdminUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import {
  walletFundsPolicySchema,
  walletFundsPolicyUpdateSchema,
  type WalletFundsPolicy,
} from '@/schemas/wallet-policy'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

const WALLET_POLICY_HEAD_KEY = 'cny-wallet-funds-policy'

type PolicyDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

function policyUnavailable(message = '钱包资金规则暂时不可用'): AppError {
  return new AppError('WALLET_POLICY_UNAVAILABLE', message, 503)
}

function databaseInteger(value: unknown): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw policyUnavailable()
  return number
}

async function policyDatabase(req: PayloadRequest): Promise<PolicyDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const database = session?.db as PolicyDatabase | undefined
  if (!database) throw policyUnavailable('无法建立安全资金规则事务')
  return database
}

async function inPolicyTransaction<T>(req: PayloadRequest, work: () => Promise<T>): Promise<T> {
  const started = await initTransaction(req)
  try {
    const result = await work()
    if (started) await commitTransaction(req)
    return result
  } catch (error) {
    if (started) await killTransaction(req)
    if (error instanceof AppError) throw error
    throw policyUnavailable()
  }
}

function rowPolicy(row: Record<string, unknown>): WalletFundsPolicy {
  const parsed = walletFundsPolicySchema.safeParse({
    accountBalanceLimitFen: databaseInteger(row.account_balance_limit_fen),
    allowNegativeBalanceRecovery: row.allow_negative_balance_recovery,
    allowRestrictedAccountEmergencyRenewal: row.allow_restricted_account_emergency_renewal,
    balanceExpiration: row.balance_expiration,
    currency: row.currency,
    financialDayCutTimezone: row.financial_day_cut_timezone,
    schemaVersion: databaseInteger(row.schema_version),
    singleSpendLimitFen: databaseInteger(row.single_spend_limit_fen),
    singleTopUpLimitFen: databaseInteger(row.single_top_up_limit_fen),
    statementCalculation: row.statement_calculation,
    version: databaseInteger(row.version),
  })
  if (!parsed.success) throw policyUnavailable('钱包资金规则损坏，已停止资金操作')
  return parsed.data
}

async function loadCurrentPolicy(req: PayloadRequest): Promise<WalletFundsPolicy> {
  const result = await (
    await policyDatabase(req)
  ).execute(sql`
    SELECT
      versions.version,
      versions.schema_version,
      versions.currency,
      versions.balance_expiration,
      versions.single_top_up_limit_fen,
      versions.account_balance_limit_fen,
      versions.single_spend_limit_fen,
      versions.allow_negative_balance_recovery,
      versions.allow_restricted_account_emergency_renewal,
      versions.financial_day_cut_timezone,
      versions.statement_calculation
    FROM wallet_policy_heads AS heads
    INNER JOIN wallet_policy_versions AS versions
      ON versions.version = heads.current_version
    WHERE heads.singleton_key = ${WALLET_POLICY_HEAD_KEY}
  `)
  if (result.rows?.length !== 1 || !result.rows[0]) {
    throw policyUnavailable('钱包资金规则尚未建立，已停止资金操作')
  }
  return rowPolicy(result.rows[0])
}

export async function loadWalletFundsPolicy(req: PayloadRequest): Promise<WalletFundsPolicy> {
  return inPolicyTransaction(req, () => loadCurrentPolicy(req))
}

function assertSystemAdmin(req: PayloadRequest): { id: number | string } {
  if (!isActiveAdminUser(req.user) || !hasRole(req.user, ['system_admin'])) {
    throw new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', '仅系统管理员可修改钱包资金规则', 403)
  }
  return req.user
}

export async function updateWalletFundsPolicy(req: PayloadRequest, rawInput: unknown) {
  const actor = assertSystemAdmin(req)
  const input = walletFundsPolicyUpdateSchema.parse(rawInput)
  return inPolicyTransaction(req, async () => {
    const current = await loadCurrentPolicy(req)
    if (input.expectedVersion !== current.version) {
      throw new AppError('WALLET_POLICY_VERSION_CONFLICT', '资金规则版本已变化，请刷新后重试', 409)
    }
    const next = walletFundsPolicySchema.parse({
      accountBalanceLimitFen: input.accountBalanceLimitFen,
      allowNegativeBalanceRecovery: input.allowNegativeBalanceRecovery,
      allowRestrictedAccountEmergencyRenewal: input.allowRestrictedAccountEmergencyRenewal,
      balanceExpiration: input.balanceExpiration,
      currency: input.currency,
      financialDayCutTimezone: input.financialDayCutTimezone,
      schemaVersion: 1,
      singleSpendLimitFen: input.singleSpendLimitFen,
      singleTopUpLimitFen: input.singleTopUpLimitFen,
      statementCalculation: input.statementCalculation,
      version: current.version + 1,
    })
    const database = await policyDatabase(req)
    const claimed = await database.execute(sql`
      UPDATE wallet_policy_heads
      SET current_version = ${next.version}, updated_at = NOW()
      WHERE singleton_key = ${WALLET_POLICY_HEAD_KEY}
        AND current_version = ${current.version}
      RETURNING singleton_key
    `)
    if (claimed.rows?.[0]?.singleton_key === undefined) {
      throw new AppError('WALLET_POLICY_VERSION_CONFLICT', '资金规则版本已变化，请刷新后重试', 409)
    }
    const inserted = await database.execute(sql`
      INSERT INTO wallet_policy_versions (
        version,
        schema_version,
        currency,
        balance_expiration,
        single_top_up_limit_fen,
        account_balance_limit_fen,
        single_spend_limit_fen,
        allow_negative_balance_recovery,
        allow_restricted_account_emergency_renewal,
        financial_day_cut_timezone,
        statement_calculation,
        changed_by,
        change_note,
        effective_at,
        updated_at,
        created_at
      ) VALUES (
        ${next.version},
        ${next.schemaVersion},
        ${next.currency},
        ${next.balanceExpiration},
        ${next.singleTopUpLimitFen},
        ${next.accountBalanceLimitFen},
        ${next.singleSpendLimitFen},
        ${next.allowNegativeBalanceRecovery},
        ${next.allowRestrictedAccountEmergencyRenewal},
        ${next.financialDayCutTimezone},
        ${next.statementCalculation},
        ${`admin:${actor.id}`},
        ${input.changeNote},
        NOW(),
        NOW(),
        NOW()
      )
      RETURNING id
    `)
    const id = inserted.rows?.[0]?.id
    if (id === undefined) throw policyUnavailable('资金规则新版本保存失败')
    await recordAuditEvent(req, {
      action: 'wallet.policy.updated',
      actor: { id: actor.id, type: 'admin' },
      metadata: { after: next, before: current, changeNote: input.changeNote },
      targetId: String(id),
    })
    return { id, value: next }
  })
}

export function assertWalletCurrency(currency: unknown): asserts currency is 'CNY' {
  if (currency !== 'CNY') {
    throw new AppError('WALLET_CURRENCY_UNSUPPORTED', 'P1 钱包仅支持人民币 CNY', 400)
  }
}

export function assertSingleTopUpLimit(policy: WalletFundsPolicy, amountFen: bigint): void {
  if (amountFen > BigInt(policy.singleTopUpLimitFen)) {
    throw new AppError('WALLET_TOP_UP_LIMIT_EXCEEDED', '充值金额超过单次充值上限', 409)
  }
}

export function assertSingleSpendLimit(policy: WalletFundsPolicy, amountFen: bigint): void {
  if (amountFen > BigInt(policy.singleSpendLimitFen)) {
    throw new AppError('WALLET_SPEND_LIMIT_EXCEEDED', '消费金额超过单笔消费上限', 409)
  }
}

export function assertAccountBalanceLimit(
  policy: WalletFundsPolicy,
  postedBalanceFen: bigint,
  incomingAmountFen: bigint,
): void {
  if (postedBalanceFen + incomingAmountFen > BigInt(policy.accountBalanceLimitFen)) {
    throw new AppError('WALLET_ACCOUNT_BALANCE_LIMIT_EXCEEDED', '充值后余额将超过账户余额上限', 409)
  }
}
