import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import { TOOL_QUOTA_TARGETS } from '@/collections/points'
import { AppError } from '@/lib/errors'
import { assertCustomerAccountCapability } from '@/services/auth/account-state'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

const MAX_SAFE_POINTS = BigInt(Number.MAX_SAFE_INTEGER)
const IDEMPOTENCY_KEY_MAX_LENGTH = 120
const MAX_EXPIRATION_BATCHES = 500

export type ToolQuotaTarget = (typeof TOOL_QUOTA_TARGETS)[number]

type PointsDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

type LockedPointsAccount = {
  accountId: number | string
  customerId: number | string
  ledgerVersion: bigint
  quotaLedgerVersion: bigint
}

type PointsBatch = {
  accountId: number | string
  batchId: number | string
  customerId: number | string
  earningKey: string
  expiresAt: Date
  points: bigint
  sourceOrderId: number | string
}

type BatchLifecycle = {
  available: bigint
  consumed: bigint
  expired: bigint
  held: bigint
  pending: bigint
  reversed: bigint
}

export type PointsBalance = BatchLifecycle

export type PointsAllocation = {
  batchId: number | string
  expiresAt: string
  points: bigint
}

export type PointsMutationResult = {
  applied: boolean
  balance: PointsBalance
  batchId: number | string
}

export type PointsRedemptionResult = {
  allocations: PointsAllocation[]
  applied: boolean
  balance: PointsBalance
  quotaBalance: bigint
  redemptionId: number | string
}

function pointsUnavailable(message = '米币账本暂时不可用'): AppError {
  return new AppError('POINTS_LEDGER_UNAVAILABLE', message, 503)
}

function identifier(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) return value
  throw pointsUnavailable()
}

function databaseInteger(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value)
  throw pointsUnavailable()
}

function positiveInteger(value: bigint | number, code: string, message: string): bigint {
  const parsed =
    typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : undefined
  if (parsed === undefined || parsed <= 0n || parsed > MAX_SAFE_POINTS) {
    throw new AppError(code, message, 400)
  }
  return parsed
}

function idempotencyKey(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new AppError('POINTS_IDEMPOTENCY_KEY_INVALID', '米币幂等键无效', 400)
  }
  return normalized
}

function expirationDate(value: string): Date {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new AppError('POINTS_EXPIRATION_INVALID', '米币过期时间无效', 400)
  }
  return parsed
}

function databaseDate(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) throw pointsUnavailable()
  return parsed
}

function quotaTarget(value: string): ToolQuotaTarget {
  if ((TOOL_QUOTA_TARGETS as readonly string[]).includes(value)) {
    return value as ToolQuotaTarget
  }
  throw new AppError('POINTS_REDEMPTION_TARGET_INVALID', '米币只能兑换已批准的工具额度', 400)
}

function assertSystemActor(req: PayloadRequest): void {
  if (!req.user) return
  throw new AppError('POINTS_SYSTEM_OPERATION_FORBIDDEN', '该米币操作只允许系统任务执行', 403)
}

function assertCustomerActor(req: PayloadRequest, customerId: number | string): void {
  if (isCustomerUser(req.user) && String(req.user.id) === String(customerId)) return
  throw new AppError('POINTS_CUSTOMER_OPERATION_FORBIDDEN', '无权操作该米币账户', 403)
}

async function pointsDatabase(req: PayloadRequest): Promise<PointsDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const database = session?.db as PointsDatabase | undefined
  if (!database) throw pointsUnavailable('无法建立安全米币事务')
  return database
}

async function inPointsTransaction<T>(req: PayloadRequest, work: () => Promise<T>): Promise<T> {
  const started = await initTransaction(req)
  try {
    const result = await work()
    if (started) await commitTransaction(req)
    return result
  } catch (error) {
    if (started) await killTransaction(req)
    if (error instanceof AppError) throw error
    throw pointsUnavailable()
  }
}

async function ensurePointsAccount(
  database: PointsDatabase,
  customerId: number | string,
): Promise<void> {
  const inserted = await database.execute(sql`
    INSERT INTO points_accounts (
      customer_id,
      ledger_version,
      quota_ledger_version,
      updated_at,
      created_at
    ) VALUES (${customerId}, 0, 0, NOW(), NOW())
    ON CONFLICT DO NOTHING
    RETURNING id
  `)
  if (inserted.rows?.[0]?.id === undefined && inserted.rows === undefined) throw pointsUnavailable()
}

async function lockPointsAccountByCustomer(
  database: PointsDatabase,
  customerId: number | string,
): Promise<LockedPointsAccount> {
  const locked = await database.execute(sql`
    SELECT id, customer_id, ledger_version, quota_ledger_version
    FROM points_accounts
    WHERE customer_id = ${customerId}
    FOR UPDATE
  `)
  const row = locked.rows?.[0]
  if (!row) throw new AppError('POINTS_ACCOUNT_UNAVAILABLE', '米币账户不存在或不可用', 409)
  const lockedCustomerId = identifier(row.customer_id)
  if (String(lockedCustomerId) !== String(customerId)) throw pointsUnavailable()
  return {
    accountId: identifier(row.id),
    customerId: lockedCustomerId,
    ledgerVersion: databaseInteger(row.ledger_version),
    quotaLedgerVersion: databaseInteger(row.quota_ledger_version),
  }
}

async function shareLockPointsAccountByCustomer(
  database: PointsDatabase,
  customerId: number | string,
): Promise<LockedPointsAccount> {
  const locked = await database.execute(sql`
    SELECT id, customer_id, ledger_version, quota_ledger_version
    FROM points_accounts
    WHERE customer_id = ${customerId}
    FOR SHARE
  `)
  const row = locked.rows?.[0]
  if (!row) throw new AppError('POINTS_ACCOUNT_UNAVAILABLE', '米币账户不存在或不可用', 409)
  const lockedCustomerId = identifier(row.customer_id)
  if (String(lockedCustomerId) !== String(customerId)) throw pointsUnavailable()
  return {
    accountId: identifier(row.id),
    customerId: lockedCustomerId,
    ledgerVersion: databaseInteger(row.ledger_version),
    quotaLedgerVersion: databaseInteger(row.quota_ledger_version),
  }
}

