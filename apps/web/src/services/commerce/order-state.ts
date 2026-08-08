import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import type { OrderStatus } from '@/lib/domain'
import { AppError } from '@/lib/errors'

export const ORDER_TRANSITIONS = {
  pending_payment: ['paid', 'manual_review', 'cancelled'],
  paid: ['fulfilling', 'refund_pending', 'manual_review'],
  fulfilling: ['succeeded', 'refund_pending', 'manual_review'],
  succeeded: [],
  refund_pending: ['refunding', 'manual_review'],
  refunding: ['refunded', 'manual_review'],
  refunded: [],
  manual_review: ['fulfilling', 'succeeded', 'refund_pending', 'refunding', 'refunded'],
  cancelled: ['manual_review'],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>

export type TransitionEvidence = {
  actorId?: string
  actorType: 'admin' | 'customer' | 'provider' | 'system'
  evidence?: Record<string, unknown>
  note?: string
  reasonCode: string
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] as readonly OrderStatus[]).includes(to)
}

export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  details: TransitionEvidence,
): void {
  if (!canTransition(from, to)) {
    throw new AppError('ORDER_TRANSITION_INVALID', `不允许从 ${from} 迁移到 ${to}`, 409)
  }
  if (from === 'manual_review' && (!details.note?.trim() || !details.evidence)) {
    throw new AppError(
      'MANUAL_REVIEW_EVIDENCE_REQUIRED',
      '人工复核出口必须包含处理备注和外部证据',
      409,
    )
  }
}

export async function transitionOrder(
  req: PayloadRequest,
  orderId: number | string,
  to: OrderStatus,
  details: TransitionEvidence,
) {
  const startedTransaction = await initTransaction(req)
  try {
    const order = await req.payload.findByID({
      collection: 'orders',
      id: orderId,
      overrideAccess: true,
      req,
    })
    const from = order.status as OrderStatus
    assertTransition(from, to, details)

    // Compare-and-swap on `status`: two operations racing on the same order (e.g. a
    // fulfillment job and a refund job with different provider operation keys, so job
    // concurrency alone doesn't serialize them) can both read the same stale `from`
    // and both pass assertTransition. Only the write that still matches `from` wins;
    // the loser sees zero updated docs and aborts instead of silently double-applying.
    const updated = await req.payload.update({
      collection: 'orders',
      data: { status: to },
      overrideAccess: true,
      req,
      where: { and: [{ id: { equals: orderId } }, { status: { equals: from } }] },
    })
    if (!updated.docs.length) {
      throw new AppError('ORDER_TRANSITION_CONFLICT', '订单状态已被并发变更，请重试', 409)
    }

    const event = await req.payload.create({
      collection: 'orderEvents',
      data: {
        actorId: details.actorId,
        actorType: details.actorType,
        customer: typeof order.customer === 'object' ? order.customer.id : order.customer,
        evidence: details.evidence,
        fromStatus: from,
        note: details.note,
        order: order.id,
        reasonCode: details.reasonCode,
        toStatus: to,
      },
      overrideAccess: true,
      req,
    })

    if (startedTransaction) await commitTransaction(req)
    return { event, order: updated.docs[0] }
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    throw error
  }
}
