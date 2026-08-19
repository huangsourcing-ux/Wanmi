import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'

const MAX_SAFE_MONEY = BigInt(Number.MAX_SAFE_INTEGER)
const TRANSACTION_KEY_MAX_LENGTH = 120

type WalletDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

export type WalletBalance = {
  availableBalance: bigint
  heldBalance: bigint
  postedBalance: bigint
}

type LockedWalletAccount = WalletBalance & {
  accountId: number | string
  customerId: number | string
  ledgerVersion: bigint
}

export type WalletTransactionStatus = 'captured' | 'held' | 'posted' | 'released'

export type WalletMutationResult = {
  applied: boolean
  balance: WalletBalance
  status: WalletTransactionStatus
  transactionId: number | string
}

function walletUnavailable(message = '钱包账本暂时不可用'): AppError {
  return new AppError('WALLET_LEDGER_UNAVAILABLE', message, 503)
}

function identifier(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) return value
  throw walletUnavailable()
}

function databaseInteger(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value)
  throw walletUnavailable()
}

function amountFen(value: bigint | number): bigint {
  const amount =
    typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : undefined
  if (amount === undefined || amount <= 0n || amount > MAX_SAFE_MONEY) {
    throw new AppError('WALLET_AMOUNT_INVALID', '钱包金额必须是正整数分', 400)
  }
  return amount
}

function transactionKey(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > TRANSACTION_KEY_MAX_LENGTH) {
    throw new AppError('WALLET_TRANSACTION_KEY_INVALID', '钱包幂等键无效', 400)
  }
  return normalized
}

function balanceOf(account: LockedWalletAccount): WalletBalance {
  return {
    availableBalance: account.availableBalance,
    heldBalance: account.heldBalance,
    postedBalance: account.postedBalance,
  }
}

async function walletDatabase(req: PayloadRequest): Promise<WalletDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const database = session?.db as WalletDatabase | undefined
  if (!database) throw walletUnavailable('无法建立安全钱包事务')
  return database
}

async function inWalletTransaction<T>(req: PayloadRequest, work: () => Promise<T>): Promise<T> {
  const started = await initTransaction(req)
  try {
    const result = await work()
    if (started) await commitTransaction(req)
    return result
  } catch (error) {
    if (started) await killTransaction(req)
    if (error instanceof AppError) throw error
    throw walletUnavailable()
  }
}

async function derivedBalance(
  database: WalletDatabase,
  account: { accountId: number | string; customerId: number | string; ledgerVersion: bigint },
): Promise<LockedWalletAccount> {
  const aggregate = await database.execute(sql`
    SELECT
      COUNT(*) AS entry_count,
      COALESCE(MAX(ledger_sequence), 0) AS max_sequence,
      COALESCE(SUM(
        CASE
          WHEN entry_type = 'credit' THEN amount_fen
          WHEN entry_type IN ('capture', 'recovery') THEN -amount_fen
          ELSE 0
        END
      ), 0) AS posted_balance,
      COALESCE(SUM(
        CASE
          WHEN entry_type = 'hold' THEN amount_fen
          WHEN entry_type IN ('capture', 'release') THEN -amount_fen
          ELSE 0
        END
      ), 0) AS held_balance,
      COALESCE((
        SELECT posted_balance_after_fen
        FROM wallet_entries
        WHERE account_id = ${account.accountId}
        ORDER BY ledger_sequence DESC
        LIMIT 1
      ), 0) AS last_posted_balance,
      COALESCE((
        SELECT held_balance_after_fen
        FROM wallet_entries
        WHERE account_id = ${account.accountId}
        ORDER BY ledger_sequence DESC
        LIMIT 1
      ), 0) AS last_held_balance
    FROM wallet_entries
    WHERE account_id = ${account.accountId}
  `)
  const row = aggregate.rows?.[0]
  if (!row) throw walletUnavailable()

  const entryCount = databaseInteger(row.entry_count)
  const maxSequence = databaseInteger(row.max_sequence)
  const postedBalance = databaseInteger(row.posted_balance)
  const heldBalance = databaseInteger(row.held_balance)
  const lastPostedBalance = databaseInteger(row.last_posted_balance)
  const lastHeldBalance = databaseInteger(row.last_held_balance)
  if (
    account.ledgerVersion !== maxSequence ||
    entryCount !== maxSequence ||
    postedBalance !== lastPostedBalance ||
    heldBalance !== lastHeldBalance
  ) {
    throw walletUnavailable('钱包账本一致性校验失败')
  }

  return {
    ...account,
    availableBalance: postedBalance - heldBalance,
    heldBalance,
    postedBalance,
  }
}

