import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { collections } from '@/collections'
import { WALLET_TOP_UP_STATUSES } from '@/collections/wallet'
import { walletTopUpCreateRequestSchema } from '@/schemas/wallet'

function collection(slug: string) {
  const result = collections.find((candidate) => candidate.slug === slug)
  if (!result) throw new Error(`Missing collection: ${slug}`)
  return result
}

function field(slug: string, name: string) {
  const result = collection(slug).fields.find(
    (candidate) => 'name' in candidate && candidate.name === name,
  )
  if (!result || !('name' in result)) throw new Error(`Missing field: ${slug}.${name}`)
  return result
}

describe('D9-B-2 wallet top-up collection and migration contracts', () => {
  it('models the frozen top-up lifecycle independently from wallet entries', () => {
    const topUps = collection('walletTopUpOrders')
    const status = field('walletTopUpOrders', 'status')
    expect(status).toMatchObject({
      defaultValue: 'created',
      options: [...WALLET_TOP_UP_STATUSES],
      required: true,
      type: 'select',
    })
    expect(
      topUps.fields.filter((candidate) => 'name' in candidate).map((candidate) => candidate.name),
    ).not.toContain('balance')
    expect(field('walletTopUpOrders', 'fundingSource')).toMatchObject({
      options: ['wechat'],
      required: true,
    })
  })

  it('declares every required top-up identifier globally unique', () => {
    for (const name of [
      'topUpOrderNumber',
      'wechatTransactionId',
      'ledgerTransactionKey',
      'originalRefundNumber',
    ]) {
      expect(field('walletTopUpOrders', name)).toMatchObject({ index: true, unique: true })
    }
  })

  it('denies generic mutations and preserves top-up orders through hooks', async () => {
    const topUps = collection('walletTopUpOrders')
    for (const operation of ['create', 'update', 'delete'] as const) {
      const decision = topUps.access?.[operation]
      if (typeof decision !== 'function') throw new Error(`Missing ${operation} access`)
      expect(await decision({} as never)).toBe(false)
    }
    const beforeChange = topUps.hooks?.beforeChange?.[0]
    const beforeDelete = topUps.hooks?.beforeDelete?.[0]
    if (!beforeChange || !beforeDelete) throw new Error('Missing top-up preservation hooks')
    await expect(async () => beforeChange({ operation: 'update' } as never)).rejects.toMatchObject({
      code: 'WALLET_TOP_UP_SERVICE_REQUIRED',
    })
    await expect(async () => beforeDelete({} as never)).rejects.toMatchObject({
      code: 'WALLET_TOP_UP_APPEND_ONLY',
    })
  })

  it('scopes reads to the owning customer and links existing evidence collections', async () => {
    const decision = collection('walletTopUpOrders').access?.read
    if (typeof decision !== 'function') throw new Error('Missing top-up read access')
    expect(await decision({ req: { user: { collection: 'customers', id: 42 } } } as never)).toEqual(
      { customer: { equals: 42 } },
    )
    expect(field('manualReviews', 'walletTopUpOrder')).toMatchObject({
      relationTo: 'walletTopUpOrders',
      type: 'relationship',
    })
    expect(field('paymentNotificationArchives', 'walletTopUpOrder')).toMatchObject({
      relationTo: 'walletTopUpOrders',
      type: 'relationship',
    })
  })

  it('rejects balance-funded and fractional top-up requests at the API schema', () => {
    expect(
      walletTopUpCreateRequestSchema.safeParse({ amountFen: 100, fundingSource: 'balance' })
        .success,
    ).toBe(false)
    expect(
      walletTopUpCreateRequestSchema.safeParse({ amountFen: 100.5, fundingSource: 'wechat' })
        .success,
    ).toBe(false)
  })

  it('uses database CAS transitions and four named global unique indexes', () => {
    const service = readFileSync(
      fileURLToPath(new URL('../../src/services/wallet/top-ups.ts', import.meta.url)),
      'utf8',
    )
    const migration = readFileSync(
      fileURLToPath(
        new URL('../../migrations/20260818_032334_d9b2_wallet_top_up_orders.ts', import.meta.url),
      ),
      'utf8',
    )
    expect(service).not.toContain('payload.update(')
    expect(service).toContain("AND status = 'payment_pending'")
    expect(service).toContain("AND status = 'provider_confirmed'")
    expect(service).toContain('RETURNING id')
    for (const index of [
      'wallet_top_up_orders_top_up_order_number_idx',
      'wallet_top_up_orders_wechat_transaction_id_idx',
      'wallet_top_up_orders_ledger_transaction_key_idx',
      'wallet_top_up_orders_original_refund_number_idx',
    ]) {
      expect(migration).toContain(`CREATE UNIQUE INDEX "${index}"`)
    }
    expect(migration).toContain('wallet_top_up_orders_amount_safe_integer')
    expect(migration).toContain('wallet_top_up_orders_state_evidence_valid')
  })
})
