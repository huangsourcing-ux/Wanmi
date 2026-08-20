import { randomBytes } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import type { PaymentOrder, PaymentProvider, VerifiedPaymentNotification } from '@/providers/types'
import {
  paymentSessionResultSchema,
  type PaymentSessionResult,
  type WechatPaymentCreateRequest,
} from '@/schemas/payments'
import { walletTopUpOrderResultSchema, type WalletTopUpOrderResult } from '@/schemas/wallet'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { assertCustomerAccountCapability } from '@/services/auth/account-state'
import { assertIdentityRiskCooldownInactive } from '@/services/auth/step-up'

import {
  captureWalletHold,
  createWalletAccount,
  holdWalletBalance,
  postWalletCredit,
  readWalletBalance,
} from './ledger'
import {
  assertAccountBalanceLimit,
  assertSingleTopUpLimit,
  assertWalletCurrency,
  loadWalletFundsPolicy,
} from './policy'

const MAX_SAFE_MONEY = BigInt(Number.MAX_SAFE_INTEGER)
const TOP_UP_PAYMENT_TTL_MS = 30 * 60 * 1_000

type CustomerIdentity = {
  collection: 'customers'
  id: number | string
  status?: string
}

type TopUpStatus =
  | 'closed'
  | 'created'
  | 'credited'
  | 'payment_pending'
  | 'provider_confirmed'
  | 'refund_pending'
  | 'refunded'
  | 'unknown'

type TopUpRecord = {
  account: number | string
  amountFen: number
  creditedAt?: null | string
  currency: 'CNY'
  customer: number | string
  fundingSource: 'wechat'
  id: number | string
  ledgerTransactionKey: string
  originalRefundNumber?: null | string
  paymentChannel?: 'h5' | 'native' | null
  paymentExpiresAt?: null | string
  providerPaidAt?: null | string
  refundedAt?: null | string
  status: TopUpStatus
  topUpOrderNumber: string
  wechatTransactionId?: null | string
}

type TopUpDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

type PaidQuery = PaymentOrder & {
  amountMinor: number
  currency: 'CNY'
  paidAt: string
  state: 'paid'
  transactionId: string
}

type ConfirmationSource =
  | { source: 'query' }
  | {
      notification: Extract<VerifiedPaymentNotification, { verified: true }>
      source: 'notification'
    }

function topUpUnavailable(message = '钱包充值服务暂时不可用'): AppError {
  return new AppError('WALLET_TOP_UP_UNAVAILABLE', message, 503)
}

function identifier(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) return value
  throw topUpUnavailable()
}

function databaseInteger(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value)
  throw topUpUnavailable()
}

function positiveAmount(value: bigint | number): bigint {
  const amount =
    typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : 0n
  if (amount <= 0n || amount > MAX_SAFE_MONEY) {
    throw new AppError('WALLET_TOP_UP_AMOUNT_INVALID', '充值金额必须是正整数分', 400)
  }
  return amount
}

function assertCustomer(req: PayloadRequest, customer: CustomerIdentity): void {
  if (!isCustomerUser(req.user) || String(req.user.id) !== String(customer.id)) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
}

function asRecord(value: unknown): TopUpRecord {
  const record = value as Partial<TopUpRecord>
  if (
    !record ||
    typeof record !== 'object' ||
    !record.id ||
    !record.topUpOrderNumber ||
    !record.ledgerTransactionKey ||
    !record.status ||
    !record.currency ||
    !record.fundingSource ||
    !record.amountFen ||
    !record.customer ||
    !record.account
  ) {
    throw topUpUnavailable('充值单数据无效')
  }
  return record as TopUpRecord
}

function view(record: TopUpRecord): Extract<WalletTopUpOrderResult, { state: 'ready' }> {
  return walletTopUpOrderResultSchema.parse({
    data: {
      amountFen: record.amountFen,
      currency: record.currency,
      status: record.status,
      topUpOrderNumber: record.topUpOrderNumber,
    },
    state: 'ready',
  }) as Extract<WalletTopUpOrderResult, { state: 'ready' }>
}

function topUpOrderNumber(): string {
  return `WT${randomBytes(15).toString('hex')}`
}