async function lockWalletAccount(
  database: WalletDatabase,
  accountId: number | string,
): Promise<LockedWalletAccount> {
  const locked = await database.execute(sql`
    SELECT id, customer_id, ledger_version
    FROM wallet_accounts
    WHERE id = ${accountId}
    FOR UPDATE
  `)
  const row = locked.rows?.[0]
  if (!row) throw new AppError('WALLET_ACCOUNT_UNAVAILABLE', '钱包账户不存在或不可用', 409)
  return derivedBalance(database, {
    accountId: identifier(row.id),
    customerId: identifier(row.customer_id),
    ledgerVersion: databaseInteger(row.ledger_version),
  })
}

async function shareLockWalletAccount(
  database: WalletDatabase,
  accountId: number | string,
): Promise<LockedWalletAccount> {
  const locked = await database.execute(sql`
    SELECT id, customer_id, ledger_version
    FROM wallet_accounts
    WHERE id = ${accountId}
    FOR SHARE
  `)
  const row = locked.rows?.[0]
  if (!row) throw new AppError('WALLET_ACCOUNT_UNAVAILABLE', '钱包账户不存在或不可用', 409)
  return derivedBalance(database, {
    accountId: identifier(row.id),
    customerId: identifier(row.customer_id),
    ledgerVersion: databaseInteger(row.ledger_version),
  })
}

async function existingTransaction(database: WalletDatabase, key: string) {
  const found = await database.execute(sql`
    SELECT id, account_id, customer_id, type, status, amount_fen
    FROM wallet_transactions
    WHERE transaction_key = ${key}
  `)
  return found.rows?.[0]
}

function assertMatchingTransaction(
  row: Record<string, unknown>,
  input: {
    accountId: number | string
    amountFen: bigint
    customerId: number | string
    type: 'credit' | 'hold' | 'recovery'
  },
): { status: WalletTransactionStatus; transactionId: number | string } {
  const status = row.status
  if (
    String(row.account_id) !== String(input.accountId) ||
    String(row.customer_id) !== String(input.customerId) ||
    row.type !== input.type ||
    databaseInteger(row.amount_fen) !== input.amountFen
  ) {
    throw new AppError('WALLET_IDEMPOTENCY_CONFLICT', '钱包幂等键已用于其他操作', 409)
  }
  return {
    status: status as WalletTransactionStatus,
    transactionId: identifier(row.id),
  }
}

async function incrementLedgerVersion(
  database: WalletDatabase,
  account: LockedWalletAccount,
  balance: { heldBalance: bigint; postedBalance: bigint },
): Promise<bigint> {
  const updated = await database.execute(sql`
    UPDATE wallet_accounts
    SET
      ledger_version = ledger_version + 1,
      posted_balance_cache_fen = ${balance.postedBalance.toString()},
      held_balance_cache_fen = ${balance.heldBalance.toString()},
      updated_at = NOW()
    WHERE id = ${account.accountId}
    RETURNING ledger_version
  `)
  const version = updated.rows?.[0]?.ledger_version
  if (version === undefined) throw walletUnavailable()
  return databaseInteger(version)
}

async function reserveLedgerVersion(
  database: WalletDatabase,
  account: LockedWalletAccount,
  delta: bigint,
): Promise<bigint> {
  const updated = await database.execute(sql`
    UPDATE wallet_accounts
    SET
      ledger_version = ledger_version + 1,
      posted_balance_cache_fen = ${account.postedBalance.toString()},
      held_balance_cache_fen = ${(account.heldBalance + delta).toString()},
      updated_at = NOW()
    WHERE id = ${account.accountId}
      AND ${delta.toString()} <= (
        SELECT COALESCE(SUM(
          CASE
            WHEN entry_type = 'credit' THEN amount_fen
            WHEN entry_type = 'hold' THEN -amount_fen
            WHEN entry_type = 'release' THEN amount_fen
            WHEN entry_type = 'recovery' THEN -amount_fen
            ELSE 0
          END
        ), 0)
        FROM wallet_entries
        WHERE account_id = ${account.accountId}
      )
    RETURNING ledger_version
  `)
  const version = updated.rows?.[0]?.ledger_version
  if (version === undefined) {
    if (delta > account.availableBalance) {
      throw new AppError('WALLET_BALANCE_INSUFFICIENT', '钱包可用余额不足', 409)
    }
    throw walletUnavailable()
  }
  return databaseInteger(version)
}

