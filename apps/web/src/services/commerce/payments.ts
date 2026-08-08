import { createHash, randomBytes } from 'node:crypto'

import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import type { PaymentOrder, PaymentProvider, VerifiedPaymentNotification } from '@/providers/types'
import { paymentPayloadDigest } from '@/providers/wechatpay'
import {
  paymentSessionResultSchema,
  paymentStatusResultSchema,
  type PaymentCreateRequest,
  type PaymentSessionResult,
  type PaymentStatusResult,
} from '@/schemas/payments'
import { transitionOrder } from '@/services/commerce/order-state'

type CustomerIdentity = {
  collection: 'customers'
  id: number
  status?: string
}

type OrderRecord = {
  amountMinor: number
  currency: 'CNY'
  customer: { id: number | string } | number | string
  id: number | string
  merchantOrderNumber?: null | string
  orderNumber: string
  paymentChannel?: 'h5' | 'native' | null
  paymentExpiresAt?: null | string
  paymentStatusPolledAt?: null | string
  quoteSnapshot?: unknown
  status: string
}

const PAYMENT_STATUS_POLL_INTERVAL_MS = 3_000
const PAYMENT_TIMEOUT_BATCH_SIZE = 100

type NotificationInput = {
  body: string
  headers: Headers
  receivedAt?: string
  traceId: string
}

type ConfirmationSource =
  | {
      digest: string
      notification: Extract<VerifiedPaymentNotification, { verified: true }>
      receivedAt: string
      source: 'notification'
    }
  | {
      digest: string
      notificationId: string
      receivedAt: string
      source: 'query'
    }

function assertCustomer(req: PayloadRequest, customer: CustomerIdentity): void {
  if (
    !isCustomerUser(req.user) ||
    customer.status !== 'active' ||
    String(req.user.id) !== String(customer.id)
  ) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
}

function quoteExpiry(order: OrderRecord): string {
  const snapshot = order.quoteSnapshot
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new AppError('ORDER_QUOTE_SNAPSHOT_INVALID', '订单报价快照无效', 500)
  }
  const expiresAt = (snapshot as Record<string, unknown>).expiresAt
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
    throw new AppError('ORDER_QUOTE_SNAPSHOT_INVALID', '订单报价有效期无效', 500)
  }
  return expiresAt
}

async function findCustomerOrder(
  req: PayloadRequest,
  orderNumber: string,
  customer: CustomerIdentity,
): Promise<OrderRecord> {
  const result = await req.payload.find({
    collection: 'orders',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req,
    user: req.user,
    where: {
      and: [{ orderNumber: { equals: orderNumber } }, { customer: { equals: customer.id } }],
    },
  })
  const order = result.docs[0]
  if (!order) throw new AppError('ORDER_NOT_FOUND', '未找到订单', 404)
  const trusted = await req.payload.findByID({
    collection: 'orders',
    depth: 0,
    id: order.id,
    overrideAccess: true,
    req,
  })
  return trusted as unknown as OrderRecord
}

async function enforcePaymentStatusPollLimit(
  req: PayloadRequest,
  order: OrderRecord,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - PAYMENT_STATUS_POLL_INTERVAL_MS).toISOString()
  const updated = await req.payload.update({
    collection: 'orders',
    data: { paymentStatusPolledAt: now.toISOString() },
    overrideAccess: true,
    req,
    where: {
      and: [
        { id: { equals: order.id } },
        {
          or: [
            { paymentStatusPolledAt: { exists: false } },
            { paymentStatusPolledAt: { less_than_equal: cutoff } },
          ],
        },
      ],
    },
  })
  if (!updated.docs.length) {
    throw new AppError('PAYMENT_STATUS_RATE_LIMITED', '支付状态查询过于频繁', 429, {
      retryAfterSeconds: PAYMENT_STATUS_POLL_INTERVAL_MS / 1_000,
    })
  }
}

function merchantOrderNumber(): string {
  return `WM${randomBytes(15).toString('hex')}`
}