function ledgerKey(orderNumber: string): string {
  return `wallet-top-up:${orderNumber}:credit`
}

function databaseConstraint(error: unknown): string | undefined {
  let candidate: unknown = error
  for (let depth = 0; depth < 4 && candidate && typeof candidate === 'object'; depth += 1) {
    const value = candidate as { cause?: unknown; constraint?: unknown }
    if (typeof value.constraint === 'string') return value.constraint
    candidate = value.cause
  }
  return undefined
}

function mapDatabaseError(error: unknown): AppError | undefined {
  const constraint = databaseConstraint(error)
  if (constraint === 'wallet_top_up_orders_wechat_transaction_id_idx') {
    return new AppError(
      'WALLET_TOP_UP_WECHAT_TRANSACTION_CONFLICT',
      '该微信交易号已用于其他充值单',
      409,
    )
  }
  if (constraint === 'wallet_top_up_orders_original_refund_number_idx') {
    return new AppError('WALLET_TOP_UP_REFUND_NUMBER_CONFLICT', '原路退款单号已被使用', 409)
  }
  if (
    constraint === 'wallet_top_up_orders_top_up_order_number_idx' ||
    constraint === 'wallet_top_up_orders_ledger_transaction_key_idx'
  ) {
    return new AppError('WALLET_TOP_UP_IDEMPOTENCY_CONFLICT', '充值单唯一标识冲突', 409)
  }
  return undefined
}

async function database(req: PayloadRequest): Promise<TopUpDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const transactionDatabase = session?.db as TopUpDatabase | undefined
  if (!transactionDatabase) throw topUpUnavailable('无法建立安全充值事务')
  return transactionDatabase
}

async function transaction<T>(req: PayloadRequest, work: () => Promise<T>): Promise<T> {
  const started = await initTransaction(req)
  try {
    const result = await work()
    if (started) await commitTransaction(req)
    return result
  } catch (error) {
    if (started) await killTransaction(req)
    if (error instanceof AppError) throw error
    throw mapDatabaseError(error) ?? topUpUnavailable()
  }
}

async function findCustomerTopUp(
  req: PayloadRequest,
  orderNumber: string,
  customer: CustomerIdentity,
): Promise<TopUpRecord> {
  const found = await req.payload.find({
    collection: 'walletTopUpOrders',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req,
    user: req.user,
    where: {
      and: [{ topUpOrderNumber: { equals: orderNumber } }, { customer: { equals: customer.id } }],
    },
  })
  if (!found.docs[0]) throw new AppError('WALLET_TOP_UP_NOT_FOUND', '未找到充值单', 404)
  return asRecord(
    await req.payload.findByID({
      collection: 'walletTopUpOrders',
      depth: 0,
      id: found.docs[0].id,
      overrideAccess: true,
      req,
    }),
  )
}

export async function findWalletTopUpByOrderNumber(
  req: PayloadRequest,
  orderNumber: string,
): Promise<TopUpRecord | undefined> {
  const found = await req.payload.find({
    collection: 'walletTopUpOrders',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { topUpOrderNumber: { equals: orderNumber } },
  })
  return found.docs[0] ? asRecord(found.docs[0]) : undefined
}

async function currentTopUp(req: PayloadRequest, id: number | string): Promise<TopUpRecord> {
  return asRecord(
    await req.payload.findByID({
      collection: 'walletTopUpOrders',
      depth: 0,
      id,
      overrideAccess: true,
      req,
    }),
  )
}

async function assertTopUpCapability(
  req: PayloadRequest,
  customerId: number | string,
): Promise<void> {
  await assertCustomerAccountCapability(req, customerId, 'purchase')
  await assertIdentityRiskCooldownInactive(req, customerId)
}

async function recordObservation(
  req: PayloadRequest,
  topUp: TopUpRecord,
  input: {
    outcome: string
    providerRequestId: string
    providerState: string
    source: ConfirmationSource['source']
  },
): Promise<void> {
  await recordAuditEvent(req, {
    action: 'wallet.top_up.payment_observed',
    actor: { id: 'wechatpay', type: 'provider' },
    metadata: input,
    targetId: topUp.id,
  })
}