async function insertTransaction(
  database: WalletDatabase,
  input: {
    account: LockedWalletAccount
    amountFen: bigint
    key: string
    status: 'held' | 'posted'
    type: 'credit' | 'hold' | 'recovery'
  },
): Promise<number | string> {
  const inserted = await database.execute(sql`
    INSERT INTO wallet_transactions (
      transaction_key,
      customer_id,
      account_id,
      type,
      status,
      amount_fen,
      updated_at,
      created_at
    ) VALUES (
      ${input.key},
      ${input.account.customerId},
      ${input.account.accountId},
      ${input.type},
      ${input.status},
      ${input.amountFen.toString()},
      NOW(),
      NOW()
    )
    ON CONFLICT (transaction_key) DO NOTHING
    RETURNING id
  `)
  const insertedId = inserted.rows?.[0]?.id
  if (insertedId !== undefined) return identifier(insertedId)
  throw new AppError('WALLET_IDEMPOTENCY_CONFLICT', '钱包幂等键并发冲突', 409)
}

async function appendEntry(
  database: WalletDatabase,
  input: {
    account: LockedWalletAccount
    amountFen: bigint
    entryType: 'capture' | 'credit' | 'hold' | 'recovery' | 'release'
    heldBalanceAfter: bigint
    key: string
    ledgerSequence: bigint
    postedBalanceAfter: bigint
    transactionId: number | string
  },
): Promise<void> {
  const inserted = await database.execute(sql`
    INSERT INTO wallet_entries (
      entry_key,
      customer_id,
      account_id,
      transaction_id,
      entry_type,
      amount_fen,
      ledger_sequence,
      posted_balance_after_fen,
      held_balance_after_fen,
      updated_at,
      created_at
    ) VALUES (
      ${`${input.key}:${input.entryType}`},
      ${input.account.customerId},
      ${input.account.accountId},
      ${input.transactionId},
      ${input.entryType},
      ${input.amountFen.toString()},
      ${input.ledgerSequence.toString()},
      ${input.postedBalanceAfter.toString()},
      ${input.heldBalanceAfter.toString()},
      NOW(),
      NOW()
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `)
  if (inserted.rows?.[0]?.id === undefined) throw walletUnavailable()
}

export async function createWalletAccount(
  req: PayloadRequest,
  customerId: number | string,
): Promise<{ accountId: number | string; created: boolean }> {
  return inWalletTransaction(req, async () => {
    const database = await walletDatabase(req)
    const created = await database.execute(sql`
      INSERT INTO wallet_accounts (
      customer_id,
      currency,
      ledger_version,
      posted_balance_cache_fen,
      held_balance_cache_fen,
      updated_at,
      created_at
      ) VALUES (${customerId}, 'CNY', 0, 0, 0, NOW(), NOW())
      ON CONFLICT (customer_id, currency) DO NOTHING
      RETURNING id
    `)
    const createdId = created.rows?.[0]?.id
    if (createdId !== undefined) return { accountId: identifier(createdId), created: true }

    const existing = await database.execute(sql`
      SELECT id
      FROM wallet_accounts
      WHERE customer_id = ${customerId}
        AND currency = 'CNY'
    `)
    const accountId = existing.rows?.[0]?.id
    if (accountId === undefined) throw walletUnavailable()
    return { accountId: identifier(accountId), created: false }
  })
}

export async function readWalletBalance(
  req: PayloadRequest,
  accountId: number | string,
): Promise<WalletBalance> {
  return inWalletTransaction(req, async () => {
    const database = await walletDatabase(req)
    const account = await shareLockWalletAccount(database, accountId)
    return balanceOf(account)
  })
}