async function derivedPointsBalance(
  database: PointsDatabase,
  account: LockedPointsAccount,
): Promise<PointsBalance> {
  const aggregate = await database.execute(sql`
    SELECT
      COUNT(*) AS entry_count,
      COALESCE(MAX(ledger_sequence), 0) AS max_sequence,
      COALESCE(SUM(CASE WHEN entry_type = 'pending' THEN points ELSE 0 END), 0) AS pending_in,
      COALESCE(SUM(CASE WHEN entry_type = 'available' THEN points ELSE 0 END), 0) AS available_in,
      COALESCE(SUM(CASE WHEN entry_type = 'held' THEN points ELSE 0 END), 0) AS held_in,
      COALESCE(SUM(CASE WHEN entry_type = 'consumed' THEN points ELSE 0 END), 0) AS consumed,
      COALESCE(SUM(CASE WHEN entry_type = 'expired' THEN points ELSE 0 END), 0) AS expired,
      COALESCE(SUM(CASE WHEN entry_type = 'reversed' THEN points ELSE 0 END), 0) AS reversed,
      COALESCE((
        SELECT COUNT(*)
        FROM points_batches AS batches
        JOIN orders ON orders.id = batches.source_order_id
        WHERE (batches.account_id = ${account.accountId}
            OR batches.customer_id = ${account.customerId})
          AND (batches.account_id <> ${account.accountId}
            OR batches.customer_id <> ${account.customerId}
            OR orders.customer_id <> ${account.customerId})
      ), 0) AS invalid_batches,
      COALESCE((
        SELECT COUNT(*)
        FROM points_ledger AS entries
        JOIN points_batches AS batches ON batches.id = entries.batch_id
        WHERE (entries.account_id = ${account.accountId}
            OR batches.account_id = ${account.accountId})
          AND (entries.account_id <> ${account.accountId}
            OR entries.customer_id <> ${account.customerId}
            OR batches.account_id <> ${account.accountId}
            OR batches.customer_id <> ${account.customerId})
      ), 0) AS invalid_ledger_links,
      COALESCE((
        SELECT COUNT(*)
        FROM points_consumption_allocations AS allocations
        JOIN points_batches AS batches ON batches.id = allocations.batch_id
        JOIN points_redemptions AS redemptions ON redemptions.id = allocations.redemption_id
        WHERE (allocations.account_id = ${account.accountId}
            OR batches.account_id = ${account.accountId}
            OR redemptions.account_id = ${account.accountId})
          AND (allocations.account_id <> ${account.accountId}
            OR allocations.customer_id <> ${account.customerId}
            OR batches.account_id <> ${account.accountId}
            OR batches.customer_id <> ${account.customerId}
            OR redemptions.account_id <> ${account.accountId}
            OR redemptions.customer_id <> ${account.customerId})
      ), 0) AS invalid_allocation_links,
      COALESCE((
        SELECT COUNT(*)
        FROM (
          SELECT
            batches.points,
            COALESCE((SELECT SUM(points) FROM points_ledger
              WHERE batch_id = batches.id AND entry_type = 'pending'), 0) AS pending,
            COALESCE((SELECT SUM(points) FROM points_ledger
              WHERE batch_id = batches.id AND entry_type = 'available'), 0) AS available,
            COALESCE((SELECT SUM(points) FROM points_ledger
              WHERE batch_id = batches.id AND entry_type = 'held'), 0) AS held,
            COALESCE((SELECT SUM(points) FROM points_ledger
              WHERE batch_id = batches.id AND entry_type = 'consumed'), 0) AS consumed,
            COALESCE((SELECT SUM(points) FROM points_ledger
              WHERE batch_id = batches.id AND entry_type = 'expired'), 0) AS expired,
            COALESCE((SELECT SUM(points) FROM points_ledger
              WHERE batch_id = batches.id AND entry_type = 'reversed'), 0) AS reversed,
            COALESCE((SELECT SUM(points) FROM points_consumption_allocations
              WHERE batch_id = batches.id), 0) AS allocated
          FROM points_batches AS batches
          WHERE batches.account_id = ${account.accountId}
        ) AS lifecycles
        WHERE pending <> points
          OR available NOT IN (0, points)
          OR reversed NOT IN (0, points)
          OR available + reversed > points
          OR held <> allocated
          OR consumed <> allocated
          OR consumed + expired > available
      ), 0) AS invalid_lifecycles
    FROM points_ledger
    WHERE account_id = ${account.accountId}
  `)
  const row = aggregate.rows?.[0]
  if (!row) throw pointsUnavailable()
  const entryCount = databaseInteger(row.entry_count)
  const maxSequence = databaseInteger(row.max_sequence)
  const availableIn = databaseInteger(row.available_in)
  const consumed = databaseInteger(row.consumed)
  const expired = databaseInteger(row.expired)
  const heldIn = databaseInteger(row.held_in)
  const pendingIn = databaseInteger(row.pending_in)
  const reversed = databaseInteger(row.reversed)
  const balance = {
    available: availableIn - heldIn - expired,
    consumed,
    expired,
    held: heldIn - consumed,
    pending: pendingIn - availableIn - reversed,
    reversed,
  }
  if (
    account.ledgerVersion !== maxSequence ||
    entryCount !== maxSequence ||
    databaseInteger(row.invalid_batches) !== 0n ||
    databaseInteger(row.invalid_ledger_links) !== 0n ||
    databaseInteger(row.invalid_allocation_links) !== 0n ||
    databaseInteger(row.invalid_lifecycles) !== 0n
  ) {
    throw pointsUnavailable('米币账本一致性校验失败')
  }
  return balance
}

async function derivedQuotaBalance(
  database: PointsDatabase,
  account: LockedPointsAccount,
  target: ToolQuotaTarget,
): Promise<bigint> {
  const aggregate = await database.execute(sql`
    SELECT
      COUNT(*) AS entry_count,
      COALESCE(MAX(ledger_sequence), 0) AS max_sequence,
      COALESCE(SUM(
        CASE
          WHEN target = ${target} AND entry_type = 'grant' THEN quota_units
          WHEN target = ${target} AND entry_type = 'consume' THEN -quota_units
          ELSE 0
        END
      ), 0) AS balance,
      COALESCE((
        SELECT COUNT(*)
        FROM tool_quota_ledger AS entries
        LEFT JOIN points_redemptions AS redemptions ON redemptions.id = entries.redemption_id
        WHERE entries.account_id = ${account.accountId}
          AND (entries.customer_id <> ${account.customerId}
            OR (entries.entry_type = 'grant' AND (
              redemptions.id IS NULL
              OR redemptions.account_id <> ${account.accountId}
              OR redemptions.customer_id <> ${account.customerId}
              OR redemptions.target::text <> entries.target::text
            )))
      ), 0) AS invalid_links
    FROM tool_quota_ledger
    WHERE account_id = ${account.accountId}
  `)
  const row = aggregate.rows?.[0]
  if (!row) throw pointsUnavailable()
  const balance = databaseInteger(row.balance)
  if (
    account.quotaLedgerVersion !== databaseInteger(row.max_sequence) ||
    databaseInteger(row.entry_count) !== databaseInteger(row.max_sequence) ||
    databaseInteger(row.invalid_links) !== 0n ||
    balance < 0n
  ) {
    throw pointsUnavailable('工具额度账本一致性校验失败')
  }
  return balance
}

