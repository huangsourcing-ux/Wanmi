import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { collections } from '@/collections'
import { TOOL_QUOTA_TARGETS } from '@/collections/points'
import { pointsExpiration } from '@/jobs/config'

const protectedCollections = [
  'pointsAccounts',
  'pointsBatches',
  'pointsRedemptions',
  'pointsLedger',
  'pointsConsumptionAllocations',
  'toolQuotaLedger',
] as const

const appendOnlyCollections = [
  'pointsBatches',
  'pointsRedemptions',
  'pointsLedger',
  'pointsConsumptionAllocations',
  'toolQuotaLedger',
] as const

function collection(slug: string) {
  const result = collections.find((candidate) => candidate.slug === slug)
  if (!result) throw new Error(`Missing collection: ${slug}`)
  return result
}

describe('D9-E-2 points collection and job contracts', () => {
  it('keeps points and wallet isolated in distinct collections and fields', () => {
    const pointSlugs = protectedCollections.map((slug) => collection(slug).slug)
    expect(pointSlugs).toEqual([...protectedCollections])
    expect(pointSlugs).not.toContain('walletAccounts')
    expect(pointSlugs).not.toContain('walletEntries')

    const pointFieldNames = protectedCollections.flatMap((slug) =>
      collection(slug)
        .fields.filter((field) => 'name' in field)
        .map((field) => field.name),
    )
    expect(pointFieldNames).not.toContain('amountFen')
    expect(pointFieldNames).not.toContain('currency')
    expect(pointFieldNames).not.toContain('walletAccount')
    expect(pointFieldNames).not.toContain('walletTransaction')
  })

  it('exposes only the three approved tool-quota redemption targets', () => {
    expect(TOOL_QUOTA_TARGETS).toEqual(['advanced_whois', 'bulk_query', 'ai_domain_analysis'])
    expect(TOOL_QUOTA_TARGETS).not.toContain('tier_acceleration' as never)
    expect(TOOL_QUOTA_TARGETS).not.toContain('order_discount' as never)
  })

  it('rejects updates and deletes at every append-only collection hook callpoint', async () => {
    for (const slug of appendOnlyCollections) {
      const config = collection(slug)
      const beforeChange = config.hooks?.beforeChange?.[0]
      const beforeDelete = config.hooks?.beforeDelete?.[0]
      if (!beforeChange || !beforeDelete) throw new Error(`${slug} append-only hooks missing`)
      await expect(async () =>
        beforeChange({ operation: 'update' } as never),
      ).rejects.toMatchObject({ status: 409 })
      await expect(async () => beforeDelete({} as never)).rejects.toMatchObject({ status: 409 })
    }
  })

  it('denies generic creates, updates, and deletes at every points collection callpoint', async () => {
    for (const slug of protectedCollections) {
      const access = collection(slug).access
      for (const operation of ['create', 'update', 'delete'] as const) {
        const decision = access?.[operation]
        if (typeof decision !== 'function') throw new Error(`${slug}.${operation} access missing`)
        expect(await decision({} as never)).toBe(false)
      }
    }
  })

  it('scopes every points collection read to the customer owner', async () => {
    for (const slug of protectedCollections) {
      const decision = collection(slug).access?.read
      if (typeof decision !== 'function') throw new Error(`${slug}.read access missing`)
      expect(
        await decision({ req: { user: { collection: 'customers', id: 42 } } } as never),
      ).toEqual({ customer: { equals: 42 } })
    }
  })

  it('runs points expiration with one exclusive background concurrency key and no retries', () => {
    expect(pointsExpiration).toMatchObject({
      concurrency: { exclusive: true, supersedes: true },
      queue: 'background',
      retries: 0,
      slug: 'pointsExpiration',
    })
    const concurrency = pointsExpiration.concurrency
    if (
      !concurrency ||
      typeof concurrency === 'function' ||
      typeof concurrency.key !== 'function'
    ) {
      throw new Error('points expiration concurrency key must be callable')
    }
    expect(concurrency.key({} as never)).toBe('points:expiration')
    expect(pointsExpiration.schedule).toEqual([{ cron: '0 0 * * * *', queue: 'background' }])
  })

  it('uses only the independent points tables and transaction-bound conditional SQL', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/services/points/ledger.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('UPDATE points_accounts')
    expect(source).toContain('RETURNING ledger_version')
    expect(source).toContain('RETURNING quota_ledger_version')
    expect(source).toContain('ORDER BY expires_at ASC, id ASC')
    expect(source).not.toContain('@/services/wallet')
    expect(source).not.toContain('wallet_accounts')
    expect(source).not.toContain('wallet_entries')
    expect(source).not.toContain('amount_fen')
    expect(source).not.toContain('payload.update(')
    expect(source).not.toContain('tier_acceleration')
    expect(source).not.toContain('order_discount')
  })
})