export async function assertPostedWalletCredit(
  req: PayloadRequest,
  input: {
    accountId: number | string
    amountFen: bigint | number
    customerId: number | string
    transactionKey: string
  },
): Promise<void> {
  const amount = amountFen(input.amountFen)
  const key = transactionKey(input.transactionKey)
  const found = await req.payload.find({
    collection: 'walletTransactions',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    req,
    where: { transactionKey: { equals: key } },
  })
  const transaction = found.docs[0]
  const account = transaction?.account
  const customer = transaction?.customer
  if (
    found.docs.length !== 1 ||
    !transaction ||
    transaction.type !== 'credit' ||
    transaction.status !== 'posted' ||
    String(typeof account === 'object' ? account.id : account) !== String(input.accountId) ||
    String(typeof customer === 'object' ? customer.id : customer) !== String(input.customerId) ||
    !Number.isSafeInteger(transaction.amountFen) ||
    BigInt(transaction.amountFen) !== amount
  ) {
    throw new AppError('WALLET_CREDIT_FACT_MISMATCH', '充值单与追加式钱包入账事实不一致', 409)
  }
}

export async function hasPositiveWalletAvailableBalance(
  req: PayloadRequest,
  customerId: number | string,
): Promise<boolean> {
  const ownerId = identifier(customerId)
  return inWalletTransaction(req, async () => {
    const database = await walletDatabase(req)
    const accounts = await database.execute(sql`
      SELECT id, customer_id, ledger_version
      FROM wallet_accounts
      WHERE customer_id = ${ownerId}
      FOR SHARE
    `)
    if (accounts.rows?.length === 0) return false
    if (accounts.rows?.length !== 1) throw walletUnavailable()
    const row = accounts.rows[0]
    const accountCustomerId = identifier(row.customer_id)
    if (String(accountCustomerId) !== String(ownerId)) throw walletUnavailable()
    const balance = await derivedBalance(database, {
      accountId: identifier(row.id),
      customerId: accountCustomerId,
      ledgerVersion: databaseInteger(row.ledger_version),
    })
    return balance.availableBalance > 0n
  })
}

export async function postWalletCredit(
  req: PayloadRequest,
  input: {
    accountId: number | string
    amountFen: bigint | number
    maximumPostedBalanceFen?: bigint | number
    transactionKey: string
  },
): Promise<WalletMutationResult> {
  const amount = amountFen(input.amountFen)
  const maximumPostedBalance =
    input.maximumPostedBalanceFen === undefined
      ? undefined
      : amountFen(input.maximumPostedBalanceFen)
  const key = transactionKey(input.transactionKey)
  return inWalletTransaction(req, async () => {
    const database = await walletDatabase(req)
    const account = await lockWalletAccount(database, input.accountId)
    const existing = await existingTransaction(database, key)
    if (existing) {
      const matched = assertMatchingTransaction(existing, {
        accountId: account.accountId,
        amountFen: amount,
        customerId: account.customerId,
        type: 'credit',
      })
      if (matched.status !== 'posted') throw walletUnavailable()
      return { applied: false, balance: balanceOf(account), ...matched }
    }

    if (
      maximumPostedBalance !== undefined &&
      account.postedBalance + amount > maximumPostedBalance
    ) {
      throw new AppError(
        'WALLET_ACCOUNT_BALANCE_LIMIT_EXCEEDED',
        '入账后余额将超过账户余额上限',
        409,
      )
    }
    const postedBalance = account.postedBalance + amount
    const ledgerSequence = await incrementLedgerVersion(database, account, {
      heldBalance: account.heldBalance,
      postedBalance,
    })
    const transactionId = await insertTransaction(database, {
      account,
      amountFen: amount,
      key,
      status: 'posted',
      type: 'credit',
    })
    await appendEntry(database, {
      account,
      amountFen: amount,
      entryType: 'credit',
      heldBalanceAfter: account.heldBalance,
      key,
      ledgerSequence,
      postedBalanceAfter: postedBalance,
      transactionId,
    })
    return {
      applied: true,
      balance: {
        availableBalance: postedBalance - account.heldBalance,
        heldBalance: account.heldBalance,
        postedBalance,
      },
      status: 'posted',
      transactionId,
    }
  })
}

