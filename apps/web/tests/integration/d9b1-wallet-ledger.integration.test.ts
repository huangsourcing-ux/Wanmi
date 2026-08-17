import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest, type Where } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Customer } from '@/payload-types'
import { walletLedgerConsistencyCheck } from '@/jobs/config'
import { maskPhone } from '@/services/auth/client-facts'
import {
  captureWalletHold,
  createWalletAccount,
  hasPositiveWalletAvailableBalance,
  holdWalletBalance,
  postWalletCredit,
  readWalletBalance,
  releaseWalletHold,
  resolveWalletHold,
} from '@/services/wallet/ledger'
import {
  inspectWalletLedgerInvariants,
  runWalletLedgerConsistencyCheck,
} from '@/services/wallet/invariants'

const fixturePrefix = `d9b1-wallet-${randomUUID()}`
let payload: Payload
let accountIds: number[] = []
let customerIds: number[] = []
const customersByAccount = new Map<number, Customer>()

function phone(): string {
  return `+86196${randomInt(10_000_000, 100_000_000)}`
}

async function request(suffix: string): Promise<PayloadRequest> {
  return createLocalReq(
    {
      req: {
        headers: new Headers({
          'x-request-id': `${fixturePrefix}-${suffix}`,
        }),
      },
    },
    payload,
  )
}

async function account(suffix: string): Promise<number> {
  const customerPhone = phone()
  const customer = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: [],
      phone: customerPhone,
      phoneMasked: maskPhone(customerPhone),
      status: 'active',
    },
    overrideAccess: true,
  })
  customerIds.push(customer.id)
  const created = await createWalletAccount(await request(`account-${suffix}`), customer.id)
  const accountId = Number(created.accountId)
  accountIds.push(accountId)
  customersByAccount.set(accountId, customer)
  return accountId
}

async function countEntries(accountId: number, where: Where = {}): Promise<number> {
  const result = await payload.count({
    collection: 'walletEntries',
    overrideAccess: true,
    where: {
      and: [{ account: { equals: accountId } }, where],
    },
  })
  return result.totalDocs
}

async function countTransactions(accountId: number, where: Where = {}): Promise<number> {
  const result = await payload.count({
    collection: 'walletTransactions',
    overrideAccess: true,
    where: {
      and: [{ account: { equals: accountId } }, where],
    },
  })
  return result.totalDocs
}

function customerFor(accountId: number): Customer {
  const customer = customersByAccount.get(accountId)
  if (!customer) throw new Error('Wallet customer fixture missing')
  return customer
}