async function ensureManualReview(
  req: PayloadRequest,
  topUp: TopUpRecord,
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
      customer: topUp.customer as never,
      evidence,
      reasonCode,
      status: 'open',
      walletTopUpOrder: topUp.id as never,
    },
    overrideAccess: true,
    req,
  })
}

function paidQuery(order: PaymentOrder | undefined): PaidQuery | undefined {
  if (
    order?.state !== 'paid' ||
    !order.transactionId ||
    !order.paidAt ||
    order.currency !== 'CNY' ||
    !Number.isSafeInteger(Number(order.amountMinor)) ||
    (order.amountMinor ?? 0) <= 0
  ) {
    return undefined
  }
  return order as PaidQuery
}

function notificationMatchesQuery(source: ConfirmationSource, query: PaidQuery): boolean {
  if (source.source === 'query') return true
  return (
    source.notification.transactionId === query.transactionId &&
    source.notification.amountMinor === query.amountMinor &&
    Date.parse(source.notification.paidAt) === Date.parse(query.paidAt)
  )
}

async function applyPaymentQuery(
  req: PayloadRequest,
  topUp: TopUpRecord,
  queryResult: Awaited<ReturnType<PaymentProvider['queryOrder']>>,
  source: ConfirmationSource,
): Promise<{ applied: boolean; topUp: TopUpRecord }> {
  const query = queryResult.ok ? queryResult.data : undefined
  const paid = paidQuery(query)
  if (!queryResult.ok || !query || query.state === 'unknown') {
    await transaction(req, async () => {
      await recordObservation(req, topUp, {
        outcome: 'status_unknown',
        providerRequestId: queryResult.requestId,
        providerState: query?.state ?? 'unavailable',
        source: source.source,
      })
    })
    return { applied: false, topUp: await currentTopUp(req, topUp.id) }
  }
  if (!paid) {
    await transaction(req, async () => {
      await recordObservation(req, topUp, {
        outcome: 'not_paid',
        providerRequestId: queryResult.requestId,
        providerState: query.state,
        source: source.source,
      })
    })
    return { applied: false, topUp: await currentTopUp(req, topUp.id) }
  }

  const merchantMatches = paid.merchantOrderNumber === topUp.topUpOrderNumber
  const amountMatches = BigInt(paid.amountMinor) === positiveAmount(topUp.amountFen)
  const notificationMatches = notificationMatchesQuery(source, paid)
  if (!merchantMatches || !amountMatches || !notificationMatches) {
    const reasonCode = amountMatches
      ? 'wallet_top_up.payment_identifier_mismatch'
      : 'wallet_top_up.payment_amount_mismatch'
    await transaction(req, async () => {
      await ensureManualReview(req, topUp, reasonCode, {
        localAmountFen: topUp.amountFen,
        merchantMatches,
        notificationMatches,
        providerAmountFen: paid.amountMinor,
        providerRequestId: queryResult.requestId,
        source: source.source,
      })
      await recordObservation(req, topUp, {
        outcome: reasonCode,
        providerRequestId: queryResult.requestId,
        providerState: paid.state,
        source: source.source,
      })
    })
    return { applied: false, topUp: await currentTopUp(req, topUp.id) }
  }

  return transaction(req, async () => {
    await assertTopUpCapability(req, topUp.customer)
    const policy = await loadWalletFundsPolicy(req)
    const db = await database(req)
    const confirmed = await db.execute(sql`
      UPDATE wallet_top_up_orders
      SET
        status = 'provider_confirmed',
        wechat_transaction_id = ${paid.transactionId},
        provider_paid_at = ${paid.paidAt},
        payer_identifier_hash = ${
          paid.payerIdentifier ? hmac(paid.payerIdentifier, getEnv().SESSION_PEPPER) : null
        },
        provider_confirmed_at = NOW(),
        updated_at = NOW()
      WHERE top_up_order_number = ${paid.merchantOrderNumber}
        AND status = 'payment_pending'
        AND amount_fen = ${BigInt(paid.amountMinor).toString()}
      RETURNING id
    `)
    if (confirmed.rows?.[0]?.id === undefined) {
      const current = await currentTopUp(req, topUp.id)
      if (current.status === 'credited' && current.wechatTransactionId === paid.transactionId) {
        return { applied: false, topUp: current }
      }
      if (current.status === 'refunded' || current.status === 'refund_pending') {
        return { applied: false, topUp: current }
      }
      throw new AppError('WALLET_TOP_UP_STATE_CONFLICT', '充值单状态已变化', 409)
    }

    const credit = await postWalletCredit(req, {
      accountId: topUp.account,
      amountFen: BigInt(paid.amountMinor),
      maximumPostedBalanceFen: policy.accountBalanceLimitFen,
      transactionKey: topUp.ledgerTransactionKey,
    })
    if (credit.status !== 'posted') throw topUpUnavailable('充值入账结果无效')

    const credited = await db.execute(sql`
      UPDATE wallet_top_up_orders
      SET status = 'credited', credited_at = NOW(), updated_at = NOW()
      WHERE id = ${topUp.id}
        AND status = 'provider_confirmed'
      RETURNING id
    `)
    if (credited.rows?.[0]?.id === undefined) throw topUpUnavailable('充值入账状态提交失败')
    await recordAuditEvent(req, {
      action: 'wallet.top_up.credited',
      actor: { id: 'wechatpay', type: 'provider' },
      metadata: {
        amountFen: paid.amountMinor,
        ledgerApplied: credit.applied,
        providerRequestId: queryResult.requestId,
        source: source.source,
      },
      targetId: topUp.id,
    })
    return { applied: true, topUp: await currentTopUp(req, topUp.id) }
  })
}