export async function recoverWalletBalance(
  req: PayloadRequest,
  input: {
    accountId: number | string
    allowNegativeBalance: boolean
    amountFen: bigint | number
    transactionKey: string
  },
): Promise<WalletMutationResult> {
  const amount = amountFen(input.amountFen)
  const key = transactionKey(input.transactionKey)
  return inWalletTransaction(req, async () => {
    const database = await walletDatabase(req)
    const account = await lockWalletAccount(database, input.accountId)
    const existing = await existingTransaction(database, key)
    if (existing) {
      const matched = assertMatchingTransaction(existing, {
        accountId: account.accountId,
        amountFen: amount,
        customerId: account.customerId,
        type: 'recovery',
      })
      if (matched.status !== 'posted') throw walletUnavailable()
      return { applied: false, balance: balanceOf(account), ...matched }
    }
    if (!input.allowNegativeBalance && amount > account.availableBalance) {
      throw new AppError(
        'WALLET_NEGATIVE_RECOVERY_DISABLED',
        '资金规则不允许争议追回形成负余额，已停止自动处理',
        409,
      )
    }
    const postedBalance = account.postedBalance - amount
    const ledgerSequence = await incrementLedgerVersion(database, account, {
      heldBalance: account.heldBalance,
      postedBalance,
    })
    const transactionId = await insertTransaction(database, {
      account,
      amountFen: amount,
      key,
      status: 'posted',
      type: 'recovery',
    })
    await appendEntry(database, {
      account,
      amountFen: amount,
      entryType: 'recovery',
      heldBalanceAfter: account.heldBalance,
      key,
      ledgerSequence,
      postedBalanceAfter: postedBalance,
      transactionId,
    })
    return {
      applied: true,
      balance: {
        availableBalance: postedBalance - account.heldBalance,
        heldBalance: account.heldBalance,
        postedBalance,
      },
      status: 'posted',
      transactionId,
    }
  })
}

export async function holdWalletBalance(
  req: PayloadRequest,
  input: { accountId: number | string; amountFen: bigint | number; transactionKey: string },
): Promise<WalletMutationResult> {
  const amount = amountFen(input.amountFen)
  const key = transactionKey(input.transactionKey)
  return inWalletTransaction(req, async () => {
    const database = await walletDatabase(req)
    const account = await lockWalletAccount(database, input.accountId)
    const existing = await existingTransaction(database, key)
    if (existing) {
      const matched = assertMatchingTransaction(existing, {
        accountId: account.accountId,
        amountFen: amount,
        customerId: account.customerId,
        type: 'hold',
      })
      return { applied: false, balance: balanceOf(account), ...matched }
    }

    const ledgerSequence = await reserveLedgerVersion(database, account, amount)
    const transactionId = await insertTransaction(database, {
      account,
      amountFen: amount,
      key,
      status: 'held',
      type: 'hold',
    })
    const heldBalance = account.heldBalance + amount
    await appendEntry(database, {
      account,
      amountFen: amount,
      entryType: 'hold',
      heldBalanceAfter: heldBalance,
      key,
      ledgerSequence,
      postedBalanceAfter: account.postedBalance,
      transactionId,
    })
    return {
      applied: true,
      balance: {
        availableBalance: account.postedBalance - heldBalance,
        heldBalance,
        postedBalance: account.postedBalance,
      },
      status: 'held',
      transactionId,
    }
  })
}

