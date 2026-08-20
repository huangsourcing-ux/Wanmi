import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const ledgerPath = `${webRoot}/src/services/points/ledger.ts`
const testFile = 'tests/integration/d9e2-points-ledger.integration.test.ts'
const mutations = []
const add = (mutation) => mutations.push(mutation)

for (const mutation of [
  {
    id: 'account-create-conflict-customer',
    predicate: 'points account INSERT conflicts only on customer_id',
    search: '    ON CONFLICT (customer_id) DO NOTHING\n',
    replacement: '    ON CONFLICT DO NOTHING\n',
    test: 'concurrently earns one pending entry for one earning idempotency key',
  },
  {
    id: 'exclusive-lock-customer',
    predicate: 'FOR UPDATE locks only the requested customer account',
    search: '    WHERE customer_id = ${customerId}\n    FOR UPDATE\n',
    replacement: '    WHERE TRUE\n    FOR UPDATE\n',
    test: 'scopes locks, balances, allocations, and batch reads to one customer account',
  },
  {
    id: 'shared-lock-customer',
    predicate: 'FOR SHARE locks only the requested customer account',
    search: '    WHERE customer_id = ${customerId}\n    FOR SHARE\n',
    replacement: '    WHERE TRUE\n    FOR SHARE\n',
    test: 'scopes locks, balances, allocations, and batch reads to one customer account',
  },
  {
    id: 'points-aggregate-account',
    predicate: 'points aggregate is scoped to the locked account',
    search: '    FROM points_ledger\n    WHERE account_id = ${account.accountId}\n',
    replacement: '    FROM points_ledger\n    WHERE TRUE\n',
    test: 'scopes locks, balances, allocations, and batch reads to one customer account',
  },
  {
    id: 'points-allocation-aggregate-account',
    predicate: 'points allocation aggregate is scoped to the locked account',
    search:
      '        FROM points_consumption_allocations\n        WHERE account_id = ${account.accountId}\n      ), 0) AS allocated,\n',
    replacement:
      '        FROM points_consumption_allocations\n        WHERE TRUE\n      ), 0) AS allocated,\n',
    test: 'scopes locks, balances, allocations, and batch reads to one customer account',
  },
  {
    id: 'quota-aggregate-account',
    predicate: 'quota aggregate is scoped to the locked account',
    search: '    FROM tool_quota_ledger\n    WHERE account_id = ${account.accountId}\n',
    replacement: '    FROM tool_quota_ledger\n    WHERE TRUE\n',
    test: 'scopes locks, balances, allocations, and batch reads to one customer account',
  },
  {
    id: 'order-id',
    predicate: 'reward source lookup uses the requested order id',
    search: '    FROM orders\n    WHERE id = ${input.orderId}\n    FOR SHARE\n',
    replacement: '    FROM orders\n    WHERE id <> ${input.orderId}\n    FOR SHARE\n',
    test: 'reads order owner and status independently and applies A3 before earning',
  },
  {
    id: 'earning-key-lookup',
    predicate: 'earning idempotency lookup uses the requested global key',
    search: '    FROM points_batches\n    WHERE earning_key = ${key}\n',
    replacement: '    FROM points_batches\n    WHERE earning_key <> ${key}\n',
    test: 'rejects every earning idempotency dimension mismatch without another entry',
  },
  {
    id: 'batch-id-lookup',
    predicate: 'batch lookup uses the requested batch id',
    search: '    FROM points_batches\n    WHERE id = ${batchId}\n',
    replacement: '    FROM points_batches\n    WHERE id <> ${batchId}\n',
    test: 'scopes locks, balances, allocations, and batch reads to one customer account',
  },
  {
    id: 'batch-lifecycle-id',
    predicate: 'batch lifecycle facts use the requested batch id',
    search: '    FROM points_ledger\n    WHERE batch_id = ${batch.batchId}\n',
    replacement: '    FROM points_ledger\n    WHERE batch_id <> ${batch.batchId}\n',
    test: 'lets exactly one of N concurrent confirmations append the available transition',
  },
  {
    id: 'redemption-key-lookup',
    predicate: 'redemption idempotency lookup uses the requested global key',
    search: '    FROM points_redemptions\n    WHERE redemption_key = ${key}\n',
    replacement: '    FROM points_redemptions\n    WHERE redemption_key <> ${key}\n',
    test: 'allocates deterministically by earliest expiry and then ascending batch id on replay',
  },
  {
    id: 'quota-usage-key-lookup',
    predicate: 'quota usage idempotency lookup uses the requested global key',
    search: '      FROM tool_quota_ledger\n      WHERE entry_key = ${entryKey}\n',
    replacement: '      FROM tool_quota_ledger\n      WHERE entry_key <> ${entryKey}\n',
    test: 'rejects every redemption and quota-use idempotency dimension mismatch',
  },
])
  add({ group: 'scope', ...mutation })

