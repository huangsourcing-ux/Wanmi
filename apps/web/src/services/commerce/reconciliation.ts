import { createHash } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

type Period = {
  end: string
  start: string
}

export type WechatStatementEntry =
  | {
      amountMinor: number
      currency: 'CNY'
      merchantOrderNumber: string
      type: 'payment'
      wechatTransactionId: string
    }
  | {
      amountMinor: number
      currency: 'CNY'
      providerRefundId: string
      refundNumber: string
      type: 'refund'
    }
  | {
      amountMinor: number
      currency: 'CNY'
      recoveryKey: string
      topUpOrderNumber: string
      type: 'wallet_recovery'
    }

type WestdigitalBalanceStatement = {
  closingAvailableMinor: number
  closingFrozenMinor: number
  creditsMinor: number
  debits: Array<{ amountMinor: number; operationKey: string }>
  openingAvailableMinor: number
  openingFrozenMinor: number
}

function assertPeriod(period: Period): void {
  if (
    !Number.isFinite(Date.parse(period.start)) ||
    !Number.isFinite(Date.parse(period.end)) ||
    Date.parse(period.start) >= Date.parse(period.end)
  ) {
    throw new AppError('RECONCILIATION_PERIOD_INVALID', '对账周期无效', 400)
  }
}

function assertMinor(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError('RECONCILIATION_AMOUNT_INVALID', `${field} 必须是非负整数分`, 400)
  }
}

function reconciliationKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

type ReconciliationDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

type ReconciliationReview = {
  customerId?: number | string
  evidence: Record<string, unknown>
  orderId?: number | string
  reasonCode: string
  walletAccountId?: number | string
  walletTopUpOrderId?: number | string
}

async function reconciliationDatabase(req: PayloadRequest): Promise<ReconciliationDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const database = session?.db as ReconciliationDatabase | undefined
  if (!database) {
    throw new AppError('RECONCILIATION_UNAVAILABLE', '无法建立安全对账事务', 503)
  }
  return database
}

