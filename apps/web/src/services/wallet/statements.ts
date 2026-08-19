import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import {
  walletStatementQuerySchema,
  walletStatementSchema,
  type WalletStatement,
} from '@/schemas/wallet-statement'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

import { loadWalletFundsPolicy } from './policy'

type StatementDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

function unavailable(message = '钱包账单暂时不可用'): AppError {
  return new AppError('WALLET_STATEMENT_UNAVAILABLE', message, 503)
}

function integer(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value)
  throw unavailable()
}

function identifier(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) return value
  throw unavailable()
}

async function database(req: PayloadRequest): Promise<StatementDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as StatementDatabase | undefined
  if (!current) throw unavailable('无法建立一致的钱包账单快照')
  return current
}

function shanghaiBoundary(localDate: string, addDays: number): Date {
  const date = new Date(`${localDate}T00:00:00+08:00`)
  if (!Number.isFinite(date.getTime())) {
    throw new AppError('WALLET_STATEMENT_PERIOD_INVALID', '账单日期无效', 400)
  }
  date.setUTCDate(date.getUTCDate() + addDays)
  return date
}

function balanceFromRows(rows: Array<Record<string, unknown>>) {
  let posted = 0n
  let held = 0n
  for (const row of rows) {
    const amount = integer(row.amount_fen)
    if (row.entry_type === 'credit') posted += amount
    else if (row.entry_type === 'recovery') posted -= amount
    else if (row.entry_type === 'hold') held += amount
    else if (row.entry_type === 'capture') {
      posted -= amount
      held -= amount
    } else if (row.entry_type === 'release') held -= amount
    else throw unavailable()
  }
  return { availableFen: String(posted - held), heldFen: String(held), postedFen: String(posted) }
}

function assertLedgerIntegrity(rows: Array<Record<string, unknown>>, ledgerVersion: bigint): void {
  let posted = 0n
  let held = 0n
  for (const [index, row] of rows.entries()) {
    const sequence = integer(row.ledger_sequence)
    if (sequence !== BigInt(index + 1)) throw unavailable('钱包账本序列不连续')
    const amount = integer(row.amount_fen)
    if (row.entry_type === 'credit') posted += amount
    else if (row.entry_type === 'recovery') posted -= amount
    else if (row.entry_type === 'hold') held += amount
    else if (row.entry_type === 'capture') {
      posted -= amount
      held -= amount
    } else if (row.entry_type === 'release') held -= amount
    else throw unavailable()
    if (
      integer(row.posted_balance_after_fen) !== posted ||
      integer(row.held_balance_after_fen) !== held ||
      held < 0n ||
      (posted > 0n && held > posted)
    ) {
      throw unavailable('钱包账本余额快照不一致')
    }
  }
  if (BigInt(rows.length) !== ledgerVersion) throw unavailable('钱包账本版本不一致')
}

export async function exportWalletStatement(
  req: PayloadRequest,
  rawInput: unknown,
): Promise<WalletStatement> {
  if (!isCustomerUser(req.user))
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  const customer = req.user
  const input = walletStatementQuerySchema.parse(rawInput)
  const start = shanghaiBoundary(input.startDate, 0)
  const end = shanghaiBoundary(input.endDate, 1)
  if (end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1_000) {
    throw new AppError('WALLET_STATEMENT_PERIOD_TOO_LARGE', '单次最多导出 366 天账单', 400)
  }

  const started = await initTransaction(req)
  try {
    const policy = await loadWalletFundsPolicy(req)
    const db = await database(req)
    const accounts = await db.execute(sql`
      SELECT id, customer_id, ledger_version
      FROM wallet_accounts
      WHERE customer_id = ${customer.id}
        AND currency = 'CNY'
      FOR SHARE
    `)
    if (accounts.rows?.length !== 1 || !accounts.rows[0]) {
      throw new AppError('WALLET_ACCOUNT_UNAVAILABLE', '钱包账户不存在或不可用', 409)
    }
    const accountId = identifier(accounts.rows[0].id)
    if (String(accounts.rows[0].customer_id) !== String(customer.id)) throw unavailable()
    const ledgerVersion = integer(accounts.rows[0].ledger_version)
    const found = await db.execute(sql`
      SELECT
        entry_key,
        entry_type,
        amount_fen,
        ledger_sequence,
        posted_balance_after_fen,
        held_balance_after_fen,
        created_at
      FROM wallet_entries
      WHERE account_id = ${accountId}
      ORDER BY ledger_sequence, id
    `)
    const rows = found.rows ?? []
    assertLedgerIntegrity(rows, ledgerVersion)
    const closingRows = rows.filter(
      (row) => new Date(String(row.created_at)).getTime() < end.getTime(),
    )
    const openingRows = closingRows.filter(
      (row) => new Date(String(row.created_at)).getTime() < start.getTime(),
    )
    const periodRows = closingRows.filter((row) => {
      const timestamp = new Date(String(row.created_at)).getTime()
      return timestamp >= start.getTime() && timestamp < end.getTime()
    })
    const total = (entryType: string) =>
      periodRows
        .filter((row) => row.entry_type === entryType)
        .reduce((sum, row) => sum + integer(row.amount_fen), 0n)
    const statement = walletStatementSchema.parse({
      accountId,
      closing: balanceFromRows(closingRows),
      currency: policy.currency,
      entries: periodRows.map((row) => ({
        amountFen: String(integer(row.amount_fen)),
        createdAt: new Date(String(row.created_at)).toISOString(),
        entryKey: String(row.entry_key),
        entryType: row.entry_type,
        ledgerSequence: String(integer(row.ledger_sequence)),
      })),
      opening: balanceFromRows(openingRows),
      period: {
        endExclusive: end.toISOString(),
        endLocalDateInclusive: input.endDate,
        startInclusive: start.toISOString(),
        startLocalDate: input.startDate,
      },
      policyVersion: policy.version,
      statementCalculation: policy.statementCalculation,
      timezone: policy.financialDayCutTimezone,
      totals: {
        capturedFen: String(total('capture')),
        creditedFen: String(total('credit')),
        heldFen: String(total('hold')),
        recoveredFen: String(total('recovery')),
        releasedFen: String(total('release')),
      },
    })
    await recordAuditEvent(req, {
      action: 'wallet.statement.exported',
      actor: { id: customer.id, type: 'customer' },
      metadata: { entryCount: statement.entries.length, period: statement.period },
      targetId: accountId,
    })
    if (started) await commitTransaction(req)
    return statement
  } catch (error) {
    if (started) await killTransaction(req)
    if (error instanceof AppError) throw error
    throw unavailable()
  }
}