async function settleWalletHold(
  req: PayloadRequest,
  input: { targetStatus: 'captured' | 'released'; transactionKey: string },
): Promise<WalletMutationResult> {
  const key = transactionKey(input.transactionKey)
  return inWalletTransaction(req, async () => {
    const database = await walletDatabase(req)
    const discovered = await existingTransaction(database, key)
    if (!discovered) throw new AppError('WALLET_HOLD_NOT_FOUND', '钱包冻结记录不存在', 409)
    if (discovered.type !== 'hold') throw walletUnavailable()
    if (discovered.status === input.targetStatus) {
      const account = await shareLockWalletAccount(database, identifier(discovered.account_id))
      if (String(account.customerId) !== String(discovered.customer_id)) throw walletUnavailable()
      return {
        applied: false,
        balance: balanceOf(account),
        status: input.targetStatus,
        transactionId: identifier(discovered.id),
      }
    }
    if (discovered.status !== 'held') {
      throw new AppError('WALLET_HOLD_ALREADY_RESOLVED', '钱包冻结已按其他结果处理', 409)
    }

    const transitioned = await database.execute(sql`
      UPDATE wallet_transactions
      SET status = ${input.targetStatus}, resolved_at = NOW(), updated_at = NOW()
      WHERE transaction_key = ${key}
        AND status = 'held'
        AND EXISTS (
          SELECT 1
          FROM wallet_entries
          WHERE transaction_id = wallet_transactions.id
            AND entry_type = 'hold'
            AND amount_fen = wallet_transactions.amount_fen
        )
      RETURNING id, account_id, customer_id, amount_fen
    `)
    const claimed = transitioned.rows?.[0]
    if (!claimed) {
      const current = await existingTransaction(database, key)
      if (current?.status === input.targetStatus) {
        const account = await shareLockWalletAccount(database, identifier(current.account_id))
        if (String(account.customerId) !== String(current.customer_id)) throw walletUnavailable()
        return {
          applied: false,
          balance: balanceOf(account),
          status: input.targetStatus,
          transactionId: identifier(current.id),
        }
      }
      if (current?.status === 'captured' || current?.status === 'released') {
        throw new AppError('WALLET_HOLD_ALREADY_RESOLVED', '钱包冻结已按其他结果处理', 409)
      }
      throw walletUnavailable()
    }

    const transactionId = identifier(claimed.id)
    const account = await lockWalletAccount(database, identifier(claimed.account_id))
    if (String(account.customerId) !== String(claimed.customer_id)) throw walletUnavailable()
    const amount = databaseInteger(claimed.amount_fen)
    if (amount > account.heldBalance) throw walletUnavailable()
    const captured = input.targetStatus === 'captured'
    const postedBalance = captured ? account.postedBalance - amount : account.postedBalance
    const heldBalance = account.heldBalance - amount
    const ledgerSequence = await incrementLedgerVersion(database, account, {
      heldBalance,
      postedBalance,
    })
    await appendEntry(database, {
      account,
      amountFen: amount,
      entryType: captured ? 'capture' : 'release',
      heldBalanceAfter: heldBalance,
      key,
      ledgerSequence,
      postedBalanceAfter: postedBalance,
      transactionId,
    })
    return {
      applied: true,
      balance: {
        availableBalance: postedBalance - heldBalance,
        heldBalance,
        postedBalance,
      },
      status: input.targetStatus,
      transactionId,
    }
  })
}

export async function captureWalletHold(
  req: PayloadRequest,
  transactionKeyValue: string,
): Promise<WalletMutationResult> {
  return settleWalletHold(req, {
    targetStatus: 'captured',
    transactionKey: transactionKeyValue,
  })
}

export async function releaseWalletHold(
  req: PayloadRequest,
  transactionKeyValue: string,
): Promise<WalletMutationResult> {
  return settleWalletHold(req, {
    targetStatus: 'released',
    transactionKey: transactionKeyValue,
  })
}

export async function resolveWalletHold(
  req: PayloadRequest,
  input: {
    outcome: 'confirmed' | 'failed' | 'unknown'
    transactionKey: string
  },
): Promise<WalletMutationResult> {
  if (input.outcome === 'confirmed') return captureWalletHold(req, input.transactionKey)
  if (input.outcome === 'failed') return releaseWalletHold(req, input.transactionKey)
  if (input.outcome !== 'unknown') throw walletUnavailable()

  const key = transactionKey(input.transactionKey)
  return inWalletTransaction(req, async () => {
    const database = await walletDatabase(req)
    const existing = await existingTransaction(database, key)
    if (!existing) throw new AppError('WALLET_HOLD_NOT_FOUND', '钱包冻结记录不存在', 409)
    if (existing.type !== 'hold') throw walletUnavailable()
    const account = await shareLockWalletAccount(database, identifier(existing.account_id))
    if (String(account.customerId) !== String(existing.customer_id)) throw walletUnavailable()
    return {
      applied: false,
      balance: balanceOf(account),
      status: existing.status as WalletTransactionStatus,
      transactionId: identifier(existing.id),
    }
  })
}
