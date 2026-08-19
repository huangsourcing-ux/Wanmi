import { createHash, randomBytes } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import type { OrderStatus } from '@/lib/domain'
import type { RefundOrder, RefundProvider, VerifiedRefundNotification } from '@/providers/types'
import { paymentPayloadDigest } from '@/providers/wechatpay'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import {
  assertPostedWalletCredit,
  captureWalletHold,
  holdWalletBalance,
  releaseWalletHold,
} from '@/services/wallet/ledger'

import { loadBalancePaymentHold, type BalancePaymentOrder } from './balance-payments'
import { transitionOrder } from './order-state'

type RefundJobInput = {
  refundId: number
  traceId: string
}

type OrderRecord = {
  amountMinor: number
  currency: 'CNY'
  customer: { id: number | string } | number | string
  id: number | string
  merchantOrderNumber?: null | string
  orderNumber: string
  paidAt?: null | string
  paymentChannel?: 'balance' | 'h5' | 'native' | null
  status: OrderStatus
}

type RefundRecord = {
  amountMinor: number
  currency: 'CNY'
  id: number | string
  order?: null | number | string | { id: number | string }
  providerRefundId?: null | string
  refundNumber: string
  reasonCode?: null | string
  status: 'pending' | 'submitted' | 'succeeded' | 'failed' | 'unknown'
  walletTopUpOrder?: null | number | string | { id: number | string }
}

type WalletTopUpRefundRecord = {
  account: number | string | { id: number | string }
  amountFen: number
  creditedAt?: null | string
  currency: 'CNY'
  customer: number | string | { id: number | string }
  id: number | string
  ledgerTransactionKey: string
  originalRefundNumber?: null | string
  paymentChannel?: 'h5' | 'native' | null
  providerPaidAt?: null | string
  refundedAmountFen?: null | number
  status: string
  topUpOrderNumber: string
  wechatTransactionId?: null | string
}

type RefundDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

type WalletTopUpRefundReason = 'account_closure' | 'duplicate_top_up'

type RefundNotificationInput = {
  body: string
  headers: Headers
  receivedAt?: string
  traceId: string
}

function refundNumber(): string {
  return `WR${randomBytes(20).toString('hex')}`
}

function relationId(value: number | string | { id: number | string }): number | string {
  return typeof value === 'object' ? value.id : value
}

function positiveAmount(value: bigint | number): bigint {
  const amount =
    typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : undefined
  if (amount === undefined || amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('REFUND_AMOUNT_INVALID', '退款金额必须是正整数分', 400)
  }
  return amount
}

async function refundDatabase(req: PayloadRequest): Promise<RefundDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const database = session?.db as RefundDatabase | undefined
  if (!database) throw new AppError('REFUND_CAS_UNAVAILABLE', '无法建立安全退款事务', 503)
  return database
}

function walletTopUpRefundHoldKey(refundNumberValue: string): string {
  return `wallet-top-up-refund:${refundNumberValue}`
}

function assertSystemRefundRequest(req: PayloadRequest): void {
  if (req.user) {
    throw new AppError(
      'WALLET_TOP_UP_REFUND_SYSTEM_ONLY',
      '钱包充值原路退款仅供受信后台流程调用',
      403,
    )
  }
}

async function loadWalletTopUp(
  req: PayloadRequest,
  topUpOrderId: number | string,
): Promise<WalletTopUpRefundRecord> {
  return (await req.payload.findByID({
    collection: 'walletTopUpOrders',
    depth: 0,
    id: topUpOrderId,
    overrideAccess: true,
    req,
  })) as unknown as WalletTopUpRefundRecord
}

async function openManualReview(
  req: PayloadRequest,
  orderId: number | string,
  reasonCode: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  const existing = await req.payload.find({
    collection: 'manualReviews',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { and: [{ order: { equals: orderId } }, { status: { equals: 'open' } }] },
  })
  if (!existing.totalDocs) {
    await req.payload.create({
      collection: 'manualReviews',
      data: { evidence, order: orderId as never, reasonCode, status: 'open' },
      overrideAccess: true,
      req,
    })
  }
  req.payload.logger.warn({ orderId, reasonCode }, 'refund requires manual review')
}

async function moveRefundToManualReview(
  req: PayloadRequest,
  order: OrderRecord,
  reasonCode: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  if (order.status !== 'manual_review') {
    await transitionOrder(req, order.id, 'manual_review', {
      actorType: 'provider',
      evidence,
      reasonCode,
    })
  }
  await openManualReview(req, order.id, reasonCode, evidence)
}

async function assertConfirmedPayment(req: PayloadRequest, order: OrderRecord): Promise<void> {
  const confirmations = await req.payload.find({
    collection: 'paymentNotifications',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { order: { equals: order.id } },
        { confirmationStatus: { equals: 'confirmed' } },
        { merchantOrderNumber: { equals: order.merchantOrderNumber } },
      ],
    },
  })
  const confirmation = confirmations.docs[0]
  if (
    !confirmation ||
    confirmation.amountMinor !== order.amountMinor ||
    confirmation.currency !== order.currency ||
    !confirmation.wechatTransactionId
  ) {
    throw new AppError(
      'REFUND_PAYMENT_EVIDENCE_MISMATCH',
      '原支付确认金额、币种或交易标识与订单不一致，禁止退款',
      409,
    )
  }
}

