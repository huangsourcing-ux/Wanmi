import { randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { hasRole, isActiveAdminUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import {
  manualOrderActionRequestSchema,
  type ManualCommerceEvidence,
} from '@/schemas/admin-commerce'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

type OrderRecord = {
  amountMinor: number
  currency: 'CNY'
  id: number | string
  merchantOrderNumber?: null | string
  orderNumber: string
  status: string
}

async function assertConfirmedPayment(req: PayloadRequest, order: OrderRecord): Promise<void> {
  const found = await req.payload.find({
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
  const confirmation = found.docs[0]
  if (
    !confirmation ||
    confirmation.amountMinor !== order.amountMinor ||
    confirmation.currency !== order.currency ||
    !confirmation.wechatTransactionId
  ) {
    throw new AppError(
      'REFUND_PAYMENT_EVIDENCE_MISMATCH',
      '原支付确认信息不完整或不一致，禁止记录特殊退款',
      409,
    )
  }
}

async function lockOrderForRefundAccounting(
  req: PayloadRequest,
  orderId: number | string,
): Promise<void> {
  const transactionId = await req.transactionID
  const transaction = (transactionId ? req.payload.db.sessions?.[transactionId] : undefined) as
    | undefined
    | { db: { execute: (statement: ReturnType<typeof sql>) => Promise<unknown> } }
  if (!transaction) {
    throw new AppError('REFUND_ACCOUNTING_LOCK_UNAVAILABLE', '无法锁定订单退款额度', 503)
  }
  await transaction.db.execute(sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`)
}

export async function recordManualOrderAction(
  req: PayloadRequest,
  orderNumber: string,
  rawInput: {
    actionType: 'invoice_note' | 'special_refund'
    amountMinor?: number
    evidence: ManualCommerceEvidence
    invoiceStatus?: 'cancelled' | 'completed' | 'processing'
    reason: string
  },
) {
  if (!isActiveAdminUser(req.user) || !hasRole(req.user, ['system_admin'])) {
    throw new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', '仅系统管理员可记录人工财务操作', 403)
  }
  const actor = req.user
  const input = manualOrderActionRequestSchema.parse(rawInput)
  const startedTransaction = await initTransaction(req)
  try {
    const found = await req.payload.find({
      collection: 'orders',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { orderNumber: { equals: orderNumber } },
    })
    let order = found.docs[0] as unknown as OrderRecord | undefined
    if (!order) throw new AppError('ORDER_NOT_FOUND', '未找到订单', 404)
    if (input.actionType === 'special_refund') {
      await lockOrderForRefundAccounting(req, order.id)
      order = (await req.payload.findByID({
        collection: 'orders',
        depth: 0,
        id: order.id,
        overrideAccess: true,
        req,
      })) as unknown as OrderRecord
      if (order.status === 'succeeded') {
        throw new AppError('SUCCEEDED_ORDER_REFUND_FORBIDDEN', '注册成功的订单不可退款', 409)
      }
      if (!order.merchantOrderNumber || order.currency !== 'CNY') {
        throw new AppError('REFUND_PAYMENT_EVIDENCE_MISSING', '原支付确认信息不完整，禁止退款', 409)
      }
      await assertConfirmedPayment(req, order)
      const previous = await req.payload.find({
        collection: 'orderManualActions',
        depth: 0,
        overrideAccess: true,
        pagination: false,
        req,
        where: {
          and: [{ order: { equals: order.id } }, { actionType: { equals: 'special_refund' } }],
        },
      })
      const alreadyRecorded = previous.docs.reduce(
        (total, action) =>
          total + (typeof action.amountMinor === 'number' ? action.amountMinor : 0),
        0,
      )
      const automaticRefunds = await req.payload.find({
        collection: 'refunds',
        depth: 0,
        overrideAccess: true,
        pagination: false,
        req,
        where: { order: { equals: order.id } },
      })
      const alreadyReservedByAutomaticRefunds = automaticRefunds.docs.reduce(
        (total, refund) => total + refund.amountMinor,
        0,
      )
      const amount = input.amountMinor!
      if (
        amount > order.amountMinor ||
        alreadyReservedByAutomaticRefunds + alreadyRecorded + amount > order.amountMinor
      ) {
        throw new AppError(
          'REFUND_AMOUNT_EXCEEDS_PAYMENT',
          '特殊退款累计金额不得超过原支付金额',
          409,
        )
      }
    }
    const actionKey = randomUUID()
    const created = await req.payload.create({
      collection: 'orderManualActions',
      data: {
        actionKey,
        actionType: input.actionType,
        ...(input.amountMinor === undefined
          ? {}
          : { amountMinor: input.amountMinor, currency: 'CNY' as const }),
        evidence: input.evidence,
        invoiceStatus: input.invoiceStatus,
        operator: actor.id as never,
        order: order.id as never,
        reason: input.reason,
        recordedAt: new Date().toISOString(),
      },
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(req, {
      action:
        input.actionType === 'special_refund'
          ? 'commerce.special_refund.recorded'
          : 'commerce.invoice_note.recorded',
      actor: { id: actor.id, type: 'admin' },
      metadata: {
        actionKey,
        amountMinor: input.amountMinor,
        evidence: input.evidence,
        reason: input.reason,
      },
      targetId: order.id,
    })
    if (startedTransaction) await commitTransaction(req)
    return { actionId: created.id, actionKey, actionType: input.actionType }
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    throw error
  }
}