for (const mutation of [
  {
    id: 'points-derived-allocation-source',
    predicate: 'points balance uses allocation rows rather than consumed entries',
    changes: [
      {
        search:
          '            COALESCE((SELECT SUM(points) FROM points_consumption_allocations\n              WHERE batch_id = batches.id), 0) AS allocated\n',
        replacement:
          "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'consumed'), 0) AS allocated\n",
      },
    ],
    test: 'fails closed for every independently corruptible points-balance invariant',
  },
  {
    id: 'points-derived-order-owner-source',
    predicate: 'batch ownership comes from the source order customer field',
    search: '            OR orders.customer_id <> ${account.customerId})\n',
    replacement: '            OR batches.customer_id <> ${account.customerId})\n',
    test: 'fails closed for every independently corruptible points-balance invariant',
  },
  {
    id: 'points-derived-entry-customer-source',
    predicate: 'ledger link validation reads entry.customer_id',
    search: '            OR entries.customer_id <> ${account.customerId}\n',
    replacement: '            OR batches.customer_id <> ${account.customerId}\n',
    test: 'fails closed for every independently corruptible points-balance invariant',
  },
  {
    id: 'points-derived-allocation-customer-source',
    predicate: 'allocation link validation reads allocation.customer_id',
    search: '            OR allocations.customer_id <> ${account.customerId}\n',
    replacement: '            OR batches.customer_id <> ${account.customerId}\n',
    test: 'fails closed for every independently corruptible points-balance invariant',
  },
  {
    id: 'points-lifecycle-pending-source',
    predicate: 'per-batch pending total reads pending entries',
    search:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'pending'), 0) AS pending,\n",
    replacement:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'available'), 0) AS pending,\n",
    test: 'fails closed for every independently corruptible points-balance invariant',
  },
  {
    id: 'points-lifecycle-available-source',
    predicate: 'per-batch available total reads available entries',
    search:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'available'), 0) AS available,\n",
    replacement:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'pending'), 0) AS available,\n",
    test: 'fails closed for every independently corruptible points-balance invariant',
  },
  {
    id: 'points-lifecycle-held-source',
    predicate: 'per-batch held total reads held entries',
    search:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'held'), 0) AS held,\n",
    replacement:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'consumed'), 0) AS held,\n",
    test: 'fails closed for every independently corruptible points-balance invariant',
  },
  {
    id: 'points-lifecycle-consumed-source',
    predicate: 'per-batch consumed total reads consumed entries',
    search:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'consumed'), 0) AS consumed,\n",
    replacement:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'held'), 0) AS consumed,\n",
    test: 'fails closed for every independently corruptible points-balance invariant',
  },
  {
    id: 'points-lifecycle-expired-source',
    predicate: 'per-batch expired total reads expired entries',
    search:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'expired'), 0) AS expired,\n",
    replacement:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'reversed'), 0) AS expired,\n",
    test: 'fails closed for independently corrupted batch lifecycle and ownership links',
  },
  {
    id: 'points-lifecycle-reversed-source',
    predicate: 'per-batch reversed total reads reversed entries',
    search:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'reversed'), 0) AS reversed,\n",
    replacement:
      "            COALESCE((SELECT SUM(points) FROM points_ledger\n              WHERE batch_id = batches.id AND entry_type = 'expired'), 0) AS reversed,\n",
    test: 'fails closed for every independently corruptible points-balance invariant',
  },
  {
    id: 'quota-target-balance-source',
    predicate: 'quota balance reads only the requested target',
    changes: [
      {
        search: "          WHEN target = ${target} AND entry_type = 'grant' THEN quota_units\n",
        replacement: "          WHEN entry_type = 'grant' THEN quota_units\n",
      },
      {
        search: "          WHEN target = ${target} AND entry_type = 'consume' THEN -quota_units\n",
        replacement: "          WHEN entry_type = 'consume' THEN -quota_units\n",
      },
    ],
    test: 'fails closed for each quota-ledger invariant and scopes balance to the requested target',
  },
])
  add({ group: 'source', ...mutation })