export async function requestWechatRegistrationFailureRefund(
  req: PayloadRequest,
  input: {
    evidence: Record<string, unknown>
    note: string
    orderId: number | string
    traceId: string
    transition?: {
      actorId?: string
      actorType: 'admin' | 'system'
      reasonCode: string
    }
  },
): Promise<{ idempotentReplay: boolean; refundId: number | string; refundNumber: string }> {
  const startedTransaction = await initTransaction(req)
  try {
    const order = (await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: input.orderId,
      overrideAccess: true,
      req,
    })) as unknown as OrderRecord
    if (order.paymentChannel === 'balance') {
      throw new AppError('REFUND_CHANNEL_MISMATCH', '余额支付订单不得进入微信原路退款', 409)
    }
    if (order.paymentChannel !== 'native' && order.paymentChannel !== 'h5') {
      throw new AppError('REFUND_PAYMENT_CHANNEL_INVALID', '订单支付渠道无效，禁止退款', 409)
    }
    if (order.status === 'succeeded') {
      throw new AppError('SUCCEEDED_ORDER_REFUND_FORBIDDEN', '注册成功的订单不可退款', 409)
    }
    if (!['paid', 'fulfilling', 'refund_pending'].includes(order.status)) {
      throw new AppError('ORDER_NOT_REFUNDABLE', '订单当前状态不可发起自动退款', 409)
    }
    if (!order.paidAt || !order.merchantOrderNumber || order.currency !== 'CNY') {
      throw new AppError('REFUND_PAYMENT_EVIDENCE_MISSING', '原支付确认信息不完整，禁止退款', 409)
    }
    await assertConfirmedPayment(req, order)
    const existing = await req.payload.find({
      collection: 'refunds',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { order: { equals: order.id } },
    })
    if (existing.docs[0]) {
      const refund = existing.docs[0] as unknown as RefundRecord
      if (refund.amountMinor !== order.amountMinor) {
        throw new AppError('REFUND_AMOUNT_CONFLICT', '已有退款金额与订单金额不一致', 409)
      }
      if (startedTransaction) await commitTransaction(req)
      return {
        idempotentReplay: true,
        refundId: refund.id,
        refundNumber: refund.refundNumber,
      }
    }
    if (!Number.isSafeInteger(order.amountMinor) || order.amountMinor <= 0) {
      throw new AppError('REFUND_AMOUNT_INVALID', '订单退款金额无效', 409)
    }
    if (order.status !== 'refund_pending') {
      await transitionOrder(req, order.id, 'refund_pending', {
        actorId: input.transition?.actorId,
        actorType: input.transition?.actorType ?? 'system',
        evidence: input.evidence,
        note: input.note,
        reasonCode: input.transition?.reasonCode ?? 'registration.failed_refund_required',
      })
    }
    const created = await req.payload.create({
      collection: 'refunds',
      data: {
        amountMinor: order.amountMinor,
        createdTraceId: input.traceId,
        currency: 'CNY',
        order: order.id as never,
        refundNumber: refundNumber(),
        status: 'pending',
      },
      overrideAccess: true,
      req,
    })
    await req.payload.jobs.queue({
      input: { refundId: Number(created.id), traceId: input.traceId },
      overrideAccess: true,
      queue: 'commerce',
      req,
      workflow: 'wechatRefund',
    })
    if (startedTransaction) await commitTransaction(req)
    return {
      idempotentReplay: false,
      refundId: created.id,
      refundNumber: created.refundNumber,
    }
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    throw error
  }
}

