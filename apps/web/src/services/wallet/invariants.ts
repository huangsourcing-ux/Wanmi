import type { PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

type LedgerDiscrepancy = {
  accountId: string
  code: string
  entryId?: string
  transactionId?: string
}

export type WalletLedgerConsistencyResult = {
  accountsChecked: number
  entriesChecked: number
  transactionsChecked: number
}

function walletCheckUnavailable(): AppError {
  return new AppError('WALLET_LEDGER_CHECK_UNAVAILABLE', '钱包账本一致性检查暂时不可用', 503)
}

function integer(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value)
  throw walletCheckUnavailable()
}

function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value
  throw walletCheckUnavailable()
}

function addDiscrepancy(discrepancies: LedgerDiscrepancy[], input: LedgerDiscrepancy): void {
  discrepancies.push(input)
}

export async function inspectWalletLedgerInvariants(
  req: PayloadRequest,
): Promise<{ discrepancies: LedgerDiscrepancy[]; result: WalletLedgerConsistencyResult }> {
  try {
    const client = await req.payload.db.pool.connect()
    let accountsResult
    let entriesResult
    let transactionsResult
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      accountsResult = await client.query(
        `SELECT id, customer_id, ledger_version
         FROM wallet_accounts
         ORDER BY id`,
      )
      entriesResult = await client.query(
        `SELECT
           id,
           entry_key,
           customer_id,
           account_id,
           transaction_id,
           entry_type,
           amount_fen,
           ledger_sequence,
           posted_balance_after_fen,
           held_balance_after_fen
         FROM wallet_entries
         ORDER BY account_id, ledger_sequence, id`,
      )
      transactionsResult = await client.query(
        `SELECT id, transaction_key, customer_id, account_id, type, status, amount_fen
         FROM wallet_transactions
         ORDER BY id`,
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    const discrepancies: LedgerDiscrepancy[] = []
    const accountState = new Map<
      string,
      {
        customerId: string
        expectedSequence: bigint
        heldBalance: bigint
        ledgerVersion: bigint
        postedBalance: bigint
      }
    >()
    for (const row of accountsResult.rows) {
      const accountId = id(row.id)
      accountState.set(accountId, {
        customerId: id(row.customer_id),
        expectedSequence: 1n,
        heldBalance: 0n,
        ledgerVersion: integer(row.ledger_version),
        postedBalance: 0n,
      })
    }

    const entriesByTransaction = new Map<string, Array<Record<string, unknown>>>()
    for (const row of entriesResult.rows as Array<Record<string, unknown>>) {
      const accountId = id(row.account_id)
      const entryId = id(row.id)
      const transactionId = id(row.transaction_id)
      const state = accountState.get(accountId)
      if (!state) throw walletCheckUnavailable()
      const amount = integer(row.amount_fen)
      const sequence = integer(row.ledger_sequence)
      if (sequence !== state.expectedSequence) {
        addDiscrepancy(discrepancies, {
          accountId,
          code: 'ledger_sequence_gap',
          entryId,
          transactionId,
        })
      }
      if (id(row.customer_id) !== state.customerId) {
        addDiscrepancy(discrepancies, {
          accountId,
          code: 'entry_customer_mismatch',
          entryId,
          transactionId,
        })
      }

      if (row.entry_type === 'credit') state.postedBalance += amount
      else if (row.entry_type === 'hold') state.heldBalance += amount
      else if (row.entry_type === 'capture') {
        state.postedBalance -= amount
        state.heldBalance -= amount
      } else if (row.entry_type === 'release') state.heldBalance -= amount
      else throw walletCheckUnavailable()

      if (integer(row.posted_balance_after_fen) !== state.postedBalance) {
        addDiscrepancy(discrepancies, {
          accountId,
          code: 'posted_equation_mismatch',
          entryId,
          transactionId,
        })
      }
      if (integer(row.held_balance_after_fen) !== state.heldBalance) {
        addDiscrepancy(discrepancies, {
          accountId,
          code: 'held_equation_mismatch',
          entryId,
          transactionId,
        })
      }
      state.expectedSequence = sequence + 1n
      const transactionEntries = entriesByTransaction.get(transactionId) ?? []
      transactionEntries.push(row)
      entriesByTransaction.set(transactionId, transactionEntries)
    }

    for (const [accountId, state] of accountState) {
      if (state.ledgerVersion !== state.expectedSequence - 1n) {
        addDiscrepancy(discrepancies, { accountId, code: 'account_ledger_version_mismatch' })
      }
    }

    for (const row of transactionsResult.rows as Array<Record<string, unknown>>) {
      const transactionId = id(row.id)
      const accountId = id(row.account_id)
      const customerId = id(row.customer_id)
      const amount = integer(row.amount_fen)
      const entries = entriesByTransaction.get(transactionId) ?? []
      if (!accountState.has(accountId)) throw walletCheckUnavailable()
      if (accountState.get(accountId)?.customerId !== customerId) {
        addDiscrepancy(discrepancies, {
          accountId,
          code: 'transaction_customer_mismatch',
          transactionId,
        })
      }
      if (
        entries.some(
          (entry) =>
            id(entry.account_id) !== accountId ||
            id(entry.customer_id) !== customerId ||
            integer(entry.amount_fen) !== amount,
        )
      ) {
        addDiscrepancy(discrepancies, {
          accountId,
          code: 'transaction_entry_mismatch',
          transactionId,
        })
      }

      const entryTypes = entries.map((entry) => entry.entry_type)
      const expectedEntryTypes =
        row.type === 'credit' && row.status === 'posted'
          ? ['credit']
          : row.type === 'hold' && row.status === 'held'
            ? ['hold']
            : row.type === 'hold' && row.status === 'captured'
              ? ['hold', 'capture']
              : row.type === 'hold' && row.status === 'released'
                ? ['hold', 'release']
                : undefined
      if (
        !expectedEntryTypes ||
        entryTypes.length !== expectedEntryTypes.length ||
        entryTypes.some((entryType, index) => entryType !== expectedEntryTypes[index])
      ) {
        addDiscrepancy(discrepancies, {
          accountId,
          code: 'transaction_history_invalid',
          transactionId,
        })
      }
    }

    return {
      discrepancies,
      result: {
        accountsChecked: accountsResult.rows.length,
        entriesChecked: entriesResult.rows.length,
        transactionsChecked: transactionsResult.rows.length,
      },
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw walletCheckUnavailable()
  }
}

export async function runWalletLedgerConsistencyCheck(
  req: PayloadRequest,
): Promise<WalletLedgerConsistencyResult> {
  const inspection = await inspectWalletLedgerInvariants(req)
  if (inspection.discrepancies.length === 0) return inspection.result

  const accountIds = [...new Set(inspection.discrepancies.map(({ accountId }) => accountId))]
  await recordAuditEvent(req, {
    action: 'wallet.ledger_invariant.failed',
    actor: { type: 'system' },
    metadata: {
      accountIds,
      discrepancyCount: inspection.discrepancies.length,
      discrepancies: inspection.discrepancies,
      ...inspection.result,
    },
    targetId: accountIds.length === 1 ? accountIds[0] : 'multiple',
  })
  throw new AppError('WALLET_LEDGER_INVARIANT_VIOLATION', '钱包账本一致性检查发现差异', 500)
}
