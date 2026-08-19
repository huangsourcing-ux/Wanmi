import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import type { CustomerAccountStatus, CustomerCapabilityRestriction } from '@/lib/domain'
import { AppError } from '@/lib/errors'
import {
  accountRestrictions,
  transitionCustomerAccount,
  type CustomerAccountSnapshot,
} from '@/services/auth/account-state'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import {
  requestAutomaticRegistrationFailureRefund,
  requestWalletTopUpOriginalRefund,
} from '@/services/commerce/refunds'

import { assertPostedWalletCredit, readWalletBalance, recoverWalletBalance } from './ledger'
import { loadWalletFundsPolicy } from './policy'

type ScenarioDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

type TopUpRecord = {
  account: number | string | { id: number | string }
  amountFen: number
  creditedAt?: null | string
  currency: 'CNY'
  customer: number | string | { id: number | string }
  id: number | string
  ledgerTransactionKey: string
  originalRefundNumber?: null | string
  paymentChannel?: 'h5' | 'native' | null
  paymentRecoveredAt?: null | string
  paymentRecoveryKey?: null | string
  paymentRecoveryType?: null | 'dispute' | 'provider_refund'
  providerPaidAt?: null | string
  refundedAmountFen?: null | number
  status: string
  topUpOrderNumber: string
  wechatTransactionId?: null | string
}

function relationId(value: number | string | { id: number | string }): number | string {
  return typeof value === 'object' ? value.id : value
}

function assertSystem(req: PayloadRequest): void {
  if (req.user)
    throw new AppError('WALLET_FUNDS_SCENARIO_SYSTEM_ONLY', '资金场景只允许受信后台流程执行', 403)
}

async function database(req: PayloadRequest): Promise<ScenarioDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as ScenarioDatabase | undefined
  if (!current) throw new AppError('WALLET_FUNDS_SCENARIO_UNAVAILABLE', '无法建立安全资金事务', 503)
  return current
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

async function topUpByNumber(req: PayloadRequest, orderNumber: string): Promise<TopUpRecord> {
  const found = await req.payload.find({
    collection: 'walletTopUpOrders',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    req,
    where: { topUpOrderNumber: { equals: orderNumber } },
  })
  if (found.docs.length !== 1 || !found.docs[0]) {
    throw new AppError('WALLET_TOP_UP_NOT_FOUND', '未找到唯一充值单', 404)
  }
  return found.docs[0] as unknown as TopUpRecord
}

export async function refundDuplicateWalletTopUp(
  req: PayloadRequest,
  input: {
    duplicateTopUpOrderNumber: string
    evidence: Record<string, unknown>
    originalTopUpOrderNumber: string
    traceId: string
  },
) {
  assertSystem(req)
  const [original, duplicate] = await Promise.all([
    topUpByNumber(req, input.originalTopUpOrderNumber),
    topUpByNumber(req, input.duplicateTopUpOrderNumber),
  ])
  if (String(original.id) === String(duplicate.id)) {
    throw new AppError('WALLET_DUPLICATE_TOP_UP_INVALID', '原充值单与重复充值单不得相同', 409)
  }
  if (
    String(relationId(original.customer)) !== String(relationId(duplicate.customer)) ||
    String(relationId(original.account)) !== String(relationId(duplicate.account)) ||
    original.currency !== 'CNY' ||
    duplicate.currency !== 'CNY' ||
    original.amountFen !== duplicate.amountFen ||
    original.status !== 'credited' ||
    duplicate.status !== 'credited' ||
    !original.wechatTransactionId ||
    !duplicate.wechatTransactionId ||
    original.wechatTransactionId === duplicate.wechatTransactionId
  ) {
    throw new AppError(
      'WALLET_DUPLICATE_TOP_UP_EVIDENCE_MISMATCH',
      '两笔充值的归属、金额、状态或微信交易证据不支持重复充值退款',
      409,
    )
  }
  await assertPostedWalletCredit(req, {
    accountId: relationId(original.account),
    amountFen: original.amountFen,
    customerId: relationId(original.customer),
    transactionKey: original.ledgerTransactionKey,
  })
  await assertPostedWalletCredit(req, {
    accountId: relationId(duplicate.account),
    amountFen: duplicate.amountFen,
    customerId: relationId(duplicate.customer),
    transactionKey: duplicate.ledgerTransactionKey,
  })
  return requestWalletTopUpOriginalRefund(req, {
    amountFen: duplicate.amountFen,
    evidence: {
      ...input.evidence,
      originalTopUpOrderId: String(original.id),
      originalTopUpOrderNumber: original.topUpOrderNumber,
    },
    note: '同一账户发生独立微信交易的重复充值，退回后发生的一笔。',
    reason: 'duplicate_top_up',
    topUpOrderId: duplicate.id,
    traceId: input.traceId,
  })
}

