import { describe, expect, it } from 'vitest'

import { ORDER_STATUSES, type OrderStatus } from '@/lib/domain'
import { AppError } from '@/lib/errors'
import { assertTransition, canTransition, ORDER_TRANSITIONS } from '@/services/commerce/order-state'

describe('order state machine', () => {
  it('accepts exactly the frozen transition matrix', () => {
    expect(ORDER_TRANSITIONS).toEqual({
      cancelled: ['manual_review'],
      fulfilling: ['succeeded', 'refund_pending', 'manual_review'],
      manual_review: ['fulfilling', 'succeeded', 'refund_pending', 'refunding', 'refunded'],
      paid: ['fulfilling', 'refund_pending', 'manual_review'],
      pending_payment: ['paid', 'cancelled'],
      refunded: [],
      refund_pending: ['refunding', 'manual_review'],
      refunding: ['refunded', 'manual_review'],
      succeeded: [],
    })
    const expected = Object.values(ORDER_TRANSITIONS).reduce(
      (total, targets) => total + targets.length,
      0,
    )
    let accepted = 0
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (canTransition(from, to)) accepted += 1
      }
    }
    expect(accepted).toBe(expected)
    expect(canTransition('succeeded', 'refund_pending')).toBe(false)
    expect(canTransition('cancelled', 'manual_review')).toBe(true)
  })

  it('rejects undefined transitions', () => {
    expect(() =>
      assertTransition('pending_payment', 'succeeded', {
        actorType: 'system',
        reasonCode: 'SKIP',
      }),
    ).toThrowError(AppError)
  })

  it.each([
    'fulfilling',
    'succeeded',
    'refund_pending',
    'refunding',
    'refunded',
  ] satisfies OrderStatus[])('requires evidence and notes for manual_review -> %s', (to) => {
    expect(() =>
      assertTransition('manual_review', to, { actorType: 'admin', reasonCode: 'REVIEW' }),
    ).toThrowError(/证据/)
    expect(() =>
      assertTransition('manual_review', to, {
        actorType: 'admin',
        evidence: { source: 'provider-query' },
        note: '已核验',
        reasonCode: 'REVIEW',
      }),
    ).not.toThrow()
  })
})