for (const mutation of [
  {
    id: 'earn-version-update-account',
    predicate: 'earning version UPDATE is scoped to the locked account id',
    search:
      '    UPDATE points_accounts\n    SET ledger_version = ledger_version + ${delta.toString()}, updated_at = NOW()\n    WHERE id = ${account.accountId}\n',
    replacement:
      '    UPDATE points_accounts\n    SET ledger_version = ledger_version + ${delta.toString()}, updated_at = NOW()\n    WHERE TRUE\n',
    test: 'scopes every points and quota CAS update to the exact account at equal versions',
  },
  {
    id: 'earn-version-expected-source',
    predicate: 'earning version UPDATE compares the expected points version',
    search: '      AND ledger_version = ${account.ledgerVersion.toString()}\n',
    replacement: '      AND ledger_version = ${account.quotaLedgerVersion.toString()}\n',
    occurrence: 1,
    expectedOccurrences: 4,
    test: 'scopes every points and quota CAS update to the exact account at equal versions',
  },
  {
    id: 'pending-claim-account',
    predicate: 'pending transition claim is scoped to the locked account id',
    search:
      '    UPDATE points_accounts\n    SET ledger_version = ledger_version + 1, updated_at = NOW()\n    WHERE id = ${account.accountId}\n      AND ledger_version = ${account.ledgerVersion.toString()}\n      AND EXISTS (\n',
    replacement:
      '    UPDATE points_accounts\n    SET ledger_version = ledger_version + 1, updated_at = NOW()\n    WHERE TRUE\n      AND ledger_version = ${account.ledgerVersion.toString()}\n      AND EXISTS (\n',
    test: 'scopes every points and quota CAS update to the exact account at equal versions',
  },
  {
    id: 'pending-claim-version-source',
    predicate: 'pending transition claim compares the expected points version',
    search: '      AND ledger_version = ${account.ledgerVersion.toString()}\n',
    replacement: '      AND ledger_version = ${account.quotaLedgerVersion.toString()}\n',
    occurrence: 2,
    expectedOccurrences: 4,
    test: 'lets exactly one of N concurrent confirmations append the available transition',
  },
  {
    id: 'pending-claim-batch',
    predicate: 'pending evidence belongs to the target batch',
    search:
      '        WHERE batch_id = ${batch.batchId}\n          AND account_id = ${account.accountId}\n',
    replacement:
      '        WHERE batch_id <> ${batch.batchId}\n          AND account_id = ${account.accountId}\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'lets exactly one of N concurrent confirmations append the available transition',
  },
  {
    id: 'pending-claim-points',
    predicate: 'pending evidence amount equals immutable batch points',
    search: '          AND points = ${batch.points.toString()}\n',
    replacement: '          AND points <> ${batch.points.toString()}\n',
    test: 'lets exactly one of N concurrent confirmations append the available transition',
  },
  {
    id: 'pending-claim-terminal-exclusion',
    predicate: 'pending transition excludes available or reversed terminal evidence',
    search: "          AND entry_type IN ('available', 'reversed')\n",
    replacement: "          AND entry_type IN ('pending')\n",
    test: 'lets exactly one of N concurrent confirmations append the available transition',
  },
  {
    id: 'spendable-account',
    predicate: 'spendable batches belong to the locked account',
    search:
      '      WHERE batches.account_id = ${account.accountId}\n        AND batches.expires_at > NOW()\n',
    replacement: '      WHERE TRUE\n        AND batches.expires_at > NOW()\n',
    test: 'scopes locks, balances, allocations, and batch reads to one customer account',
  },
  {
    id: 'spendable-live-expiry',
    predicate: 'spendable batches have not expired at authorization time',
    search: '        AND batches.expires_at > NOW()\n',
    replacement: '        AND TRUE\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'never allocates an expired batch and consumes only a later live batch',
  },
  {
    id: 'spendable-order-expiry',
    predicate: 'allocation orders by earliest expiry',
    search: '    ORDER BY expires_at ASC, id ASC\n',
    replacement: '    ORDER BY expires_at DESC, id ASC\n',
    test: 'allocates deterministically by earliest expiry and then ascending batch id on replay',
  },
  {
    id: 'spendable-order-id-tiebreak',
    predicate: 'allocation ties break by ascending batch id',
    search: '    ORDER BY expires_at ASC, id ASC\n',
    replacement: '    ORDER BY expires_at ASC, id DESC\n',
    test: 'allocates deterministically by earliest expiry and then ascending batch id on replay',
  },
  {
    id: 'persisted-allocation-order',
    predicate: 'replayed allocations use expiry then batch id order',
    search: '    ORDER BY batches.expires_at ASC, allocations.batch_id ASC\n',
    replacement: '    ORDER BY batches.expires_at ASC, allocations.batch_id DESC\n',
    test: 'allocates deterministically by earliest expiry and then ascending batch id on replay',
  },
  {
    id: 'redemption-reservation-account',
    predicate: 'points reservation UPDATE is scoped to the locked account id',
    search:
      '    UPDATE points_accounts\n    SET ledger_version = ledger_version + ${sequenceDelta.toString()}, updated_at = NOW()\n    WHERE id = ${account.accountId}\n',
    replacement:
      '    UPDATE points_accounts\n    SET ledger_version = ledger_version + ${sequenceDelta.toString()}, updated_at = NOW()\n    WHERE TRUE\n',
    test: 'scopes locks, balances, allocations, and batch reads to one customer account',
  },
  {
    id: 'redemption-reservation-version-source',
    predicate: 'points reservation compares the expected points version',
    search: '      AND ledger_version = ${account.ledgerVersion.toString()}\n',
    replacement: '      AND ledger_version = ${account.quotaLedgerVersion.toString()}\n',
    occurrence: 3,
    expectedOccurrences: 4,
    test: 'atomically consumes to the exact boundary under N concurrent redemptions without overdraft',
  },
  {
    id: 'redemption-reservation-cost-source',
    predicate: 'points reservation ceiling uses the requested points cost',
    search: '      AND ${pointsCost.toString()} <= (\n',
    replacement: '      AND ${MAX_SAFE_POINTS.toString()} <= (\n',
    test: 'recomputes remaining expirable points from cross-batch allocations',
  },
  {
    id: 'redemption-reservation-account-source',
    predicate: 'reservation availability derives only target-account batches',
    search:
      '          WHERE batches.account_id = ${account.accountId}\n            AND batches.expires_at > NOW()\n',
    replacement: '          WHERE TRUE\n            AND batches.expires_at > NOW()\n',
    test: 'scopes locks, balances, allocations, and batch reads to one customer account',
  },
  {
    id: 'redemption-reservation-live-expiry',
    predicate: 'reservation availability excludes expired batches',
    search: '            AND batches.expires_at > NOW()\n',
    replacement: '            AND TRUE\n',
    test: 'never allocates an expired batch and consumes only a later live batch',
  },
  {
    id: 'quota-grant-update-account',
    predicate: 'quota grant version UPDATE is scoped to the locked account id',
    search:
      '      UPDATE points_accounts\n      SET quota_ledger_version = quota_ledger_version + 1, updated_at = NOW()\n      WHERE id = ${account.accountId}\n',
    replacement:
      '      UPDATE points_accounts\n      SET quota_ledger_version = quota_ledger_version + 1, updated_at = NOW()\n      WHERE TRUE\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'scopes every points and quota CAS update to the exact account at equal versions',
  },
  {
    id: 'quota-grant-version-source',
    predicate: 'quota grant compares the expected quota version',
    search: '        AND quota_ledger_version = ${account.quotaLedgerVersion.toString()}\n',
    replacement: '        AND quota_ledger_version = ${account.ledgerVersion.toString()}\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'recomputes remaining expirable points from cross-batch allocations',
  },
  {
    id: 'quota-consume-update-account',
    predicate: 'quota consume reservation is scoped to the locked account id',
    search:
      '      UPDATE points_accounts\n      SET quota_ledger_version = quota_ledger_version + 1, updated_at = NOW()\n      WHERE id = ${account.accountId}\n',
    replacement:
      '      UPDATE points_accounts\n      SET quota_ledger_version = quota_ledger_version + 1, updated_at = NOW()\n      WHERE TRUE\n',
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'scopes every points and quota CAS update to the exact account at equal versions',
  },
  {
    id: 'quota-consume-version-source',
    predicate: 'quota consume compares the expected quota version',
    search: '        AND quota_ledger_version = ${account.quotaLedgerVersion.toString()}\n',
    replacement: '        AND quota_ledger_version = ${account.ledgerVersion.toString()}\n',
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'grants only approved tool quotas and atomically prevents quota over-consumption',
  },
  {
    id: 'quota-consume-units-source',
    predicate: 'quota reservation ceiling uses requested quota units',
    search: '        AND ${quotaUnits.toString()} <= (\n',
    replacement: '        AND ${MAX_SAFE_POINTS.toString()} <= (\n',
    test: 'grants only approved tool quotas and atomically prevents quota over-consumption',
  },
  {
    id: 'quota-consume-account-source',
    predicate: 'quota availability derives only the locked account',
    search:
      '          WHERE account_id = ${account.accountId}\n            AND target = ${target}\n',
    replacement: '          WHERE TRUE\n            AND target = ${target}\n',
    test: 'scopes locks, balances, allocations, and batch reads to one customer account',
  },
  {
    id: 'quota-consume-target-source',
    predicate: 'quota availability derives only the requested target',
    search: '            AND target = ${target}\n',
    replacement: '            AND TRUE\n',
    test: 'fails closed for each quota-ledger invariant and scopes balance to the requested target',
  },
])
  add({ group: 'atomic', ...mutation })

