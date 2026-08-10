import { createHash } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import {
  ProviderWriteGuardError,
  type ProviderWriteBudgetAuthorization,
} from '@/lib/provider-write-guardrails'

type Database = {
  execute(statement: ReturnType<typeof sql>): Promise<{
    rows?: Array<Record<string, number | string>>
  }>
}

function safeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function scopeKey(input: ProviderWriteBudgetAuthorization): string {
  return `${input.provider}:${input.capability}`
}

export function providerWriteBudgetDebitKey(input: ProviderWriteBudgetAuthorization): string {
  return `budget:${createHash('sha256')
    .update(scopeKey(input))
    .update('\0')
    .update(input.operationKey)
    .digest('hex')}`
}

function validate(input: ProviderWriteBudgetAuthorization): void {
  const values = [input.amountFen, input.amountLimitFen, input.operationDelta, input.operationLimit]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new ProviderWriteGuardError('PROVIDER_WRITE_BUDGET_INVALID')
  }
  if (!input.operationKey.trim()) {
    throw new ProviderWriteGuardError('PROVIDER_WRITE_OPERATION_KEY_INVALID')
  }
}

async function transaction<T>(req: PayloadRequest, work: () => Promise<T>): Promise<T> {
  const started = await initTransaction(req)
  try {
    const result = await work()
    if (started) await commitTransaction(req)
    return result
  } catch (error) {
    if (started) await killTransaction(req)
    throw error
  }
}

async function database(req: PayloadRequest): Promise<Database> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as Database | undefined
  if (!current) {
    throw new ProviderWriteGuardError('PROVIDER_WRITE_BUDGET_DATABASE_UNAVAILABLE')
  }
  return current
}

export async function consumeProviderWriteBudget(
  req: PayloadRequest,
  input: ProviderWriteBudgetAuthorization,
): Promise<{ debited: boolean }> {
  validate(input)
  const scope = scopeKey(input)
  const debit = providerWriteBudgetDebitKey(input)

  return transaction(req, async () => {
    const db = await database(req)
    await db.execute(sql`
      INSERT INTO provider_write_budgets (
        scope_key,
        provider,
        capability,
        used_operations,
        used_amount_fen,
        configured_operation_limit,
        configured_amount_limit_fen,
        updated_at,
        created_at
      ) VALUES (
        ${scope},
        ${input.provider},
        ${input.capability},
        0,
        0,
        ${input.operationLimit},
        ${input.amountLimitFen},
        NOW(),
        NOW()
      )
      ON CONFLICT (scope_key) DO NOTHING
    `)

    const inserted = await db.execute(sql`
      INSERT INTO provider_write_budget_debits (
        debit_key,
        budget_id,
        operation_delta,
        amount_fen,
        updated_at,
        created_at
      )
      SELECT
        ${debit},
        id,
        ${input.operationDelta},
        ${input.amountFen},
        NOW(),
        NOW()
      FROM provider_write_budgets
      WHERE scope_key = ${scope}
      ON CONFLICT (debit_key) DO NOTHING
      RETURNING id
    `)

    if (inserted.rows?.[0]?.id === undefined) {
      const existing = await db.execute(sql`
        SELECT operation_delta, amount_fen
        FROM provider_write_budget_debits
        WHERE debit_key = ${debit}
      `)
      const operationDelta = safeInteger(existing.rows?.[0]?.operation_delta)
      const amountFen = safeInteger(existing.rows?.[0]?.amount_fen)
      if (operationDelta !== input.operationDelta || amountFen !== input.amountFen) {
        throw new ProviderWriteGuardError('PROVIDER_WRITE_BUDGET_IDEMPOTENCY_CONFLICT')
      }
      return { debited: false }
    }

    const updated = await db.execute(sql`
      UPDATE provider_write_budgets
      SET
        used_operations = used_operations + ${input.operationDelta},
        used_amount_fen = used_amount_fen + ${input.amountFen},
        configured_operation_limit = ${input.operationLimit},
        configured_amount_limit_fen = ${input.amountLimitFen},
        updated_at = NOW()
      WHERE scope_key = ${scope}
        AND used_operations + ${input.operationDelta} <= ${input.operationLimit}
        AND used_amount_fen + ${input.amountFen} <= ${input.amountLimitFen}
      RETURNING id
    `)
    if (updated.rows?.[0]?.id !== undefined) return { debited: true }

    await db.execute(sql`
      DELETE FROM provider_write_budget_debits
      WHERE id = ${inserted.rows[0]!.id}
        AND debit_key = ${debit}
    `)

    const current = await db.execute(sql`
      SELECT used_operations, used_amount_fen
      FROM provider_write_budgets
      WHERE scope_key = ${scope}
    `)
    const usedOperations = safeInteger(current.rows?.[0]?.used_operations)
    const usedAmountFen = safeInteger(current.rows?.[0]?.used_amount_fen)
    if (usedOperations === undefined || usedAmountFen === undefined) {
      throw new ProviderWriteGuardError('PROVIDER_WRITE_BUDGET_DATABASE_UNAVAILABLE')
    }
    if (usedOperations + input.operationDelta > input.operationLimit) {
      throw new ProviderWriteGuardError(input.operationLimitExceededCode)
    }
    throw new ProviderWriteGuardError(input.amountLimitExceededCode)
  })
}
