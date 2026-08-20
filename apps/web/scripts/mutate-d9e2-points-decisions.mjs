import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integrationTest = 'tests/integration/d9e2-points-ledger.integration.test.ts'
const unitTest = 'tests/unit/d9e2-points-collections.test.ts'
const ledgerFile = 'src/services/points/ledger.ts'
const collectionFile = 'src/collections/points.ts'
const jobFile = 'src/jobs/config.ts'
const mutations = []
const add = (mutation) => mutations.push(mutation)

for (const mutation of [
  {
    id: 'integer-safe-number',
    search:
      "typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : undefined",
    replacement: "typeof value === 'bigint' ? value : BigInt(Math.trunc(value))",
  },
  {
    id: 'integer-positive',
    search: 'parsed === undefined || parsed <= 0n || parsed > MAX_SAFE_POINTS',
    replacement: 'parsed === undefined || parsed > MAX_SAFE_POINTS',
  },
  {
    id: 'integer-safe-maximum',
    search: 'parsed === undefined || parsed <= 0n || parsed > MAX_SAFE_POINTS',
    replacement: 'parsed === undefined || parsed <= 0n',
  },
  {
    id: 'key-nonblank',
    search: '!normalized || normalized.length > IDEMPOTENCY_KEY_MAX_LENGTH',
    replacement: 'normalized.length > IDEMPOTENCY_KEY_MAX_LENGTH',
  },
  {
    id: 'key-maximum',
    search: '!normalized || normalized.length > IDEMPOTENCY_KEY_MAX_LENGTH',
    replacement: '!normalized',
  },
  {
    id: 'expiry-valid-date',
    search: 'if (!Number.isFinite(parsed.getTime())) {',
    replacement: 'if (false) {',
    test: 'rejects invalid integer, key, expiry, and expiration-job boundaries before writes',
  },
  {
    id: 'new-batch-expiry-future',
    search: 'if (expiresAt.getTime() <= Date.now()) {',
    replacement: 'if (false) {',
    test: 'rejects invalid integer, key, expiry, and expiration-job boundaries before writes',
  },
]) {
  add({
    group: 'input',
    file: ledgerFile,
    test:
      mutation.test ??
      'rejects invalid integer, key, expiry, and expiration-job boundaries before writes',
    ...mutation,
  })
}

for (const mutation of [
  {
    id: 'expiration-cutoff-finite',
    search: 'if (!Number.isFinite(cutoff.getTime())) {',
    replacement: 'if (false) {',
  },
  {
    id: 'expiration-limit-safe-integer',
    search:
      'if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_EXPIRATION_BATCHES) {',
    replacement: 'if (maxBatches < 1 || maxBatches > MAX_EXPIRATION_BATCHES) {',
  },
  {
    id: 'expiration-limit-positive',
    search:
      'if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_EXPIRATION_BATCHES) {',
    replacement: 'if (!Number.isSafeInteger(maxBatches) || maxBatches > MAX_EXPIRATION_BATCHES) {',
  },
  {
    id: 'expiration-limit-maximum',
    search:
      'if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_EXPIRATION_BATCHES) {',
    replacement: 'if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) {',
  },
]) {
  add({
    group: 'expiration-input',
    file: ledgerFile,
    test: 'rejects invalid integer, key, expiry, and expiration-job boundaries before writes',
    ...mutation,
  })
}

for (const [id, occurrence] of [
  ['earn-system-actor', 1],
  ['transition-system-actor', 2],
  ['expiration-system-actor', 3],
]) {
  add({
    group: 'actor',
    id,
    file: ledgerFile,
    search: '  assertSystemActor(req)\n',
    replacement: '',
    occurrence,
    expectedOccurrences: 3,
    test: 'enforces system, customer-owner, and read ownership at every service callpoint',
  })
}
for (const [id, occurrence] of [
  ['redemption-owner', 1],
  ['quota-consumption-owner', 2],
]) {
  add({
    group: 'actor',
    id,
    file: ledgerFile,
    search: '  assertCustomerActor(req, input.customerId)\n',
    replacement: '',
    occurrence,
    expectedOccurrences: 2,
    test: 'enforces system, customer-owner, and read ownership at every service callpoint',
  })
}
for (const [id, occurrence] of [
  ['balance-read-owner', 1],
  ['batch-read-owner', 2],
  ['quota-read-owner', 3],
]) {
  add({
    group: 'actor',
    id,
    file: ledgerFile,
    search: '  if (req.user) assertCustomerActor(req, ',
    replacement: '  if (false) assertCustomerActor(req, ',
    occurrence,
    expectedOccurrences: 3,
    test: 'enforces system, customer-owner, and read ownership at every service callpoint',
  })
}