export async function createWalletTopUpOrder(
  req: PayloadRequest,
  input: { amountFen: bigint | number; currency?: string; fundingSource: string },
  options: { customer: CustomerIdentity },
): Promise<Extract<WalletTopUpOrderResult, { state: 'ready' }>> {
  assertCustomer(req, options.customer)
  if (input.fundingSource !== 'wechat') {
    throw new AppError('WALLET_TOP_UP_BALANCE_FORBIDDEN', '余额不能用于余额充值', 409)
  }
  assertWalletCurrency(input.currency ?? 'CNY')
  const amount = positiveAmount(input.amountFen)
  return transaction(req, async () => {
    await assertTopUpCapability(req, options.customer.id)
    const policy = await loadWalletFundsPolicy(req)
    assertSingleTopUpLimit(policy, amount)
    const account = await createWalletAccount(req, options.customer.id)
    const balance = await readWalletBalance(req, account.accountId)
    assertAccountBalanceLimit(policy, balance.postedBalance, amount)
    const orderNumber = topUpOrderNumber()
    const transactionKey = ledgerKey(orderNumber)
    const inserted = await (
      await database(req)
    ).execute(sql`
      INSERT INTO wallet_top_up_orders (
        top_up_order_number,
        customer_id,
        account_id,
        amount_fen,
        currency,
        funding_source,
        status,
        ledger_transaction_key,
        updated_at,
        created_at
      ) VALUES (
        ${orderNumber},
        ${options.customer.id},
        ${account.accountId},
        ${amount.toString()},
        'CNY',
        'wechat',
        'created',
        ${transactionKey},
        NOW(),
        NOW()
      )
      RETURNING id
    `)
    const id = inserted.rows?.[0]?.id
    if (id === undefined) throw topUpUnavailable('创建充值单失败')
    await recordAuditEvent(req, {
      action: 'wallet.top_up.created',
      actor: { id: options.customer.id, type: 'customer' },
      metadata: { amountFen: amount.toString(), fundingSource: 'wechat' },
      targetId: identifier(id),
    })
    return view(await currentTopUp(req, identifier(id)))
  })
}