async function assertOrderFact(
  database: PointsDatabase,
  input: {
    customerId: number | string
    orderId: number | string
    status: 'refunded' | 'succeeded'
  },
): Promise<void> {
  const found = await database.execute(sql`
    SELECT id, customer_id, status
    FROM orders
    WHERE id = ${input.orderId}
    FOR SHARE
  `)
  const row = found.rows?.[0]
  if (!row) throw new AppError('POINTS_SOURCE_ORDER_NOT_FOUND', '米币来源订单不存在', 409)
  if (String(row.customer_id) !== String(input.customerId)) {
    throw new AppError('POINTS_SOURCE_ORDER_OWNER_MISMATCH', '米币来源订单不属于目标用户', 409)
  }
  if (row.status !== input.status) {
    throw new AppError('POINTS_SOURCE_ORDER_STATE_INVALID', '米币来源订单状态不满足操作条件', 409)
  }
}

function batchFromRow(row: Record<string, unknown>): PointsBatch {
  return {
    accountId: identifier(row.account_id),
    batchId: identifier(row.id),
    customerId: identifier(row.customer_id),
    earningKey: String(row.earning_key),
    expiresAt: databaseDate(row.expires_at),
    points: databaseInteger(row.points),
    sourceOrderId: identifier(row.source_order_id),
  }
}

async function loadBatchByEarningKey(
  database: PointsDatabase,
  key: string,
): Promise<PointsBatch | undefined> {
  const found = await database.execute(sql`
    SELECT id, earning_key, customer_id, account_id, source_order_id, points, expires_at
    FROM points_batches
    WHERE earning_key = ${key}
  `)
  const row = found.rows?.[0]
  return row ? batchFromRow(row) : undefined
}

async function loadBatchById(
  database: PointsDatabase,
  batchId: number | string,
): Promise<PointsBatch | undefined> {
  const found = await database.execute(sql`
    SELECT id, earning_key, customer_id, account_id, source_order_id, points, expires_at
    FROM points_batches
    WHERE id = ${batchId}
  `)
  const row = found.rows?.[0]
  return row ? batchFromRow(row) : undefined
}