for (const mutation of [
  {
    id: 'earn-a3-purchase',
    search: "  await assertCustomerAccountCapability(req, input.customerId, 'purchase')\n",
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'reads order owner and status independently and applies A3 before earning',
  },
  {
    id: 'confirm-a3-purchase',
    search: "      await assertCustomerAccountCapability(req, discovered.customerId, 'purchase')\n",
    test: 'applies A3 independently before a pending reward can become available',
  },
  {
    id: 'redemption-a3-purchase',
    search: "  await assertCustomerAccountCapability(req, input.customerId, 'purchase')\n",
    occurrence: 2,
    expectedOccurrences: 2,
    test: 'applies A3 independently at points redemption and tool-quota consumption callpoints',
  },
  {
    id: 'quota-a3-login',
    search: "  await assertCustomerAccountCapability(req, input.customerId, 'login')\n",
    test: 'applies A3 independently at points redemption and tool-quota consumption callpoints',
  },
]) {
  add({ group: 'a3', file: ledgerFile, replacement: '', ...mutation })
}

for (const mutation of [
  {
    id: 'order-exists',
    search:
      "  if (!row) throw new AppError('POINTS_SOURCE_ORDER_NOT_FOUND', '米币来源订单不存在', 409)\n",
    replacement:
      "  if (!row) throw new AppError('POINTS_SOURCE_ORDER_STATE_INVALID', 'mutated', 409)\n",
  },
  {
    id: 'order-owner',
    search: '  if (String(row.customer_id) !== String(input.customerId)) {\n',
    replacement: '  if (false) {\n',
  },
  {
    id: 'order-status',
    search: '  if (row.status !== input.status) {\n',
    replacement: '  if (false) {\n',
  },
]) {
  add({
    group: 'order-fact',
    file: ledgerFile,
    test: 'reads order owner and status independently and applies A3 before earning',
    ...mutation,
  })
}

for (const [id, search, replacement] of [
  ['batch-account', '    String(batch.accountId) !== String(input.accountId) ||\n', ''],
  ['batch-customer', '    String(batch.customerId) !== String(input.customerId) ||\n', ''],
  ['batch-order', '    String(batch.sourceOrderId) !== String(input.sourceOrderId) ||\n', ''],
  ['batch-points', '    batch.points !== input.points ||\n', ''],
  ['batch-expiry', '    batch.expiresAt.getTime() !== input.expiresAt.getTime()\n', '    false\n'],
]) {
  add({
    group: 'earning-idempotency',
    id,
    file: ledgerFile,
    search,
    replacement,
    test: 'rejects every earning idempotency dimension mismatch without another entry',
  })
}

for (const [id, search, replacement = ''] of [
  ['points-account-version', '    account.ledgerVersion !== maxSequence ||\n'],
  ['points-contiguous-sequence', '    entryCount !== maxSequence ||\n'],
  ['points-held-allocation', '    heldIn !== allocated ||\n'],
  ['points-consumed-allocation', '    consumed !== allocated ||\n'],
  ['points-batch-links', '    databaseInteger(row.invalid_batches) !== 0n ||\n'],
  ['points-entry-links', '    databaseInteger(row.invalid_ledger_links) !== 0n ||\n'],
  ['points-allocation-links', '    databaseInteger(row.invalid_allocation_links) !== 0n ||\n'],
  ['points-lifecycle', '    databaseInteger(row.invalid_lifecycles) !== 0n\n', '    false\n'],
  ['points-nonnegative', '    Object.values(balance).some((value) => value < 0n)\n', '    false\n'],
]) {
  add({
    group: 'points-derived',
    id,
    file: ledgerFile,
    search,
    replacement,
    test: 'fails closed for every independently corruptible points-balance invariant',
  })
}

for (const [id, search, replacement = ''] of [
  [
    'quota-account-version',
    '    account.quotaLedgerVersion !== databaseInteger(row.max_sequence) ||\n',
  ],
  [
    'quota-contiguous-sequence',
    '    databaseInteger(row.entry_count) !== databaseInteger(row.max_sequence) ||\n',
  ],
  ['quota-links', '    databaseInteger(row.invalid_links) !== 0n ||\n'],
  ['quota-nonnegative', '    balance < 0n\n', '    false\n'],
]) {
  add({
    group: 'quota-derived',
    id,
    file: ledgerFile,
    search,
    replacement,
    test: 'fails closed for each quota-ledger invariant and scopes balance to the requested target',
  })
}

