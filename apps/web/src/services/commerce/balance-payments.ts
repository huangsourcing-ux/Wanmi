import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import { paymentSessionResultSchema, type PaymentSessionResult } from '@/schemas/payments'
import { assertCustomerAccountCapability } from '@/services/auth/account-state'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import {
  captureWalletHold,
  holdWalletBalance,
  type WalletMutationResult,
} from '@/services/wallet/ledger'

import { enqueueCommerceFulfillment } from './fulfillment'
import { transitionOrder } from './order-state'

type CustomerIdentity = {
  collection: 'customers'
  id: number
  status?: string
}

export type BalancePaymentOrder = {
  amountMinor: number
  currency: 'CNY'
  customer: { id: number | string } | number | string
  id: number | string
  merchantOrderNumber?: null | string
  orderNumber: string
  paidAt?: null | string
  paymentChannel?: 'balance' | 'h5' | 'native' | null
  paymentExpiresAt?: null | string
  balanceHoldTransactionKey?: null | string
  quoteSnapshot?: unknown
  status: string
}

type BalancePaymentDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

function relationId(value: { id: number | string } | number | string): number | string {
  return typeof value === 'object' ? value.id : value
}

function assertCustomer(req: PayloadRequest, customer: CustomerIdentity): void {
  if (!isCustomerUser(req.user) || String(req.user.id) !== String(customer.id)) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
}

function orderAmountFen(order: BalancePaymentOrder): bigint {
  if (!Number.isSafeInteger(order.amountMinor) || order.amountMinor <= 0) {
    throw new AppError('BALANCE_PAYMENT_AMOUNT_INVALID', '订单冻结金额无效，禁止余额支付', 409)
  }
  return BigInt(order.amountMinor)
}

function quoteExpiry(order: BalancePaymentOrder): string {
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

async function database(req: PayloadRequest): Promise<BalancePaymentDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as BalancePaymentDatabase | undefined
  if (!current) {
    throw new AppError('BALANCE_PAYMENT_CLAIM_UNAVAILABLE', '无法原子确认余额支付', 503)
  }
  return current
}