add({
  group: 'atomic',
  id: 'redemption-account-authorization',
  predicate: 'allocation and atomic reservation both use the locked points account',
  changes: [
    {
      search:
        '      WHERE batches.account_id = ${account.accountId}\n        AND batches.expires_at > NOW()\n',
      replacement: '      WHERE TRUE\n        AND batches.expires_at > NOW()\n',
    },
    {
      search:
        '          WHERE batches.account_id = ${account.accountId}\n            AND batches.expires_at > NOW()\n',
      replacement: '          WHERE TRUE\n            AND batches.expires_at > NOW()\n',
    },
  ],
  test: 'scopes locks, balances, allocations, and batch reads to one customer account',
})

add({
  group: 'atomic',
  id: 'redemption-live-expiry-authorization',
  predicate: 'allocation and atomic reservation both exclude expired batches',
  changes: [
    {
      search:
        '      WHERE batches.account_id = ${account.accountId}\n        AND batches.expires_at > NOW()\n',
      replacement: '      WHERE batches.account_id = ${account.accountId}\n        AND TRUE\n',
    },
    {
      search:
        '          WHERE batches.account_id = ${account.accountId}\n            AND batches.expires_at > NOW()\n',
      replacement:
        '          WHERE batches.account_id = ${account.accountId}\n            AND TRUE\n',
    },
  ],
  test: 'excludes elapsed but unswept batches in both allocation and atomic reservation',
})