async function insertHeldTransaction(input: {
  accountId: number
  amountFen: number
  customerId: number
  transactionKey: string
}): Promise<number> {
  const inserted = await payload.db.pool.query<{ id: number }>(
    `INSERT INTO wallet_transactions (
       transaction_key,
       customer_id,
       account_id,
       type,
       status,
       amount_fen,
       updated_at,
       created_at
     ) VALUES ($1, $2, $3, 'hold', 'held', $4, NOW(), NOW())
     RETURNING id`,
    [input.transactionKey, input.customerId, input.accountId, input.amountFen],
  )
  const transactionId = inserted.rows[0]?.id
  if (!transactionId) throw new Error('Failed to create wallet transaction fixture')
  return transactionId
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterEach(async () => {
  if (customerIds.length > 0) {
    await payload.db.pool.query(
      `DELETE FROM wallet_entries
       WHERE account_id IN (
         SELECT id FROM wallet_accounts WHERE customer_id = ANY($1::int[])
       )`,
      [customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM wallet_transactions
       WHERE account_id IN (
         SELECT id FROM wallet_accounts WHERE customer_id = ANY($1::int[])
       )`,
      [customerIds],
    )
    await payload.db.pool.query('DELETE FROM wallet_accounts WHERE customer_id = ANY($1::int[])', [
      customerIds,
    ])
    await payload.db.pool.query('DELETE FROM customers WHERE id = ANY($1::int[])', [customerIds])
  }
  await payload.db.pool.query(
    `DELETE FROM audit_logs
     WHERE action = 'wallet.ledger_invariant.failed'
       AND trace_id LIKE $1`,
    [`${fixturePrefix}-%`],
  )
  accountIds = []
  customerIds = []
  customersByAccount.clear()
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9-B-1 wallet ledger and three-state balances', () => {
  it('concurrently creates exactly one CNY wallet account for one customer', async () => {
    await account('account-concurrency-decoy')
    const customerPhone = phone()
    const customer = await payload.create({
      collection: 'customers',
      data: {
        capabilityRestrictions: [],
        phone: customerPhone,
        phoneMasked: maskPhone(customerPhone),
        status: 'active',
      },
      overrideAccess: true,
    })
    customerIds.push(customer.id)
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        createWalletAccount(await request(`account-concurrency-${index}`), customer.id),
      ),
    )
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(8)
    const results = attempts
      .filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof createWalletAccount>>> =>
          attempt.status === 'fulfilled',
      )
      .map(({ value }) => value)
    const uniqueAccountIds = [...new Set(results.map(({ accountId }) => Number(accountId)))]
    accountIds.push(...uniqueAccountIds)
    expect(uniqueAccountIds).toHaveLength(1)
    expect(results.filter(({ created }) => created)).toHaveLength(1)
    const persisted = await payload.count({
      collection: 'walletAccounts',
      overrideAccess: true,
      where: {
        and: [{ customer: { equals: customer.id } }, { currency: { equals: 'CNY' } }],
      },
    })
    expect(persisted.totalDocs).toBe(1)
  })

  it('allows exactly the funded number of N concurrent holds without exceeding available balance', async () => {
    const accountId = await account('concurrent-limit')
    await postWalletCredit(await request('concurrent-limit-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:concurrent-limit:credit`,
    })

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, async (_, index) =>
        holdWalletBalance(await request(`concurrent-limit-hold-${index}`), {
          accountId,
          amountFen: 30,
          transactionKey: `${fixturePrefix}:concurrent-limit:hold:${index}`,
        }),
      ),
    )

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(3)
    const rejected = results.filter(({ status }) => status === 'rejected')
    expect(rejected).toHaveLength(7)
    expect(
      rejected.every(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: unknown }).code === 'WALLET_BALANCE_INSUFFICIENT',
      ),
    ).toBe(true)
    await expect(
      readWalletBalance(await request('concurrent-limit-read'), accountId),
    ).resolves.toEqual({
      availableBalance: 10n,
      heldBalance: 90n,
      postedBalance: 100n,
    })
    await expect(countEntries(accountId, { entryType: { equals: 'hold' } })).resolves.toBe(3)
    await expect(countTransactions(accountId, { status: { equals: 'held' } })).resolves.toBe(3)
  })

  it('atomically reaches the exact available-balance boundary and never derives a negative value', async () => {
    const accountId = await account('exact-boundary')
    await postWalletCredit(await request('exact-boundary-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:exact-boundary:credit`,
    })

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        holdWalletBalance(await request(`exact-boundary-hold-${index}`), {
          accountId,
          amountFen: 25,
          transactionKey: `${fixturePrefix}:exact-boundary:hold:${index}`,
        }),
      ),
    )

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(4)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(4)
    const balance = await readWalletBalance(await request('exact-boundary-read'), accountId)
    expect(balance).toEqual({ availableBalance: 0n, heldBalance: 100n, postedBalance: 100n })
    expect(balance.availableBalance).toBeGreaterThanOrEqual(0n)
    await expect(countEntries(accountId, { entryType: { equals: 'hold' } })).resolves.toBe(4)
  })

  it('lets exactly one concurrent capture or release settle the same hold', async () => {
    const accountId = await account('settlement-race')
    const holdKey = `${fixturePrefix}:settlement-race:hold`
    await postWalletCredit(await request('settlement-race-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:settlement-race:credit`,
    })
    await holdWalletBalance(await request('settlement-race-hold'), {
      accountId,
      amountFen: 60,
      transactionKey: holdKey,
    })

    const blocker = await payload.db.pool.connect()
    let results: PromiseSettledResult<Awaited<ReturnType<typeof captureWalletHold>>>[]
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT id FROM wallet_transactions WHERE transaction_key = $1 FOR UPDATE',
        [holdKey],
      )
      const attempts = Promise.allSettled([
        captureWalletHold(await request('settlement-race-capture'), holdKey),
        releaseWalletHold(await request('settlement-race-release'), holdKey),
      ])
      await new Promise((resolve) => setTimeout(resolve, 75))
      await blocker.query('COMMIT')
      results = await attempts
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: 'WALLET_HOLD_ALREADY_RESOLVED' })
    await expect(
      countEntries(accountId, {
        or: [{ entryType: { equals: 'capture' } }, { entryType: { equals: 'release' } }],
      }),
    ).resolves.toBe(1)
    await expect(
      countTransactions(accountId, {
        and: [
          { transactionKey: { equals: holdKey } },
          { status: { in: ['captured', 'released'] } },
        ],
      }),
    ).resolves.toBe(1)
    const balance = await readWalletBalance(await request('settlement-race-read'), accountId)
    expect(balance.heldBalance).toBe(0n)
    expect(balance.availableBalance).toBeGreaterThanOrEqual(0n)
  })

  it('makes concurrent retries of the same capture idempotent with one terminal entry', async () => {
    const accountId = await account('capture-idempotency')
    const holdKey = `${fixturePrefix}:capture-idempotency:hold`
    await postWalletCredit(await request('capture-idempotency-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:capture-idempotency:credit`,
    })
    await holdWalletBalance(await request('capture-idempotency-hold'), {
      accountId,
      amountFen: 40,
      transactionKey: holdKey,
    })

    const blocker = await payload.db.pool.connect()
    let attempts: PromiseSettledResult<Awaited<ReturnType<typeof captureWalletHold>>>[]
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        'SELECT id FROM wallet_transactions WHERE transaction_key = $1 FOR UPDATE',
        [holdKey],
      )
      const captures = Promise.allSettled(
        Array.from({ length: 6 }, async (_, index) =>
          captureWalletHold(await request(`capture-idempotency-${index}`), holdKey),
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 75))
      await blocker.query('COMMIT')
      attempts = await captures
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(6)
    const results = attempts
      .filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof captureWalletHold>>> =>
          attempt.status === 'fulfilled',
      )
      .map(({ value }) => value)
    expect(results.filter(({ applied }) => applied)).toHaveLength(1)
    expect(results.filter(({ applied }) => !applied)).toHaveLength(5)
    expect(results.every(({ status }) => status === 'captured')).toBe(true)
    await expect(
      countEntries(accountId, { entryKey: { equals: `${holdKey}:capture` } }),
    ).resolves.toBe(1)
    await expect(
      readWalletBalance(await request('capture-idempotency-read'), accountId),
    ).resolves.toEqual({
      availableBalance: 60n,
      heldBalance: 0n,
      postedBalance: 60n,
    })
  })

  it('concurrently posts one entry for one credit idempotency key', async () => {
    const accountId = await account('credit-idempotency')
    const creditKey = `${fixturePrefix}:credit-idempotency:credit`

    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        postWalletCredit(await request(`credit-idempotency-${index}`), {
          accountId,
          amountFen: 100,
          transactionKey: creditKey,
        }),
      ),
    )
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(8)
    const results = attempts
      .filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof postWalletCredit>>> =>
          attempt.status === 'fulfilled',
      )
      .map(({ value }) => value)
    expect(results.filter(({ applied }) => applied)).toHaveLength(1)
    expect(results.filter(({ applied }) => !applied)).toHaveLength(7)
    await expect(
      countEntries(accountId, { entryKey: { equals: `${creditKey}:credit` } }),
    ).resolves.toBe(1)
    await expect(
      countTransactions(accountId, { transactionKey: { equals: creditKey } }),
    ).resolves.toBe(1)
    await expect(
      readWalletBalance(await request('credit-idempotency-read'), accountId),
    ).resolves.toEqual({
      availableBalance: 100n,
      heldBalance: 0n,
      postedBalance: 100n,
    })
  })

  it('serializes distinct concurrent credits on one account without losing an entry', async () => {
    const accountId = await account('distinct-credits')

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, async (_, index) =>
        postWalletCredit(await request(`distinct-credits-${index}`), {
          accountId,
          amountFen: 10,
          transactionKey: `${fixturePrefix}:distinct-credits:${index}`,
        }),
      ),
    )
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(6)
    const results = attempts
      .filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof postWalletCredit>>> =>
          attempt.status === 'fulfilled',
      )
      .map(({ value }) => value)
    expect(results.every(({ applied, status }) => applied && status === 'posted')).toBe(true)
    await expect(
      readWalletBalance(await request('distinct-credits-read'), accountId),
    ).resolves.toEqual({
      availableBalance: 60n,
      heldBalance: 0n,
      postedBalance: 60n,
    })
    await expect(countEntries(accountId, { entryType: { equals: 'credit' } })).resolves.toBe(6)
    await expect(countTransactions(accountId, { type: { equals: 'credit' } })).resolves.toBe(6)
  })

  it('serializes settlements of distinct holds and preserves both captures', async () => {
    const accountId = await account('distinct-settlements')
    const holdKeys = [
      `${fixturePrefix}:distinct-settlements:hold:0`,
      `${fixturePrefix}:distinct-settlements:hold:1`,
    ]
    await postWalletCredit(await request('distinct-settlements-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:distinct-settlements:credit`,
    })
    for (const [index, holdKey] of holdKeys.entries()) {
      await holdWalletBalance(await request(`distinct-settlements-hold-${index}`), {
        accountId,
        amountFen: 20,
        transactionKey: holdKey,
      })
    }

    const blocker = await payload.db.pool.connect()
    let attempts: PromiseSettledResult<Awaited<ReturnType<typeof captureWalletHold>>>[]
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM wallet_accounts WHERE id = $1 FOR UPDATE', [accountId])
      const captures = Promise.allSettled(
        holdKeys.map(async (holdKey, index) =>
          captureWalletHold(await request(`distinct-settlements-capture-${index}`), holdKey),
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 75))
      await blocker.query('COMMIT')
      attempts = await captures
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(2)
    const results = attempts
      .filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof captureWalletHold>>> =>
          attempt.status === 'fulfilled',
      )
      .map(({ value }) => value)
    expect(results.every(({ applied, status }) => applied && status === 'captured')).toBe(true)
    await expect(
      readWalletBalance(await request('distinct-settlements-read'), accountId),
    ).resolves.toEqual({ availableBalance: 60n, heldBalance: 0n, postedBalance: 60n })
    await expect(countEntries(accountId, { entryType: { equals: 'capture' } })).resolves.toBe(2)
    await expect(countTransactions(accountId, { status: { equals: 'captured' } })).resolves.toBe(2)
  })

  it('derives capture and release balances and rejects conflicting idempotency reuse', async () => {
    const accountId = await account('primitives')
    const creditKey = `${fixturePrefix}:primitives:credit`
    const captureKey = `${fixturePrefix}:primitives:capture`
    const releaseKey = `${fixturePrefix}:primitives:release`
    await postWalletCredit(await request('primitives-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: creditKey,
    })
    const initialHold = await Promise.allSettled([
      holdWalletBalance(await request('primitives-capture-hold'), {
        accountId,
        amountFen: 40,
        transactionKey: captureKey,
      }),
    ])
    expect(initialHold.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    await expect(
      holdWalletBalance(await request('primitives-capture-hold-retry'), {
        accountId,
        amountFen: 40,
        transactionKey: captureKey,
      }),
    ).resolves.toMatchObject({ applied: false, status: 'held' })
    await expect(
      captureWalletHold(await request('primitives-capture'), captureKey),
    ).resolves.toMatchObject({
      applied: true,
      balance: { availableBalance: 60n, heldBalance: 0n, postedBalance: 60n },
      status: 'captured',
    })
    await expect(
      captureWalletHold(await request('primitives-capture-retry'), captureKey),
    ).resolves.toMatchObject({ applied: false, status: 'captured' })
    await expect(
      releaseWalletHold(await request('primitives-capture-conflict'), captureKey),
    ).rejects.toMatchObject({ code: 'WALLET_HOLD_ALREADY_RESOLVED' })

    await holdWalletBalance(await request('primitives-release-hold'), {
      accountId,
      amountFen: 20,
      transactionKey: releaseKey,
    })
    await expect(
      releaseWalletHold(await request('primitives-release'), releaseKey),
    ).resolves.toMatchObject({
      applied: true,
      balance: { availableBalance: 60n, heldBalance: 0n, postedBalance: 60n },
      status: 'released',
    })
    await expect(
      postWalletCredit(await request('primitives-credit-conflict'), {
        accountId,
        amountFen: 101,
        transactionKey: creditKey,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_IDEMPOTENCY_CONFLICT' })
    await expect(
      holdWalletBalance(await request('primitives-hold-conflict'), {
        accountId,
        amountFen: 41,
        transactionKey: captureKey,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_IDEMPOTENCY_CONFLICT' })
    await expect(
      countEntries(accountId, {
        entryType: { in: ['capture', 'release'] },
      }),
    ).resolves.toBe(2)
  })

  it('returns posted minus held at every credit, hold, and settlement callpoint', async () => {
    const accountId = await account('callpoint-balances')
    await postWalletCredit(await request('callpoint-balances-credit-initial'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:callpoint-balances:credit-initial`,
    })
    const firstHoldKey = `${fixturePrefix}:callpoint-balances:hold-first`
    await expect(
      holdWalletBalance(await request('callpoint-balances-hold-first'), {
        accountId,
        amountFen: 40,
        transactionKey: firstHoldKey,
      }),
    ).resolves.toMatchObject({
      balance: { availableBalance: 60n, heldBalance: 40n, postedBalance: 100n },
    })
    await expect(
      postWalletCredit(await request('callpoint-balances-credit-second'), {
        accountId,
        amountFen: 10,
        transactionKey: `${fixturePrefix}:callpoint-balances:credit-second`,
      }),
    ).resolves.toMatchObject({
      balance: { availableBalance: 70n, heldBalance: 40n, postedBalance: 110n },
    })
    await holdWalletBalance(await request('callpoint-balances-hold-second'), {
      accountId,
      amountFen: 20,
      transactionKey: `${fixturePrefix}:callpoint-balances:hold-second`,
    })
    await expect(
      captureWalletHold(await request('callpoint-balances-capture-first'), firstHoldKey),
    ).resolves.toMatchObject({
      balance: { availableBalance: 50n, heldBalance: 20n, postedBalance: 70n },
    })
  })

  it('keeps an unknown asynchronous outcome held without appending a terminal entry', async () => {
    const accountId = await account('unknown-hold')
    const holdKey = `${fixturePrefix}:unknown-hold:hold`
    await postWalletCredit(await request('unknown-hold-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:unknown-hold:credit`,
    })
    await holdWalletBalance(await request('unknown-hold-create'), {
      accountId,
      amountFen: 40,
      transactionKey: holdKey,
    })

    await expect(
      resolveWalletHold(await request('unknown-hold-resolve'), {
        outcome: 'unknown',
        transactionKey: holdKey,
      }),
    ).resolves.toMatchObject({ applied: false, status: 'held' })
    await expect(readWalletBalance(await request('unknown-hold-read'), accountId)).resolves.toEqual(
      {
        availableBalance: 60n,
        heldBalance: 40n,
        postedBalance: 100n,
      },
    )
    await expect(
      countEntries(accountId, {
        entryType: { in: ['capture', 'release'] },
      }),
    ).resolves.toBe(0)
    await expect(
      countTransactions(accountId, {
        and: [{ transactionKey: { equals: holdKey } }, { status: { equals: 'held' } }],
      }),
    ).resolves.toBe(1)
  })

  it('rejects wallet entry updates and deletes even for overrideAccess system calls', async () => {
    const accountId = await account('append-only')
    const creditKey = `${fixturePrefix}:append-only:credit`
    await postWalletCredit(await request('append-only-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: creditKey,
    })
    const entries = await payload.find({
      collection: 'walletEntries',
      limit: 2,
      overrideAccess: true,
      where: {
        and: [{ account: { equals: accountId } }, { entryKey: { equals: `${creditKey}:credit` } }],
      },
    })
    expect(entries.docs).toHaveLength(1)
    const entryId = entries.docs[0]!.id

    await expect(
      payload.update({
        collection: 'walletEntries',
        data: { amountFen: 101 },
        id: entryId,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ENTRY_APPEND_ONLY' })
    await expect(
      payload.delete({ collection: 'walletEntries', id: entryId, overrideAccess: true }),
    ).rejects.toMatchObject({ code: 'WALLET_ENTRY_APPEND_ONLY' })
    await expect(
      countEntries(accountId, { entryKey: { equals: `${creditKey}:credit` } }),
    ).resolves.toBe(1)
  })

  it('fails closed for a missing account, an inconsistent ledger, and non-integer fen', async () => {
    const accountId = await account('fail-closed')
    await postWalletCredit(await request('fail-closed-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:fail-closed:credit`,
    })

    await expect(
      readWalletBalance(await request('fail-closed-missing'), 2_147_483_647),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_UNAVAILABLE' })
    await expect(
      postWalletCredit(await request('fail-closed-missing-credit'), {
        accountId: 2_147_483_647,
        amountFen: 1,
        transactionKey: `${fixturePrefix}:fail-closed:missing-credit`,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_UNAVAILABLE' })
    await expect(
      holdWalletBalance(await request('fail-closed-missing-hold'), {
        accountId: 2_147_483_647,
        amountFen: 1,
        transactionKey: `${fixturePrefix}:fail-closed:missing-hold`,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_UNAVAILABLE' })
    await payload.db.pool.query(
      'UPDATE wallet_accounts SET ledger_version = ledger_version + 1 WHERE id = $1',
      [accountId],
    )
    await expect(
      readWalletBalance(await request('fail-closed-corrupt'), accountId),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
    await payload.db.pool.query(
      'UPDATE wallet_accounts SET ledger_version = ledger_version - 1 WHERE id = $1',
      [accountId],
    )
    await expect(
      postWalletCredit(await request('fail-closed-fraction'), {
        accountId,
        amountFen: 1.5,
        transactionKey: `${fixturePrefix}:fail-closed:fraction`,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_AMOUNT_INVALID' })
  })

  it('fails closed when the consistency task cannot query every required ledger relation', async () => {
    const accountId = await account('query-failure')
    await postWalletCredit(await request('query-failure-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:query-failure:credit`,
    })
    const query = vi.spyOn(payload.db.pool, 'connect').mockRejectedValueOnce(new Error('fixture'))
    try {
      await expect(
        runWalletLedgerConsistencyCheck(await request('query-failure-check')),
      ).rejects.toMatchObject({ code: 'WALLET_LEDGER_CHECK_UNAVAILABLE' })
    } finally {
      query.mockRestore()
    }
    const evidence = await payload.count({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.ledger_invariant.failed' } },
          { targetId: { equals: String(accountId) } },
          { traceId: { equals: `${fixturePrefix}-query-failure-check` } },
        ],
      },
    })
    expect(evidence.totalDocs).toBe(0)
  })

  it('enforces customer row isolation across all three wallet collections', async () => {
    const firstAccountId = await account('isolation-first')
    const secondAccountId = await account('isolation-second')
    const firstCustomer = customersByAccount.get(firstAccountId)
    if (!firstCustomer) throw new Error('Wallet customer fixture missing')
    const firstKey = `${fixturePrefix}:isolation:first`
    const secondKey = `${fixturePrefix}:isolation:second`
    await postWalletCredit(await request('isolation-first-credit'), {
      accountId: firstAccountId,
      amountFen: 10,
      transactionKey: firstKey,
    })
    await postWalletCredit(await request('isolation-second-credit'), {
      accountId: secondAccountId,
      amountFen: 20,
      transactionKey: secondKey,
    })
    const user = { ...firstCustomer, collection: 'customers' as const }

    const visibleAccounts = await payload.count({
      collection: 'walletAccounts',
      overrideAccess: false,
      user,
      where: { id: { in: [firstAccountId, secondAccountId] } },
    })
    const visibleTransactions = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: false,
      user,
      where: { transactionKey: { in: [firstKey, secondKey] } },
    })
    const visibleEntries = await payload.count({
      collection: 'walletEntries',
      overrideAccess: false,
      user,
      where: { entryKey: { in: [`${firstKey}:credit`, `${secondKey}:credit`] } },
    })
    expect(visibleAccounts.totalDocs).toBe(1)
    expect(visibleTransactions.totalDocs).toBe(1)
    expect(visibleEntries.totalDocs).toBe(1)
    await expect(
      payload.count({
        collection: 'walletAccounts',
        overrideAccess: false,
        where: { id: { in: [firstAccountId, secondAccountId] } },
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('detects a manufactured opening-credit-debit-ending mismatch and appends audit evidence', async () => {
    const accountId = await account('invariant')
    const traceSuffix = 'invariant-check'
    const creditKey = `${fixturePrefix}:invariant:credit`
    await postWalletCredit(await request('invariant-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: creditKey,
    })
    await expect(
      runWalletLedgerConsistencyCheck(await request('invariant-baseline')),
    ).resolves.toMatchObject({ accountsChecked: expect.any(Number) })

    const changed = await payload.db.pool.query(
      `UPDATE wallet_entries
       SET posted_balance_after_fen = posted_balance_after_fen + 1
       WHERE account_id = $1
         AND entry_key = $2
       RETURNING id`,
      [accountId, `${creditKey}:credit`],
    )
    expect(changed.rowCount).toBe(1)
    const consistencyHandler = walletLedgerConsistencyCheck.handler
    if (typeof consistencyHandler !== 'function') {
      throw new Error('wallet ledger consistency workflow handler must be callable')
    }
    await expect(
      consistencyHandler({ req: await request(traceSuffix) } as never),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_INVARIANT_VIOLATION' })

    const evidence = await payload.count({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.ledger_invariant.failed' } },
          { targetId: { equals: String(accountId) } },
          { traceId: { equals: `${fixturePrefix}-${traceSuffix}` } },
        ],
      },
    })
    expect(evidence.totalDocs).toBe(1)
  })

  it('rejects every invalid integer-fen and idempotency-key boundary before ledger writes', async () => {
    const accountId = await account('input-guards')
    const invalidAmounts = [0, -1, 1.5, BigInt(Number.MAX_SAFE_INTEGER) + 1n]
    for (const [index, invalidAmount] of invalidAmounts.entries()) {
      await expect(
        postWalletCredit(await request(`input-guards-amount-${index}`), {
          accountId,
          amountFen: invalidAmount,
          transactionKey: `${fixturePrefix}:input-guards:amount:${index}`,
        }),
      ).rejects.toMatchObject({ code: 'WALLET_AMOUNT_INVALID' })
    }
    for (const [index, invalidKey] of ['   ', 'x'.repeat(121)].entries()) {
      await expect(
        postWalletCredit(await request(`input-guards-key-${index}`), {
          accountId,
          amountFen: 1,
          transactionKey: invalidKey,
        }),
      ).rejects.toMatchObject({ code: 'WALLET_TRANSACTION_KEY_INVALID' })
    }
    await expect(countEntries(accountId)).resolves.toBe(0)
    await expect(countTransactions(accountId)).resolves.toBe(0)
  })

  it('fails closed when account ledgerVersion differs from the maximum entry sequence', async () => {
    const accountId = await account('guard-ledger-version')
    await postWalletCredit(await request('guard-ledger-version-credit'), {
      accountId,
      amountFen: 10,
      transactionKey: `${fixturePrefix}:guard-ledger-version:credit`,
    })
    await payload.db.pool.query(
      'UPDATE wallet_accounts SET ledger_version = ledger_version + 1 WHERE id = $1',
      [accountId],
    )
    await expect(
      readWalletBalance(await request('guard-ledger-version-read'), accountId),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
  })

  it('fails closed when entry count differs from the maximum ledger sequence', async () => {
    const accountId = await account('guard-sequence-gap')
    const creditKey = `${fixturePrefix}:guard-sequence-gap:credit`
    await postWalletCredit(await request('guard-sequence-gap-credit'), {
      accountId,
      amountFen: 10,
      transactionKey: creditKey,
    })
    await payload.db.pool.query(
      `UPDATE wallet_entries
       SET ledger_sequence = 2
       WHERE account_id = $1
         AND entry_key = $2`,
      [accountId, `${creditKey}:credit`],
    )
    await payload.db.pool.query('UPDATE wallet_accounts SET ledger_version = 2 WHERE id = $1', [
      accountId,
    ])
    await expect(
      readWalletBalance(await request('guard-sequence-gap-read'), accountId),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
  })

  it('fails closed when a posted ending snapshot differs from derived entries', async () => {
    const accountId = await account('guard-posted-snapshot')
    const creditKey = `${fixturePrefix}:guard-posted-snapshot:credit`
    await postWalletCredit(await request('guard-posted-snapshot-credit'), {
      accountId,
      amountFen: 10,
      transactionKey: creditKey,
    })
    await payload.db.pool.query(
      `UPDATE wallet_entries
       SET posted_balance_after_fen = 11
       WHERE account_id = $1
         AND entry_key = $2`,
      [accountId, `${creditKey}:credit`],
    )
    await expect(
      readWalletBalance(await request('guard-posted-snapshot-read'), accountId),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
  })

  it('fails closed when a held ending snapshot differs from derived entries', async () => {
    const accountId = await account('guard-held-snapshot')
    const holdKey = `${fixturePrefix}:guard-held-snapshot:hold`
    await postWalletCredit(await request('guard-held-snapshot-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:guard-held-snapshot:credit`,
    })
    await holdWalletBalance(await request('guard-held-snapshot-hold'), {
      accountId,
      amountFen: 40,
      transactionKey: holdKey,
    })
    await payload.db.pool.query(
      `UPDATE wallet_entries
       SET held_balance_after_fen = 39
       WHERE account_id = $1
         AND entry_key = $2`,
      [accountId, `${holdKey}:hold`],
    )
    await expect(
      readWalletBalance(await request('guard-held-snapshot-read'), accountId),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
  })

  it('scopes the credit ledger-version UPDATE to exactly the requested account', async () => {
    const decoyAccountId = await account('credit-update-decoy')
    const targetAccountId = await account('credit-update-target')
    await postWalletCredit(await request('credit-update-target-post'), {
      accountId: targetAccountId,
      amountFen: 10,
      transactionKey: `${fixturePrefix}:credit-update-target:credit`,
    })

    await expect(
      readWalletBalance(await request('credit-update-target-read'), targetAccountId),
    ).resolves.toEqual({ availableBalance: 10n, heldBalance: 0n, postedBalance: 10n })
    await expect(
      readWalletBalance(await request('credit-update-decoy-read'), decoyAccountId),
    ).resolves.toEqual({ availableBalance: 0n, heldBalance: 0n, postedBalance: 0n })
  })

  it('scopes the hold ledger-version UPDATE to exactly the requested account', async () => {
    const decoyAccountId = await account('hold-update-decoy')
    const targetAccountId = await account('hold-update-target')
    await postWalletCredit(await request('hold-update-target-credit'), {
      accountId: targetAccountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:hold-update-target:credit`,
    })
    await expect(
      holdWalletBalance(await request('hold-update-target-hold'), {
        accountId: targetAccountId,
        amountFen: 20,
        transactionKey: `${fixturePrefix}:hold-update-target:hold`,
      }),
    ).resolves.toMatchObject({ applied: true, status: 'held' })

    await expect(
      readWalletBalance(await request('hold-update-target-read'), targetAccountId),
    ).resolves.toEqual({ availableBalance: 80n, heldBalance: 20n, postedBalance: 100n })
    await expect(
      readWalletBalance(await request('hold-update-decoy-read'), decoyAccountId),
    ).resolves.toEqual({ availableBalance: 0n, heldBalance: 0n, postedBalance: 0n })
  })

  it('scopes a balance read to exactly the requested account', async () => {
    const decoyAccountId = await account('read-scope-decoy')
    const targetAccountId = await account('read-scope-target')
    await postWalletCredit(await request('read-scope-decoy-credit'), {
      accountId: decoyAccountId,
      amountFen: 90,
      transactionKey: `${fixturePrefix}:read-scope-decoy:credit`,
    })
    await holdWalletBalance(await request('read-scope-decoy-hold'), {
      accountId: decoyAccountId,
      amountFen: 20,
      transactionKey: `${fixturePrefix}:read-scope-decoy:hold`,
    })
    const targetCredit = await Promise.allSettled([
      postWalletCredit(await request('read-scope-target-credit'), {
        accountId: targetAccountId,
        amountFen: 10,
        transactionKey: `${fixturePrefix}:read-scope-target:credit`,
      }),
    ])
    expect(targetCredit.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)

    const attempts = await Promise.allSettled([
      readWalletBalance(await request('read-scope-target-read'), targetAccountId),
    ])
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect((attempts[0] as PromiseFulfilledResult<unknown>).value).toEqual({
      availableBalance: 10n,
      heldBalance: 0n,
      postedBalance: 10n,
    })
  })

  it('scopes the account-closure balance check and fails closed on an inconsistent ledger', async () => {
    const emptyAccountId = await account('closure-balance-empty')
    const positiveAccountId = await account('closure-balance-positive')
    const emptyCustomer = customersByAccount.get(emptyAccountId)
    const positiveCustomer = customersByAccount.get(positiveAccountId)
    if (!emptyCustomer || !positiveCustomer) throw new Error('Missing wallet customer fixture')

    await postWalletCredit(await request('closure-empty-credit'), {
      accountId: emptyAccountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:closure-empty:credit`,
    })
    await holdWalletBalance(await request('closure-empty-hold'), {
      accountId: emptyAccountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:closure-empty:hold`,
    })
    await postWalletCredit(await request('closure-positive-credit'), {
      accountId: positiveAccountId,
      amountFen: 200,
      transactionKey: `${fixturePrefix}:closure-positive:credit`,
    })

    await expect(
      hasPositiveWalletAvailableBalance(
        await request('closure-empty-read'),
        Number(emptyCustomer.id),
      ),
    ).resolves.toBe(false)
    await expect(
      hasPositiveWalletAvailableBalance(
        await request('closure-positive-read'),
        Number(positiveCustomer.id),
      ),
    ).resolves.toBe(true)

    const corrupted = await payload.db.pool.query(
      `UPDATE wallet_accounts
       SET ledger_version = ledger_version + 1
       WHERE id = $1
         AND customer_id = $2
       RETURNING id`,
      [positiveAccountId, positiveCustomer.id],
    )
    expect(corrupted.rowCount).toBe(1)
    await expect(
      hasPositiveWalletAvailableBalance(
        await request('closure-corrupt-read'),
        Number(positiveCustomer.id),
      ),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
  })

  it('derives the hold ceiling from only the requested account entries', async () => {
    const targetAccountId = await account('hold-scope-target')
    const decoyAccountId = await account('hold-scope-decoy')
    await postWalletCredit(await request('hold-scope-target-credit'), {
      accountId: targetAccountId,
      amountFen: 20,
      transactionKey: `${fixturePrefix}:hold-scope-target:credit`,
    })
    await postWalletCredit(await request('hold-scope-decoy-credit'), {
      accountId: decoyAccountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:hold-scope-decoy:credit`,
    })

    await expect(
      holdWalletBalance(await request('hold-scope-target-hold'), {
        accountId: targetAccountId,
        amountFen: 50,
        transactionKey: `${fixturePrefix}:hold-scope-target:hold`,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_BALANCE_INSUFFICIENT' })
    await expect(countEntries(targetAccountId, { entryType: { equals: 'hold' } })).resolves.toBe(0)
  })

  it('makes a global idempotency key credit exactly one of two concurrent accounts', async () => {
    const firstAccountId = await account('cross-account-idempotency-first')
    const secondAccountId = await account('cross-account-idempotency-second')
    const transactionKey = `${fixturePrefix}:cross-account-idempotency:credit`
    const blocker = await payload.db.pool.connect()
    let results: PromiseSettledResult<Awaited<ReturnType<typeof postWalletCredit>>>[]
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE wallet_transactions IN SHARE MODE')
      const credits = Promise.allSettled([
        postWalletCredit(await request('cross-account-idempotency-first'), {
          accountId: firstAccountId,
          amountFen: 100,
          transactionKey,
        }),
        postWalletCredit(await request('cross-account-idempotency-second'), {
          accountId: secondAccountId,
          amountFen: 100,
          transactionKey,
        }),
      ])
      await new Promise((resolve) => setTimeout(resolve, 75))
      await blocker.query('COMMIT')
      results = await credits
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter(({ status }) => status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'WALLET_IDEMPOTENCY_CONFLICT',
    })
    const balances = await Promise.all([
      readWalletBalance(await request('cross-account-idempotency-first-read'), firstAccountId),
      readWalletBalance(await request('cross-account-idempotency-second-read'), secondAccountId),
    ])
    expect(balances.map(({ postedBalance }) => postedBalance).sort()).toEqual([0n, 100n])
    const transactions = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: { transactionKey: { equals: transactionKey } },
    })
    expect(transactions.totalDocs).toBe(1)
  })

  it('rejects every persisted idempotency dimension mismatch independently', async () => {
    const accountMismatch = await account('idempotency-account')
    const accountMismatchDecoy = await account('idempotency-account-decoy')
    const accountMismatchKey = `${fixturePrefix}:idempotency-account:credit`
    await postWalletCredit(await request('idempotency-account-credit'), {
      accountId: accountMismatch,
      amountFen: 10,
      transactionKey: accountMismatchKey,
    })
    await payload.db.pool.query(
      'UPDATE wallet_transactions SET account_id = $1 WHERE transaction_key = $2',
      [accountMismatchDecoy, accountMismatchKey],
    )
    await expect(
      postWalletCredit(await request('idempotency-account-retry'), {
        accountId: accountMismatch,
        amountFen: 10,
        transactionKey: accountMismatchKey,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_IDEMPOTENCY_CONFLICT' })

    const customerMismatch = await account('idempotency-customer')
    const customerMismatchDecoy = await account('idempotency-customer-decoy')
    const customerMismatchKey = `${fixturePrefix}:idempotency-customer:credit`
    await postWalletCredit(await request('idempotency-customer-credit'), {
      accountId: customerMismatch,
      amountFen: 10,
      transactionKey: customerMismatchKey,
    })
    await payload.db.pool.query(
      'UPDATE wallet_transactions SET customer_id = $1 WHERE transaction_key = $2',
      [customerFor(customerMismatchDecoy).id, customerMismatchKey],
    )
    await expect(
      postWalletCredit(await request('idempotency-customer-retry'), {
        accountId: customerMismatch,
        amountFen: 10,
        transactionKey: customerMismatchKey,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_IDEMPOTENCY_CONFLICT' })

    const typeMismatch = await account('idempotency-type')
    const typeMismatchKey = `${fixturePrefix}:idempotency-type:credit`
    await postWalletCredit(await request('idempotency-type-credit'), {
      accountId: typeMismatch,
      amountFen: 10,
      transactionKey: typeMismatchKey,
    })
    await expect(
      holdWalletBalance(await request('idempotency-type-hold'), {
        accountId: typeMismatch,
        amountFen: 10,
        transactionKey: typeMismatchKey,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_IDEMPOTENCY_CONFLICT' })

    const amountMismatch = await account('idempotency-amount')
    const amountMismatchKey = `${fixturePrefix}:idempotency-amount:credit`
    await postWalletCredit(await request('idempotency-amount-credit'), {
      accountId: amountMismatch,
      amountFen: 10,
      transactionKey: amountMismatchKey,
    })
    await expect(
      postWalletCredit(await request('idempotency-amount-retry'), {
        accountId: amountMismatch,
        amountFen: 11,
        transactionKey: amountMismatchKey,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_IDEMPOTENCY_CONFLICT' })
  })

  it('settles only the hold selected by its transaction key', async () => {
    const accountId = await account('settlement-key-scope')
    const targetKey = `${fixturePrefix}:settlement-key-scope:target`
    const decoyKey = `${fixturePrefix}:settlement-key-scope:decoy`
    await postWalletCredit(await request('settlement-key-scope-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:settlement-key-scope:credit`,
    })
    await holdWalletBalance(await request('settlement-key-scope-target-hold'), {
      accountId,
      amountFen: 20,
      transactionKey: targetKey,
    })
    await holdWalletBalance(await request('settlement-key-scope-decoy-hold'), {
      accountId,
      amountFen: 20,
      transactionKey: decoyKey,
    })

    await captureWalletHold(await request('settlement-key-scope-capture'), targetKey)
    await expect(
      countTransactions(accountId, {
        and: [{ transactionKey: { equals: targetKey } }, { status: { equals: 'captured' } }],
      }),
    ).resolves.toBe(1)
    await expect(
      countTransactions(accountId, {
        and: [{ transactionKey: { equals: decoyKey } }, { status: { equals: 'held' } }],
      }),
    ).resolves.toBe(1)
  })

  it('requires hold ledger evidence before an atomic settlement claim', async () => {
    const accountId = await account('settlement-evidence')
    const corruptKey = `${fixturePrefix}:settlement-evidence:corrupt`
    await postWalletCredit(await request('settlement-evidence-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:settlement-evidence:credit`,
    })
    await holdWalletBalance(await request('settlement-evidence-legitimate-hold'), {
      accountId,
      amountFen: 40,
      transactionKey: `${fixturePrefix}:settlement-evidence:legitimate`,
    })
    await insertHeldTransaction({
      accountId,
      amountFen: 40,
      customerId: customerFor(accountId).id,
      transactionKey: corruptKey,
    })

    await expect(
      captureWalletHold(await request('settlement-evidence-capture'), corruptKey),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
    await expect(
      countTransactions(accountId, {
        and: [{ transactionKey: { equals: corruptKey } }, { status: { equals: 'held' } }],
      }),
    ).resolves.toBe(1)
  })

  it('requires the atomic settlement evidence to be a hold entry', async () => {
    const accountId = await account('settlement-evidence-type')
    const customerId = customerFor(accountId).id
    const corruptKey = `${fixturePrefix}:settlement-evidence-type:corrupt`
    await postWalletCredit(await request('settlement-evidence-type-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:settlement-evidence-type:credit`,
    })
    await holdWalletBalance(await request('settlement-evidence-type-legitimate'), {
      accountId,
      amountFen: 40,
      transactionKey: `${fixturePrefix}:settlement-evidence-type:legitimate`,
    })
    const transactionId = await insertHeldTransaction({
      accountId,
      amountFen: 40,
      customerId,
      transactionKey: corruptKey,
    })
    await payload.db.pool.query('UPDATE wallet_accounts SET ledger_version = 3 WHERE id = $1', [
      accountId,
    ])
    await payload.db.pool.query(
      `INSERT INTO wallet_entries (
         entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
         ledger_sequence, posted_balance_after_fen, held_balance_after_fen, updated_at, created_at
       ) VALUES ($1, $2, $3, $4, 'credit', 40, 3, 140, 40, NOW(), NOW())`,
      [`${corruptKey}:credit`, customerId, accountId, transactionId],
    )

    await expect(
      captureWalletHold(await request('settlement-evidence-type-capture'), corruptKey),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
    await expect(
      countTransactions(accountId, {
        and: [{ transactionKey: { equals: corruptKey } }, { status: { equals: 'held' } }],
      }),
    ).resolves.toBe(1)
  })

  it('fails closed at each settlement type, ownership, and held-amount decision point', async () => {
    const accountId = await account('settlement-guards')
    const decoyAccountId = await account('settlement-guards-decoy')
    const customerId = customerFor(accountId).id
    const decoyCustomerId = customerFor(decoyAccountId).id
    const creditKey = `${fixturePrefix}:settlement-guards:credit`
    await postWalletCredit(await request('settlement-guards-credit'), {
      accountId,
      amountFen: 200,
      transactionKey: creditKey,
    })
    await expect(
      captureWalletHold(await request('settlement-guards-credit-type'), creditKey),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })

    const claimedOwnerKey = `${fixturePrefix}:settlement-guards:claimed-owner`
    await holdWalletBalance(await request('settlement-guards-claimed-owner-hold'), {
      accountId,
      amountFen: 20,
      transactionKey: claimedOwnerKey,
    })
    await payload.db.pool.query(
      'UPDATE wallet_transactions SET customer_id = $1 WHERE transaction_key = $2',
      [decoyCustomerId, claimedOwnerKey],
    )
    await expect(
      releaseWalletHold(await request('settlement-guards-claimed-owner-release'), claimedOwnerKey),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
    await expect(
      countTransactions(accountId, {
        and: [{ transactionKey: { equals: claimedOwnerKey } }, { status: { equals: 'held' } }],
      }),
    ).resolves.toBe(1)

    const retryOwnerKey = `${fixturePrefix}:settlement-guards:retry-owner`
    await holdWalletBalance(await request('settlement-guards-retry-owner-hold'), {
      accountId,
      amountFen: 20,
      transactionKey: retryOwnerKey,
    })
    await captureWalletHold(await request('settlement-guards-retry-owner-capture'), retryOwnerKey)
    await payload.db.pool.query(
      'UPDATE wallet_transactions SET customer_id = $1 WHERE transaction_key = $2',
      [decoyCustomerId, retryOwnerKey],
    )
    await expect(
      captureWalletHold(await request('settlement-guards-retry-owner-retry'), retryOwnerKey),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })

    const heldAmountKey = `${fixturePrefix}:settlement-guards:held-amount`
    await holdWalletBalance(await request('settlement-guards-held-amount-hold'), {
      accountId,
      amountFen: 40,
      transactionKey: heldAmountKey,
    })
    const heldAmountTransaction = await payload.db.pool.query<{ id: number }>(
      'SELECT id FROM wallet_transactions WHERE transaction_key = $1',
      [heldAmountKey],
    )
    await payload.db.pool.query(
      `UPDATE wallet_accounts SET ledger_version = ledger_version + 1 WHERE id = $1`,
      [accountId],
    )
    const state = await payload.db.pool.query<{
      ledger_version: string
      posted_balance: string
      held_balance: string
    }>(
      `SELECT
         account.ledger_version,
         SUM(CASE WHEN entry.entry_type = 'credit' THEN entry.amount_fen
                  WHEN entry.entry_type = 'capture' THEN -entry.amount_fen ELSE 0 END) AS posted_balance,
         SUM(CASE WHEN entry.entry_type = 'hold' THEN entry.amount_fen
                  WHEN entry.entry_type IN ('capture', 'release') THEN -entry.amount_fen ELSE 0 END) AS held_balance
       FROM wallet_accounts account
       JOIN wallet_entries entry ON entry.account_id = account.id
       WHERE account.id = $1
       GROUP BY account.ledger_version`,
      [accountId],
    )
    const row = state.rows[0]!
    await payload.db.pool.query(
      `INSERT INTO wallet_entries (
         entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
         ledger_sequence, posted_balance_after_fen, held_balance_after_fen, updated_at, created_at
       ) VALUES ($1, $2, $3, $4, 'release', 40, $5, $6, $7, NOW(), NOW())`,
      [
        `${heldAmountKey}:manufactured-release`,
        customerId,
        accountId,
        heldAmountTransaction.rows[0]!.id,
        row.ledger_version,
        row.posted_balance,
        String(BigInt(row.held_balance) - 40n),
      ],
    )
    await expect(
      captureWalletHold(await request('settlement-guards-held-amount-capture'), heldAmountKey),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
  })

  it('requires hold evidence amount to match the claimed transaction amount', async () => {
    const accountId = await account('settlement-evidence-amount')
    const customerId = customerFor(accountId).id
    const corruptKey = `${fixturePrefix}:settlement-evidence-amount:corrupt`
    await postWalletCredit(await request('settlement-evidence-amount-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:settlement-evidence-amount:credit`,
    })
    await holdWalletBalance(await request('settlement-evidence-amount-legitimate'), {
      accountId,
      amountFen: 50,
      transactionKey: `${fixturePrefix}:settlement-evidence-amount:legitimate`,
    })
    const transactionId = await insertHeldTransaction({
      accountId,
      amountFen: 40,
      customerId,
      transactionKey: corruptKey,
    })
    await payload.db.pool.query(
      `UPDATE wallet_accounts
       SET ledger_version = 3
       WHERE id = $1`,
      [accountId],
    )
    await payload.db.pool.query(
      `INSERT INTO wallet_entries (
         entry_key,
         customer_id,
         account_id,
         transaction_id,
         entry_type,
         amount_fen,
         ledger_sequence,
         posted_balance_after_fen,
         held_balance_after_fen,
         updated_at,
         created_at
       ) VALUES ($1, $2, $3, $4, 'hold', 30, 3, 100, 80, NOW(), NOW())`,
      [`${corruptKey}:hold`, customerId, accountId, transactionId],
    )

    await expect(
      captureWalletHold(await request('settlement-evidence-amount-capture'), corruptKey),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
    await expect(
      countTransactions(accountId, {
        and: [{ transactionKey: { equals: corruptKey } }, { status: { equals: 'held' } }],
      }),
    ).resolves.toBe(1)
  })

  it('routes confirmed and failed outcomes to capture and release while unknown remains held', async () => {
    const accountId = await account('resolve-outcomes')
    const confirmedKey = `${fixturePrefix}:resolve-outcomes:confirmed`
    const failedKey = `${fixturePrefix}:resolve-outcomes:failed`
    const unknownKey = `${fixturePrefix}:resolve-outcomes:unknown`
    await postWalletCredit(await request('resolve-outcomes-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:resolve-outcomes:credit`,
    })
    for (const [index, transactionKey] of [confirmedKey, failedKey, unknownKey].entries()) {
      await holdWalletBalance(await request(`resolve-outcomes-hold-${index}`), {
        accountId,
        amountFen: 20,
        transactionKey,
      })
    }

    await expect(
      resolveWalletHold(await request('resolve-outcomes-confirmed'), {
        outcome: 'confirmed',
        transactionKey: confirmedKey,
      }),
    ).resolves.toMatchObject({ applied: true, status: 'captured' })
    await expect(
      resolveWalletHold(await request('resolve-outcomes-failed'), {
        outcome: 'failed',
        transactionKey: failedKey,
      }),
    ).resolves.toMatchObject({ applied: true, status: 'released' })
    await expect(
      resolveWalletHold(await request('resolve-outcomes-unknown'), {
        outcome: 'unknown',
        transactionKey: unknownKey,
      }),
    ).resolves.toMatchObject({ applied: false, status: 'held' })
    await expect(
      readWalletBalance(await request('resolve-outcomes-read'), accountId),
    ).resolves.toEqual({
      availableBalance: 60n,
      heldBalance: 20n,
      postedBalance: 80n,
    })
  })

  it('fails closed when unknown outcome ownership or transaction type is inconsistent', async () => {
    const accountId = await account('unknown-guards')
    const decoyAccountId = await account('unknown-guards-decoy')
    const holdKey = `${fixturePrefix}:unknown-guards:hold`
    const creditKey = `${fixturePrefix}:unknown-guards:credit`
    await postWalletCredit(await request('unknown-guards-credit'), {
      accountId,
      amountFen: 100,
      transactionKey: creditKey,
    })
    await holdWalletBalance(await request('unknown-guards-hold'), {
      accountId,
      amountFen: 20,
      transactionKey: holdKey,
    })

    await expect(
      resolveWalletHold(await request('unknown-guards-type'), {
        outcome: 'unknown',
        transactionKey: creditKey,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
    await expect(
      resolveWalletHold(await request('unknown-guards-invalid-outcome'), {
        outcome: 'indeterminate' as 'unknown',
        transactionKey: holdKey,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
    await payload.db.pool.query(
      `UPDATE wallet_transactions
       SET customer_id = $1
       WHERE account_id = $2
         AND transaction_key = $3`,
      [customerFor(decoyAccountId).id, accountId, holdKey],
    )
    await expect(
      resolveWalletHold(await request('unknown-guards-owner'), {
        outcome: 'unknown',
        transactionKey: holdKey,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_LEDGER_UNAVAILABLE' })
  })

  it('fails closed for missing capture, release, and unknown hold keys', async () => {
    await expect(
      captureWalletHold(await request('missing-hold-capture'), `${fixturePrefix}:missing:capture`),
    ).rejects.toMatchObject({ code: 'WALLET_HOLD_NOT_FOUND' })
    await expect(
      releaseWalletHold(await request('missing-hold-release'), `${fixturePrefix}:missing:release`),
    ).rejects.toMatchObject({ code: 'WALLET_HOLD_NOT_FOUND' })
    await expect(
      resolveWalletHold(await request('missing-hold-unknown'), {
        outcome: 'unknown',
        transactionKey: `${fixturePrefix}:missing:unknown`,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_HOLD_NOT_FOUND' })
  })

  it('reports every independently corruptible ledger invariant against the affected account', async () => {
    const expected: Array<{ accountId: number; code: string }> = []

    const sequenceAccount = await account('invariant-sequence')
    const sequenceKey = `${fixturePrefix}:invariant-sequence:credit`
    await postWalletCredit(await request('invariant-sequence-credit'), {
      accountId: sequenceAccount,
      amountFen: 10,
      transactionKey: sequenceKey,
    })
    await payload.db.pool.query(
      `UPDATE wallet_entries SET ledger_sequence = 2 WHERE entry_key = $1`,
      [`${sequenceKey}:credit`],
    )
    await payload.db.pool.query('UPDATE wallet_accounts SET ledger_version = 2 WHERE id = $1', [
      sequenceAccount,
    ])
    expected.push({ accountId: sequenceAccount, code: 'ledger_sequence_gap' })

    const entryCustomerAccount = await account('invariant-entry-customer')
    const entryCustomerDecoy = await account('invariant-entry-customer-decoy')
    const entryCustomerKey = `${fixturePrefix}:invariant-entry-customer:credit`
    await postWalletCredit(await request('invariant-entry-customer-credit'), {
      accountId: entryCustomerAccount,
      amountFen: 10,
      transactionKey: entryCustomerKey,
    })
    await payload.db.pool.query(`UPDATE wallet_entries SET customer_id = $1 WHERE entry_key = $2`, [
      customerFor(entryCustomerDecoy).id,
      `${entryCustomerKey}:credit`,
    ])
    expected.push({ accountId: entryCustomerAccount, code: 'entry_customer_mismatch' })
    expected.push({ accountId: entryCustomerAccount, code: 'transaction_entry_mismatch' })

    const postedAccount = await account('invariant-posted')
    const postedKey = `${fixturePrefix}:invariant-posted:credit`
    await postWalletCredit(await request('invariant-posted-credit'), {
      accountId: postedAccount,
      amountFen: 10,
      transactionKey: postedKey,
    })
    await payload.db.pool.query(
      `UPDATE wallet_entries SET posted_balance_after_fen = 11 WHERE entry_key = $1`,
      [`${postedKey}:credit`],
    )
    expected.push({ accountId: postedAccount, code: 'posted_equation_mismatch' })

    const heldAccount = await account('invariant-held')
    const heldKey = `${fixturePrefix}:invariant-held:hold`
    await postWalletCredit(await request('invariant-held-credit'), {
      accountId: heldAccount,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:invariant-held:credit`,
    })
    await holdWalletBalance(await request('invariant-held-hold'), {
      accountId: heldAccount,
      amountFen: 40,
      transactionKey: heldKey,
    })
    await payload.db.pool.query(
      `UPDATE wallet_entries SET held_balance_after_fen = 39 WHERE entry_key = $1`,
      [`${heldKey}:hold`],
    )
    expected.push({ accountId: heldAccount, code: 'held_equation_mismatch' })

    const versionAccount = await account('invariant-version')
    await postWalletCredit(await request('invariant-version-credit'), {
      accountId: versionAccount,
      amountFen: 10,
      transactionKey: `${fixturePrefix}:invariant-version:credit`,
    })
    await payload.db.pool.query(
      'UPDATE wallet_accounts SET ledger_version = ledger_version + 1 WHERE id = $1',
      [versionAccount],
    )
    expected.push({ accountId: versionAccount, code: 'account_ledger_version_mismatch' })

    const transactionCustomerAccount = await account('invariant-transaction-customer')
    const transactionCustomerDecoy = await account('invariant-transaction-customer-decoy')
    const transactionCustomerKey = `${fixturePrefix}:invariant-transaction-customer:credit`
    await postWalletCredit(await request('invariant-transaction-customer-credit'), {
      accountId: transactionCustomerAccount,
      amountFen: 10,
      transactionKey: transactionCustomerKey,
    })
    await payload.db.pool.query(
      `UPDATE wallet_transactions SET customer_id = $1 WHERE transaction_key = $2`,
      [customerFor(transactionCustomerDecoy).id, transactionCustomerKey],
    )
    expected.push({ accountId: transactionCustomerAccount, code: 'transaction_customer_mismatch' })
    expected.push({ accountId: transactionCustomerAccount, code: 'transaction_entry_mismatch' })

    const transactionAccountSource = await account('invariant-transaction-account-source')
    const transactionAccountDecoy = await account('invariant-transaction-account-decoy')
    const transactionAccountKey = `${fixturePrefix}:invariant-transaction-account:credit`
    await postWalletCredit(await request('invariant-transaction-account-credit'), {
      accountId: transactionAccountSource,
      amountFen: 10,
      transactionKey: transactionAccountKey,
    })
    await payload.db.pool.query(
      `UPDATE wallet_transactions
       SET account_id = $1
       WHERE transaction_key = $2`,
      [transactionAccountDecoy, transactionAccountKey],
    )
    expected.push({ accountId: transactionAccountDecoy, code: 'transaction_entry_mismatch' })

    const transactionAmountAccount = await account('invariant-transaction-amount')
    const transactionAmountKey = `${fixturePrefix}:invariant-transaction-amount:credit`
    await postWalletCredit(await request('invariant-transaction-amount-credit'), {
      accountId: transactionAmountAccount,
      amountFen: 10,
      transactionKey: transactionAmountKey,
    })
    await payload.db.pool.query(
      `UPDATE wallet_entries
       SET amount_fen = 11, posted_balance_after_fen = 11
       WHERE entry_key = $1`,
      [`${transactionAmountKey}:credit`],
    )
    expected.push({ accountId: transactionAmountAccount, code: 'transaction_entry_mismatch' })

    const historyLengthAccount = await account('invariant-history-length')
    const historyLengthCustomer = customerFor(historyLengthAccount).id
    const historyLengthKey = `${fixturePrefix}:invariant-history-length:hold`
    await postWalletCredit(await request('invariant-history-length-credit'), {
      accountId: historyLengthAccount,
      amountFen: 100,
      transactionKey: `${fixturePrefix}:invariant-history-length:credit`,
    })
    const historyLengthTransaction = await payload.db.pool.query<{ id: number }>(
      `INSERT INTO wallet_transactions (
         transaction_key, customer_id, account_id, type, status, amount_fen,
         resolved_at, updated_at, created_at
       ) VALUES ($1, $2, $3, 'hold', 'captured', 20, NOW(), NOW(), NOW())
       RETURNING id`,
      [historyLengthKey, historyLengthCustomer, historyLengthAccount],
    )
    await payload.db.pool.query('UPDATE wallet_accounts SET ledger_version = 2 WHERE id = $1', [
      historyLengthAccount,
    ])
    await payload.db.pool.query(
      `INSERT INTO wallet_entries (
         entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
         ledger_sequence, posted_balance_after_fen, held_balance_after_fen, updated_at, created_at
       ) VALUES ($1, $2, $3, $4, 'hold', 20, 2, 100, 20, NOW(), NOW())`,
      [
        `${historyLengthKey}:hold`,
        historyLengthCustomer,
        historyLengthAccount,
        historyLengthTransaction.rows[0]!.id,
      ],
    )
    expected.push({ accountId: historyLengthAccount, code: 'transaction_history_invalid' })

    const historyTypeAccount = await account('invariant-history-type')
    const historyTypeCustomer = customerFor(historyTypeAccount).id
    const historyTypeKey = `${fixturePrefix}:invariant-history-type:hold`
    const historyTypeTransaction = await insertHeldTransaction({
      accountId: historyTypeAccount,
      amountFen: 10,
      customerId: historyTypeCustomer,
      transactionKey: historyTypeKey,
    })
    await payload.db.pool.query('UPDATE wallet_accounts SET ledger_version = 1 WHERE id = $1', [
      historyTypeAccount,
    ])
    await payload.db.pool.query(
      `INSERT INTO wallet_entries (
         entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
         ledger_sequence, posted_balance_after_fen, held_balance_after_fen, updated_at, created_at
       ) VALUES ($1, $2, $3, $4, 'credit', 10, 1, 10, 0, NOW(), NOW())`,
      [`${historyTypeKey}:credit`, historyTypeCustomer, historyTypeAccount, historyTypeTransaction],
    )
    expected.push({ accountId: historyTypeAccount, code: 'transaction_history_invalid' })

    const inspection = await inspectWalletLedgerInvariants(await request('invariant-decision-map'))
    for (const item of expected) {
      expect(inspection.discrepancies).toContainEqual(
        expect.objectContaining({ accountId: String(item.accountId), code: item.code }),
      )
    }
  })
})