export async function refundOrderWhenServiceNotProvided(
  req: PayloadRequest,
  input: {
    evidence: Record<string, unknown>
    note: string
    orderId: number | string
    traceId: string
  },
) {
  assertSystem(req)
  return requestAutomaticRegistrationFailureRefund(req, {
    evidence: input.evidence,
    note: input.note,
    orderId: input.orderId,
    traceId: input.traceId,
    transition: { actorType: 'system', reasonCode: 'service.not_provided_full_refund' },
  })
}

export async function requestAccountClosureBalanceRefunds(
  req: PayloadRequest,
  input: { customerId: number; requestId: string; traceId: string },
) {
  assertSystem(req)
  return transaction(req, async () => {
    const accountState = await (
      await database(req)
    ).execute(sql`
      SELECT id, status, active_account_closure_request_key
      FROM customers
      WHERE id = ${input.customerId}
        AND active_account_closure_request_key = ${input.requestId}
        AND status IN ('active', 'restricted')
      FOR SHARE
    `)
    if (accountState.rows?.length !== 1) {
      throw new AppError(
        'ACCOUNT_CLOSURE_REQUEST_NOT_FOUND',
        '未找到该账户的有效关闭申请，禁止处理余额',
        404,
      )
    }
    const accounts = await req.payload.find({
      collection: 'walletAccounts',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      req,
      where: {
        and: [{ customer: { equals: input.customerId } }, { currency: { equals: 'CNY' } }],
      },
    })
    if (accounts.docs.length !== 1 || !accounts.docs[0]) {
      throw new AppError('WALLET_ACCOUNT_UNAVAILABLE', '钱包账户不存在或不可用', 409)
    }
    const accountId = accounts.docs[0].id
    const balance = await readWalletBalance(req, accountId)
    if (balance.availableBalance <= 0n) return { refunds: [], totalAmountFen: '0' }
    const candidates = await req.payload.find({
      collection: 'walletTopUpOrders',
      depth: 0,
      limit: 1_000,
      overrideAccess: true,
      req,
      sort: '-creditedAt',
      where: {
        and: [
          { account: { equals: accountId } },
          { customer: { equals: input.customerId } },
          { currency: { equals: 'CNY' } },
          { status: { equals: 'credited' } },
          { originalRefundNumber: { exists: false } },
          { paymentRecoveryKey: { exists: false } },
        ],
      },
    })
    let remaining = balance.availableBalance
    const refunds: Array<{ amountFen: string; refundId: string; topUpOrderId: string }> = []
    for (const raw of candidates.docs) {
      if (remaining === 0n) break
      const topUp = raw as unknown as TopUpRecord
      if (
        String(relationId(topUp.account)) !== String(accountId) ||
        String(relationId(topUp.customer)) !== String(input.customerId) ||
        topUp.currency !== 'CNY' ||
        !Number.isSafeInteger(topUp.amountFen) ||
        topUp.amountFen <= 0
      ) {
        throw new AppError('WALLET_TOP_UP_REFUND_EVIDENCE_INVALID', '充值退款来源数据无效', 409)
      }
      await assertPostedWalletCredit(req, {
        accountId,
        amountFen: topUp.amountFen,
        customerId: input.customerId,
        transactionKey: topUp.ledgerTransactionKey,
      })
      const amount = remaining < BigInt(topUp.amountFen) ? remaining : BigInt(topUp.amountFen)
      const refund = await requestWalletTopUpOriginalRefund(req, {
        amountFen: amount,
        evidence: { accountClosureRequestId: input.requestId },
        note: '账户关闭前按最近充值优先退回未消费余额。',
        reason: 'account_closure',
        topUpOrderId: topUp.id,
        traceId: `${input.traceId}:${topUp.id}`,
      })
      refunds.push({
        amountFen: amount.toString(),
        refundId: String(refund.refundId),
        topUpOrderId: String(topUp.id),
      })
      remaining -= amount
    }
    if (remaining !== 0n) {
      throw new AppError(
        'WALLET_CLOSURE_REFUND_SOURCE_INSUFFICIENT',
        '未消费余额无法完整映射到已确认的原充值来源',
        409,
      )
    }
    return { refunds, totalAmountFen: balance.availableBalance.toString() }
  })
}

