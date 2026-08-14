import { createHash } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'

type Period = {
  end: string
  start: string
}

type WechatStatementEntry =
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

async function persistReconciliation(
  req: PayloadRequest,
  input: {
    differenceMinor: number
    kind: 'three_way' | 'wechat' | 'westdigital'
    ledger: 'internal_orders' | 'wechat_funds' | 'westdigital_prepaid'
    period: Period
    recordKey: string
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
  const existing = await req.payload.find({
    collection: 'reconciliations',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { reconciliationKey: { equals: key } },
  })
  if (existing.docs[0]) return { idempotentReplay: true, record: existing.docs[0] }
  const record = await req.payload.create({
    collection: 'reconciliations',
    data: {
      currency: 'CNY',
      differenceMinor: input.differenceMinor,
      kind: input.kind,
      ledger: input.ledger,
      periodEnd: input.period.end,
      periodStart: input.period.start,
      reconciliationKey: key,
      recordKey: input.recordKey,
      status: input.differenceMinor === 0 ? 'matched' : 'difference',
      summary: input.summary,
      traceId: input.traceId,
    },
    overrideAccess: true,
    req,
  })
  if (input.differenceMinor !== 0) {
    req.payload.logger.warn(
      { kind: input.kind, ledger: input.ledger, reconciliationKey: key },
      'reconciliation difference recorded for manual confirmation',
    )
  }
  return { idempotentReplay: false, record }
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
      const found = await req.payload.find({
        collection: 'orders',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        req,
        where: { merchantOrderNumber: { equals: entry.merchantOrderNumber } },
      })
      const order = found.docs[0]
      const expectedMinor = order?.amountMinor ?? 0
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
          },
          traceId: input.traceId,
        }),
      )
    } else {
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