async function inReconciliationTransaction<T>(
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

async function persistReconciliation(
  req: PayloadRequest,
  input: {
    differenceMinor: number
    kind: 'three_way' | 'wallet' | 'wechat' | 'westdigital'
    ledger: 'internal_orders' | 'wallet_balance' | 'wechat_funds' | 'westdigital_prepaid'
    period: Period
    recordKey: string
    review?: ReconciliationReview
    summary: Record<string, unknown>
    traceId: string
  },
) {
  const key = reconciliationKey([
    input.kind,
    input.ledger,
    input.period.start,
    input.period.end,
    input.recordKey,
  ])
  return inReconciliationTransaction(req, async () => {
    const inserted = await (
      await reconciliationDatabase(req)
    ).execute(sql`
      INSERT INTO reconciliations (
        reconciliation_key,
        kind,
        ledger,
        record_key,
        period_start,
        period_end,
        status,
        summary,
        difference_minor,
        currency,
        trace_id,
        updated_at,
        created_at
      ) VALUES (
        ${key},
        ${input.kind},
        ${input.ledger},
        ${input.recordKey},
        ${input.period.start}::timestamptz,
        ${input.period.end}::timestamptz,
        ${input.differenceMinor === 0 ? 'matched' : 'difference'},
        ${JSON.stringify(input.summary)}::jsonb,
        ${input.differenceMinor},
        'CNY',
        ${input.traceId},
        NOW(),
        NOW()
      )
      ON CONFLICT (reconciliation_key) DO NOTHING
      RETURNING id
    `)
    const insertedId = inserted.rows?.[0]?.id
    const records = await req.payload.find({
      collection: 'reconciliations',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      req,
      where: { reconciliationKey: { equals: key } },
    })
    const record = records.docs[0]
    if (records.docs.length !== 1 || !record) {
      throw new AppError('RECONCILIATION_UNAVAILABLE', '对账证据写入失败', 503)
    }
    if (insertedId === undefined) return { idempotentReplay: true, record }

    if (input.differenceMinor !== 0) {
      req.payload.logger.warn(
        { kind: input.kind, ledger: input.ledger, reconciliationKey: key },
        'reconciliation difference recorded for manual confirmation',
      )
      if (input.review) {
        await req.payload.create({
          collection: 'manualReviews',
          data: {
            ...(input.review.customerId === undefined
              ? {}
              : { customer: input.review.customerId as never }),
            evidence: {
              ...input.review.evidence,
              correctionApplied: false,
              reconciliationKey: key,
            },
            ...(input.review.orderId === undefined ? {} : { order: input.review.orderId as never }),
            reasonCode: input.review.reasonCode,
            reconciliation: record.id as never,
            status: 'open',
            ...(input.review.walletAccountId === undefined
              ? {}
              : { walletAccount: input.review.walletAccountId as never }),
            ...(input.review.walletTopUpOrderId === undefined
              ? {}
              : { walletTopUpOrder: input.review.walletTopUpOrderId as never }),
          },
          overrideAccess: true,
          req,
        })
        await recordAuditEvent(req, {
          action: 'wallet.reconciliation.difference_recorded',
          actor: { type: 'system' },
          metadata: {
            differenceMinor: input.differenceMinor,
            ledger: input.ledger,
            reasonCode: input.review.reasonCode,
            reconciliationKey: key,
            recordKey: input.recordKey,
          },
          targetId: record.id,
        })
      }
    }
    return { idempotentReplay: false, record }
  })
}

export async function reconcileWechatFunds(
  req: PayloadRequest,
  input: { entries: WechatStatementEntry[]; period: Period; traceId: string },
) {
  assertPeriod(input.period)
  const results = []
  for (const entry of input.entries) {
    assertMinor(entry.amountMinor, '微信账单金额')
    if (entry.type === 'payment') {
      const orders = await req.payload.find({
        collection: 'orders',
        depth: 0,
        limit: 2,
        overrideAccess: true,
        req,
        where: { merchantOrderNumber: { equals: entry.merchantOrderNumber } },
      })
      const topUps = await req.payload.find({
        collection: 'walletTopUpOrders',
        depth: 0,
        limit: 2,
        overrideAccess: true,
        req,
        where: { topUpOrderNumber: { equals: entry.merchantOrderNumber } },
      })
      const order = orders.docs[0]
      const topUp = topUps.docs[0]
      const topUpWechatIdMatches = topUp?.wechatTransactionId === entry.wechatTransactionId
      const sourceCount = Number(Boolean(order)) + Number(Boolean(topUp && topUpWechatIdMatches))
      const expectedMinor = sourceCount === 1 ? (order?.amountMinor ?? topUp?.amountFen ?? 0) : 0
      const differenceMinor = entry.amountMinor - expectedMinor
      results.push(
        await persistReconciliation(req, {
          differenceMinor,
          kind: 'wechat',
          ledger: 'wechat_funds',
          period: input.period,
          recordKey: `payment:${entry.wechatTransactionId}`,
          summary: {
            entryType: 'payment',
            expectedMinor,
            internalOrderFound: Boolean(order),
            observedMinor: entry.amountMinor,
            walletTopUpOrderFound: Boolean(topUp),
            walletTopUpOrderNumber: topUp?.topUpOrderNumber,
            walletTopUpWechatTransactionMatched: topUpWechatIdMatches,
          },
          traceId: input.traceId,
        }),
      )
    } else if (entry.type === 'refund') {
      const found = await req.payload.find({
        collection: 'refunds',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        req,
        where: { refundNumber: { equals: entry.refundNumber } },
      })
      const refund = found.docs[0]
      const expectedMinor = refund?.amountMinor ?? 0
      const differenceMinor = entry.amountMinor - expectedMinor
      results.push(
        await persistReconciliation(req, {
          differenceMinor,
          kind: 'wechat',
          ledger: 'wechat_funds',
          period: input.period,
          recordKey: `refund:${entry.providerRefundId}`,
          summary: {
            entryType: 'refund',
            expectedMinor,
            internalRefundFound: Boolean(refund),
            observedMinor: entry.amountMinor,
          },
          traceId: input.traceId,
        }),
      )
    } else {
      const found = await req.payload.find({
        collection: 'walletTopUpOrders',
        depth: 0,
        limit: 2,
        overrideAccess: true,
        req,
        where: { topUpOrderNumber: { equals: entry.topUpOrderNumber } },
      })
      const topUp = found.docs[0]
      const recoveryMatches =
        found.docs.length === 1 &&
        topUp?.paymentRecoveryKey === entry.recoveryKey &&
        Boolean(topUp.paymentRecoveryType) &&
        Boolean(topUp.paymentRecoveredAt)
      const expectedMinor = recoveryMatches ? topUp.amountFen : 0
      const differenceMinor = entry.amountMinor - expectedMinor
      results.push(
        await persistReconciliation(req, {
          differenceMinor,
          kind: 'wechat',
          ledger: 'wechat_funds',
          period: input.period,
          recordKey: `wallet-recovery:${entry.recoveryKey}`,
          summary: {
            entryType: 'wallet_recovery',
            expectedMinor,
            observedMinor: entry.amountMinor,
            recoveryKey: entry.recoveryKey,
            recoveryRecordMatched: recoveryMatches,
            walletTopUpOrderFound: Boolean(topUp),
            walletTopUpOrderNumber: entry.topUpOrderNumber,
          },
          traceId: input.traceId,
        }),
      )
    }
  }
  return results
}

export async function reconcileWestdigitalPrepaidBalance(
  req: PayloadRequest,
  input: { period: Period; statement: WestdigitalBalanceStatement; traceId: string },
) {
  assertPeriod(input.period)
  const values = [
    ['期初可用余额', input.statement.openingAvailableMinor],
    ['期初冻结金额', input.statement.openingFrozenMinor],
    ['期末可用余额', input.statement.closingAvailableMinor],
    ['期末冻结金额', input.statement.closingFrozenMinor],
    ['充值金额', input.statement.creditsMinor],
  ] as const
  for (const [field, value] of values) assertMinor(value, field)
  for (const debit of input.statement.debits) assertMinor(debit.amountMinor, '西部数码扣款金额')
  const debitsMinor = input.statement.debits.reduce((sum, item) => sum + item.amountMinor, 0)
  if (!Number.isSafeInteger(debitsMinor)) {
    throw new AppError('RECONCILIATION_AMOUNT_OVERFLOW', '西部数码扣款合计溢出', 400)
  }
  const expectedClosingMinor =
    input.statement.openingAvailableMinor + input.statement.creditsMinor - debitsMinor
  const differenceMinor = input.statement.closingAvailableMinor - expectedClosingMinor
  return persistReconciliation(req, {
    differenceMinor,
    kind: 'westdigital',
    ledger: 'westdigital_prepaid',
    period: input.period,
    recordKey: 'available-balance',
    summary: {
      closingAvailableMinor: input.statement.closingAvailableMinor,
      closingFrozenMinor: input.statement.closingFrozenMinor,
      correctionApplied: false,
      creditsMinor: input.statement.creditsMinor,
      debitCount: input.statement.debits.length,
      debitsMinor,
      expectedClosingMinor,
      openingAvailableMinor: input.statement.openingAvailableMinor,
      openingFrozenMinor: input.statement.openingFrozenMinor,
      source: 'westdigital_checkbalance_fixture',
    },
    traceId: input.traceId,
  })
}

export async function recordWestdigitalBalanceObservation(
  req: PayloadRequest,
  input: {
    availableMinor: number
    frozenMinor: number
    observedAt: string
    providerRequestId: string
    traceId: string
  },
) {
  assertMinor(input.availableMinor, '西部数码可用余额')
  assertMinor(input.frozenMinor, '西部数码冻结金额')
  const observedAt = Date.parse(input.observedAt)
  if (!Number.isFinite(observedAt)) {
    throw new AppError('RECONCILIATION_PERIOD_INVALID', '余额观察时间无效', 400)
  }
  return persistReconciliation(req, {
    differenceMinor: 0,
    kind: 'westdigital',
    ledger: 'westdigital_prepaid',
    period: {
      end: new Date(observedAt + 1).toISOString(),
      start: new Date(observedAt).toISOString(),
    },
    recordKey: `balance-observation:${input.providerRequestId}`,
    summary: {
      availableMinor: input.availableMinor,
      correctionApplied: false,
      frozenMinor: input.frozenMinor,
      providerRequestId: input.providerRequestId,
      source: 'westdigital_checkbalance',
    },
    traceId: input.traceId,
  })
}

export async function recordThreeWayDifference(
  req: PayloadRequest,
  input: {
    orderNumber: string
    period: Period
    traceId: string
    wechatReconciliationKey: string
    westdigitalReconciliationKey: string
  },
) {
  assertPeriod(input.period)
  const sources = await req.payload.find({
    collection: 'reconciliations',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    req,
    where: {
      or: [
        { reconciliationKey: { equals: input.wechatReconciliationKey } },
        { reconciliationKey: { equals: input.westdigitalReconciliationKey } },
      ],
    },
  })
  const wechat = sources.docs.find((row) => row.ledger === 'wechat_funds')
  const westdigital = sources.docs.find((row) => row.ledger === 'westdigital_prepaid')
  if (!wechat || !westdigital) {
    throw new AppError('RECONCILIATION_SOURCE_MISSING', '三方对账缺少独立账本证据', 409)
  }
  const differenceMinor = Math.abs(wechat.differenceMinor) + Math.abs(westdigital.differenceMinor)
  return persistReconciliation(req, {
    differenceMinor,
    kind: 'three_way',
    ledger: 'internal_orders',
    period: input.period,
    recordKey: `order:${input.orderNumber}`,
    summary: {
      correctionApplied: false,
      orderNumber: input.orderNumber,
      wechatReconciliationKey: input.wechatReconciliationKey,
      westdigitalReconciliationKey: input.westdigitalReconciliationKey,
    },
    traceId: input.traceId,
  })
}

const WALLET_RECONCILIATION_SOURCE_ATTEMPTS = 2
const MAX_SAFE_MONEY = BigInt(Number.MAX_SAFE_INTEGER)

type WalletReconciliationRow = Record<string, unknown>

function databaseInteger(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value)
  throw new AppError('RECONCILIATION_SOURCE_INVALID', '对账事实包含无效整数金额', 503)
}