for (const [id, search, replacement = ''] of [
  ['batch-pending-total', '    lifecycle.pending !== batch.points ||\n'],
  [
    'batch-available-terminal',
    '    (lifecycle.available !== 0n && lifecycle.available !== batch.points) ||\n',
  ],
  [
    'batch-reversed-terminal',
    '    (lifecycle.reversed !== 0n && lifecycle.reversed !== batch.points) ||\n',
  ],
  ['batch-terminal-exclusive', '    lifecycle.available + lifecycle.reversed > batch.points ||\n'],
  ['batch-allocation-links', '    databaseInteger(row.invalid_allocation_links) !== 0n ||\n'],
  ['batch-held-allocation', '    allocated !== lifecycle.held ||\n'],
  ['batch-consumed-allocation', '    allocated !== lifecycle.consumed ||\n'],
  [
    'batch-consumed-expired-ceiling',
    '    lifecycle.consumed + lifecycle.expired > lifecycle.available\n',
    '    false\n',
  ],
]) {
  add({
    group: 'batch-lifecycle',
    id,
    file: ledgerFile,
    search,
    replacement,
    test: 'fails closed for independently corrupted batch lifecycle and ownership links',
    ...(id === 'batch-allocation-links' ? { occurrence: 2, expectedOccurrences: 2 } : {}),
  })
}
add({
  group: 'batch-lifecycle',
  id: 'batch-entry-links',
  file: ledgerFile,
  search: '  if (!row || databaseInteger(row.invalid_links) !== 0n) throw pointsUnavailable()\n',
  replacement: '  if (!row) throw pointsUnavailable()\n',
  test: 'fails closed for independently corrupted batch lifecycle and ownership links',
})

for (const [id, search, replacement = ''] of [
  ['redemption-customer', '    String(row.customer_id) !== String(input.account.customerId) ||\n'],
  ['redemption-account', '    String(row.account_id) !== String(input.account.accountId) ||\n'],
  ['redemption-target', '    row.target !== input.target ||\n'],
  ['redemption-points', '    databaseInteger(row.points_cost) !== input.pointsCost ||\n'],
  [
    'redemption-quota',
    '    databaseInteger(row.quota_units) !== input.quotaUnits\n',
    '    false\n',
  ],
]) {
  add({
    group: 'redemption-idempotency',
    id,
    file: ledgerFile,
    search,
    replacement,
    test:
      id === 'redemption-account'
        ? 'rejects global earning and redemption key reuse across otherwise valid customer facts'
        : 'rejects every redemption and quota-use idempotency dimension mismatch',
  })
}

for (const [id, search, replacement = ''] of [
  [
    'quota-use-customer',
    '        String(existingRow.customer_id) !== String(account.customerId) ||\n',
  ],
  [
    'quota-use-account',
    '        String(existingRow.account_id) !== String(account.accountId) ||\n',
  ],
  ['quota-use-target', '        existingRow.target !== target ||\n'],
  ['quota-use-type', "        existingRow.entry_type !== 'consume' ||\n"],
  [
    'quota-use-units',
    '        databaseInteger(existingRow.quota_units) !== quotaUnits\n',
    '        false\n',
  ],
]) {
  add({
    group: 'quota-idempotency',
    id,
    file: ledgerFile,
    search,
    replacement,
    test:
      id === 'quota-use-account'
        ? 'rejects global earning and redemption key reuse across otherwise valid customer facts'
        : 'rejects every redemption and quota-use idempotency dimension mismatch',
  })
}

for (const [id, search, replacement, test] of [
  [
    'replay-allocation-total',
    "  if (allocated !== input.pointsCost) throw pointsUnavailable('米币兑换分配不完整')\n",
    '',
    'fails closed when replay facts are reassigned across otherwise valid equal-cost batches',
  ],
  [
    'replay-held-count',
    '    databaseInteger(evidenceRow.held_count) !== BigInt(allocations.length) ||\n',
    '',
    'fails closed when a redemption replay lacks exact held, consumed, or quota evidence',
  ],
  [
    'replay-consumed-count',
    '    databaseInteger(evidenceRow.consumed_count) !== BigInt(allocations.length) ||\n',
    '',
    'fails closed when a redemption replay lacks exact held, consumed, or quota evidence',
  ],
  [
    'replay-fact-links',
    '    databaseInteger(evidenceRow.invalid_facts) !== 0n ||\n',
    '',
    'fails closed when replay facts are reassigned across otherwise valid equal-cost batches',
  ],
  [
    'replay-one-quota-entry',
    '    quota.rows?.length !== 1 ||\n',
    '',
    'fails closed when a redemption replay lacks exact held, consumed, or quota evidence',
  ],
  [
    'replay-quota-units',
    '    databaseInteger(quotaRow.quota_units) !== input.quotaUnits\n',
    '    false\n',
    'fails closed when a redemption replay lacks exact held, consumed, or quota evidence',
  ],
]) {
  add({ group: 'redemption-replay', id, file: ledgerFile, search, replacement, test })
}