export async function createWalletTopUpPayment(
  req: PayloadRequest,
  orderNumber: string,
  input: WechatPaymentCreateRequest,
  options: {
    clientIp?: string
    customer: CustomerIdentity
    now?: () => Date
    provider: PaymentProvider
    traceId: string
  },
): Promise<Extract<PaymentSessionResult, { state: 'ready' }>> {
  assertCustomer(req, options.customer)
  const topUp = await findCustomerTopUp(req, orderNumber, options.customer)
  if (topUp.fundingSource !== 'wechat') {
    throw new AppError('WALLET_TOP_UP_BALANCE_FORBIDDEN', '余额不能用于余额充值', 409)
  }
  const now = options.now?.() ?? new Date()
  const expiresAt = new Date(now.getTime() + TOP_UP_PAYMENT_TTL_MS).toISOString()
  await transaction(req, async () => {
    await assertTopUpCapability(req, topUp.customer)
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE wallet_top_up_orders
      SET
        status = 'payment_pending',
        payment_channel = ${input.channel},
        payment_expires_at = ${expiresAt},
        updated_at = NOW()
      WHERE id = ${topUp.id}
        AND status = 'created'
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) {
      throw new AppError(
        'WALLET_TOP_UP_PAYMENT_CREATE_CONFLICT',
        '充值支付单正在创建或已经创建',
        409,
      )
    }
    await recordAuditEvent(req, {
      action: 'wallet.top_up.payment_started',
      actor: { id: options.customer.id, type: 'customer' },
      metadata: { channel: input.channel, expiresAt },
      targetId: topUp.id,
    })
  })

  const result = await options.provider.createPayment({
    amountMinor: Number(positiveAmount(topUp.amountFen)),
    channel: input.channel,
    clientIp: options.clientIp,
    description: 'Wanmi 钱包充值',
    expiresAt,
    merchantOrderNumber: topUp.topUpOrderNumber,
    traceId: options.traceId,
  })
  if (!result.ok) {
    if (!result.error.statusKnown) {
      const query = await options.provider.queryOrder({
        merchantOrderNumber: topUp.topUpOrderNumber,
        traceId: options.traceId,
      })
      await applyPaymentQuery(req, topUp, query, { source: 'query' })
    } else {
      await transaction(req, async () => {
        const closed = await (
          await database(req)
        ).execute(sql`
          UPDATE wallet_top_up_orders
          SET status = 'closed', updated_at = NOW()
          WHERE id = ${topUp.id}
            AND status = 'payment_pending'
          RETURNING id
        `)
        if (closed.rows?.[0]?.id === undefined) {
          throw new AppError('WALLET_TOP_UP_STATE_CONFLICT', '充值单状态已变化', 409)
        }
      })
    }
    throw new AppError(
      result.error.statusKnown ? 'WECHATPAY_CREATE_REJECTED' : 'WECHATPAY_CREATE_UNKNOWN',
      result.error.statusKnown ? '微信充值支付单创建失败' : '微信充值支付单状态暂时无法确认',
      result.error.statusKnown ? 409 : 503,
      { retryable: result.error.retryable },
    )
  }
  return paymentSessionResultSchema.parse({
    data: { ...result.data, merchantOrderNumber: topUp.topUpOrderNumber },
    meta: { observedAt: result.observedAt, traceId: options.traceId },
    state: 'ready',
  }) as Extract<PaymentSessionResult, { state: 'ready' }>
}

export async function queryAndConfirmWalletTopUpPayment(
  req: PayloadRequest,
  orderNumber: string,
  options: {
    customer: CustomerIdentity
    provider: PaymentProvider
    traceId: string
  },
): Promise<Extract<WalletTopUpOrderResult, { state: 'ready' }>> {
  assertCustomer(req, options.customer)
  const topUp = await findCustomerTopUp(req, orderNumber, options.customer)
  if (!topUp.paymentChannel || !topUp.paymentExpiresAt) {
    throw new AppError('WALLET_TOP_UP_PAYMENT_NOT_CREATED', '充值单尚未创建微信支付单', 409)
  }
  const query = await options.provider.queryOrder({
    merchantOrderNumber: topUp.topUpOrderNumber,
    traceId: options.traceId,
  })
  const result = await applyPaymentQuery(req, topUp, query, { source: 'query' })
  return view(result.topUp)
}

export async function processWalletTopUpPaymentNotification(
  req: PayloadRequest,
  notification: Extract<VerifiedPaymentNotification, { verified: true }>,
  provider: PaymentProvider,
  traceId: string,
): Promise<{ handled: boolean; idempotentReplay?: boolean; topUpOrderId?: number | string }> {
  const topUp = await findWalletTopUpByOrderNumber(req, notification.merchantOrderNumber)
  if (!topUp) return { handled: false }
  const query = await provider.queryOrder({
    merchantOrderNumber: topUp.topUpOrderNumber,
    traceId,
  })
  const result = await applyPaymentQuery(req, topUp, query, {
    notification,
    source: 'notification',
  })
  return { handled: true, idempotentReplay: !result.applied, topUpOrderId: topUp.id }
}