async function batchLifecycle(
  database: PointsDatabase,
  batch: PointsBatch,
): Promise<BatchLifecycle> {
  const aggregate = await database.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN entry_type = 'pending' THEN points ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN entry_type = 'available' THEN points ELSE 0 END), 0) AS available,
      COALESCE(SUM(CASE WHEN entry_type = 'held' THEN points ELSE 0 END), 0) AS held,
      COALESCE(SUM(CASE WHEN entry_type = 'consumed' THEN points ELSE 0 END), 0) AS consumed,
      COALESCE(SUM(CASE WHEN entry_type = 'expired' THEN points ELSE 0 END), 0) AS expired,
      COALESCE(SUM(CASE WHEN entry_type = 'reversed' THEN points ELSE 0 END), 0) AS reversed
    FROM points_ledger
    WHERE batch_id = ${batch.batchId}
  `)
  const row = aggregate.rows?.[0]
  if (!row) throw pointsUnavailable()
  const lifecycle = {
    available: databaseInteger(row.available),
    consumed: databaseInteger(row.consumed),
    expired: databaseInteger(row.expired),
    held: databaseInteger(row.held),
    pending: databaseInteger(row.pending),
    reversed: databaseInteger(row.reversed),
  }
  return lifecycle
}

function assertMatchingBatch(
  batch: PointsBatch,
  input: {
    accountId: number | string
    expiresAt: Date
    points: bigint
    sourceOrderId: number | string
  },
): void {
  if (
    String(batch.accountId) !== String(input.accountId) ||
    String(batch.sourceOrderId) !== String(input.sourceOrderId) ||
    batch.points !== input.points ||
    batch.expiresAt.getTime() !== input.expiresAt.getTime()
  ) {
    throw new AppError('POINTS_IDEMPOTENCY_CONFLICT', '米币赚取幂等键已用于其他事实', 409)
  }
}

async function incrementPointsLedgerVersion(
  database: PointsDatabase,
  account: LockedPointsAccount,
  delta = 1n,
): Promise<bigint> {
  const updated = await database.execute(sql`
    UPDATE points_accounts
    SET ledger_version = ledger_version + ${delta.toString()}, updated_at = NOW()
    WHERE id = ${account.accountId}
      AND ledger_version = ${account.ledgerVersion.toString()}
    RETURNING ledger_version
  `)
  const version = updated.rows?.[0]?.ledger_version
  if (version === undefined) throw pointsUnavailable()
  return databaseInteger(version)
}

async function claimPendingTransition(
  database: PointsDatabase,
  account: LockedPointsAccount,
  batch: PointsBatch,
): Promise<bigint> {
  const updated = await database.execute(sql`
    UPDATE points_accounts
    SET ledger_version = ledger_version + 1, updated_at = NOW()
    WHERE id = ${account.accountId}
      AND ledger_version = ${account.ledgerVersion.toString()}
      AND EXISTS (
        SELECT 1
        FROM points_ledger
        WHERE batch_id = ${batch.batchId}
          AND account_id = ${account.accountId}
          AND customer_id = ${account.customerId}
          AND entry_type = 'pending'
          AND points = ${batch.points.toString()}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM points_ledger
        WHERE batch_id = ${batch.batchId}
          AND account_id = ${account.accountId}
          AND customer_id = ${account.customerId}
          AND entry_type IN ('available', 'reversed')
      )
    RETURNING ledger_version
  `)
  const version = updated.rows?.[0]?.ledger_version
  if (version === undefined) throw pointsUnavailable()
  return databaseInteger(version)
}

async function appendPointsEntry(
  database: PointsDatabase,
  input: {
    account: LockedPointsAccount
    batchId: number | string
    entryKey: string
    entryType: 'available' | 'consumed' | 'expired' | 'held' | 'pending' | 'reversed'
    ledgerSequence: bigint
    points: bigint
    redemptionId?: number | string
  },
): Promise<void> {
  const inserted = await database.execute(sql`
    INSERT INTO points_ledger (
      entry_key,
      customer_id,
      account_id,
      batch_id,
      redemption_id,
      entry_type,
      points,
      ledger_sequence,
      updated_at,
      created_at
    ) VALUES (
      ${input.entryKey},
      ${input.account.customerId},
      ${input.account.accountId},
      ${input.batchId},
      ${input.redemptionId ?? null},
      ${input.entryType},
      ${input.points.toString()},
      ${input.ledgerSequence.toString()},
      NOW(),
      NOW()
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `)
  if (inserted.rows?.[0]?.id === undefined) throw pointsUnavailable()
}

export async function earnPendingOrderReward(
  req: PayloadRequest,
  input: {
    customerId: number | string
    earningKey: string
    expiresAt: string
    orderId: number | string
    points: bigint | number
  },
): Promise<PointsMutationResult> {
  assertSystemActor(req)
  const key = idempotencyKey(input.earningKey)
  const points = positiveInteger(input.points, 'POINTS_AMOUNT_INVALID', '米币数量必须是正整数')
  const expiresAt = expirationDate(input.expiresAt)
  if (expiresAt.getTime() <= Date.now()) {
    throw new AppError('POINTS_EXPIRATION_INVALID', '新米币批次的过期时间必须在未来', 400)
  }
  await assertCustomerAccountCapability(req, input.customerId, 'purchase')

  return inPointsTransaction(req, async () => {
    const database = await pointsDatabase(req)
    await assertOrderFact(database, {
      customerId: input.customerId,
      orderId: input.orderId,
      status: 'succeeded',
    })
    await ensurePointsAccount(database, input.customerId)
    const account = await lockPointsAccountByCustomer(database, input.customerId)
    const existing = await loadBatchByEarningKey(database, key)
    if (existing) {
      assertMatchingBatch(existing, {
        accountId: account.accountId,
        expiresAt,
        points,
        sourceOrderId: input.orderId,
      })
      await batchLifecycle(database, existing)
      return {
        applied: false,
        balance: await derivedPointsBalance(database, account),
        batchId: existing.batchId,
      }
    }

    const inserted = await database.execute(sql`
      INSERT INTO points_batches (
        earning_key,
        customer_id,
        account_id,
        source_type,
        source_order_id,
        points,
        expires_at,
        updated_at,
        created_at
      ) VALUES (
        ${key},
        ${account.customerId},
        ${account.accountId},
        'order_reward',
        ${input.orderId},
        ${points.toString()},
        ${expiresAt.toISOString()},
        NOW(),
        NOW()
      )
      ON CONFLICT (earning_key) DO NOTHING
      RETURNING id
    `)
    const insertedId = inserted.rows?.[0]?.id
    if (insertedId === undefined) {
      const conflicted = await loadBatchByEarningKey(database, key)
      if (!conflicted) throw pointsUnavailable()
      assertMatchingBatch(conflicted, {
        accountId: account.accountId,
        expiresAt,
        points,
        sourceOrderId: input.orderId,
      })
      await batchLifecycle(database, conflicted)
      return {
        applied: false,
        balance: await derivedPointsBalance(database, account),
        batchId: conflicted.batchId,
      }
    }

    const batchId = identifier(insertedId)
    const ledgerSequence = await incrementPointsLedgerVersion(database, account)
    await appendPointsEntry(database, {
      account,
      batchId,
      entryKey: `${key}:pending`,
      entryType: 'pending',
      ledgerSequence,
      points,
    })
    await recordAuditEvent(req, {
      action: 'points.reward.pending',
      actor: { type: 'system' },
      metadata: { orderId: String(input.orderId), points: points.toString() },
      targetId: batchId,
    })
    return {
      applied: true,
      balance: await derivedPointsBalance(database, { ...account, ledgerVersion: ledgerSequence }),
      batchId,
    }
  })
}

async function transitionPendingOrderReward(
  req: PayloadRequest,
  input: { earningKey: string; target: 'available' | 'reversed' },
): Promise<PointsMutationResult> {
  assertSystemActor(req)
  const key = idempotencyKey(input.earningKey)
  return inPointsTransaction(req, async () => {
    const database = await pointsDatabase(req)
    const discovered = await loadBatchByEarningKey(database, key)
    if (!discovered) throw new AppError('POINTS_BATCH_NOT_FOUND', '米币批次不存在', 409)
    await assertOrderFact(database, {
      customerId: discovered.customerId,
      orderId: discovered.sourceOrderId,
      status: input.target === 'available' ? 'succeeded' : 'refunded',
    })
    if (input.target === 'available') {
      await assertCustomerAccountCapability(req, discovered.customerId, 'purchase')
    }
    const account = await lockPointsAccountByCustomer(database, discovered.customerId)
    if (String(account.accountId) !== String(discovered.accountId)) throw pointsUnavailable()
    const lifecycle = await batchLifecycle(database, discovered)
    const alreadyApplied =
      input.target === 'available'
        ? lifecycle.available === discovered.points
        : lifecycle.reversed === discovered.points
    if (alreadyApplied) {
      return {
        applied: false,
        balance: await derivedPointsBalance(database, account),
        batchId: discovered.batchId,
      }
    }
    if (lifecycle.available > 0n || lifecycle.reversed > 0n) {
      throw new AppError('POINTS_BATCH_ALREADY_TRANSITIONED', '米币批次已按其他结果处理', 409)
    }

    const ledgerSequence = await claimPendingTransition(database, account, discovered)
    await appendPointsEntry(database, {
      account,
      batchId: discovered.batchId,
      entryKey: `${key}:${input.target}`,
      entryType: input.target,
      ledgerSequence,
      points: discovered.points,
    })
    await recordAuditEvent(req, {
      action: input.target === 'available' ? 'points.reward.available' : 'points.reward.reversed',
      actor: { type: 'system' },
      metadata: {
        orderId: String(discovered.sourceOrderId),
        points: discovered.points.toString(),
      },
      targetId: discovered.batchId,
    })
    return {
      applied: true,
      balance: await derivedPointsBalance(database, { ...account, ledgerVersion: ledgerSequence }),
      batchId: discovered.batchId,
    }
  })
}

export async function confirmPendingOrderReward(
  req: PayloadRequest,
  earningKeyValue: string,
): Promise<PointsMutationResult> {
  return transitionPendingOrderReward(req, { earningKey: earningKeyValue, target: 'available' })
}

export async function reversePendingOrderReward(
  req: PayloadRequest,
  earningKeyValue: string,
): Promise<PointsMutationResult> {
  return transitionPendingOrderReward(req, { earningKey: earningKeyValue, target: 'reversed' })
}

async function spendableBatches(
  database: PointsDatabase,
  account: LockedPointsAccount,
): Promise<Array<{ batchId: number | string; expiresAt: Date; remaining: bigint }>> {
  const found = await database.execute(sql`
    WITH balances AS (
      SELECT
        batches.id,
        batches.customer_id,
        batches.expires_at,
        COALESCE((
          SELECT SUM(points)
          FROM points_ledger
          WHERE batch_id = batches.id
            AND account_id = batches.account_id
            AND customer_id = batches.customer_id
            AND entry_type = 'available'
        ), 0)
        - COALESCE((
          SELECT SUM(points)
          FROM points_consumption_allocations
          WHERE batch_id = batches.id
            AND account_id = batches.account_id
            AND customer_id = batches.customer_id
        ), 0)
        - COALESCE((
          SELECT SUM(points)
          FROM points_ledger
          WHERE batch_id = batches.id
            AND account_id = batches.account_id
            AND customer_id = batches.customer_id
            AND entry_type = 'expired'
        ), 0) AS remaining
      FROM points_batches AS batches
      WHERE batches.account_id = ${account.accountId}
        AND batches.expires_at > NOW()
    )
    SELECT id, customer_id, expires_at, remaining
    FROM balances
    WHERE remaining > 0
    ORDER BY expires_at ASC, id ASC
  `)
  return (found.rows ?? []).map((row) => {
    if (String(row.customer_id) !== String(account.customerId)) throw pointsUnavailable()
    return {
      batchId: identifier(row.id),
      expiresAt: databaseDate(row.expires_at),
      remaining: databaseInteger(row.remaining),
    }
  })
}

function allocateEarliestExpiry(
  batches: Array<{ batchId: number | string; expiresAt: Date; remaining: bigint }>,
  pointsCost: bigint,
): PointsAllocation[] {
  let remainingCost = pointsCost
  const allocations: PointsAllocation[] = []
  for (const batch of batches) {
    if (remainingCost === 0n) break
    const allocated = batch.remaining < remainingCost ? batch.remaining : remainingCost
    if (allocated <= 0n) continue
    allocations.push({
      batchId: batch.batchId,
      expiresAt: batch.expiresAt.toISOString(),
      points: allocated,
    })
    remainingCost -= allocated
  }
  if (remainingCost !== 0n) {
    throw new AppError('POINTS_BALANCE_INSUFFICIENT', '可用米币不足', 409)
  }
  return allocations
}

async function existingRedemption(database: PointsDatabase, key: string) {
  const found = await database.execute(sql`
    SELECT id, customer_id, account_id, target, points_cost, quota_units
    FROM points_redemptions
    WHERE redemption_key = ${key}
  `)
  return found.rows?.[0]
}

function assertMatchingRedemption(
  row: Record<string, unknown>,
  input: {
    account: LockedPointsAccount
    pointsCost: bigint
    quotaUnits: bigint
    target: ToolQuotaTarget
  },
): number | string {
  if (
    String(row.account_id) !== String(input.account.accountId) ||
    row.target !== input.target ||
    databaseInteger(row.points_cost) !== input.pointsCost ||
    databaseInteger(row.quota_units) !== input.quotaUnits
  ) {
    throw new AppError('POINTS_IDEMPOTENCY_CONFLICT', '米币兑换幂等键已用于其他事实', 409)
  }
  return identifier(row.id)
}

async function persistedAllocations(
  database: PointsDatabase,
  input: {
    account: LockedPointsAccount
    pointsCost: bigint
    quotaUnits: bigint
    redemptionId: number | string
    target: ToolQuotaTarget
  },
): Promise<PointsAllocation[]> {
  const found = await database.execute(sql`
    SELECT
      allocations.batch_id,
      allocations.points,
      batches.expires_at
    FROM points_consumption_allocations AS allocations
    JOIN points_batches AS batches ON batches.id = allocations.batch_id
    WHERE allocations.redemption_id = ${input.redemptionId}
    ORDER BY batches.expires_at ASC, allocations.batch_id ASC
  `)
  const allocations = (found.rows ?? []).map((row) => ({
    batchId: identifier(row.batch_id),
    expiresAt: databaseDate(row.expires_at).toISOString(),
    points: databaseInteger(row.points),
  }))
  const allocated = allocations.reduce((total, allocation) => total + allocation.points, 0n)
  if (allocated !== input.pointsCost) throw pointsUnavailable('米币兑换分配不完整')

  const evidence = await database.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE entry_type = 'held') AS held_count,
      COUNT(*) FILTER (WHERE entry_type = 'consumed') AS consumed_count,
      COUNT(*) FILTER (
        WHERE customer_id <> ${input.account.customerId}
          OR account_id <> ${input.account.accountId}
          OR entry_type NOT IN ('held', 'consumed')
          OR NOT EXISTS (
            SELECT 1
            FROM points_consumption_allocations AS allocations
            WHERE allocations.redemption_id = ${input.redemptionId}
              AND allocations.batch_id = points_ledger.batch_id
              AND allocations.points = points_ledger.points
          )
      ) AS invalid_facts
    FROM points_ledger
    WHERE redemption_id = ${input.redemptionId}
  `)
  const evidenceRow = evidence.rows?.[0]
  const quota = await database.execute(sql`
    SELECT quota_units
    FROM tool_quota_ledger
    WHERE redemption_id = ${input.redemptionId}
  `)
  const quotaRow = quota.rows?.[0]
  if (
    !evidenceRow ||
    databaseInteger(evidenceRow.held_count) !== BigInt(allocations.length) ||
    databaseInteger(evidenceRow.consumed_count) !== BigInt(allocations.length) ||
    databaseInteger(evidenceRow.invalid_facts) !== 0n ||
    quota.rows?.length !== 1 ||
    !quotaRow ||
    databaseInteger(quotaRow.quota_units) !== input.quotaUnits
  ) {
    throw pointsUnavailable('米币兑换事实不完整')
  }
  return allocations
}