add({
  group: 'target',
  id: 'approved-tool-targets-only',
  file: ledgerFile,
  search: '  if ((TOOL_QUOTA_TARGETS as readonly string[]).includes(value)) {\n',
  replacement: '  if (true) {\n',
  test: 'grants only approved tool quotas and atomically prevents quota over-consumption',
})

add({
  group: 'allocation',
  id: 'allocation-minimum',
  file: ledgerFile,
  search:
    '    const allocated = batch.remaining < remainingCost ? batch.remaining : remainingCost\n',
  replacement:
    '    const allocated = batch.remaining > remainingCost ? batch.remaining : remainingCost\n',
  test: 'allocates equal-expiry spendable batches by ascending id and replays identically',
})

for (const [id, occurrence, test] of [
  [
    'earn-entry-type-pending',
    1,
    'keeps a succeeded-order reward pending and unavailable until confirmation',
  ],
  [
    'transition-entry-type',
    2,
    'lets exactly one of N concurrent confirmations append the available transition',
  ],
  [
    'redemption-held-entry',
    3,
    'recomputes remaining expirable points from cross-batch allocations',
  ],
  [
    'redemption-consumed-entry',
    4,
    'recomputes remaining expirable points from cross-batch allocations',
  ],
  [
    'expiration-entry',
    5,
    'expires only by appending an expired entry and leaves every historical row unchanged',
  ],
]) {
  const replacements = [
    "      entryType: 'available',\n",
    "      entryType: 'pending',\n",
    "        entryType: 'consumed',\n",
    "        entryType: 'held',\n",
    "      entryType: 'available',\n",
  ]
  add({
    group: 'entry-callpoint',
    id,
    file: ledgerFile,
    search:
      occurrence === 2
        ? '      entryType: input.target,\n'
        : occurrence === 1
          ? "      entryType: 'pending',\n"
          : occurrence === 3
            ? "        entryType: 'held',\n"
            : occurrence === 4
              ? "        entryType: 'consumed',\n"
              : "      entryType: 'expired',\n",
    replacement: replacements[occurrence - 1],
    test,
  })
}
for (const [id, search, replacement, test] of [
  [
    'quota-grant-entry',
    "      entryType: 'grant',\n",
    "      entryType: 'consume',\n",
    'grants only approved tool quotas and atomically prevents quota over-consumption',
  ],
  [
    'quota-consume-entry',
    "      entryType: 'consume',\n",
    "      entryType: 'grant',\n",
    'grants only approved tool quotas and atomically prevents quota over-consumption',
  ],
]) {
  add({ group: 'entry-callpoint', id, file: ledgerFile, search, replacement, test })
}

for (const [id, occurrence] of [
  ['earn-audit', 1],
  ['transition-audit', 2],
  ['redemption-audit', 3],
  ['quota-consumption-audit', 4],
  ['expiration-audit', 5],
]) {
  add({
    group: 'audit',
    id,
    file: ledgerFile,
    search: '    await recordAuditEvent(req, {\n',
    replacement: '    await Promise.resolve(); void ({\n',
    occurrence,
    expectedOccurrences: 5,
    test: 'records audit evidence at every points mutation callpoint',
  })
}

for (const [id, search, replacement, test] of [
  [
    'append-only-update-hook',
    "        if (operation === 'update') throw new AppError(code, message, 409)\n",
    '        if (false) throw new AppError(code, message, 409)\n',
    'rejects updates and deletes at every append-only collection hook callpoint',
  ],
  [
    'append-only-delete-hook',
    '        throw new AppError(code, message, 409)\n',
    '        return undefined\n',
    'rejects updates and deletes at every append-only collection hook callpoint',
  ],
  [
    'generic-create-denied',
    '  create: deny,\n',
    '  create: () => true,\n',
    'denies generic creates, updates, and deletes at every points collection callpoint',
  ],
  [
    'generic-delete-denied',
    '  delete: deny,\n',
    '  delete: () => true,\n',
    'denies generic creates, updates, and deletes at every points collection callpoint',
  ],
  [
    'generic-update-denied',
    '  update: deny,\n',
    '  update: () => true,\n',
    'denies generic creates, updates, and deletes at every points collection callpoint',
  ],
  [
    'owner-scoped-read',
    "  read: ownOrSystem('customer'),\n",
    '  read: () => true,\n',
    'scopes every points collection read to the customer owner',
  ],
  [
    'approved-target-enum',
    "export const TOOL_QUOTA_TARGETS = ['advanced_whois', 'bulk_query', 'ai_domain_analysis'] as const\n",
    "export const TOOL_QUOTA_TARGETS = ['advanced_whois', 'bulk_query', 'ai_domain_analysis', 'tier_acceleration'] as const\n",
    'exposes only the three approved tool-quota redemption targets',
  ],
]) {
  add({
    group: 'collection',
    id,
    file: collectionFile,
    search,
    replacement,
    testFile: unitTest,
    test,
  })
}

