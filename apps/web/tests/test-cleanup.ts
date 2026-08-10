import { sql } from '@payloadcms/db-postgres'
import {
  commitTransaction,
  createLocalReq,
  initTransaction,
  killTransaction,
  ValidationError,
  type Payload,
} from 'payload'

import type { ProviderWriteBudgetAuthorization } from '@/lib/provider-write-guardrails'
import type { Admin } from '@/payload-types'
import { providerWriteBudgetDebitKey } from '@/services/providers/provider-write-budget'

export const ANCHOR_SYSTEM_ADMIN_EMAIL = 'integration-system-admin-anchor@example.test'
export const ANCHOR_SYSTEM_ADMIN_PASSWORD = 'Integration-anchor-password-2026'

export async function findOrCreateUniqueFixture<T>(options: {
  create: () => Promise<T>
  find: () => Promise<T | undefined>
  path: string
  tableName: string
}): Promise<{ created: boolean; value: T }> {
  const existing = await options.find()
  if (existing) return { created: false, value: existing }

  try {
    return { created: true, value: await options.create() }
  } catch (error) {
    const isExpectedUniqueConflict =
      error instanceof ValidationError &&
      error.data.errors.some(
        (fieldError) =>
          fieldError.path === options.path &&
          (fieldError.tableName === options.tableName ||
            (fieldError.tableName === undefined && error.data.collection === options.tableName)),
      )
    if (!isExpectedUniqueConflict) throw error

    const raced = await options.find()
    if (raced) return { created: false, value: raced }
    throw error
  }
}

export async function ensureAnchorSystemAdmin(payload: Payload): Promise<Admin> {
  const result = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'admins',
        context: { adminAccountOperation: 'bootstrap' },
        data: {
          email: ANCHOR_SYSTEM_ADMIN_EMAIL,
          password: ANCHOR_SYSTEM_ADMIN_PASSWORD,
          roles: ['system_admin'],
          status: 'active',
        },
        overrideAccess: true,
      }),
    find: async () => {
      const existing = await payload.find({
        collection: 'admins',
        limit: 1,
        overrideAccess: true,
        where: { email: { equals: ANCHOR_SYSTEM_ADMIN_EMAIL } },
      })
      return existing.docs[0]
    },
    path: 'email',
    tableName: 'admins',
  })
  return result.value
}

export async function ignorePayloadNotFound(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
      return
    }
    throw error
  }
}

export async function cleanupProviderWriteBudgetFixtures(
  payload: Payload,
  authorizations: readonly ProviderWriteBudgetAuthorization[],
): Promise<void> {
  if (authorizations.length === 0) return
  const req = await createLocalReq({}, payload)
  const started = await initTransaction(req)
  try {
    const transactionId = await req.transactionID
    const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
    const database = session?.db as
      | {
          execute(statement: ReturnType<typeof sql>): Promise<{
            rows?: Array<Record<string, number | string>>
          }>
        }
      | undefined
    if (!database) throw new Error('Provider write budget fixture cleanup transaction unavailable')

    const keys = new Set(authorizations.map(providerWriteBudgetDebitKey))
    for (const key of keys) {
      const removed = await database.execute(sql`
        DELETE FROM provider_write_budget_debits
        WHERE debit_key = ${key}
        RETURNING budget_id, operation_delta, amount_fen
      `)
      const row = removed.rows?.[0]
      if (!row) continue
      const restored = await database.execute(sql`
        UPDATE provider_write_budgets
        SET
          used_operations = used_operations - ${row.operation_delta},
          used_amount_fen = used_amount_fen - ${row.amount_fen},
          updated_at = NOW()
        WHERE id = ${row.budget_id}
          AND used_operations >= ${row.operation_delta}
          AND used_amount_fen >= ${row.amount_fen}
        RETURNING id
      `)
      if (restored.rows?.[0]?.id === undefined) {
        throw new Error('Provider write budget fixture cleanup would underflow persisted usage')
      }
    }
    if (started) await commitTransaction(req)
  } catch (error) {
    if (started) await killTransaction(req)
    throw error
  }
}