async function reservePointsConsumption(
  database: PointsDatabase,
  account: LockedPointsAccount,
  pointsCost: bigint,
  sequenceDelta: bigint,
): Promise<bigint> {
  const updated = await database.execute(sql`
    UPDATE points_accounts
    SET ledger_version = ledger_version + ${sequenceDelta.toString()}, updated_at = NOW()
    WHERE id = ${account.accountId}
      AND ledger_version = ${account.ledgerVersion.toString()}
      AND ${pointsCost.toString()} <= (
        SELECT COALESCE(SUM(remaining), 0)
        FROM (
          SELECT
            COALESCE((
              SELECT SUM(points)
              FROM points_ledger
              WHERE batch_id = batches.id
                AND account_id = batches.account_id
                AND customer_id = batches.customer_id
                AND entry_type = 'available'
            ), 0)
            - COALESCE((
              SELECT SUM(points)
              FROM points_consumption_allocations
              WHERE batch_id = batches.id
                AND account_id = batches.account_id
                AND customer_id = batches.customer_id
            ), 0)
            - COALESCE((
              SELECT SUM(points)
              FROM points_ledger
              WHERE batch_id = batches.id
                AND account_id = batches.account_id
                AND customer_id = batches.customer_id
                AND entry_type = 'expired'
            ), 0) AS remaining
          FROM points_batches AS batches
          WHERE batches.account_id = ${account.accountId}
            AND batches.expires_at > NOW()
        ) AS spendable
        WHERE remaining > 0
      )
    RETURNING ledger_version
  `)
  const version = updated.rows?.[0]?.ledger_version
  if (version === undefined) throw new AppError('POINTS_BALANCE_INSUFFICIENT', '可用米币不足', 409)
  return databaseInteger(version)
}