export async function createWechatPayment(
  req: PayloadRequest,
  orderNumber: string,
  input: PaymentCreateRequest,
  options: {
    clientIp?: string
    customer: CustomerIdentity
    now?: () => Date
    provider: PaymentProvider
    traceId: string
  },
): Promise<Extract<PaymentSessionResult, { state: 'ready' }>> {
  assertCustomer(req, options.customer)
  const now = options.now ?? (() => new Date())
  const order = await findCustomerOrder(req, orderNumber, options.customer)
  if (order.status !== 'pending_payment') {
    throw new AppError('ORDER_NOT_PENDING_PAYMENT', '订单当前不可发起支付', 409)
  }
  const expiresAt = quoteExpiry(order)
  if (Date.parse(expiresAt) <= now().getTime()) {
    throw new AppError('QUOTE_EXPIRED', '报价已过期，请重新获取报价并下单', 409)
  }
  if (order.merchantOrderNumber && order.paymentChannel !== input.channel) {
    throw new AppError('PAYMENT_CHANNEL_ALREADY_SELECTED', '该订单已创建其他支付方式', 409)
  }
  const merchantNumber = order.merchantOrderNumber ?? merchantOrderNumber()
  if (!order.merchantOrderNumber) {
    const updated = await req.payload.update({
      collection: 'orders',
      data: {
        merchantOrderNumber: merchantNumber,
        paymentChannel: input.channel,
        paymentExpiresAt: expiresAt,
      },
      overrideAccess: true,
      req,
      where: {
        and: [
          { id: { equals: order.id } },
          { status: { equals: 'pending_payment' } },
          { merchantOrderNumber: { exists: false } },
        ],
      },
    })
    if (!updated.docs.length) {
      throw new AppError('PAYMENT_CREATE_CONFLICT', '支付单正在创建，请重试', 409)
    }
  }
  const result = await options.provider.createPayment({
    amountMinor: order.amountMinor,
    channel: input.channel,
    clientIp: options.clientIp,
    description: 'Wanmi 域名注册服务',
    expiresAt,
    merchantOrderNumber: merchantNumber,
    traceId: options.traceId,
  })
  if (!result.ok) {
    if (!result.error.statusKnown) {
      const query = await options.provider.queryOrder({
        merchantOrderNumber: merchantNumber,
        traceId: options.traceId,
      })
      const digest = createHash('sha256')
        .update(`${merchantNumber}:${query.requestId}`)
        .digest('hex')
      await persistAndApplyConfirmation(
        req,
        { ...order, merchantOrderNumber: merchantNumber },
        query,
        {
          digest,
          notificationId: `QUERY-${digest}`,
          receivedAt: now().toISOString(),
          source: 'query',
        },
      )
    }
    throw new AppError(
      result.error.statusKnown ? 'WECHATPAY_CREATE_REJECTED' : 'WECHATPAY_CREATE_UNKNOWN',
      result.error.statusKnown ? '微信支付单创建失败' : '微信支付单状态暂时无法确认',
      result.error.statusKnown ? 409 : 503,
      { retryable: result.error.retryable },
    )
  }
  return paymentSessionResultSchema.parse({
    data: { ...result.data, merchantOrderNumber: merchantNumber },
    meta: { observedAt: result.observedAt, traceId: options.traceId },
    state: 'ready',
  }) as Extract<PaymentSessionResult, { state: 'ready' }>
}

async function ensureOpenManualReview(
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
  if (existing.totalDocs) return
  await req.payload.create({
    collection: 'manualReviews',
    data: { evidence, order: orderId as never, reasonCode, status: 'open' },
    overrideAccess: true,
    req,
  })
}

async function moveToManualReview(
  req: PayloadRequest,
  order: OrderRecord,
  reasonCode: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  if (
    ['pending_payment', 'paid', 'fulfilling', 'refund_pending', 'refunding', 'cancelled'].includes(
      order.status,
    )
  ) {
    await transitionOrder(req, order.id, 'manual_review', {
      actorType: 'provider',
      evidence,
      reasonCode,
    })
  }
  await ensureOpenManualReview(req, order.id, reasonCode, evidence)
}

async function findOrderByMerchantNumber(
  req: PayloadRequest,
  merchantNumber: string,
): Promise<OrderRecord | undefined> {
  const result = await req.payload.find({
    collection: 'orders',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { merchantOrderNumber: { equals: merchantNumber } },
  })
  return result.docs[0] as unknown as OrderRecord | undefined
}

async function notificationById(req: PayloadRequest, notificationId: string) {
  const existing = await req.payload.find({
    collection: 'paymentNotifications',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { notificationId: { equals: notificationId } },
  })
  return existing.docs[0]
}

type PaidPaymentOrder = PaymentOrder & {
  amountMinor: number
  currency: 'CNY'
  paidAt: string
  state: 'paid'
  transactionId: string
}

function paidPaymentOrder(query: PaymentOrder | undefined): PaidPaymentOrder | undefined {
  if (
    query?.state !== 'paid' ||
    !query.transactionId ||
    !query.paidAt ||
    query.amountMinor === undefined ||
    query.currency !== 'CNY'
  ) {
    return undefined
  }
  return query as PaidPaymentOrder
}

