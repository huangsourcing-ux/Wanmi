import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'

export type AuthTransactionDatabase = {
  execute: (statement: ReturnType<typeof sql>) => Promise<{ rows?: Array<Record<string, unknown>> }>
}

export async function authTransactionDatabase(
  req: PayloadRequest,
): Promise<AuthTransactionDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const database = session?.db as AuthTransactionDatabase | undefined
  if (!database) {
    throw new AppError('AUTH_TRANSACTION_UNAVAILABLE', '无法建立安全认证事务', 503)
  }
  return database
}

export async function inAuthTransaction<T>(
  req: PayloadRequest,
  work: () => Promise<T>,
): Promise<T> {
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