function databaseIdentifier(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) return value
  throw new AppError('RECONCILIATION_SOURCE_INVALID', '对账事实包含无效业务标识', 503)
}

function optionalIdentifier(value: unknown): number | string | undefined {
  return value === null || value === undefined ? undefined : databaseIdentifier(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safeDifferenceMinor(value: bigint): number {
  if (value > MAX_SAFE_MONEY || value < -MAX_SAFE_MONEY) {
    throw new AppError('RECONCILIATION_AMOUNT_OVERFLOW', '对账差异金额溢出', 400)
  }
  return Number(value)
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value
}

function reconciliationSummary(record: { summary?: unknown }): Record<string, unknown> {
  if (!record.summary || typeof record.summary !== 'object' || Array.isArray(record.summary)) {
    throw new AppError('RECONCILIATION_SOURCE_INVALID', '微信对账证据摘要无效', 503)
  }
  return record.summary as Record<string, unknown>
}

async function recordWalletReconciliationSourceFailure(
  req: PayloadRequest,
  input: { attempts: number; outcome: 'exhausted' | 'retry_succeeded'; traceId: string },
): Promise<void> {
  await recordAuditEvent(req, {
    action: 'wallet.reconciliation.failed',
    actor: { type: 'system' },
    metadata: {
      attempts: input.attempts,
      fundsChanged: false,
      outcome: input.outcome,
      retryable: true,
      traceId: input.traceId,
    },
    targetId: input.traceId,
  })
}

async function loadWechatEntriesWithRetry(
  req: PayloadRequest,
  input: { loadWechatEntries: () => Promise<WechatStatementEntry[]>; traceId: string },
): Promise<WechatStatementEntry[]> {
  let failure: unknown
  for (let attempt = 1; attempt <= WALLET_RECONCILIATION_SOURCE_ATTEMPTS; attempt += 1) {
    try {
      const entries = await input.loadWechatEntries()
      if (!Array.isArray(entries)) {
        throw new AppError('RECONCILIATION_SOURCE_INVALID', '微信对账数据格式无效', 503)
      }
      if (attempt > 1) {
        await recordWalletReconciliationSourceFailure(req, {
          attempts: attempt,
          outcome: 'retry_succeeded',
          traceId: input.traceId,
        })
      }
      return entries
    } catch (error) {
      failure = error
      req.payload.logger.warn(
        { attempt, traceId: input.traceId },
        'wallet reconciliation upstream read failed; retrying without changing funds',
      )
    }
  }
  await recordWalletReconciliationSourceFailure(req, {
    attempts: WALLET_RECONCILIATION_SOURCE_ATTEMPTS,
    outcome: 'exhausted',
    traceId: input.traceId,
  })
  throw failure
}

async function walletBalanceRows(
  database: ReconciliationDatabase,
  period: Period,
): Promise<WalletReconciliationRow[]> {
  const result = await database.execute(sql`
    SELECT
      account.id AS account_id,
      account.customer_id,
      account.posted_balance_cache_fen,
      account.held_balance_cache_fen,
      COALESCE(SUM(
        CASE
          WHEN entry.entry_type = 'credit' THEN entry.amount_fen
          WHEN entry.entry_type IN ('capture', 'recovery') THEN -entry.amount_fen
          ELSE 0
        END
      ), 0) AS posted_balance_from_entries_fen,
      COALESCE(SUM(
        CASE
          WHEN entry.entry_type = 'hold' THEN entry.amount_fen
          WHEN entry.entry_type IN ('capture', 'release') THEN -entry.amount_fen
          ELSE 0
        END
      ), 0) AS held_balance_from_entries_fen
    FROM wallet_accounts account
    LEFT JOIN wallet_entries entry ON entry.account_id = account.id
    WHERE EXISTS (
      SELECT 1
      FROM wallet_entries period_entry
      WHERE period_entry.account_id = account.id
        AND period_entry.created_at >= ${period.start}::timestamptz
        AND period_entry.created_at < ${period.end}::timestamptz
    )
    GROUP BY
      account.id,
      account.customer_id,
      account.posted_balance_cache_fen,
      account.held_balance_cache_fen
    ORDER BY account.id
  `)
  return result.rows ?? []
}

async function walletCreditRows(
  database: ReconciliationDatabase,
  period: Period,
): Promise<WalletReconciliationRow[]> {
  const result = await database.execute(sql`
    SELECT
      entry.account_id,
      entry.customer_id,
      entry.amount_fen AS wallet_amount_fen,
      transaction.transaction_key,
      top_up.id AS top_up_id,
      top_up.top_up_order_number,
      top_up.amount_fen AS top_up_amount_fen,
      top_up.status AS top_up_status,
      top_up.wechat_transaction_id
    FROM wallet_entries entry
    INNER JOIN wallet_transactions transaction ON transaction.id = entry.transaction_id
    LEFT JOIN wallet_top_up_orders top_up
      ON top_up.ledger_transaction_key = transaction.transaction_key
    WHERE entry.entry_type = 'credit'
      AND transaction.type = 'credit'
      AND transaction.transaction_key LIKE 'wallet-top-up:%:credit'
      AND entry.created_at >= ${period.start}::timestamptz
      AND entry.created_at < ${period.end}::timestamptz
    ORDER BY entry.id
  `)
  return result.rows ?? []
}

async function walletBalancePaymentRows(
  database: ReconciliationDatabase,
  period: Period,
): Promise<WalletReconciliationRow[]> {
  const result = await database.execute(sql`
    SELECT
      entry.account_id,
      entry.customer_id,
      entry.amount_fen AS wallet_amount_fen,
      transaction.transaction_key,
      orders.id AS order_id,
      orders.order_number,
      orders.amount_minor AS order_amount_fen,
      orders.payment_channel
    FROM wallet_entries entry
    INNER JOIN wallet_transactions transaction ON transaction.id = entry.transaction_id
    LEFT JOIN orders
      ON orders.balance_hold_transaction_key = transaction.transaction_key
      OR (
        orders.balance_hold_transaction_key IS NULL
        AND transaction.transaction_key = 'order-balance-payment:' || orders.id::text
      )
    WHERE entry.entry_type = 'capture'
      AND transaction.type = 'hold'
      AND (
        orders.id IS NOT NULL
        OR transaction.transaction_key LIKE 'order-balance-payment:%'
      )
      AND entry.created_at >= ${period.start}::timestamptz
      AND entry.created_at < ${period.end}::timestamptz
    ORDER BY entry.id
  `)
  return result.rows ?? []
}

async function walletRecoveryRows(
  database: ReconciliationDatabase,
  period: Period,
): Promise<WalletReconciliationRow[]> {
  const result = await database.execute(sql`
    SELECT
      entry.account_id,
      entry.customer_id,
      entry.amount_fen AS wallet_amount_fen,
      transaction.transaction_key,
      top_up.id AS top_up_id,
      top_up.top_up_order_number,
      top_up.amount_fen AS top_up_amount_fen,
      top_up.payment_recovery_key,
      top_up.payment_recovery_type,
      top_up.payment_recovered_at
    FROM wallet_entries entry
    INNER JOIN wallet_transactions transaction ON transaction.id = entry.transaction_id
    LEFT JOIN wallet_top_up_orders top_up
      ON transaction.transaction_key = 'wallet-top-up-payment-recovery:' || top_up.id::text
    WHERE entry.entry_type = 'recovery'
      AND transaction.type = 'recovery'
      AND transaction.transaction_key LIKE 'wallet-top-up-payment-recovery:%'
      AND entry.created_at >= ${period.start}::timestamptz
      AND entry.created_at < ${period.end}::timestamptz
    ORDER BY entry.id
  `)
  return result.rows ?? []
}

export async function reconcileWalletLedger(
  req: PayloadRequest,
  input: {
    loadWechatEntries: () => Promise<WechatStatementEntry[]>
    period: Period
    traceId: string
  },
) {
  assertPeriod(input.period)
  const wechatEntries = await loadWechatEntriesWithRetry(req, input)
  return inReconciliationTransaction(req, async () => {
    const wechatResults = await reconcileWechatFunds(req, {
      entries: wechatEntries,
      period: input.period,
      traceId: input.traceId,
    })
    const paymentEvidence = new Map<string, { amount: bigint; matched: boolean }>()
    const recoveryEvidence = new Map<string, { amount: bigint; matched: boolean }>()
    for (const result of wechatResults) {
      const summary = reconciliationSummary(result.record)
      const observedMinor = databaseInteger(summary.observedMinor)
      const matched = result.record.status === 'matched' && result.record.differenceMinor === 0
      if (summary.entryType === 'payment') {
        const topUpOrderNumber = optionalString(summary.walletTopUpOrderNumber)
        if (topUpOrderNumber)
          paymentEvidence.set(topUpOrderNumber, { amount: observedMinor, matched })
      }
      if (summary.entryType === 'wallet_recovery') {
        const recoveryKey = optionalString(summary.recoveryKey)
        if (recoveryKey) recoveryEvidence.set(recoveryKey, { amount: observedMinor, matched })
      }
    }

    const database = await reconciliationDatabase(req)
    const balanceRows = await walletBalanceRows(database, input.period)
    const creditRows = await walletCreditRows(database, input.period)
    const balancePaymentRows = await walletBalancePaymentRows(database, input.period)
    const recoveryRows = await walletRecoveryRows(database, input.period)
    const results = []

    for (const row of creditRows) {
      const accountId = databaseIdentifier(row.account_id)
      const customerId = databaseIdentifier(row.customer_id)
      const walletAmount = databaseInteger(row.wallet_amount_fen)
      const transactionKey = optionalString(row.transaction_key) ?? 'missing-transaction-key'
      const topUpId = optionalIdentifier(row.top_up_id)
      const topUpOrderNumber = optionalString(row.top_up_order_number)
      const topUpAmount =
        row.top_up_amount_fen === null || row.top_up_amount_fen === undefined
          ? undefined
          : databaseInteger(row.top_up_amount_fen)
      const wechat = topUpOrderNumber ? paymentEvidence.get(topUpOrderNumber) : undefined
      const topUpFactMatches =
        topUpId !== undefined &&
        topUpAmount === walletAmount &&
        ['credited', 'refund_pending', 'refunded'].includes(String(row.top_up_status)) &&
        Boolean(optionalString(row.wechat_transaction_id))
      const difference = walletAmount - (wechat?.amount ?? 0n)
      const differenceMinor = safeDifferenceMinor(
        difference === 0n && (!topUpFactMatches || !wechat?.matched) ? 1n : difference,
      )
      results.push(
        await persistReconciliation(req, {
          differenceMinor,
          kind: 'wallet',
          ledger: 'wallet_balance',
          period: input.period,
          recordKey: `top-up:${topUpOrderNumber ?? transactionKey}`,
          ...(differenceMinor === 0
            ? {}
            : {
                review: {
                  customerId,
                  evidence: {
                    topUpFactMatches,
                    topUpOrderNumber,
                    walletAmountFen: walletAmount.toString(),
                    wechatAmountFen: wechat?.amount.toString(),
                    wechatMatched: wechat?.matched ?? false,
                  },
                  reasonCode: 'wallet_reconciliation.top_up_wechat_difference',
                  walletAccountId: accountId,
                  walletTopUpOrderId: topUpId,
                },
              }),
          summary: {
            accountId: String(accountId),
            correctionApplied: false,
            mapping: 'wallet_top_up_credit_to_wechat_funds',
            topUpFactMatches,
            topUpOrderNumber,
            walletAmountFen: walletAmount.toString(),
            wechatAmountFen: wechat?.amount.toString(),
            wechatMatched: wechat?.matched ?? false,
          },
          traceId: input.traceId,
        }),
      )
    }

    for (const row of balancePaymentRows) {
      const accountId = databaseIdentifier(row.account_id)
      const customerId = databaseIdentifier(row.customer_id)
      const walletAmount = databaseInteger(row.wallet_amount_fen)
      const orderId = optionalIdentifier(row.order_id)
      const orderAmount =
        row.order_amount_fen === null || row.order_amount_fen === undefined
          ? undefined
          : databaseInteger(row.order_amount_fen)
      const orderNumber = optionalString(row.order_number)
      const orderFactMatches = orderId !== undefined && row.payment_channel === 'balance'
      const difference = walletAmount - (orderAmount ?? 0n)
      const differenceMinor = safeDifferenceMinor(
        difference === 0n && !orderFactMatches ? 1n : difference,
      )
      results.push(
        await persistReconciliation(req, {
          differenceMinor,
          kind: 'wallet',
          ledger: 'wallet_balance',
          period: input.period,
          recordKey: `balance-payment:${orderNumber ?? String(row.transaction_key)}`,
          ...(differenceMinor === 0
            ? {}
            : {
                review: {
                  customerId,
                  evidence: {
                    orderAmountFen: orderAmount?.toString(),
                    orderFactMatches,
                    orderNumber,
                    walletAmountFen: walletAmount.toString(),
                  },
                  orderId,
                  reasonCode: 'wallet_reconciliation.balance_payment_order_difference',
                  walletAccountId: accountId,
                },
              }),
          summary: {
            accountId: String(accountId),
            correctionApplied: false,
            mapping: 'wallet_balance_payment_to_internal_orders',
            orderAmountFen: orderAmount?.toString(),
            orderFactMatches,
            orderNumber,
            walletAmountFen: walletAmount.toString(),
          },
          traceId: input.traceId,
        }),
      )
    }

    for (const row of recoveryRows) {
      const accountId = databaseIdentifier(row.account_id)
      const customerId = databaseIdentifier(row.customer_id)
      const walletAmount = databaseInteger(row.wallet_amount_fen)
      const topUpId = optionalIdentifier(row.top_up_id)
      const topUpOrderNumber = optionalString(row.top_up_order_number)
      const recoveryKey = optionalString(row.payment_recovery_key)
      const recovery = recoveryKey ? recoveryEvidence.get(recoveryKey) : undefined
      const recoveryFactMatches =
        topUpId !== undefined &&
        databaseInteger(row.top_up_amount_fen) === walletAmount &&
        Boolean(recoveryKey) &&
        ['dispute', 'provider_refund'].includes(String(row.payment_recovery_type)) &&
        Boolean(row.payment_recovered_at)
      const difference = walletAmount - (recovery?.amount ?? 0n)
      const differenceMinor = safeDifferenceMinor(
        difference === 0n && (!recoveryFactMatches || !recovery?.matched) ? 1n : difference,
      )
      results.push(
        await persistReconciliation(req, {
          differenceMinor,
          kind: 'wallet',
          ledger: 'wallet_balance',
          period: input.period,
          recordKey: `payment-recovery:${recoveryKey ?? String(row.transaction_key)}`,
          ...(differenceMinor === 0
            ? {}
            : {
                review: {
                  customerId,
                  evidence: {
                    recoveryFactMatches,
                    recoveryKey,
                    walletAmountFen: walletAmount.toString(),
                    wechatReversalAmountFen: recovery?.amount.toString(),
                    wechatReversalMatched: recovery?.matched ?? false,
                  },
                  reasonCode: 'wallet_reconciliation.payment_recovery_wechat_difference',
                  walletAccountId: accountId,
                  walletTopUpOrderId: topUpId,
                },
              }),
          summary: {
            accountId: String(accountId),
            correctionApplied: false,
            mapping: 'wallet_payment_recovery_to_wechat_funds_reverse',
            recoveryFactMatches,
            recoveryKey,
            topUpOrderNumber,
            walletAmountFen: walletAmount.toString(),
            wechatReversalAmountFen: recovery?.amount.toString(),
            wechatReversalMatched: recovery?.matched ?? false,
          },
          traceId: input.traceId,
        }),
      )
    }

    for (const row of balanceRows) {
      const accountId = databaseIdentifier(row.account_id)
      const customerId = databaseIdentifier(row.customer_id)
      const postedFromEntries = databaseInteger(row.posted_balance_from_entries_fen)
      const heldFromEntries = databaseInteger(row.held_balance_from_entries_fen)
      const postedCache = databaseInteger(row.posted_balance_cache_fen)
      const heldCache = databaseInteger(row.held_balance_cache_fen)
      const difference =
        absolute(postedFromEntries - postedCache) + absolute(heldFromEntries - heldCache)
      const differenceMinor = safeDifferenceMinor(difference)
      results.push(
        await persistReconciliation(req, {
          differenceMinor,
          kind: 'wallet',
          ledger: 'wallet_balance',
          period: input.period,
          recordKey: `balance-cache:${accountId}`,
          ...(differenceMinor === 0
            ? {}
            : {
                review: {
                  customerId,
                  evidence: {
                    heldBalanceCacheFen: heldCache.toString(),
                    heldBalanceFromEntriesFen: heldFromEntries.toString(),
                    postedBalanceCacheFen: postedCache.toString(),
                    postedBalanceFromEntriesFen: postedFromEntries.toString(),
                  },
                  reasonCode: 'wallet_reconciliation.balance_cache_difference',
                  walletAccountId: accountId,
                },
              }),
          summary: {
            accountId: String(accountId),
            correctionApplied: false,
            heldBalanceCacheFen: heldCache.toString(),
            heldBalanceFromEntriesFen: heldFromEntries.toString(),
            mapping: 'wallet_entries_to_wallet_account_cache',
            postedBalanceCacheFen: postedCache.toString(),
            postedBalanceFromEntriesFen: postedFromEntries.toString(),
            source: 'wallet_entries_aggregate',
          },
          traceId: input.traceId,
        }),
      )
    }

    return { results, wechatResults }
  })
}