function validOccurredAt(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new AppError('WALLET_PAYMENT_RECOVERY_TIME_INVALID', '支付退款或争议发生时间无效', 400)
  }
  return new Date(value).toISOString()
}

function validRecoveryKey(value: string): string {
  const key = value.trim()
  if (!key || key.length > 128) {
    throw new AppError('WALLET_PAYMENT_RECOVERY_KEY_INVALID', '支付退款或争议业务键无效', 400)
  }
  return key
}

async function restrictNegativeBalanceSpending(
  req: PayloadRequest,
  customerId: number,
  recoveryKey: string,
  recoveredAt: string,
): Promise<void> {
  const customer = (await req.payload.findByID({
    collection: 'customers',
    depth: 0,
    id: customerId,
    overrideAccess: true,
    req,
  })) as CustomerAccountSnapshot
  const status = customer.status as CustomerAccountStatus
  const restrictions = accountRestrictions(customer)
  if (restrictions.includes('balance_spend_disabled')) return
  if (status !== 'active' && status !== 'restricted') {
    throw new AppError(
      'WALLET_NEGATIVE_ACCOUNT_STATE_INVALID',
      '账号状态无法安全施加负余额限制',
      409,
    )
  }
  const nextRestrictions = [
    ...restrictions,
    'balance_spend_disabled',
  ].sort() as CustomerCapabilityRestriction[]
  await transitionCustomerAccount(req, {
    actor: { type: 'system' },
    changedAt: recoveredAt,
    customerId,
    evidence: {
      observedAt: recoveredAt,
      reference: recoveryKey,
      source: 'security_event',
    },
    expectedRestrictions: restrictions,
    expectedStatus: status,
    reason: 'wallet_negative_balance_after_payment_recovery',
    restrictions: nextRestrictions,
    status: 'restricted',
  })
}

