import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { collections } from '@/collections'
import { walletLedgerConsistencyCheck } from '@/jobs/config'

function collection(slug: string) {
  const result = collections.find((candidate) => candidate.slug === slug)
  if (!result) throw new Error(`Missing collection: ${slug}`)
  return result
}

describe('D9-B-1 wallet collection contracts', () => {
  it('keeps mutable balance fields out of wallet accounts and derives all three states from entries', () => {
    const accountFields = collection('walletAccounts')
      .fields.filter((field) => 'name' in field)
      .map((field) => field.name)
    expect(accountFields).toEqual(['customer', 'currency', 'ledgerVersion'])
    expect(accountFields).not.toContain('postedBalance')
    expect(accountFields).not.toContain('heldBalance')
    expect(accountFields).not.toContain('availableBalance')
  })

  it('rejects wallet entry updates and deletes in collection hooks', async () => {
    const entries = collection('walletEntries')
    const beforeChange = entries.hooks?.beforeChange?.[0]
    const beforeDelete = entries.hooks?.beforeDelete?.[0]
    if (!beforeChange || !beforeDelete) throw new Error('Wallet append-only hooks missing')

    await expect(async () => beforeChange({ operation: 'update' } as never)).rejects.toMatchObject({
      code: 'WALLET_ENTRY_APPEND_ONLY',
    })
    await expect(async () => beforeDelete({} as never)).rejects.toMatchObject({
      code: 'WALLET_ENTRY_APPEND_ONLY',
    })
  })

  it('denies generic creates, updates, and deletes at every wallet collection callpoint', async () => {
    for (const slug of ['walletAccounts', 'walletTransactions', 'walletEntries']) {
      const access = collection(slug).access
      for (const operation of ['create', 'update', 'delete'] as const) {
        const decision = access?.[operation]
        if (typeof decision !== 'function') throw new Error(`${slug}.${operation} access missing`)
        expect(await decision({} as never)).toBe(false)
      }
    }
  })

  it('scopes every wallet collection read to the customer owner', async () => {
    for (const slug of ['walletAccounts', 'walletTransactions', 'walletEntries']) {
      const decision = collection(slug).access?.read
      if (typeof decision !== 'function') throw new Error(`${slug}.read access missing`)
      expect(
        await decision({
          req: { user: { collection: 'customers', id: 42 } },
        } as never),
      ).toEqual({ customer: { equals: 42 } })
    }
  })

  it('runs the invariant checker exclusively on the background queue without retries', () => {
    expect(walletLedgerConsistencyCheck).toMatchObject({
      concurrency: {
        exclusive: true,
        supersedes: true,
      },
      queue: 'background',
      retries: 0,
      slug: 'walletLedgerConsistencyCheck',
    })
    const concurrency = walletLedgerConsistencyCheck.concurrency
    if (
      !concurrency ||
      typeof concurrency === 'function' ||
      typeof concurrency.key !== 'function'
    ) {
      throw new Error('wallet ledger consistency concurrency key must be callable')
    }
    expect(concurrency.key({} as never)).toBe('wallet:ledger-consistency')
    expect(walletLedgerConsistencyCheck.schedule).toEqual([
      { cron: '0 30 2 * * *', queue: 'background' },
    ])
  })

  it('uses transaction-bound SQL updates instead of Payload where updates for wallet mutexes', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/services/wallet/ledger.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('UPDATE wallet_accounts')
    expect(source).toContain('UPDATE wallet_transactions')
    expect(source).toContain('RETURNING ledger_version')
    expect(source).not.toContain('payload.update(')
  })
})