async function insertAllocation(
  database: PointsDatabase,
  input: {
    account: LockedPointsAccount
    allocation: PointsAllocation
    key: string
    redemptionId: number | string
  },
): Promise<void> {
  const inserted = await database.execute(sql`
    INSERT INTO points_consumption_allocations (
      allocation_key,
      customer_id,
      account_id,
      redemption_id,
      batch_id,
      points,
      updated_at,
      created_at
    ) VALUES (
      ${`${input.key}:${input.allocation.batchId}`},
      ${input.account.customerId},
      ${input.account.accountId},
      ${input.redemptionId},
      ${input.allocation.batchId},
      ${input.allocation.points.toString()},
      NOW(),
      NOW()
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `)
  if (inserted.rows?.[0]?.id === undefined) throw pointsUnavailable()
}

async function appendQuotaEntry(
  database: PointsDatabase,
  input: {
    account: LockedPointsAccount
    entryKey: string
    entryType: 'consume' | 'grant'
    ledgerSequence: bigint
    quotaUnits: bigint
    redemptionId?: number | string
    target: ToolQuotaTarget
  },
): Promise<void> {
  const inserted = await database.execute(sql`
    INSERT INTO tool_quota_ledger (
      entry_key,
      customer_id,
      account_id,
      redemption_id,
      target,
      entry_type,
      quota_units,
      ledger_sequence,
      updated_at,
      created_at
    ) VALUES (
      ${input.entryKey},
      ${input.account.customerId},
      ${input.account.accountId},
      ${input.redemptionId ?? null},
      ${input.target},
      ${input.entryType},
      ${input.quotaUnits.toString()},
      ${input.ledgerSequence.toString()},
      NOW(),
      NOW()
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `)
  if (inserted.rows?.[0]?.id === undefined) throw pointsUnavailable()
}

export async function redeemPointsForToolQuota(
  req: PayloadRequest,
  input: {
    customerId: number | string
    pointsCost: bigint | number
    quotaUnits: bigint | number
    redemptionKey: string
    target: string
  },
): Promise<PointsRedemptionResult> {
  assertCustomerActor(req, input.customerId)
  const key = idempotencyKey(input.redemptionKey)
  const pointsCost = positiveInteger(
    input.pointsCost,
    'POINTS_AMOUNT_INVALID',
    '米币数量必须是正整数',
  )
  const quotaUnits = positiveInteger(
    input.quotaUnits,
    'TOOL_QUOTA_AMOUNT_INVALID',
    '工具额度必须是正整数',
  )
  const target = quotaTarget(input.target)
  await assertCustomerAccountCapability(req, input.customerId, 'purchase')

  return inPointsTransaction(req, async () => {
    const database = await pointsDatabase(req)
    const account = await lockPointsAccountByCustomer(database, input.customerId)
    await derivedPointsBalance(database, account)
    const existing = await existingRedemption(database, key)
    if (existing) {
      const redemptionId = assertMatchingRedemption(existing, {
        account,
        pointsCost,
        quotaUnits,
        target,
      })
      const allocations = await persistedAllocations(database, {
        account,
        pointsCost,
        quotaUnits,
        redemptionId,
        target,
      })
      return {
        allocations,
        applied: false,
        balance: await derivedPointsBalance(database, account),
        quotaBalance: await derivedQuotaBalance(database, account, target),
        redemptionId,
      }
    }

    const allocations = allocateEarliestExpiry(
      await spendableBatches(database, account),
      pointsCost,
    )
    const inserted = await database.execute(sql`
      INSERT INTO points_redemptions (
        redemption_key,
        customer_id,
        account_id,
        target,
        points_cost,
        quota_units,
        updated_at,
        created_at
      ) VALUES (
        ${key},
        ${account.customerId},
        ${account.accountId},
        ${target},
        ${pointsCost.toString()},
        ${quotaUnits.toString()},
        NOW(),
        NOW()
      )
      ON CONFLICT (redemption_key) DO NOTHING
      RETURNING id
    `)
    const redemptionIdValue = inserted.rows?.[0]?.id
    if (redemptionIdValue === undefined) {
      throw new AppError('POINTS_IDEMPOTENCY_CONFLICT', '米币兑换幂等键发生并发冲突', 409)
    }
    const redemptionId = identifier(redemptionIdValue)
    const sequenceDelta = BigInt(allocations.length * 2)
    const endingSequence = await reservePointsConsumption(
      database,
      account,
      pointsCost,
      sequenceDelta,
    )
    let sequence = endingSequence - sequenceDelta
    for (const allocation of allocations) {
      await insertAllocation(database, { account, allocation, key, redemptionId })
      sequence += 1n
      await appendPointsEntry(database, {
        account,
        batchId: allocation.batchId,
        entryKey: `${key}:${allocation.batchId}:held`,
        entryType: 'held',
        ledgerSequence: sequence,
        points: allocation.points,
        redemptionId,
      })
      sequence += 1n
      await appendPointsEntry(database, {
        account,
        batchId: allocation.batchId,
        entryKey: `${key}:${allocation.batchId}:consumed`,
        entryType: 'consumed',
        ledgerSequence: sequence,
        points: allocation.points,
        redemptionId,
      })
    }
    if (sequence !== endingSequence) throw pointsUnavailable()

    const quotaVersion = await database.execute(sql`
      UPDATE points_accounts
      SET quota_ledger_version = quota_ledger_version + 1, updated_at = NOW()
      WHERE id = ${account.accountId}
        AND quota_ledger_version = ${account.quotaLedgerVersion.toString()}
      RETURNING quota_ledger_version
    `)
    const quotaSequenceValue = quotaVersion.rows?.[0]?.quota_ledger_version
    if (quotaSequenceValue === undefined) throw pointsUnavailable()
    const quotaSequence = databaseInteger(quotaSequenceValue)
    await appendQuotaEntry(database, {
      account,
      entryKey: `${key}:quota-grant`,
      entryType: 'grant',
      ledgerSequence: quotaSequence,
      quotaUnits,
      redemptionId,
      target,
    })
    await recordAuditEvent(req, {
      action: 'points.redeemed',
      metadata: {
        pointsCost: pointsCost.toString(),
        quotaUnits: quotaUnits.toString(),
        target,
      },
      targetId: redemptionId,
    })
    const updatedAccount = {
      ...account,
      ledgerVersion: endingSequence,
      quotaLedgerVersion: quotaSequence,
    }
    return {
      allocations,
      applied: true,
      balance: await derivedPointsBalance(database, updatedAccount),
      quotaBalance: await derivedQuotaBalance(database, updatedAccount, target),
      redemptionId,
    }
  })
}