export async function requestWalletTopUpOriginalRefund(
  req: PayloadRequest,
  input: {
    amountFen: bigint | number
    evidence: Record<string, unknown>
    note: string
    reason: WalletTopUpRefundReason
    topUpOrderId: number | string
    traceId: string
  },
): Promise<{ idempotentReplay: boolean; refundId: number | string; refundNumber: string }> {
  assertSystemRefundRequest(req)
  const amount = positiveAmount(input.amountFen)
  const startedTransaction = await initTransaction(req)
  try {
    const topUp = await loadWalletTopUp(req, input.topUpOrderId)
    if (
      topUp.currency !== 'CNY' ||
      !Number.isSafeInteger(topUp.amountFen) ||
      topUp.amountFen <= 0 ||
      amount > BigInt(topUp.amountFen)
    ) {
      throw new AppError('REFUND_AMOUNT_MISMATCH', '退款金额不得超过充值单冻结金额', 409)
    }
    if (
      !topUp.wechatTransactionId ||
      !topUp.providerPaidAt ||
      !topUp.creditedAt ||
      (topUp.paymentChannel !== 'native' && topUp.paymentChannel !== 'h5')
    ) {
      throw new AppError(
        'REFUND_PAYMENT_EVIDENCE_MISSING',
        '充值原支付确认信息不完整，禁止退款',
        409,
      )
    }
    await assertPostedWalletCredit(req, {
      accountId: relationId(topUp.account),
      amountFen: topUp.amountFen,
      customerId: relationId(topUp.customer),
      transactionKey: topUp.ledgerTransactionKey,
    })
    const existing = await req.payload.find({
      collection: 'refunds',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      req,
      where: { walletTopUpOrder: { equals: topUp.id } },
    })
    const existingRefund = existing.docs[0] as unknown as RefundRecord | undefined
    if (existing.docs.length > 1)
      throw new AppError('REFUND_TARGET_CONFLICT', '充值单退款记录冲突', 409)
    if (existingRefund) {
      if (
        BigInt(existingRefund.amountMinor) !== amount ||
        existingRefund.reasonCode !== `wallet_top_up.${input.reason}`
      ) {
        throw new AppError('REFUND_AMOUNT_CONFLICT', '已有充值退款金额或原因不一致', 409)
      }
      if (startedTransaction) await commitTransaction(req)
      return {
        idempotentReplay: true,
        refundId: existingRefund.id,
        refundNumber: existingRefund.refundNumber,
      }
    }
    if (topUp.status !== 'credited' || topUp.originalRefundNumber || topUp.refundedAmountFen) {
      throw new AppError('WALLET_TOP_UP_REFUND_STATE_INVALID', '充值单当前不可发起原路退款', 409)
    }

    const number = refundNumber()
    const hold = await holdWalletBalance(req, {
      accountId: relationId(topUp.account),
      amountFen: amount,
      transactionKey: walletTopUpRefundHoldKey(number),
    })
    if (hold.status !== 'held') {
      throw new AppError('WALLET_TOP_UP_REFUND_HOLD_INVALID', '充值退款资金冻结状态无效', 409)
    }
    const claimed = await (
      await refundDatabase(req)
    ).execute(sql`
      UPDATE wallet_top_up_orders
      SET
        status = 'refund_pending',
        original_refund_number = ${number},
        refunded_amount_fen = ${amount.toString()},
        updated_at = NOW()
      WHERE id = ${topUp.id}
        AND status = 'credited'
        AND original_refund_number IS NULL
        AND refunded_amount_fen IS NULL
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) {
      throw new AppError('WALLET_TOP_UP_REFUND_CONFLICT', '充值单退款正在处理，请勿重复提交', 409)
    }
    const created = await req.payload.create({
      collection: 'refunds',
      data: {
        amountMinor: Number(amount),
        createdTraceId: input.traceId,
        currency: 'CNY',
        reasonCode: `wallet_top_up.${input.reason}`,
        refundNumber: number,
        status: 'pending',
        walletTopUpOrder: topUp.id as never,
      },
      overrideAccess: true,
      req,
    })
    await req.payload.jobs.queue({
      input: { refundId: Number(created.id), traceId: input.traceId },
      overrideAccess: true,
      queue: 'commerce',
      req,
      workflow: 'wechatRefund',
    })
    await recordAuditEvent(req, {
      action: 'wallet.top_up.original_refund_requested',
      actor: { type: 'system' },
      metadata: {
        amountFen: amount.toString(),
        evidence: input.evidence,
        note: input.note,
        reason: input.reason,
        refundId: String(created.id),
      },
      targetId: topUp.id,
    })
    if (startedTransaction) await commitTransaction(req)
    return {
      idempotentReplay: false,
      refundId: created.id,
      refundNumber: created.refundNumber,
    }
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    throw error
  }
}

async function markBalanceRefundForManualReview(
  req: PayloadRequest,
  input: {
    evidence: Record<string, unknown>
    orderId: number | string
    reasonCode: string
  },
): Promise<void> {
  const order = (await req.payload.findByID({
    collection: 'orders',
    depth: 0,
    id: input.orderId,
    overrideAccess: true,
    req,
  })) as unknown as OrderRecord
  if (
    order.status !== 'manual_review' &&
    order.status !== 'refunded' &&
    order.status !== 'succeeded'
  ) {
    await transitionOrder(req, order.id, 'manual_review', {
      actorType: 'system',
      evidence: input.evidence,
      reasonCode: input.reasonCode,
    })
  }
  await openManualReview(req, order.id, input.reasonCode, input.evidence)
  await recordAuditEvent(req, {
    action: 'wallet.balance_refund.blocked',
    actor: { type: 'system' },
    metadata: { ...input.evidence, reasonCode: input.reasonCode },
    targetId: order.id,
  })
}

export async function requestBalanceRegistrationFailureRefund(
  req: PayloadRequest,
  input: {
    evidence: Record<string, unknown>
    note: string
    orderId: number | string
    traceId: string
    transition?: {
      actorId?: string
      actorType: 'admin' | 'system'
      reasonCode: string
    }
  },
): Promise<{ idempotentReplay: boolean; refundId: number | string; refundNumber: string }> {
  const startedTransaction = await initTransaction(req)
  let mismatch:
    | {
        evidence: Record<string, unknown>
        error: AppError
        reasonCode: string
      }
    | undefined
  try {
    const order = (await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: input.orderId,
      overrideAccess: true,
      req,
    })) as unknown as OrderRecord
    if (order.paymentChannel !== 'balance') {
      throw new AppError('REFUND_CHANNEL_MISMATCH', '微信支付订单不得退回余额', 409)
    }
    if (order.status === 'succeeded') {
      throw new AppError('SUCCEEDED_ORDER_REFUND_FORBIDDEN', '注册成功的订单不可退款', 409)
    }
    const existing = await req.payload.find({
      collection: 'refunds',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { order: { equals: order.id } },
    })
    const existingRefund = existing.docs[0] as unknown as RefundRecord | undefined
    if (existingRefund && order.status === 'refunded' && existingRefund.status === 'succeeded') {
      if (existingRefund.amountMinor !== order.amountMinor) {
        mismatch = {
          error: new AppError('REFUND_AMOUNT_MISMATCH', '退款金额与订单冻结金额不一致', 409),
          evidence: {
            orderAmountMinor: order.amountMinor,
            refundAmountMinor: existingRefund.amountMinor,
          },
          reasonCode: 'wallet.refund_amount_mismatch',
        }
      } else {
        if (startedTransaction) await commitTransaction(req)
        return {
          idempotentReplay: true,
          refundId: existingRefund.id,
          refundNumber: existingRefund.refundNumber,
        }
      }
    }
    if (!mismatch && !['paid', 'fulfilling', 'refund_pending'].includes(order.status)) {
      throw new AppError('ORDER_NOT_REFUNDABLE', '订单当前状态不可发起自动退款', 409)
    }
    if (!mismatch && (!Number.isSafeInteger(order.amountMinor) || order.amountMinor <= 0)) {
      mismatch = {
        error: new AppError('REFUND_AMOUNT_MISMATCH', '订单冻结金额无效，禁止退款', 409),
        evidence: { orderAmountMinor: order.amountMinor },
        reasonCode: 'wallet.refund_amount_mismatch',
      }
    }
    let hold: Awaited<ReturnType<typeof loadBalancePaymentHold>> | undefined
    if (!mismatch) {
      try {
        hold = await loadBalancePaymentHold(req, order as unknown as BalancePaymentOrder)
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'BALANCE_PAYMENT_HOLD_MISMATCH')
          throw error
        mismatch = {
          error: new AppError('REFUND_AMOUNT_MISMATCH', '退款金额与订单冻结金额不一致', 409),
          evidence: { orderAmountMinor: order.amountMinor },
          reasonCode: 'wallet.refund_amount_mismatch',
        }
      }
    }
    if (mismatch) {
      if (startedTransaction) await killTransaction(req)
      await markBalanceRefundForManualReview(req, {
        evidence: mismatch.evidence,
        orderId: order.id,
        reasonCode: mismatch.reasonCode,
      })
      throw mismatch.error
    }
    if (existingRefund) {
      throw new AppError('BALANCE_REFUND_STATE_CONFLICT', '余额退款状态冲突，需要人工核对', 409)
    }
    if (order.status !== 'refund_pending') {
      await transitionOrder(req, order.id, 'refund_pending', {
        actorId: input.transition?.actorId,
        actorType: input.transition?.actorType ?? 'system',
        evidence: input.evidence,
        note: input.note,
        reasonCode: input.transition?.reasonCode ?? 'registration.failed_refund_required',
      })
    }
    const created = await req.payload.create({
      collection: 'refunds',
      data: {
        amountMinor: order.amountMinor,
        createdTraceId: input.traceId,
        currency: 'CNY',
        order: order.id as never,
        refundNumber: refundNumber(),
        status: 'pending',
      },
      overrideAccess: true,
      req,
    })
    await transitionOrder(req, order.id, 'refunding', {
      actorType: 'system',
      evidence: {
        amountMinor: order.amountMinor,
        holdTransactionId: String(hold!.transactionId),
        paymentChannel: order.paymentChannel,
      },
      reasonCode: 'wallet.balance_refund_processing',
    })
    const released = await releaseWalletHold(req, hold!.transactionKey)
    if (released.status !== 'released') {
      throw new AppError('BALANCE_REFUND_RELEASE_INVALID', '余额退款释放状态无效', 409)
    }
    const refundedAt = new Date().toISOString()
    await transitionOrder(req, order.id, 'refunded', {
      actorType: 'system',
      evidence: {
        amountMinor: order.amountMinor,
        holdTransactionId: String(hold!.transactionId),
        paymentChannel: order.paymentChannel,
      },
      reasonCode: 'wallet.balance_refund_confirmed',
    })
    await req.payload.update({
      collection: 'refunds',
      data: { lastCheckedAt: refundedAt, refundedAt, status: 'succeeded' },
      id: created.id,
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(req, {
      action: 'wallet.balance_refund.completed',
      actor: { type: 'system' },
      metadata: {
        amountMinor: order.amountMinor,
        holdTransactionId: String(hold!.transactionId),
        paymentChannel: order.paymentChannel,
        refundId: String(created.id),
      },
      targetId: order.id,
    })
    if (startedTransaction) await commitTransaction(req)
    return {
      idempotentReplay: false,
      refundId: created.id,
      refundNumber: created.refundNumber,
    }
  } catch (error) {
    if (startedTransaction && !mismatch) await killTransaction(req)
    throw error
  }
}

export async function requestAutomaticRegistrationFailureRefund(
  req: PayloadRequest,
  input: Parameters<typeof requestWechatRegistrationFailureRefund>[1],
) {
  const order = (await req.payload.findByID({
    collection: 'orders',
    depth: 0,
    id: input.orderId,
    overrideAccess: true,
    req,
  })) as unknown as OrderRecord
  if (order.paymentChannel === 'balance') {
    return requestBalanceRegistrationFailureRefund(req, input)
  }
  if (order.paymentChannel === 'native' || order.paymentChannel === 'h5') {
    return requestWechatRegistrationFailureRefund(req, input)
  }
  throw new AppError('REFUND_PAYMENT_CHANNEL_INVALID', '订单支付渠道无效，禁止退款', 409)
}

async function loadRefundAndOrder(req: PayloadRequest, refundId: number | string) {
  const refund = (await req.payload.findByID({
    collection: 'refunds',
    depth: 0,
    id: refundId,
    overrideAccess: true,
    req,
  })) as unknown as RefundRecord
  if (!refund.order || refund.walletTopUpOrder) {
    throw new AppError('REFUND_TARGET_INVALID', '退款目标不是普通订单', 409)
  }
  const order = (await req.payload.findByID({
    collection: 'orders',
    depth: 0,
    id: relationId(refund.order),
    overrideAccess: true,
    req,
  })) as unknown as OrderRecord
  if (order.paymentChannel === 'balance') {
    throw new AppError('REFUND_CHANNEL_MISMATCH', '余额支付订单不得进入微信原路退款', 409)
  }
  if (order.paymentChannel !== 'native' && order.paymentChannel !== 'h5') {
    throw new AppError('REFUND_PAYMENT_CHANNEL_INVALID', '订单支付渠道无效，禁止退款', 409)
  }
  if (order.status === 'succeeded') {
    throw new AppError('SUCCEEDED_ORDER_REFUND_FORBIDDEN', '注册成功的订单不可退款', 409)
  }
  if (
    refund.currency !== order.currency ||
    refund.amountMinor !== order.amountMinor ||
    refund.amountMinor > order.amountMinor
  ) {
    throw new AppError('REFUND_AMOUNT_MISMATCH', '退款金额必须等于且不得超过原支付金额', 409)
  }
  if (!order.merchantOrderNumber || !order.paidAt) {
    throw new AppError('REFUND_PAYMENT_EVIDENCE_MISSING', '原支付确认信息不完整，禁止退款', 409)
  }
  await assertConfirmedPayment(req, order)
  return { order, refund }
}

async function loadRefundAndWalletTopUp(req: PayloadRequest, refundId: number | string) {
  const refund = (await req.payload.findByID({
    collection: 'refunds',
    depth: 0,
    id: refundId,
    overrideAccess: true,
    req,
  })) as unknown as RefundRecord
  if (!refund.walletTopUpOrder || refund.order) {
    throw new AppError('REFUND_TARGET_INVALID', '退款目标不是钱包充值单', 409)
  }
  const topUp = await loadWalletTopUp(req, relationId(refund.walletTopUpOrder))
  if (
    refund.currency !== 'CNY' ||
    topUp.currency !== 'CNY' ||
    !Number.isSafeInteger(refund.amountMinor) ||
    refund.amountMinor <= 0 ||
    !Number.isSafeInteger(topUp.amountFen) ||
    refund.amountMinor > topUp.amountFen ||
    topUp.refundedAmountFen !== refund.amountMinor ||
    topUp.originalRefundNumber !== refund.refundNumber
  ) {
    throw new AppError('REFUND_AMOUNT_MISMATCH', '充值退款金额或业务标识不一致', 409)
  }
  if (!topUp.wechatTransactionId || !topUp.providerPaidAt || !topUp.creditedAt) {
    throw new AppError('REFUND_PAYMENT_EVIDENCE_MISSING', '充值原支付确认信息不完整，禁止退款', 409)
  }
  if (!['refund_pending', 'refunded', 'unknown'].includes(topUp.status)) {
    throw new AppError('WALLET_TOP_UP_REFUND_STATE_INVALID', '充值单退款状态无效', 409)
  }
  await assertPostedWalletCredit(req, {
    accountId: relationId(topUp.account),
    amountFen: topUp.amountFen,
    customerId: relationId(topUp.customer),
    transactionKey: topUp.ledgerTransactionKey,
  })
  return { refund, topUp }
}

type WechatRefundTarget =
  | { kind: 'order'; order: OrderRecord }
  | { kind: 'wallet_top_up'; topUp: WalletTopUpRefundRecord }

async function loadWechatRefundTarget(
  req: PayloadRequest,
  refundId: number | string,
): Promise<{ refund: RefundRecord; target: WechatRefundTarget }> {
  const raw = (await req.payload.findByID({
    collection: 'refunds',
    depth: 0,
    id: refundId,
    overrideAccess: true,
    req,
  })) as unknown as RefundRecord
  if (raw.order && !raw.walletTopUpOrder) {
    const { order, refund } = await loadRefundAndOrder(req, refundId)
    return { refund, target: { kind: 'order', order } }
  }
  if (raw.walletTopUpOrder && !raw.order) {
    const { refund, topUp } = await loadRefundAndWalletTopUp(req, refundId)
    return { refund, target: { kind: 'wallet_top_up', topUp } }
  }
  throw new AppError('REFUND_TARGET_INVALID', '退款必须且只能关联一个业务目标', 409)
}

async function providerOperation(
  req: PayloadRequest,
  refund: RefundRecord,
  target: WechatRefundTarget,
) {
  const operationKey = `wechat-refund:${refund.refundNumber}`
  const found = await req.payload.find({
    collection: 'providerOperations',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { operationKey: { equals: operationKey } },
  })
  return (
    found.docs[0] ??
    (await req.payload.create({
      collection: 'providerOperations',
      data: {
        attemptCount: 0,
        maxAttempts: 3,
        operation: 'refund',
        operationKey,
        ...(target.kind === 'order' ? { order: target.order.id as never } : {}),
        provider: 'wechatpay',
        status: 'prepared',
        targetId: String(target.kind === 'order' ? target.order.id : target.topUp.id),
        targetType: target.kind,
      },
      overrideAccess: true,
      req,
    }))
  )
}

function safeRefundEvidence(
  refund: RefundRecord,
  result: RefundOrder | undefined,
  providerRequestId: string,
) {
  return {
    providerRequestId,
    providerState: result?.state ?? 'unavailable',
    refundNumber: refund.refundNumber,
  }
}

async function applyRefundResult(
  req: PayloadRequest,
  order: OrderRecord,
  refund: RefundRecord,
  operation: { id: number | string },
  providerResult: Awaited<ReturnType<RefundProvider['queryRefund']>>,
  source: 'create' | 'query',
) {
  const result = providerResult.ok ? providerResult.data : undefined
  const evidence = safeRefundEvidence(refund, result, providerResult.requestId)
  const identifiersMatch =
    result?.refundNumber === refund.refundNumber &&
    result.merchantOrderNumber === order.merchantOrderNumber
  const amountMatches =
    result?.currency === order.currency &&
    result.amountMinor === order.amountMinor &&
    result.amountMinor === refund.amountMinor
  const now = new Date().toISOString()

  if (!providerResult.ok && !providerResult.error.statusKnown) {
    await req.payload.update({
      collection: 'refunds',
      data: { failureCategory: 'unknown', lastCheckedAt: now, status: 'unknown' },
      id: refund.id,
      overrideAccess: true,
      req,
    })
    await req.payload.update({
      collection: 'providerOperations',
      data: { lastCheckedAt: now, safeResult: evidence, status: 'unknown' },
      id: operation.id,
      overrideAccess: true,
      req,
    })
    if (source === 'create' && order.status === 'refund_pending') {
      await transitionOrder(req, order.id, 'refunding', {
        actorType: 'system',
        evidence,
        reasonCode: 'wechatpay.refund_request_sent',
      })
      order.status = 'refunding'
    }
    await moveRefundToManualReview(req, order, 'wechatpay.refund_status_unknown', evidence)
    return { status: 'manual_review' as const }
  }

  if (!providerResult.ok || !result || !identifiersMatch || !amountMatches) {
    const failureCategory = !providerResult.ok
      ? providerResult.error.code.includes('BALANCE')
        ? 'balance_insufficient'
        : providerResult.error.code.includes('DISPUTE')
          ? 'disputed'
          : 'provider_rejected'
      : 'unknown'
    await req.payload.update({
      collection: 'refunds',
      data: { failureCategory, lastCheckedAt: now, status: 'failed' },
      id: refund.id,
      overrideAccess: true,
      req,
    })
    await req.payload.update({
      collection: 'providerOperations',
      data: { lastCheckedAt: now, safeResult: evidence, status: 'failed' },
      id: operation.id,
      overrideAccess: true,
      req,
    })
    await moveRefundToManualReview(
      req,
      order,
      failureCategory === 'balance_insufficient'
        ? 'wechatpay.refund_balance_insufficient'
        : failureCategory === 'disputed'
          ? 'wechatpay.refund_disputed'
          : !identifiersMatch || !amountMatches
            ? 'wechatpay.refund_amount_or_identifier_mismatch'
            : 'wechatpay.refund_failed',
      evidence,
    )
    return { status: 'manual_review' as const }
  }

  const submitted = result.state === 'processing'
  if (submitted) {
    await req.payload.update({
      collection: 'refunds',
      data: {
        lastCheckedAt: now,
        providerRefundId: result.providerRefundId,
        status: 'submitted',
        ...(source === 'create' ? { submittedAt: now } : {}),
      },
      id: refund.id,
      overrideAccess: true,
      req,
    })
    await req.payload.update({
      collection: 'providerOperations',
      data: {
        lastCheckedAt: now,
        providerRequestId: providerResult.requestId,
        safeResult: evidence,
        status: 'submitted',
        ...(source === 'create' ? { submittedAt: now } : {}),
      },
      id: operation.id,
      overrideAccess: true,
      req,
    })
    if (order.status === 'refund_pending') {
      await transitionOrder(req, order.id, 'refunding', {
        actorType: 'provider',
        evidence,
        reasonCode: 'wechatpay.refund_processing',
      })
    }
    return { status: 'refunding' as const }
  }

  if (result.state !== 'succeeded' || !result.providerRefundId || !result.refundedAt) {
    await req.payload.update({
      collection: 'refunds',
      data: {
        failureCategory: result.failureCategory ?? 'provider_rejected',
        lastCheckedAt: now,
        status: 'failed',
      },
      id: refund.id,
      overrideAccess: true,
      req,
    })
    await moveRefundToManualReview(req, order, 'wechatpay.refund_failed', evidence)
    return { status: 'manual_review' as const }
  }

  if (order.status === 'refund_pending') {
    await transitionOrder(req, order.id, 'refunding', {
      actorType: 'provider',
      evidence,
      reasonCode: 'wechatpay.refund_submitted_and_confirmed',
    })
    order.status = 'refunding'
  }
  await transitionOrder(req, order.id, 'refunded', {
    actorType: 'provider',
    evidence,
    ...(order.status === 'manual_review'
      ? { note: '经微信退款查询或验签通知确认原路全额退款成功。' }
      : {}),
    reasonCode: 'wechatpay.refund_confirmed',
  })
  await req.payload.update({
    collection: 'refunds',
    data: {
      lastCheckedAt: now,
      providerRefundId: result.providerRefundId,
      refundedAt: result.refundedAt,
      status: 'succeeded',
    },
    id: refund.id,
    overrideAccess: true,
    req,
  })
  await req.payload.update({
    collection: 'providerOperations',
    data: {
      lastCheckedAt: now,
      providerRequestId: providerResult.requestId,
      safeResult: evidence,
      status: 'succeeded',
    },
    id: operation.id,
    overrideAccess: true,
    req,
  })
  return { status: 'refunded' as const }
}

async function ensureWalletTopUpRefundManualReview(
  req: PayloadRequest,
  topUp: WalletTopUpRefundRecord,
  reasonCode: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  const existing = await req.payload.find({
    collection: 'manualReviews',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { walletTopUpOrder: { equals: topUp.id } },
        { reasonCode: { equals: reasonCode } },
        { status: { equals: 'open' } },
      ],
    },
  })
  if (existing.totalDocs > 0) return
  await req.payload.create({
    collection: 'manualReviews',
    data: {
      customer: relationId(topUp.customer) as never,
      evidence,
      reasonCode,
      status: 'open',
      walletTopUpOrder: topUp.id as never,
    },
    overrideAccess: true,
    req,
  })
}

async function claimWalletTopUpRefundSubmission(
  req: PayloadRequest,
  refund: RefundRecord,
  topUp: WalletTopUpRefundRecord,
): Promise<boolean> {
  const started = await initTransaction(req)
  try {
    const claimed = await (
      await refundDatabase(req)
    ).execute(sql`
      UPDATE refunds
      SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
      WHERE id = ${refund.id}
        AND wallet_top_up_order_id = ${topUp.id}
        AND order_id IS NULL
        AND status = 'pending'
      RETURNING id
    `)
    if (started) await commitTransaction(req)
    return claimed.rows?.[0]?.id !== undefined
  } catch (error) {
    if (started) await killTransaction(req)
    throw error
  }
}

async function applyWalletTopUpRefundResult(
  req: PayloadRequest,
  topUp: WalletTopUpRefundRecord,
  refund: RefundRecord,
  operation: { id: number | string },
  providerResult: Awaited<ReturnType<RefundProvider['queryRefund']>>,
  source: 'create' | 'query',
) {
  const result = providerResult.ok ? providerResult.data : undefined
  const evidence = safeRefundEvidence(refund, result, providerResult.requestId)
  const identifiersMatch =
    result?.refundNumber === refund.refundNumber &&
    result.merchantOrderNumber === topUp.topUpOrderNumber
  const amountMatches =
    result?.currency === topUp.currency && result.amountMinor === refund.amountMinor
  const now = new Date().toISOString()
  const started = await initTransaction(req)
  try {
    const database = await refundDatabase(req)
    if (!providerResult.ok && !providerResult.error.statusKnown) {
      await req.payload.update({
        collection: 'refunds',
        data: { failureCategory: 'unknown', lastCheckedAt: now, status: 'unknown' },
        id: refund.id,
        overrideAccess: true,
        req,
      })
      await req.payload.update({
        collection: 'providerOperations',
        data: { lastCheckedAt: now, safeResult: evidence, status: 'unknown' },
        id: operation.id,
        overrideAccess: true,
        req,
      })
      const marked = await database.execute(sql`
        UPDATE wallet_top_up_orders
        SET status = 'unknown', updated_at = NOW()
        WHERE id = ${topUp.id}
          AND status IN ('refund_pending', 'unknown')
          AND original_refund_number = ${refund.refundNumber}
          AND refunded_amount_fen = ${refund.amountMinor}
        RETURNING id
      `)
      if (marked.rows?.[0]?.id === undefined) {
        throw new AppError('WALLET_TOP_UP_REFUND_CONFLICT', '充值退款状态已变化', 409)
      }
      await ensureWalletTopUpRefundManualReview(
        req,
        topUp,
        'wallet_top_up.refund_status_unknown',
        evidence,
      )
      if (started) await commitTransaction(req)
      return { status: 'manual_review' as const }
    }

    if (!providerResult.ok || !result || !identifiersMatch || !amountMatches) {
      const failureCategory = !providerResult.ok
        ? providerResult.error.code.includes('BALANCE')
          ? 'balance_insufficient'
          : providerResult.error.code.includes('DISPUTE')
            ? 'disputed'
            : 'provider_rejected'
        : 'unknown'
      await req.payload.update({
        collection: 'refunds',
        data: { failureCategory, lastCheckedAt: now, status: 'failed' },
        id: refund.id,
        overrideAccess: true,
        req,
      })
      await req.payload.update({
        collection: 'providerOperations',
        data: { lastCheckedAt: now, safeResult: evidence, status: 'failed' },
        id: operation.id,
        overrideAccess: true,
        req,
      })
      const marked = await database.execute(sql`
        UPDATE wallet_top_up_orders
        SET status = 'unknown', updated_at = NOW()
        WHERE id = ${topUp.id}
          AND status IN ('refund_pending', 'unknown')
          AND original_refund_number = ${refund.refundNumber}
          AND refunded_amount_fen = ${refund.amountMinor}
        RETURNING id
      `)
      if (marked.rows?.[0]?.id === undefined) {
        throw new AppError('WALLET_TOP_UP_REFUND_CONFLICT', '充值退款状态已变化', 409)
      }
      await ensureWalletTopUpRefundManualReview(
        req,
        topUp,
        !identifiersMatch || !amountMatches
          ? 'wallet_top_up.refund_amount_or_identifier_mismatch'
          : 'wallet_top_up.refund_failed',
        evidence,
      )
      if (started) await commitTransaction(req)
      return { status: 'manual_review' as const }
    }

    if (result.state === 'processing') {
      await req.payload.update({
        collection: 'refunds',
        data: {
          lastCheckedAt: now,
          providerRefundId: result.providerRefundId,
          status: 'submitted',
          ...(source === 'create' ? { submittedAt: now } : {}),
        },
        id: refund.id,
        overrideAccess: true,
        req,
      })
      await req.payload.update({
        collection: 'providerOperations',
        data: {
          lastCheckedAt: now,
          providerRequestId: providerResult.requestId,
          safeResult: evidence,
          status: 'submitted',
          ...(source === 'create' ? { submittedAt: now } : {}),
        },
        id: operation.id,
        overrideAccess: true,
        req,
      })
      if (started) await commitTransaction(req)
      return { status: 'refunding' as const }
    }

    if (result.state !== 'succeeded' || !result.providerRefundId || !result.refundedAt) {
      await req.payload.update({
        collection: 'refunds',
        data: {
          failureCategory: result.failureCategory ?? 'provider_rejected',
          lastCheckedAt: now,
          status: 'failed',
        },
        id: refund.id,
        overrideAccess: true,
        req,
      })
      await ensureWalletTopUpRefundManualReview(req, topUp, 'wallet_top_up.refund_failed', evidence)
      if (started) await commitTransaction(req)
      return { status: 'manual_review' as const }
    }

    const captured = await captureWalletHold(req, walletTopUpRefundHoldKey(refund.refundNumber))
    if (captured.status !== 'captured') {
      throw new AppError('WALLET_TOP_UP_REFUND_CAPTURE_INVALID', '充值退款账本扣回状态无效', 409)
    }
    if (!captured.applied) {
      const settled = await database.execute(sql`
        SELECT top_ups.id
        FROM wallet_top_up_orders AS top_ups
        INNER JOIN refunds
          ON refunds.wallet_top_up_order_id = top_ups.id
        WHERE top_ups.id = ${topUp.id}
          AND top_ups.status = 'refunded'
          AND top_ups.original_refund_number = ${refund.refundNumber}
          AND top_ups.refunded_amount_fen = ${refund.amountMinor}
          AND top_ups.refunded_at IS NOT NULL
          AND refunds.id = ${refund.id}
          AND refunds.status = 'succeeded'
          AND refunds.provider_refund_id = ${result.providerRefundId}
          AND refunds.refunded_at IS NOT NULL
      `)
      if (settled.rows?.[0]?.id !== undefined) {
        if (started) await commitTransaction(req)
        return { status: 'refunded' as const }
      }
    }
    const refunded = await database.execute(sql`
      UPDATE wallet_top_up_orders
      SET status = 'refunded', refunded_at = ${result.refundedAt}, updated_at = NOW()
      WHERE id = ${topUp.id}
        AND status IN ('refund_pending', 'unknown')
        AND original_refund_number = ${refund.refundNumber}
        AND refunded_amount_fen = ${refund.amountMinor}
      RETURNING id
    `)
    if (refunded.rows?.[0]?.id === undefined) {
      throw new AppError('WALLET_TOP_UP_REFUND_CONFLICT', '充值退款状态已变化', 409)
    }
    await req.payload.update({
      collection: 'refunds',
      data: {
        lastCheckedAt: now,
        providerRefundId: result.providerRefundId,
        refundedAt: result.refundedAt,
        status: 'succeeded',
      },
      id: refund.id,
      overrideAccess: true,
      req,
    })
    await req.payload.update({
      collection: 'providerOperations',
      data: {
        lastCheckedAt: now,
        providerRequestId: providerResult.requestId,
        safeResult: evidence,
        status: 'succeeded',
      },
      id: operation.id,
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(req, {
      action: 'wallet.top_up.refunded',
      actor: { id: 'wechatpay', type: 'provider' },
      metadata: {
        amountFen: refund.amountMinor,
        ledgerApplied: captured.applied,
        providerRequestId: providerResult.requestId,
        source,
      },
      targetId: topUp.id,
    })
    if (started) await commitTransaction(req)
    return { status: 'refunded' as const }
  } catch (error) {
    if (started) await killTransaction(req)
    throw error
  }
}

export async function runWechatRefund(
  req: PayloadRequest,
  input: RefundJobInput,
  provider: RefundProvider,
) {
  const { refund, target } = await loadWechatRefundTarget(req, input.refundId)
  if (refund.status === 'succeeded') return { idempotentReplay: true, status: 'refunded' as const }
  const operation = await providerOperation(req, refund, target)
  const topUpCreateClaimed =
    target.kind === 'wallet_top_up' && refund.status === 'pending'
      ? await claimWalletTopUpRefundSubmission(req, refund, target.topUp)
      : false
  const queryOnly =
    target.kind === 'wallet_top_up'
      ? !topUpCreateClaimed
      : ['submitted', 'unknown'].includes(refund.status) ||
        ['submitted', 'unknown'].includes(String(operation.status))
  const merchantOrderNumber =
    target.kind === 'order' ? target.order.merchantOrderNumber! : target.topUp.topUpOrderNumber
  const result = queryOnly
    ? await provider.queryRefund({ refundNumber: refund.refundNumber, traceId: input.traceId })
    : await provider.createRefund({
        amountMinor: refund.amountMinor,
        merchantOrderNumber,
        reason:
          target.kind === 'order'
            ? '域名注册明确失败，自动原路全额退款'
            : refund.reasonCode === 'wallet_top_up.account_closure'
              ? '账户关闭前退回未消费钱包余额'
              : '重复钱包充值原路退款',
        refundNumber: refund.refundNumber,
        traceId: input.traceId,
      })
  const applied =
    target.kind === 'order'
      ? await applyRefundResult(
          req,
          target.order,
          refund,
          operation,
          result,
          queryOnly ? 'query' : 'create',
        )
      : await applyWalletTopUpRefundResult(
          req,
          target.topUp,
          refund,
          operation,
          result,
          queryOnly ? 'query' : 'create',
        )
  return { idempotentReplay: queryOnly, ...applied }
}

async function refundByNumber(req: PayloadRequest, number: string) {
  const found = await req.payload.find({
    collection: 'refunds',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { refundNumber: { equals: number } },
  })
  return found.docs[0] as unknown as RefundRecord | undefined
}

async function refundNotificationById(req: PayloadRequest, notificationId: string) {
  const found = await req.payload.find({
    collection: 'refundNotifications',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { notificationId: { equals: notificationId } },
  })
  return found.docs[0]
}

export async function processWechatRefundNotification(
  req: PayloadRequest,
  input: RefundNotificationInput,
  provider: RefundProvider,
) {
  const digest = paymentPayloadDigest(input.body)
  const verified = await provider.verifyRefundNotification(input)
  if (!verified.verified) {
    const notificationId = `REJECTED-${digest}`
    if (!(await refundNotificationById(req, notificationId))) {
      await req.payload.create({
        collection: 'refundNotifications',
        data: {
          confirmationStatus: 'rejected',
          notificationId,
          payloadDigest: digest,
          receivedAt: input.receivedAt ?? new Date().toISOString(),
          signatureVerified: verified.signatureVerified,
          source: 'notification',
        },
        overrideAccess: true,
        req,
      })
    }
    throw new AppError('WECHATPAY_REFUND_NOTIFICATION_SIGNATURE_INVALID', '退款通知验签失败', 401)
  }
  if (await refundNotificationById(req, verified.notificationId)) {
    return { idempotentReplay: true }
  }
  const refund = await refundByNumber(req, verified.refundNumber)
  if (!refund) throw new AppError('REFUND_NOT_FOUND', '未找到退款记录', 404)
  const { target } = await loadWechatRefundTarget(req, refund.id)
  const targetMerchantOrderNumber =
    target.kind === 'order' ? target.order.merchantOrderNumber : target.topUp.topUpOrderNumber
  const targetCurrency = target.kind === 'order' ? target.order.currency : target.topUp.currency
  const query = await provider.queryRefund({
    refundNumber: refund.refundNumber,
    traceId: input.traceId,
  })
  const confirmed =
    query.ok &&
    query.data.state === 'succeeded' &&
    query.data.providerRefundId === verified.providerRefundId &&
    query.data.refundNumber === verified.refundNumber &&
    query.data.merchantOrderNumber === verified.merchantOrderNumber &&
    query.data.amountMinor === verified.amountMinor &&
    query.data.amountMinor === refund.amountMinor &&
    verified.merchantOrderNumber === targetMerchantOrderNumber &&
    verified.currency === targetCurrency
  const startedTransaction = await initTransaction(req)
  try {
    await req.payload.create({
      collection: 'refundNotifications',
      data: {
        amountMinor: verified.amountMinor,
        confirmationStatus: confirmed ? 'confirmed' : 'mismatch',
        currency: verified.currency,
        notificationId: verified.notificationId,
        payloadDigest: digest,
        providerRefundId: verified.providerRefundId,
        providerRequestId: query.requestId,
        receivedAt: input.receivedAt ?? new Date().toISOString(),
        refund: refund.id as never,
        refundedAt: verified.refundedAt,
        refundNumber: verified.refundNumber,
        signatureVerified: true,
        source: 'notification',
      },
      overrideAccess: true,
      req,
    })
    const operation = await providerOperation(req, refund, target)
    if (confirmed) {
      if (target.kind === 'order') {
        await applyRefundResult(req, target.order, refund, operation, query, 'query')
      } else {
        await applyWalletTopUpRefundResult(req, target.topUp, refund, operation, query, 'query')
      }
    } else {
      const evidence = {
        notificationId: verified.notificationId,
        payloadDigest: digest,
        providerRequestId: query.requestId,
      }
      if (target.kind === 'order') {
        await moveRefundToManualReview(
          req,
          target.order,
          'wechatpay.refund_amount_or_identifier_mismatch',
          evidence,
        )
      } else {
        await ensureWalletTopUpRefundManualReview(
          req,
          target.topUp,
          'wallet_top_up.refund_amount_or_identifier_mismatch',
          evidence,
        )
      }
    }
    if (startedTransaction) await commitTransaction(req)
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    if (await refundNotificationById(req, verified.notificationId).catch(() => undefined)) {
      return { idempotentReplay: true }
    }
    throw error
  }
  return { idempotentReplay: false }
}

export function refundQueryDigest(
  notification: Extract<VerifiedRefundNotification, { verified: true }>,
) {
  return createHash('sha256')
    .update(`${notification.notificationId}:${notification.refundNumber}`)
    .digest('hex')
}
