import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { collections } from '@/collections'
import { VIP_TIER_EVENT_SOURCES } from '@/collections/vip'
import { MARKETING_NOTIFICATION_TYPES, TRANSACTIONAL_NOTIFICATION_TYPES } from '@/lib/domain'

const vipCollections = [
  'vipTierRuleVersions',
  'vipTierRuleLevels',
  'vipSpendEntries',
  'vipTierEvents',
  'vipTierAppeals',
] as const

function collection(slug: string) {
  const result = collections.find((candidate) => candidate.slug === slug)
  if (!result) throw new Error(`Missing collection: ${slug}`)
  return result
}

describe('D9-E-3 VIP collection contracts', () => {
  it('uses exactly the four approved tier-event sources', () => {
    expect(VIP_TIER_EVENT_SOURCES).toEqual([
      'natural_achievement',
      'operational_promotion',
      'data_correction',
      'fraud_reversal',
    ])
  })

  it('keeps every VIP business record append-only and denies generic mutations', async () => {
    for (const slug of vipCollections) {
      const config = collection(slug)
      for (const operation of ['create', 'update', 'delete'] as const) {
        const decision = config.access?.[operation]
        if (typeof decision !== 'function') throw new Error(`${slug}.${operation} access missing`)
        expect(await decision({} as never)).toBe(false)
      }
      const beforeChange = config.hooks?.beforeChange?.[0]
      const beforeDelete = config.hooks?.beforeDelete?.[0]
      if (!beforeChange || !beforeDelete) throw new Error(`${slug} append-only hooks missing`)
      await expect(async () =>
        beforeChange({ operation: 'update' } as never),
      ).rejects.toMatchObject({
        status: 409,
      })
      await expect(async () => beforeDelete({} as never)).rejects.toMatchObject({ status: 409 })
    }
  })

  it('contains no independent VIP identity field in collections or generated customer types', () => {
    const forbidden = ['vip' + 'Granted', 'is' + 'Vip', 'vip' + 'Level']
    const fieldNames = collections.flatMap((config) =>
      config.fields.filter((field) => 'name' in field).map((field) => field.name),
    )
    for (const name of forbidden) expect(fieldNames).not.toContain(name)

    const generated = readFileSync(
      fileURLToPath(new URL('../../src/payload-types.ts', import.meta.url)),
      'utf8',
    )
    const customerBlock = generated.slice(
      generated.indexOf('export interface Customer {'),
      generated.indexOf(
        '\nexport interface ',
        generated.indexOf('export interface Customer {') + 1,
      ),
    )
    for (const name of forbidden) expect(customerBlock).not.toMatch(new RegExp(`\\b${name}\\??:`))
  })

  it('registers advance benefit changes as a non-optional transactional notification', () => {
    expect(TRANSACTIONAL_NOTIFICATION_TYPES).toContain('vip_benefit_change_advance')
    expect(MARKETING_NOTIFICATION_TYPES).not.toContain('vip_benefit_change_advance' as never)
  })

  it('keeps tier reads sourced from append-only events and spend totals sourced from append-only entries', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/services/vip/tiers.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('FROM vip_tier_events')
    expect(source.match(/compareVipTierEventsNewestFirst/gu)?.length).toBeGreaterThanOrEqual(3)
    expect(source).toContain('FROM vip_spend_entries')
    expect(source).toContain("WHEN entry_type = 'succeeded_order' THEN amount_fen")
    expect(source).toContain('BigInt(tier.thresholdFen) > BigInt(cumulative)')
    expect(source).not.toContain('payload.update({ where')
  })
})