export async function consumeToolQuota(
  req: PayloadRequest,
  input: {
    customerId: number | string
    quotaUnits: bigint | number
    target: string
    usageKey: string
  },
): Promise<{ applied: boolean; quotaBalance: bigint }> {
  assertCustomerActor(req, input.customerId)
  const key = idempotencyKey(input.usageKey)
  const quotaUnits = positiveInteger(
    input.quotaUnits,
    'TOOL_QUOTA_AMOUNT_INVALID',
    '工具额度必须是正整数',
  )
  const target = quotaTarget(input.target)
  await assertCustomerAccountCapability(req, input.customerId, 'login')

  return inPointsTransaction(req, async () => {
    const database = await pointsDatabase(req)
    const account = await lockPointsAccountByCustomer(database, input.customerId)
    await derivedQuotaBalance(database, account, target)
    const entryKey = `${key}:quota-consume`
    const existing = await database.execute(sql`
      SELECT customer_id, account_id, target, entry_type, quota_units
      FROM tool_quota_ledger
      WHERE entry_key = ${entryKey}
    `)
    const existingRow = existing.rows?.[0]
    if (existingRow) {
      if (
        String(existingRow.account_id) !== String(account.accountId) ||
        existingRow.target !== target ||
        databaseInteger(existingRow.quota_units) !== quotaUnits
      ) {
        throw new AppError('POINTS_IDEMPOTENCY_CONFLICT', '工具额度幂等键已用于其他事实', 409)
      }
      return {
        applied: false,
        quotaBalance: await derivedQuotaBalance(database, account, target),
      }
    }

    const reserved = await database.execute(sql`
      UPDATE points_accounts
      SET quota_ledger_version = quota_ledger_version + 1, updated_at = NOW()
      WHERE id = ${account.accountId}
        AND quota_ledger_version = ${account.quotaLedgerVersion.toString()}
        AND ${quotaUnits.toString()} <= (
          SELECT COALESCE(SUM(
            CASE
              WHEN entry_type = 'grant' THEN quota_units
              WHEN entry_type = 'consume' THEN -quota_units
              ELSE 0
            END
          ), 0)
          FROM tool_quota_ledger
          WHERE account_id = ${account.accountId}
            AND target = ${target}
        )
      RETURNING quota_ledger_version
    `)
    const quotaSequenceValue = reserved.rows?.[0]?.quota_ledger_version
    if (quotaSequenceValue === undefined) {
      throw new AppError('TOOL_QUOTA_INSUFFICIENT', '工具额度不足', 409)
    }
    const quotaSequence = databaseInteger(quotaSequenceValue)
    await appendQuotaEntry(database, {
      account,
      entryKey,
      entryType: 'consume',
      ledgerSequence: quotaSequence,
      quotaUnits,
      target,
    })
    await recordAuditEvent(req, {
      action: 'points.tool_quota.consumed',
      metadata: { quotaUnits: quotaUnits.toString(), target },
      targetId: account.accountId,
    })
    return {
      applied: true,
      quotaBalance: await derivedQuotaBalance(
        database,
        { ...account, quotaLedgerVersion: quotaSequence },
        target,
      ),
    }
  })
}

async function batchRemainingPoints(database: PointsDatabase, batch: PointsBatch): Promise<bigint> {
  const aggregate = await database.execute(sql`
    SELECT
      COALESCE((
        SELECT SUM(points)
        FROM points_ledger
        WHERE batch_id = ${batch.batchId}
          AND account_id = ${batch.accountId}
          AND customer_id = ${batch.customerId}
          AND entry_type = 'available'
      ), 0)
      - COALESCE((
        SELECT SUM(points)
        FROM points_consumption_allocations
        WHERE batch_id = ${batch.batchId}
          AND account_id = ${batch.accountId}
          AND customer_id = ${batch.customerId}
      ), 0)
      - COALESCE((
        SELECT SUM(points)
        FROM points_ledger
        WHERE batch_id = ${batch.batchId}
          AND account_id = ${batch.accountId}
          AND customer_id = ${batch.customerId}
          AND entry_type = 'expired'
      ), 0) AS remaining
  `)
  const remaining = databaseInteger(aggregate.rows?.[0]?.remaining)
  if (remaining < 0n) throw pointsUnavailable('米币批次剩余额度不一致')
  return remaining
}