async function findCustomerOrder(
  req: PayloadRequest,
  orderNumber: string,
  customer: CustomerIdentity,
): Promise<BalancePaymentOrder> {
  const found = await req.payload.find({
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
  const order = found.docs[0]
  if (!order) throw new AppError('ORDER_NOT_FOUND', '未找到订单', 404)
  return (await req.payload.findByID({
    collection: 'orders',
    depth: 0,
    id: order.id,
    overrideAccess: true,
    req,
  })) as unknown as BalancePaymentOrder
}

async function customerWalletAccountId(
  req: PayloadRequest,
  customer: CustomerIdentity,
): Promise<number | string> {
  const accounts = await req.payload.find({
    collection: 'walletAccounts',
    depth: 0,
    limit: 2,
    overrideAccess: false,
    req,
    user: req.user,
    where: {
      and: [{ customer: { equals: customer.id } }, { currency: { equals: 'CNY' } }],
    },
  })
  if (accounts.docs.length !== 1) {
    throw new AppError('WALLET_ACCOUNT_UNAVAILABLE', '钱包账户不存在或不可用', 409)
  }
  return accounts.docs[0]!.id
}

function mixedPaymentError(): AppError {
  return new AppError('MIXED_PAYMENT_CHANNELS_FORBIDDEN', '同一订单不得同时使用余额与微信支付', 409)
}

export function balancePaymentTransactionKey(orderId: number | string): string {
  return `order-balance-payment:${orderId}`
}

export async function claimBalancePaymentChannel(
  req: PayloadRequest,
  input: { orderId: number | string; paidAt: string },
): Promise<boolean> {
  return transaction(req, async () => {
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE orders
      SET payment_channel = 'balance', paid_at = ${input.paidAt}::timestamptz, updated_at = NOW()
      WHERE id = ${input.orderId}
        AND status = 'pending_payment'
        AND payment_channel IS NULL
        AND merchant_order_number IS NULL
        AND payment_expires_at IS NULL
      RETURNING id
    `)
    return claimed.rows?.[0]?.id !== undefined
  })
}

export async function loadBalancePaymentHold(
  req: PayloadRequest,
  order: BalancePaymentOrder,
): Promise<{
  amountFen: bigint
  status: 'captured' | 'held' | 'released'
  transactionId: number | string
  transactionKey: string
}> {
  const expectedAmount = orderAmountFen(order)
  const transactionKey =
    order.balanceHoldTransactionKey?.trim() || balancePaymentTransactionKey(order.id)
  const found = await req.payload.find({
    collection: 'walletTransactions',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    req,
    where: { transactionKey: { equals: transactionKey } },
  })
  const hold = found.docs[0]
  const customerId = relationId(order.customer)
  if (
    found.docs.length !== 1 ||
    !hold ||
    hold.type !== 'hold' ||
    String(relationId(hold.customer)) !== String(customerId) ||
    !Number.isSafeInteger(hold.amountFen) ||
    BigInt(hold.amountFen) !== expectedAmount ||
    !['captured', 'held', 'released'].includes(hold.status)
  ) {
    throw new AppError(
      'BALANCE_PAYMENT_HOLD_MISMATCH',
      '余额冻结记录与订单冻结金额或归属不一致',
      409,
    )
  }
  return {
    amountFen: BigInt(hold.amountFen),
    status: hold.status as 'captured' | 'held' | 'released',
    transactionId: hold.id,
    transactionKey,
  }
}

export async function createBalancePayment(
  req: PayloadRequest,
  orderNumber: string,
  options: {
    customer: CustomerIdentity
    now?: () => Date
    traceId: string
  },
): Promise<Extract<PaymentSessionResult, { state: 'ready' }>> {
  assertCustomer(req, options.customer)
  const now = options.now ?? (() => new Date())
  return transaction(req, async () => {
    await assertCustomerAccountCapability(req, options.customer.id, 'purchase')
    await assertCustomerAccountCapability(req, options.customer.id, 'balance_spend')
    const order = await findCustomerOrder(req, orderNumber, options.customer)
    if (order.paymentChannel === 'balance') {
      throw new AppError('BALANCE_PAYMENT_ALREADY_SELECTED', '该订单正在进行余额支付', 409)
    }
    if (order.status !== 'pending_payment') {
      throw new AppError('ORDER_NOT_PENDING_PAYMENT', '订单当前不可发起支付', 409)
    }
    if (Date.parse(quoteExpiry(order)) <= now().getTime()) {
      throw new AppError('QUOTE_EXPIRED', '报价已过期，请重新获取报价并下单', 409)
    }

    const paidAt = now().toISOString()
    const claimed = await claimBalancePaymentChannel(req, { orderId: order.id, paidAt })
    if (!claimed) {
      const current = (await req.payload.findByID({
        collection: 'orders',
        depth: 0,
        id: order.id,
        overrideAccess: true,
        req,
      })) as unknown as BalancePaymentOrder
      if (
        current.paymentChannel === 'h5' ||
        current.paymentChannel === 'native' ||
        current.merchantOrderNumber ||
        current.paymentExpiresAt
      ) {
        throw mixedPaymentError()
      }
      throw new AppError('BALANCE_PAYMENT_CREATE_CONFLICT', '余额支付正在处理，请勿重复提交', 409)
    }

    const accountId = await customerWalletAccountId(req, options.customer)
    const hold = await holdWalletBalance(req, {
      accountId,
      amountFen: orderAmountFen(order),
      transactionKey: balancePaymentTransactionKey(order.id),
    })
    if (hold.status !== 'held') {
      throw new AppError('BALANCE_PAYMENT_HOLD_INVALID', '余额冻结状态无效', 409)
    }
    await transitionOrder(req, order.id, 'paid', {
      actorId: String(options.customer.id),
      actorType: 'customer',
      evidence: {
        amountMinor: order.amountMinor,
        holdTransactionId: String(hold.transactionId),
        paymentChannel: 'balance',
      },
      reasonCode: 'wallet.balance_payment_confirmed',
    })
    await enqueueCommerceFulfillment(req, { orderId: order.id, traceId: options.traceId })
    await recordAuditEvent(req, {
      action: 'wallet.balance_payment.held',
      actor: { id: options.customer.id, type: 'customer' },
      metadata: {
        amountMinor: order.amountMinor,
        holdTransactionId: String(hold.transactionId),
        paymentChannel: 'balance',
      },
      targetId: order.id,
    })
    return paymentSessionResultSchema.parse({
      data: {
        amountMinor: order.amountMinor,
        channel: 'balance',
        currency: 'CNY',
        orderNumber: order.orderNumber,
        status: 'paid',
      },
      meta: { observedAt: paidAt, traceId: options.traceId },
      state: 'ready',
    }) as Extract<PaymentSessionResult, { state: 'ready' }>
  })
}

export async function captureBalancePaymentForFulfillment(
  req: PayloadRequest,
  orderId: number | string,
): Promise<WalletMutationResult | undefined> {
  const order = (await req.payload.findByID({
    collection: 'orders',
    depth: 0,
    id: orderId,
    overrideAccess: true,
    req,
  })) as unknown as BalancePaymentOrder
  if (order.paymentChannel !== 'balance') return undefined
  const hold = await loadBalancePaymentHold(req, order)
  const captured = await captureWalletHold(req, hold.transactionKey)
  if (captured.status !== 'captured') {
    throw new AppError('BALANCE_PAYMENT_CAPTURE_INVALID', '余额扣减状态无效', 409)
  }
  if (captured.applied) {
    await recordAuditEvent(req, {
      action: 'wallet.balance_payment.captured',
      actor: { type: 'system' },
      metadata: {
        amountMinor: order.amountMinor,
        holdTransactionId: String(hold.transactionId),
        paymentChannel: order.paymentChannel,
      },
      targetId: order.id,
    })
  }
  return captured
}