for (const mutation of [
  {
    id: 'batch-remaining-allocation-source',
    predicate: 'remaining expiry amount subtracts allocations, not consumed entries',
    search:
      '        FROM points_consumption_allocations\n        WHERE batch_id = ${batch.batchId}\n          AND account_id = ${batch.accountId}\n          AND customer_id = ${batch.customerId}\n',
    replacement:
      "        FROM points_ledger\n        WHERE batch_id = ${batch.batchId}\n          AND account_id = ${batch.accountId}\n          AND customer_id = ${batch.customerId}\n          AND entry_type = 'consumed'\n",
    test: 'uses allocations rather than correlated consumed entries as the remaining-batch source',
  },
  {
    id: 'batch-remaining-account',
    predicate: 'remaining expiry facts match the immutable batch account',
    search: '          AND account_id = ${batch.accountId}\n',
    replacement: '          AND account_id <> ${batch.accountId}\n',
    occurrence: 1,
    expectedOccurrences: 6,
    test: 'recomputes remaining expirable points from cross-batch allocations',
  },
  {
    id: 'batch-remaining-customer',
    predicate: 'remaining expiry facts match the immutable batch customer',
    search: '          AND customer_id = ${batch.customerId}\n',
    replacement: '          AND customer_id <> ${batch.customerId}\n',
    occurrence: 1,
    expectedOccurrences: 6,
    test: 'recomputes remaining expirable points from cross-batch allocations',
  },
  {
    id: 'expire-cutoff-recheck',
    predicate: 'per-batch expiration rechecks immutable expiry against cutoff',
    search: '    if (!batch || batch.expiresAt.getTime() > input.cutoff.getTime()) return 0n\n',
    replacement:
      '    if (!batch || batch.expiresAt.getTime() <= input.cutoff.getTime()) return 0n\n',
    test: 'expires only by appending an expired entry and leaves every historical row unchanged',
  },
  {
    id: 'expire-claim-account',
    predicate: 'expiration claim is scoped to the locked account id',
    search:
      '      UPDATE points_accounts\n      SET ledger_version = ledger_version + 1, updated_at = NOW()\n      WHERE id = ${account.accountId}\n        AND ledger_version = ${account.ledgerVersion.toString()}\n',
    replacement:
      '      UPDATE points_accounts\n      SET ledger_version = ledger_version + 1, updated_at = NOW()\n      WHERE TRUE\n        AND ledger_version = ${account.ledgerVersion.toString()}\n',
    test: 'scopes every points and quota CAS update to the exact account at equal versions',
  },
  {
    id: 'expire-claim-version-source',
    predicate: 'expiration claim compares the expected points version',
    search: '      AND ledger_version = ${account.ledgerVersion.toString()}\n',
    replacement: '      AND ledger_version = ${account.quotaLedgerVersion.toString()}\n',
    occurrence: 4,
    expectedOccurrences: 4,
    test: 'scopes every points and quota CAS update to the exact account at equal versions',
  },
  {
    id: 'expiration-order-expiry',
    predicate: 'expiration candidates order by earliest expiry',
    search: '     ORDER BY batches.expires_at ASC, batches.id ASC\n',
    replacement: '     ORDER BY batches.expires_at DESC, batches.id ASC\n',
    test: 'expires equal-time batches by ascending id and honors the exact batch limit',
  },
  {
    id: 'expiration-order-id-tiebreak',
    predicate: 'equal-expiry candidates order by ascending batch id',
    search: '     ORDER BY batches.expires_at ASC, batches.id ASC\n',
    replacement: '     ORDER BY batches.expires_at ASC, batches.id DESC\n',
    test: 'expires equal-time batches by ascending id and honors the exact batch limit',
  },
  {
    id: 'expiration-limit',
    predicate: 'expiration candidate query honors the exact configured batch limit',
    search: '     LIMIT $2`,\n',
    replacement: '     LIMIT 500`,\n',
    test: 'expires equal-time batches by ascending id and honors the exact batch limit',
  },
])
  add({ group: 'expiration', ...mutation })