async function expireBatch(
  req: PayloadRequest,
  input: { batchId: number | string; cutoff: Date },
): Promise<bigint> {
  return inPointsTransaction(req, async () => {
    const database = await pointsDatabase(req)
    const batch = await loadBatchById(database, input.batchId)
    if (!batch || batch.expiresAt.getTime() > input.cutoff.getTime()) return 0n
    const account = await lockPointsAccountByCustomer(database, batch.customerId)
    if (String(account.accountId) !== String(batch.accountId)) throw pointsUnavailable()
    const lifecycle = await batchLifecycle(database, batch)
    if (lifecycle.available === 0n || lifecycle.reversed > 0n) return 0n
    const remaining = await batchRemainingPoints(database, batch)
    if (remaining === 0n) return 0n

    const claimed = await database.execute(sql`
      UPDATE points_accounts
      SET ledger_version = ledger_version + 1, updated_at = NOW()
      WHERE id = ${account.accountId}
        AND ledger_version = ${account.ledgerVersion.toString()}
        AND EXISTS (
          SELECT 1
          FROM points_batches
          WHERE id = ${batch.batchId}
            AND expires_at <= ${input.cutoff.toISOString()}
        )
        AND 0 < (
          COALESCE((
            SELECT SUM(points)
            FROM points_ledger
            WHERE batch_id = ${batch.batchId}
              AND account_id = ${batch.accountId}
              AND customer_id = ${batch.customerId}
              AND entry_type = 'available'
          ), 0)
          - COALESCE((
            SELECT SUM(points)
            FROM points_consumption_allocations
            WHERE batch_id = ${batch.batchId}
              AND account_id = ${batch.accountId}
              AND customer_id = ${batch.customerId}
          ), 0)
          - COALESCE((
            SELECT SUM(points)
            FROM points_ledger
            WHERE batch_id = ${batch.batchId}
              AND account_id = ${batch.accountId}
              AND customer_id = ${batch.customerId}
              AND entry_type = 'expired'
          ), 0)
        )
      RETURNING ledger_version
    `)
    const sequenceValue = claimed.rows?.[0]?.ledger_version
    if (sequenceValue === undefined) throw pointsUnavailable()
    const ledgerSequence = databaseInteger(sequenceValue)
    await appendPointsEntry(database, {
      account,
      batchId: batch.batchId,
      entryKey: `points-expiration:${batch.batchId}`,
      entryType: 'expired',
      ledgerSequence,
      points: remaining,
    })
    await recordAuditEvent(req, {
      action: 'points.expired',
      actor: { type: 'system' },
      metadata: { points: remaining.toString() },
      targetId: batch.batchId,
    })
    return remaining
  })
}

export async function runPointsExpiration(
  req: PayloadRequest,
  options: { cutoff?: Date; maxBatches?: number } = {},
): Promise<{ expiredBatches: number; expiredPoints: bigint }> {
  assertSystemActor(req)
  const cutoff = options.cutoff ?? new Date()
  if (!Number.isFinite(cutoff.getTime())) {
    throw new AppError('POINTS_EXPIRATION_INVALID', '米币过期截止时间无效', 400)
  }
  const maxBatches = options.maxBatches ?? 100
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_EXPIRATION_BATCHES) {
    throw new AppError('POINTS_EXPIRATION_LIMIT_INVALID', '米币过期批次数量限制无效', 400)
  }
  const candidates = await req.payload.db.pool.query<{ id: number | string }>(
    `SELECT batches.id
     FROM points_batches AS batches
     WHERE batches.expires_at <= $1
       AND EXISTS (
         SELECT 1 FROM points_ledger
         WHERE batch_id = batches.id
           AND account_id = batches.account_id
           AND customer_id = batches.customer_id
           AND entry_type = 'available'
       )
       AND 0 < (
         COALESCE((
           SELECT SUM(points) FROM points_ledger
           WHERE batch_id = batches.id
             AND account_id = batches.account_id
             AND customer_id = batches.customer_id
             AND entry_type = 'available'
         ), 0)
         - COALESCE((
           SELECT SUM(points) FROM points_consumption_allocations
           WHERE batch_id = batches.id
             AND account_id = batches.account_id
             AND customer_id = batches.customer_id
         ), 0)
         - COALESCE((
           SELECT SUM(points) FROM points_ledger
           WHERE batch_id = batches.id
             AND account_id = batches.account_id
             AND customer_id = batches.customer_id
             AND entry_type = 'expired'
         ), 0)
       )
     ORDER BY batches.expires_at ASC, batches.id ASC
     LIMIT $2`,
    [cutoff.toISOString(), maxBatches],
  )
  let expiredBatches = 0
  let expiredPoints = 0n
  for (const candidate of candidates.rows) {
    const expired = await expireBatch(req, { batchId: identifier(candidate.id), cutoff })
    if (expired > 0n) {
      expiredBatches += 1
      expiredPoints += expired
    }
  }
  return { expiredBatches, expiredPoints }
}

export async function readPointsBalance(
  req: PayloadRequest,
  customerId: number | string,
): Promise<PointsBalance> {
  if (req.user) assertCustomerActor(req, customerId)
  return inPointsTransaction(req, async () => {
    const database = await pointsDatabase(req)
    const account = await shareLockPointsAccountByCustomer(database, customerId)
    return derivedPointsBalance(database, account)
  })
}

export async function readBatchRemainingPoints(
  req: PayloadRequest,
  input: { batchId: number | string; customerId: number | string },
): Promise<bigint> {
  if (req.user) assertCustomerActor(req, input.customerId)
  return inPointsTransaction(req, async () => {
    const database = await pointsDatabase(req)
    const account = await shareLockPointsAccountByCustomer(database, input.customerId)
    const batch = await loadBatchById(database, input.batchId)
    if (
      !batch ||
      String(batch.customerId) !== String(account.customerId) ||
      String(batch.accountId) !== String(account.accountId)
    ) {
      throw new AppError('POINTS_BATCH_NOT_FOUND', '米币批次不存在', 404)
    }
    return batchRemainingPoints(database, batch)
  })
}

export async function readToolQuotaBalance(
  req: PayloadRequest,
  input: { customerId: number | string; target: string },
): Promise<bigint> {
  if (req.user) assertCustomerActor(req, input.customerId)
  const target = quotaTarget(input.target)
  return inPointsTransaction(req, async () => {
    const database = await pointsDatabase(req)
    const account = await shareLockPointsAccountByCustomer(database, input.customerId)
    return derivedQuotaBalance(database, account, target)
  })
}