export async function markWalletTopUpOriginalRefunded(
  req: PayloadRequest,
  input: { originalRefundNumber: string; refundedAt: string; topUpOrderNumber: string },
): Promise<{ applied: boolean; status: 'refunded' }> {
  if (req.user) {
    throw new AppError(
      'WALLET_TOP_UP_REFUND_SYSTEM_ONLY',
      '充值退款标记只能由受信后台流程执行',
      403,
    )
  }
  const refundNumber = input.originalRefundNumber.trim()
  if (!refundNumber || refundNumber.length > 64) {
    throw new AppError('WALLET_TOP_UP_REFUND_NUMBER_INVALID', '原路退款单号无效', 400)
  }
  if (!Number.isFinite(Date.parse(input.refundedAt))) {
    throw new AppError('WALLET_TOP_UP_REFUNDED_AT_INVALID', '原路退款时间无效', 400)
  }
  const topUp = await findWalletTopUpByOrderNumber(req, input.topUpOrderNumber)
  if (!topUp) throw new AppError('WALLET_TOP_UP_NOT_FOUND', '未找到充值单', 404)

  return transaction(req, async () => {
    const db = await database(req)
    const claimed = await db.execute(sql`
      UPDATE wallet_top_up_orders
      SET
        status = 'refund_pending',
        original_refund_number = ${refundNumber},
        refunded_amount_fen = amount_fen,
        updated_at = NOW()
      WHERE id = ${topUp.id}
        AND status IN ('payment_pending', 'provider_confirmed', 'credited')
      RETURNING
        id,
        account_id,
        amount_fen,
        ledger_transaction_key,
        credited_at
    `)
    const row = claimed.rows?.[0]
    if (!row) {
      const current = await currentTopUp(req, topUp.id)
      if (current.status === 'refunded') {
        if (current.originalRefundNumber !== refundNumber) {
          throw new AppError('WALLET_TOP_UP_REFUND_CONFLICT', '充值单已由其他原路退款单处理', 409)
        }
        return { applied: false, status: 'refunded' as const }
      }
      if (current.status === 'refund_pending') {
        throw new AppError('WALLET_TOP_UP_REFUND_CONFLICT', '充值单已由其他原路退款单处理', 409)
      }
      throw new AppError('WALLET_TOP_UP_REFUND_STATE_INVALID', '充值单当前不可标记原路退款', 409)
    }

    const hadWalletCredit = row.credited_at !== null && row.credited_at !== undefined
    if (hadWalletCredit) {
      const refundLedgerKey = `${String(row.ledger_transaction_key)}:original-refund`
      try {
        await holdWalletBalance(req, {
          accountId: identifier(row.account_id),
          amountFen: databaseInteger(row.amount_fen),
          transactionKey: refundLedgerKey,
        })
      } catch (error) {
        if (error instanceof AppError && error.code === 'WALLET_BALANCE_INSUFFICIENT') {
          throw new AppError(
            'WALLET_TOP_UP_REFUND_BALANCE_CONSUMED',
            '该笔充值对应余额已被消费，不能无条件原路退款',
            409,
          )
        }
        throw error
      }
      await captureWalletHold(req, refundLedgerKey)
    }

    const refunded = await db.execute(sql`
      UPDATE wallet_top_up_orders
      SET status = 'refunded', refunded_at = ${input.refundedAt}, updated_at = NOW()
      WHERE id = ${topUp.id}
        AND status = 'refund_pending'
      RETURNING id
    `)
    if (refunded.rows?.[0]?.id === undefined) throw topUpUnavailable('充值退款状态提交失败')
    await recordAuditEvent(req, {
      action: 'wallet.top_up.refunded',
      actor: { id: 'wechatpay', type: 'provider' },
      metadata: { hadWalletCredit, refundedAt: input.refundedAt },
      targetId: topUp.id,
    })
    return { applied: true, status: 'refunded' as const }
  })
}
