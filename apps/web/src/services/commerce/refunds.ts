import { createHash, randomBytes } from 'node:crypto'

import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import type { OrderStatus } from '@/lib/domain'
import type { RefundOrder, RefundProvider, VerifiedRefundNotification } from '@/providers/types'
import { paymentPayloadDigest } from '@/providers/wechatpay'

import { transitionOrder } from './order-state'

type RefundJobInput = {
  refundId: number
  traceId: string
}

type OrderRecord = {
  amountMinor: number
  currency: 'CNY'
  id: number | string
  merchantOrderNumber?: null | string
  orderNumber: string
  paidAt?: null | string
  status: OrderStatus
}

type RefundRecord = {
  amountMinor: number
  currency: 'CNY'
  id: number | string
  order: number | string | { id: number | string }
  providerRefundId?: null | string
  refundNumber: string
  status: 'pending' | 'submitted' | 'succeeded' | 'failed' | 'unknown'
}

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

export async function requestAutomaticRegistrationFailureRefund(
  req: PayloadRequest,
  input: {
    evidence: Record<string, unknown>
    note: string
    orderId: number | string
    traceId: string
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
        actorType: 'system',
        evidence: input.evidence,
        note: input.note,
        reasonCode: 'registration.failed_refund_required',
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

async function loadRefundAndOrder(req: PayloadRequest, refundId: number | string) {
  const refund = (await req.payload.findByID({
    collection: 'refunds',
    depth: 0,
    id: refundId,
    overrideAccess: true,
    req,
  })) as unknown as RefundRecord
  const order = (await req.payload.findByID({
    collection: 'orders',
    depth: 0,
    id: relationId(refund.order),
    overrideAccess: true,
    req,
  })) as unknown as OrderRecord
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

async function providerOperation(req: PayloadRequest, refund: RefundRecord) {
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
        operation: 'refund',
        operationKey,
        order: relationId(refund.order) as never,
        provider: 'wechatpay',
        status: 'prepared',
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

export async function runWechatRefund(
  req: PayloadRequest,
  input: RefundJobInput,
  provider: RefundProvider,
) {
  const { order, refund } = await loadRefundAndOrder(req, input.refundId)
  if (refund.status === 'succeeded') return { idempotentReplay: true, status: 'refunded' as const }
  const operation = await providerOperation(req, refund)
  const queryOnly =
    ['submitted', 'unknown'].includes(refund.status) ||
    ['submitted', 'unknown'].includes(String(operation.status))
  const result = queryOnly
    ? await provider.queryRefund({ refundNumber: refund.refundNumber, traceId: input.traceId })
    : await provider.createRefund({
        amountMinor: refund.amountMinor,
        merchantOrderNumber: order.merchantOrderNumber!,
        reason: '域名注册明确失败，自动原路全额退款',
        refundNumber: refund.refundNumber,
        traceId: input.traceId,
      })
  const applied = await applyRefundResult(
    req,
    order,
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
  const { order } = await loadRefundAndOrder(req, refund.id)
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
    verified.amountMinor === order.amountMinor &&
    verified.currency === order.currency
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
    const operation = await providerOperation(req, refund)
    if (confirmed) {
      await applyRefundResult(req, order, refund, operation, query, 'query')
    } else {
      await moveRefundToManualReview(req, order, 'wechatpay.refund_amount_or_identifier_mismatch', {
        notificationId: verified.notificationId,
        payloadDigest: digest,
        providerRequestId: query.requestId,
      })
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