async function confirmedPayment(req: PayloadRequest, query: PaidPaymentOrder) {
  const existing = await req.payload.find({
    collection: 'paymentNotifications',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { confirmationStatus: { equals: 'confirmed' } },
        { merchantOrderNumber: { equals: query.merchantOrderNumber } },
        { wechatTransactionId: { equals: query.transactionId } },
      ],
    },
  })
  return existing.docs[0]
}

function safeEvidence(
  source: ConfirmationSource,
  query: PaymentOrder | undefined,
  providerRequestId: string,
) {
  return {
    notificationId:
      source.source === 'notification' ? source.notification.notificationId : source.notificationId,
    payloadDigest: source.digest,
    providerRequestId,
    queryState: query?.state ?? 'unavailable',
    source: source.source,
  }
}

async function persistAndApplyConfirmation(
  req: PayloadRequest,
  order: OrderRecord,
  queryResult: Awaited<ReturnType<PaymentProvider['queryOrder']>>,
  source: ConfirmationSource,
): Promise<{ idempotentReplay: boolean; order: OrderRecord }> {
  const sourceNotificationId =
    source.source === 'notification' ? source.notification.notificationId : source.notificationId
  if (await notificationById(req, sourceNotificationId)) {
    const current = await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: order.id,
      overrideAccess: true,
      req,
    })
    return { idempotentReplay: true, order: current as unknown as OrderRecord }
  }
  const query = queryResult.ok ? queryResult.data : undefined
  const evidence = safeEvidence(source, query, queryResult.requestId)
  const paidQuery = paidPaymentOrder(query)
  const identifiersMatch =
    paidQuery !== undefined &&
    paidQuery.merchantOrderNumber === order.merchantOrderNumber &&
    (source.source === 'query' ||
      (source.notification.merchantOrderNumber === paidQuery.merchantOrderNumber &&
        source.notification.transactionId === paidQuery.transactionId))
  const amountMatches =
    paidQuery !== undefined &&
    order.currency === 'CNY' &&
    paidQuery.amountMinor === order.amountMinor &&
    (source.source === 'query' || source.notification.amountMinor === paidQuery.amountMinor)
  const confirmed = Boolean(paidQuery && identifiersMatch && amountMatches)
  if (confirmed && paidQuery && (await confirmedPayment(req, paidQuery))) {
    const current = await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: order.id,
      overrideAccess: true,
      req,
    })
    return { idempotentReplay: true, order: current as unknown as OrderRecord }
  }
  const confirmationStatus = confirmed
    ? 'confirmed'
    : source.source === 'query' &&
        queryResult.ok &&
        query &&
        ['closed', 'not_paid', 'refunded'].includes(query.state)
      ? 'not_paid'
      : queryResult.ok && query?.state !== 'unknown'
        ? 'mismatch'
        : 'unknown'
  const requiresManualReview =
    !confirmed &&
    (source.source === 'notification' || !queryResult.ok || query?.state === 'unknown')
  const startedTransaction = await initTransaction(req)
  try {
    await req.payload.create({
      collection: 'paymentNotifications',
      data: {
        amountMinor:
          query?.amountMinor ??
          (source.source === 'notification' ? source.notification.amountMinor : undefined),
        confirmationStatus,
        currency:
          query?.currency ??
          (source.source === 'notification' ? source.notification.currency : undefined),
        ...(paidQuery && identifiersMatch
          ? {
              merchantOrderNumber: paidQuery.merchantOrderNumber,
              paidAt: paidQuery.paidAt,
              wechatTransactionId: paidQuery.transactionId,
            }
          : {}),
        notificationId:
          source.source === 'notification'
            ? source.notification.notificationId
            : source.notificationId,
        order: order.id as never,
        payloadDigest: source.digest,
        providerRequestId: queryResult.requestId,
        receivedAt: source.receivedAt,
        signatureVerified: true,
        source: source.source,
      },
      overrideAccess: true,
      req,
    })
    if (confirmed) {
      if (order.status === 'pending_payment') {
        await transitionOrder(req, order.id, 'paid', {
          actorType: 'provider',
          evidence,
          reasonCode: 'wechatpay.payment_confirmed',
        })
      } else if (order.status === 'cancelled') {
        await moveToManualReview(req, order, 'wechatpay.late_payment', evidence)
      } else if (order.status === 'manual_review') {
        await ensureOpenManualReview(req, order.id, 'wechatpay.confirmed_during_review', evidence)
      }
      await req.payload.update({
        collection: 'orders',
        data: { paidAt: paidQuery!.paidAt },
        id: order.id,
        overrideAccess: true,
        req,
      })
    } else if (requiresManualReview) {
      const reason =
        !queryResult.ok || query?.state === 'unknown'
          ? 'wechatpay.payment_status_unknown'
          : 'wechatpay.payment_amount_or_identifier_mismatch'
      await moveToManualReview(req, order, reason, evidence)
      if (paidQuery) {
        await req.payload.update({
          collection: 'orders',
          data: { paidAt: paidQuery.paidAt },
          id: order.id,
          overrideAccess: true,
          req,
        })
      }
    }
    if (startedTransaction) await commitTransaction(req)
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    const replay = await notificationById(req, sourceNotificationId).catch(() => undefined)
    if (replay) {
      const current = await req.payload.findByID({
        collection: 'orders',
        depth: 0,
        id: order.id,
        overrideAccess: true,
        req,
      })
      return { idempotentReplay: true, order: current as unknown as OrderRecord }
    }
    throw error
  }
  const current = await req.payload.findByID({
    collection: 'orders',
    depth: 0,
    id: order.id,
    overrideAccess: true,
    req,
  })
  return { idempotentReplay: false, order: current as unknown as OrderRecord }
}