export async function recoverWalletTopUpPaymentReversal(
  req: PayloadRequest,
  input: {
    occurredAt: string
    recoveryKey: string
    recoveryType: 'dispute' | 'provider_refund'
    topUpOrderNumber: string
  },
) {
  assertSystem(req)
  const recoveredAt = validOccurredAt(input.occurredAt)
  const recoveryKey = validRecoveryKey(input.recoveryKey)
  return transaction(req, async () => {
    const policy = await loadWalletFundsPolicy(req)
    const topUp = await topUpByNumber(req, input.topUpOrderNumber)
    if (
      topUp.currency !== 'CNY' ||
      !Number.isSafeInteger(topUp.amountFen) ||
      topUp.amountFen <= 0 ||
      !topUp.creditedAt ||
      !topUp.providerPaidAt ||
      !topUp.wechatTransactionId
    ) {
      throw new AppError('WALLET_PAYMENT_RECOVERY_EVIDENCE_INVALID', '充值支付证据不完整', 409)
    }
    await assertPostedWalletCredit(req, {
      accountId: relationId(topUp.account),
      amountFen: topUp.amountFen,
      customerId: relationId(topUp.customer),
      transactionKey: topUp.ledgerTransactionKey,
    })
    if (topUp.paymentRecoveryKey) {
      if (
        topUp.paymentRecoveryKey !== recoveryKey ||
        topUp.paymentRecoveryType !== input.recoveryType ||
        !topUp.paymentRecoveredAt
      ) {
        throw new AppError(
          'WALLET_PAYMENT_RECOVERY_CONFLICT',
          '充值已由其他退款或争议事件处理',
          409,
        )
      }
      const replayBalance = await readWalletBalance(req, relationId(topUp.account))
      return {
        applied: false,
        balance: replayBalance,
        restricted: replayBalance.availableBalance < 0n,
      }
    }
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE wallet_top_up_orders
      SET
        status = 'refund_pending',
        payment_recovery_key = ${recoveryKey},
        payment_recovery_type = ${input.recoveryType},
        updated_at = NOW()
      WHERE id = ${topUp.id}
        AND status = 'credited'
        AND payment_recovery_key IS NULL
        AND original_refund_number IS NULL
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) {
      throw new AppError(
        'WALLET_PAYMENT_RECOVERY_CONFLICT',
        '充值状态已变化，退款或争议追回未执行',
        409,
      )
    }
    const customerId = Number(relationId(topUp.customer))
    if (!Number.isSafeInteger(customerId) || customerId <= 0) {
      throw new AppError('WALLET_PAYMENT_RECOVERY_EVIDENCE_INVALID', '充值账户归属无效', 409)
    }
    const recovered = await recoverWalletBalance(req, {
      accountId: relationId(topUp.account),
      allowNegativeBalance: policy.allowNegativeBalanceRecovery,
      amountFen: topUp.amountFen,
      transactionKey: `wallet-top-up-payment-recovery:${topUp.id}`,
    })
    const restricted = recovered.balance.availableBalance < 0n
    if (restricted) {
      await restrictNegativeBalanceSpending(req, customerId, recoveryKey, recoveredAt)
      await req.payload.create({
        collection: 'manualReviews',
        data: {
          customer: customerId,
          evidence: {
            availableBalanceFen: recovered.balance.availableBalance.toString(),
            recoveryKey,
            recoveryType: input.recoveryType,
          },
          reasonCode: 'wallet_top_up.negative_balance_after_payment_recovery',
          status: 'open',
          walletTopUpOrder: topUp.id as never,
        },
        overrideAccess: true,
        req,
      })
    }
    const finalized = await (
      await database(req)
    ).execute(sql`
      UPDATE wallet_top_up_orders
      SET
        status = 'refunded',
        refunded_at = ${recoveredAt},
        payment_recovered_at = ${recoveredAt},
        updated_at = NOW()
      WHERE id = ${topUp.id}
        AND status = 'refund_pending'
        AND payment_recovery_key = ${recoveryKey}
        AND payment_recovery_type = ${input.recoveryType}
      RETURNING id
    `)
    if (finalized.rows?.[0]?.id === undefined) {
      throw new AppError('WALLET_PAYMENT_RECOVERY_CONFLICT', '充值退款或争议追回状态提交失败', 409)
    }
    await recordAuditEvent(req, {
      action: 'wallet.top_up.payment_recovered',
      actor: { type: 'system' },
      metadata: {
        amountFen: topUp.amountFen,
        availableBalanceFen: recovered.balance.availableBalance.toString(),
        recoveryKey,
        recoveryType: input.recoveryType,
        restricted,
      },
      targetId: topUp.id,
    })
    return { applied: recovered.applied, balance: recovered.balance, restricted }
  })
}