const redundantPredicatesRemovedFromProduction = new Set([
  'account-create-conflict-customer',
  'points-allocation-aggregate-account',
  'spendable-account',
  'spendable-live-expiry',
  'redemption-reservation-account-source',
  'redemption-reservation-live-expiry',
])
const activeMutations = mutations.filter(
  (mutation) => !redundantPredicatesRemovedFromProduction.has(mutation.id),
)

function changesFor(mutation) {
  return mutation.changes ?? [mutation]
}

function occurrences(source, search) {
  return source.split(search).length - 1
}

function replaceOccurrence(source, search, replacement, occurrence) {
  let seen = 0
  return source.replaceAll(search, (match) => {
    seen += 1
    return seen === occurrence ? replacement : match
  })
}

function mutateSource(source, mutation) {
  let mutated = source
  for (const change of changesFor(mutation)) {
    const found = occurrences(mutated, change.search)
    const expected = change.expectedOccurrences ?? mutation.expectedOccurrences ?? 1
    if (found !== expected) {
      throw new Error(`expected ${expected} occurrences, found ${found}`)
    }
    mutated = replaceOccurrence(
      mutated,
      change.search,
      change.replacement,
      change.occurrence ?? mutation.occurrence ?? 1,
    )
  }
  return mutated
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of activeMutations) {
    process.stdout.write(
      `${mutation.group}\t${mutation.id}\t${mutation.predicate}\t${mutation.test}\n`,
    )
  }
  process.stdout.write(`TOTAL\t${activeMutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  const source = readFileSync(ledgerPath, 'utf8')
  for (const mutation of activeMutations) {
    try {
      mutateSource(source, mutation)
    } catch (error) {
      invalid += 1
      process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    }
  }
  process.stdout.write(`VALIDATED\t${activeMutations.length - invalid}/${activeMutations.length}\n`)
  process.exit(invalid ? 1 : 0)
}
const selected = selectors.length
  ? activeMutations.filter(
      (mutation) => selectors.includes(mutation.group) || selectors.includes(mutation.id),
    )
  : activeMutations
if (!selected.length) {
  process.stderr.write(`No D9-E-2 SQL mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const original = readFileSync(ledgerPath, 'utf8')
  let result
  try {
    writeFileSync(ledgerPath, mutateSource(original, mutation), 'utf8')
    result = spawnSync(
      'pnpm',
      [
        '--filter',
        '@wanmi/web',
        'exec',
        'vitest',
        'run',
        '--config',
        'vitest.config.mts',
        testFile,
        '-t',
        mutation.test,
      ],
      { cwd: repositoryRoot, encoding: 'utf8', env: process.env },
    )
  } finally {
    writeFileSync(ledgerPath, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const assertion = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(
    `PREDICATE ${mutation.predicate}\nTEST ${mutation.test}\nRAW_FAILURE ${assertion}\n`,
  )
  if (result?.status !== 0 && output.includes('AssertionError:')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}

process.stdout.write(`\nD9E2_SQL_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