async function recordRejectedNotification(
  req: PayloadRequest,
  input: NotificationInput,
  digest: string,
  signatureVerified: boolean,
): Promise<void> {
  const notificationId = `REJECTED-${digest}`
  const existing = await req.payload.find({
    collection: 'paymentNotifications',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { notificationId: { equals: notificationId } },
  })
  if (existing.totalDocs) return
  try {
    await req.payload.create({
      collection: 'paymentNotifications',
      data: {
        confirmationStatus: 'rejected',
        notificationId,
        payloadDigest: digest,
        receivedAt: input.receivedAt ?? new Date().toISOString(),
        signatureVerified,
        source: 'notification',
      },
      overrideAccess: true,
      req,
    })
  } catch (error) {
    if (await notificationById(req, notificationId).catch(() => undefined)) return
    throw error
  }
}

export async function processWechatPaymentNotification(
  req: PayloadRequest,
  input: NotificationInput,
  provider: PaymentProvider,
) {
  const digest = paymentPayloadDigest(input.body)
  const verified = await provider.verifyNotification({
    body: input.body,
    headers: input.headers,
    traceId: input.traceId,
  })
  if (!verified.verified) {
    await recordRejectedNotification(req, input, digest, verified.signatureVerified)
    throw new AppError(
      verified.signatureVerified
        ? 'WECHATPAY_NOTIFICATION_RESOURCE_INVALID'
        : 'WECHATPAY_NOTIFICATION_SIGNATURE_INVALID',
      verified.signatureVerified ? '支付通知内容无效' : '支付通知验签失败',
      verified.signatureVerified ? 400 : 401,
    )
  }
  const order = await findOrderByMerchantNumber(req, verified.merchantOrderNumber)
  if (!order) {
    if (!(await notificationById(req, verified.notificationId))) {
      await req.payload.create({
        collection: 'paymentNotifications',
        data: {
          amountMinor: verified.amountMinor,
          confirmationStatus: 'mismatch',
          currency: verified.currency,
          notificationId: verified.notificationId,
          payloadDigest: digest,
          receivedAt: input.receivedAt ?? new Date().toISOString(),
          signatureVerified: true,
          source: 'notification',
        },
        overrideAccess: true,
        req,
      })
    }
    throw new AppError('WECHATPAY_ORDER_NOT_FOUND', '支付通知无法匹配订单', 404)
  }
  const query = await provider.queryOrder({
    merchantOrderNumber: verified.merchantOrderNumber,
    traceId: input.traceId,
  })
  return persistAndApplyConfirmation(req, order, query, {
    digest,
    notification: verified,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    source: 'notification',
  })
}

export async function queryAndConfirmWechatPayment(
  req: PayloadRequest,
  orderNumber: string,
  options: {
    customer: CustomerIdentity
    now?: () => Date
    provider: PaymentProvider
    traceId: string
  },
): Promise<Extract<PaymentStatusResult, { state: 'ready' }>> {
  assertCustomer(req, options.customer)
  const order = await findCustomerOrder(req, orderNumber, options.customer)
  if (!order.merchantOrderNumber) {
    throw new AppError('PAYMENT_NOT_CREATED', '该订单尚未创建微信支付单', 409)
  }
  const now = options.now?.() ?? new Date()
  await enforcePaymentStatusPollLimit(req, order, now)
  const query = await options.provider.queryOrder({
    merchantOrderNumber: order.merchantOrderNumber,
    traceId: options.traceId,
  })
  const digest = createHash('sha256')
    .update(`${order.merchantOrderNumber}:${query.requestId}`)
    .digest('hex')
  const result = await persistAndApplyConfirmation(req, order, query, {
    digest,
    notificationId: `QUERY-${digest}`,
    receivedAt: now.toISOString(),
    source: 'query',
  })
  return paymentStatusResultSchema.parse({
    data: {
      amountMinor: result.order.amountMinor,
      currency: result.order.currency,
      orderNumber: result.order.orderNumber,
      status: result.order.status,
    },
    meta: { observedAt: query.observedAt, traceId: options.traceId },
    state: 'ready',
  }) as Extract<PaymentStatusResult, { state: 'ready' }>
}