for (const [id, search, replacement] of [
  ['job-exclusive', '    exclusive: true,\n', '    exclusive: false,\n'],
  [
    'job-key',
    "    key: () => 'points:expiration',\n",
    "    key: () => 'points:expiration:mutated',\n",
  ],
  ['job-supersedes', '    supersedes: true,\n', '    supersedes: false,\n'],
  ['job-queue', "  queue: 'background',\n", "  queue: 'commerce',\n"],
  ['job-retries', '  retries: 0,\n', '  retries: 1,\n'],
  [
    'job-schedule-cron',
    "  schedule: [{ cron: '0 0 * * * *', queue: 'background' }],\n",
    "  schedule: [{ cron: '1 0 * * * *', queue: 'background' }],\n",
  ],
  [
    'job-schedule-queue',
    "  schedule: [{ cron: '0 0 * * * *', queue: 'background' }],\n",
    "  schedule: [{ cron: '0 0 * * * *', queue: 'commerce' }],\n",
  ],
]) {
  add({
    group: 'job',
    id,
    file: jobFile,
    search,
    replacement,
    testFile: unitTest,
    test: 'runs points expiration with one exclusive background concurrency key and no retries',
    ...(id === 'job-exclusive' || id === 'job-supersedes'
      ? { occurrence: 14, expectedOccurrences: 15 }
      : id === 'job-queue'
        ? { occurrence: 10, expectedOccurrences: 10 }
        : id === 'job-retries'
          ? { occurrence: 15, expectedOccurrences: 17 }
          : {}),
  })
}

const redundantPredicatesRemovedFromProduction = new Set([
  'batch-customer',
  'points-held-allocation',
  'points-consumed-allocation',
  'points-nonnegative',
  'batch-pending-total',
  'batch-available-terminal',
  'batch-reversed-terminal',
  'batch-terminal-exclusive',
  'batch-allocation-links',
  'batch-held-allocation',
  'batch-consumed-allocation',
  'batch-consumed-expired-ceiling',
  'batch-entry-links',
  'redemption-customer',
  'quota-use-customer',
  'quota-use-type',
])
const activeMutations = mutations.filter(
  (mutation) => !redundantPredicatesRemovedFromProduction.has(mutation.id),
)

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

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of activeMutations) {
    process.stdout.write(`${mutation.group}\t${mutation.id}\t${mutation.file}\t${mutation.test}\n`)
  }
  process.stdout.write(`TOTAL\t${activeMutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of activeMutations) {
    const source = readFileSync(`${webRoot}/${mutation.file}`, 'utf8')
    const found = occurrences(source, mutation.search)
    const expected = mutation.expectedOccurrences ?? 1
    if (found !== expected) {
      invalid += 1
      process.stderr.write(
        `MUTATION SETUP FAILED ${mutation.id}: expected ${expected} occurrences, found ${found}\n`,
      )
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
  process.stderr.write(`No D9-E-2 decision mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const path = `${webRoot}/${mutation.file}`
  const original = readFileSync(path, 'utf8')
  const found = occurrences(original, mutation.search)
  const expected = mutation.expectedOccurrences ?? 1
  if (found !== expected) {
    process.stderr.write(
      `MUTATION SETUP FAILED ${mutation.id}: expected ${expected} occurrences, found ${found}\n`,
    )
    failed = true
    continue
  }
  const mutated = replaceOccurrence(
    original,
    mutation.search,
    mutation.replacement,
    mutation.occurrence ?? 1,
  )
  let result
  try {
    writeFileSync(path, mutated, 'utf8')
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
        mutation.testFile ?? integrationTest,
        '-t',
        mutation.test,
      ],
      { cwd: repositoryRoot, encoding: 'utf8', env: process.env },
    )
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const assertion = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(
    `TEST ${mutation.testFile ?? integrationTest} :: ${mutation.test}\nRAW_FAILURE ${assertion}\n`,
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

process.stdout.write(`\nD9E2_DECISION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