type PaymentTimeoutResult = {
  cancelled: number
  checked: number
  failed: number
  paid: number
  unchanged: number
}

async function queryAndApplyPaymentState(
  req: PayloadRequest,
  order: OrderRecord,
  provider: PaymentProvider,
  traceId: string,
  receivedAt: string,
) {
  const query = await provider.queryOrder({
    merchantOrderNumber: order.merchantOrderNumber!,
    traceId,
  })
  const digest = createHash('sha256')
    .update(`${order.merchantOrderNumber}:${query.requestId}`)
    .digest('hex')
  const applied = await persistAndApplyConfirmation(req, order, query, {
    digest,
    notificationId: `QUERY-${digest}`,
    receivedAt,
    source: 'query',
  })
  return { applied, query }
}

export async function runPaymentTimeoutClose(
  req: PayloadRequest,
  options: {
    limit?: number
    now?: Date
    orderId?: number | string
    provider: PaymentProvider
    traceId: string
  },
): Promise<PaymentTimeoutResult> {
  if (req.user) {
    throw new AppError('PAYMENT_TIMEOUT_SYSTEM_ONLY', '支付超时关单只能由后台执行', 403)
  }
  const now = options.now ?? new Date()
  const due = await req.payload.find({
    collection: 'orders',
    depth: 0,
    limit: Math.min(options.limit ?? PAYMENT_TIMEOUT_BATCH_SIZE, PAYMENT_TIMEOUT_BATCH_SIZE),
    overrideAccess: true,
    req,
    sort: 'paymentExpiresAt',
    where: {
      and: [
        { status: { equals: 'pending_payment' } },
        { merchantOrderNumber: { exists: true } },
        { paymentExpiresAt: { less_than_equal: now.toISOString() } },
        ...(options.orderId === undefined ? [] : [{ id: { equals: options.orderId } }]),
      ],
    },
  })
  const result: PaymentTimeoutResult = {
    cancelled: 0,
    checked: due.docs.length,
    failed: 0,
    paid: 0,
    unchanged: 0,
  }

  for (const rawOrder of due.docs) {
    const order = rawOrder as unknown as OrderRecord
    const orderTraceId = `${options.traceId}-${order.id}`
    try {
      const initial = await queryAndApplyPaymentState(
        req,
        order,
        options.provider,
        orderTraceId,
        now.toISOString(),
      )
      if (initial.applied.order.status === 'paid') {
        result.paid += 1
        continue
      }
      if (initial.applied.order.status !== 'pending_payment') {
        result.unchanged += 1
        continue
      }
      const initialState = initial.query.ok ? initial.query.data.state : 'unknown'
      if (initialState !== 'closed' && initialState !== 'not_paid') {
        result.unchanged += 1
        continue
      }

      let confirmed = initial
      if (initialState === 'not_paid') {
        await options.provider.closeOrder({
          merchantOrderNumber: order.merchantOrderNumber!,
          traceId: orderTraceId,
        })
        confirmed = await queryAndApplyPaymentState(
          req,
          initial.applied.order,
          options.provider,
          `${orderTraceId}-confirm-close`,
          now.toISOString(),
        )
      }
      if (confirmed.applied.order.status === 'paid') {
        result.paid += 1
        continue
      }
      if (
        confirmed.applied.order.status !== 'pending_payment' ||
        !confirmed.query.ok ||
        confirmed.query.data.state !== 'closed'
      ) {
        result.unchanged += 1
        continue
      }
      await transitionOrder(req, order.id, 'cancelled', {
        actorType: 'system',
        evidence: {
          paymentExpiresAt: order.paymentExpiresAt,
          providerRequestId: confirmed.query.requestId,
          providerState: confirmed.query.data.state,
        },
        reasonCode: 'wechatpay.payment_expired_closed',
      })
      result.cancelled += 1
    } catch (error) {
      result.failed += 1
      req.payload.logger.error({
        err: error,
        msg: 'Payment timeout close failed and will be retried by the next scheduled scan',
        orderId: order.id,
      })
    }
  }
  return result
}
