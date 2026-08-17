import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const integrationTest = 'tests/integration/d9b1-wallet-ledger.integration.test.ts'
const unitTest = 'tests/unit/d9b1-wallet-collections.test.ts'
const ledgerFile = 'src/services/wallet/ledger.ts'
const invariantFile = 'src/services/wallet/invariants.ts'
const accountClosureFile = 'src/services/auth/account-closure.ts'
const accountClosureTest = 'tests/integration/d9a-account-closure.integration.test.ts'
const collectionFile = 'src/collections/wallet.ts'
const jobFile = 'src/jobs/config.ts'
const mutations = []
const add = (mutation) => mutations.push(mutation)

for (const mutation of [
  {
    id: 'amount-requires-safe-integer',
    search:
      "typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : undefined",
    replacement: "typeof value === 'bigint' ? value : BigInt(Math.trunc(value))",
  },
  {
    id: 'amount-requires-positive',
    search: 'amount === undefined || amount <= 0n || amount > MAX_SAFE_MONEY',
    replacement: 'amount === undefined || amount > MAX_SAFE_MONEY',
  },
  {
    id: 'amount-requires-safe-maximum',
    search: 'amount === undefined || amount <= 0n || amount > MAX_SAFE_MONEY',
    replacement: 'amount === undefined || amount <= 0n',
  },
  {
    id: 'transaction-key-requires-nonblank',
    search: '!normalized || normalized.length > TRANSACTION_KEY_MAX_LENGTH',
    replacement: 'normalized.length > TRANSACTION_KEY_MAX_LENGTH',
  },
  {
    id: 'transaction-key-requires-maximum',
    search: '!normalized || normalized.length > TRANSACTION_KEY_MAX_LENGTH',
    replacement: '!normalized',
  },
]) {
  add({
    group: 'input',
    file: ledgerFile,
    test: 'rejects every invalid integer-fen and idempotency-key boundary before ledger writes',
    ...mutation,
  })
}

for (const mutation of [
  {
    id: 'derived-account-version',
    search: '    account.ledgerVersion !== maxSequence ||\n',
    test: 'fails closed when account ledgerVersion differs from the maximum entry sequence',
  },
  {
    id: 'derived-contiguous-sequence',
    search: '    entryCount !== maxSequence ||\n',
    test: 'fails closed when entry count differs from the maximum ledger sequence',
  },
  {
    id: 'derived-posted-snapshot',
    search: '    postedBalance !== lastPostedBalance ||\n',
    test: 'fails closed when a posted ending snapshot differs from derived entries',
  },
  {
    id: 'derived-held-snapshot',
    search: '    heldBalance !== lastHeldBalance\n',
    replacement: '    false\n',
    test: 'fails closed when a held ending snapshot differs from derived entries',
  },
]) {
  add({ group: 'derived-guard', file: ledgerFile, replacement: '', ...mutation })
}

for (const mutation of [
  {
    id: 'read-available-posted-minus-held',
    search: '    availableBalance: postedBalance - heldBalance,\n',
    replacement: '    availableBalance: postedBalance + heldBalance,\n',
    occurrence: 1,
    expectedOccurrences: 2,
    test: 'keeps an unknown asynchronous outcome held without appending a terminal entry',
  },
  {
    id: 'credit-result-available-posted-minus-held',
    search: '        availableBalance: postedBalance - account.heldBalance,\n',
    replacement: '        availableBalance: postedBalance + account.heldBalance,\n',
    test: 'returns posted minus held at every credit, hold, and settlement callpoint',
  },
  {
    id: 'hold-result-available-posted-minus-held',
    search: '        availableBalance: account.postedBalance - heldBalance,\n',
    replacement: '        availableBalance: account.postedBalance + heldBalance,\n',
    test: 'returns posted minus held at every credit, hold, and settlement callpoint',
  },
  {
    id: 'settlement-result-available-posted-minus-held',
    search: '        availableBalance: postedBalance - heldBalance,\n',
    replacement: '        availableBalance: postedBalance + heldBalance,\n',
    test: 'returns posted minus held at every credit, hold, and settlement callpoint',
  },
]) {
  add({ group: 'three-state', file: ledgerFile, ...mutation })
}

add({
  group: 'closure-balance',
  id: 'closure-balance-positive-result',
  file: ledgerFile,
  search: '    return balance.availableBalance > 0n\n',
  replacement: '    return false\n',
  test: 'scopes the account-closure balance check and fails closed on an inconsistent ledger',
})
add({
  group: 'closure-balance',
  id: 'closure-balance-derived-callpoint',
  file: ledgerFile,
  search:
    '    const balance = await derivedBalance(database, {\n      accountId: identifier(row.id),\n      customerId: accountCustomerId,\n      ledgerVersion: databaseInteger(row.ledger_version),\n    })\n',
  replacement:
    '    const balance: WalletBalance = { availableBalance: 1n, heldBalance: 0n, postedBalance: 1n }\n',
  test: 'scopes the account-closure balance check and fails closed on an inconsistent ledger',
})
add({
  group: 'closure-balance',
  id: 'closure-balance-service-callpoint',
  file: accountClosureFile,
  search: '  return hasPositiveWalletAvailableBalance(req, customerId)\n',
  replacement: '  return false\n',
  testFile: accountClosureTest,
  test: 'blocks with only positive_balance when the append-only wallet ledger is positive',
})

const accountLockCall = '    const account = await lockWalletAccount(database, '
for (const mutation of [
  {
    id: 'credit-account-lock-callpoint',
    occurrence: 1,
    test: 'serializes distinct concurrent credits on one account without losing an entry',
  },
  {
    id: 'hold-account-lock-callpoint',
    occurrence: 2,
    test: 'allows exactly the funded number of N concurrent holds without exceeding available balance',
  },
  {
    id: 'settlement-account-lock-callpoint',
    occurrence: 3,
    test: 'serializes settlements of distinct holds and preserves both captures',
  },
]) {
  add({
    group: 'callpoint-lock',
    file: ledgerFile,
    search: accountLockCall,
    replacement: '    const account = await shareLockWalletAccount(database, ',
    expectedOccurrences: 3,
    ...mutation,
  })
}

const existingCall = '    const existing = await existingTransaction(database, key)\n'
for (const mutation of [
  {
    id: 'credit-idempotency-lookup-callpoint',
    occurrence: 1,
    test: 'concurrently posts one entry for one credit idempotency key',
  },
  {
    id: 'hold-idempotency-lookup-callpoint',
    occurrence: 2,
    test: 'derives capture and release balances and rejects conflicting idempotency reuse',
  },
  {
    id: 'unknown-hold-lookup-callpoint',
    occurrence: 3,
    test: 'keeps an unknown asynchronous outcome held without appending a terminal entry',
  },
]) {
  add({
    group: 'callpoint-lookup',
    file: ledgerFile,
    search: existingCall,
    replacement: '    const existing = undefined\n',
    expectedOccurrences: 3,
    ...mutation,
  })
}
add({
  group: 'callpoint-lookup',
  id: 'settlement-discovery-lookup-callpoint',
  file: ledgerFile,
  search: '    const discovered = await existingTransaction(database, key)\n',
  replacement: '    const discovered = undefined\n',
  test: 'derives capture and release balances and rejects conflicting idempotency reuse',
})
add({
  group: 'callpoint-lookup',
  id: 'settlement-race-reread-callpoint',
  file: ledgerFile,
  search: '      const current = await existingTransaction(database, key)\n',
  replacement: '      const current = undefined\n',
  test: 'makes concurrent retries of the same capture idempotent with one terminal entry',
})

for (const mutation of [
  {
    id: 'idempotency-account-match',
    search: '    String(row.account_id) !== String(input.accountId) ||\n',
  },
  {
    id: 'idempotency-customer-match',
    search: '    String(row.customer_id) !== String(input.customerId) ||\n',
  },
  {
    id: 'idempotency-type-match',
    search: '    row.type !== input.type ||\n',
  },
  {
    id: 'idempotency-amount-match',
    search: '    databaseInteger(row.amount_fen) !== input.amountFen\n',
    replacement: '    false\n',
  },
]) {
  add({
    group: 'idempotency-dimension',
    file: ledgerFile,
    replacement: '',
    test: 'rejects every persisted idempotency dimension mismatch independently',
    ...mutation,
  })
}

add({
  group: 'idempotency-callpoint',
  id: 'credit-matching-guard-callpoint',
  file: ledgerFile,
  search: `      const matched = assertMatchingTransaction(existing, {
        accountId: account.accountId,
        amountFen: amount,
        customerId: account.customerId,
        type: 'credit',
      })
`,
  replacement:
    '      const matched = { status: existing.status as WalletTransactionStatus, transactionId: identifier(existing.id) }\n',
  test: 'rejects every persisted idempotency dimension mismatch independently',
})
add({
  group: 'idempotency-callpoint',
  id: 'hold-matching-guard-callpoint',
  file: ledgerFile,
  search: `      const matched = assertMatchingTransaction(existing, {
        accountId: account.accountId,
        amountFen: amount,
        customerId: account.customerId,
        type: 'hold',
      })
`,
  replacement:
    '      const matched = { status: existing.status as WalletTransactionStatus, transactionId: identifier(existing.id) }\n',
  test: 'rejects every persisted idempotency dimension mismatch independently',
})
add({
  group: 'idempotency-callpoint',
  id: 'credit-retry-must-remain-posted',
  file: ledgerFile,
  search: "      if (matched.status !== 'posted') throw walletUnavailable()\n",
  replacement: '      if (true) throw walletUnavailable()\n',
  test: 'concurrently posts one entry for one credit idempotency key',
})

for (const mutation of [
  {
    id: 'credit-ledger-version-update-callpoint',
    occurrence: 1,
    test: 'serializes distinct concurrent credits on one account without losing an entry',
  },
  {
    id: 'settlement-ledger-version-update-callpoint',
    occurrence: 2,
    test: 'serializes settlements of distinct holds and preserves both captures',
  },
]) {
  add({
    group: 'version-callpoint',
    file: ledgerFile,
    search: '    const ledgerSequence = await incrementLedgerVersion(database, account)\n',
    replacement: '    const ledgerSequence = account.ledgerVersion + 1n\n',
    expectedOccurrences: 2,
    ...mutation,
  })
}
add({
  group: 'version-callpoint',
  id: 'hold-reservation-update-callpoint',
  file: ledgerFile,
  search: '    const ledgerSequence = await reserveLedgerVersion(database, account, amount)\n',
  replacement: '    const ledgerSequence = account.ledgerVersion + 1n\n',
  test: 'allows exactly the funded number of N concurrent holds without exceeding available balance',
})

add({
  group: 'transaction-callpoint',
  id: 'credit-transaction-type-callpoint',
  file: ledgerFile,
  search: "      type: 'credit',\n",
  replacement: "      type: 'hold',\n",
  occurrence: 2,
  expectedOccurrences: 2,
  test: 'concurrently posts one entry for one credit idempotency key',
})
add({
  group: 'transaction-callpoint',
  id: 'hold-transaction-type-callpoint',
  file: ledgerFile,
  search: "      type: 'hold',\n",
  replacement: "      type: 'credit',\n",
  occurrence: 2,
  expectedOccurrences: 2,
  test: 'allows exactly the funded number of N concurrent holds without exceeding available balance',
})
for (const mutation of [
  {
    id: 'credit-entry-append-callpoint',
    search: "      entryType: 'credit',\n",
    replacement: "      entryType: 'hold',\n",
    test: 'concurrently posts one entry for one credit idempotency key',
  },
  {
    id: 'hold-entry-append-callpoint',
    search: "      entryType: 'hold',\n",
    replacement: "      entryType: 'credit',\n",
    test: 'allows exactly the funded number of N concurrent holds without exceeding available balance',
  },
  {
    id: 'settlement-entry-append-callpoint',
    search: "      entryType: captured ? 'capture' : 'release',\n",
    replacement: "      entryType: captured ? 'release' : 'capture',\n",
    test: 'derives capture and release balances and rejects conflicting idempotency reuse',
  },
]) {
  add({ group: 'entry-callpoint', file: ledgerFile, ...mutation })
}

for (const mutation of [
  {
    id: 'settlement-requires-existing-transaction',
    search:
      "    if (!discovered) throw new AppError('WALLET_HOLD_NOT_FOUND', '钱包冻结记录不存在', 409)\n",
    replacement: '    if (false) throw walletUnavailable()\n',
    test: 'fails closed for missing capture, release, and unknown hold keys',
  },
  {
    id: 'settlement-requires-hold-type',
    search: "    if (discovered.type !== 'hold') throw walletUnavailable()\n",
    replacement: '    if (false) throw walletUnavailable()\n',
    test: 'fails closed at each settlement type, ownership, and held-amount decision point',
  },
  {
    id: 'settlement-retry-target-status',
    search: '    if (discovered.status === input.targetStatus) {\n',
    replacement: '    if (false) {\n',
    test: 'derives capture and release balances and rejects conflicting idempotency reuse',
  },
  {
    id: 'settlement-retry-owner',
    search:
      '      if (String(account.customerId) !== String(discovered.customer_id)) throw walletUnavailable()\n',
    replacement: '',
    test: 'fails closed at each settlement type, ownership, and held-amount decision point',
  },
  {
    id: 'settlement-requires-held-status',
    search: "    if (discovered.status !== 'held') {\n",
    replacement: '    if (true) {\n',
    test: 'derives capture and release balances and rejects conflicting idempotency reuse',
  },
  {
    id: 'settlement-race-target-status',
    search: '      if (current?.status === input.targetStatus) {\n',
    replacement: '      if (false) {\n',
    test: 'makes concurrent retries of the same capture idempotent with one terminal entry',
  },
  {
    id: 'settlement-race-owner',
    search:
      '        if (String(account.customerId) !== String(current.customer_id)) throw walletUnavailable()\n',
    replacement: '        if (true) throw walletUnavailable()\n',
    test: 'makes concurrent retries of the same capture idempotent with one terminal entry',
  },
  {
    id: 'settlement-race-opposite-terminal-status',
    search: "      if (current?.status === 'captured' || current?.status === 'released') {\n",
    replacement: '      if (false) {\n',
    test: 'lets exactly one concurrent capture or release settle the same hold',
  },
  {
    id: 'settlement-claimed-owner',
    search:
      '    if (String(account.customerId) !== String(claimed.customer_id)) throw walletUnavailable()\n',
    replacement: '',
    test: 'fails closed at each settlement type, ownership, and held-amount decision point',
  },
  {
    id: 'settlement-held-amount-ceiling',
    search: '    if (amount > account.heldBalance) throw walletUnavailable()\n',
    replacement: '    if (true) throw walletUnavailable()\n',
    test: 'derives capture and release balances and rejects conflicting idempotency reuse',
  },
  {
    id: 'settlement-capture-versus-release',
    search: "    const captured = input.targetStatus === 'captured'\n",
    replacement: "    const captured = input.targetStatus !== 'captured'\n",
    test: 'derives capture and release balances and rejects conflicting idempotency reuse',
  },
]) {
  add({ group: 'settlement-guard', file: ledgerFile, ...mutation })
}

for (const mutation of [
  {
    id: 'resolve-confirmed-routes-to-capture',
    search:
      "  if (input.outcome === 'confirmed') return captureWalletHold(req, input.transactionKey)\n",
    replacement: '  if (false) return captureWalletHold(req, input.transactionKey)\n',
    test: 'routes confirmed and failed outcomes to capture and release while unknown remains held',
  },
  {
    id: 'resolve-failed-routes-to-release',
    search:
      "  if (input.outcome === 'failed') return releaseWalletHold(req, input.transactionKey)\n",
    replacement: '  if (false) return releaseWalletHold(req, input.transactionKey)\n',
    test: 'routes confirmed and failed outcomes to capture and release while unknown remains held',
  },
  {
    id: 'resolve-rejects-unrecognized-outcome',
    search: "  if (input.outcome !== 'unknown') throw walletUnavailable()\n",
    replacement: '',
    test: 'fails closed when unknown outcome ownership or transaction type is inconsistent',
  },
  {
    id: 'unknown-requires-existing-transaction',
    search:
      "    if (!existing) throw new AppError('WALLET_HOLD_NOT_FOUND', '钱包冻结记录不存在', 409)\n",
    replacement: '    if (false) throw walletUnavailable()\n',
    test: 'fails closed for missing capture, release, and unknown hold keys',
  },
  {
    id: 'unknown-requires-hold-type',
    search: "    if (existing.type !== 'hold') throw walletUnavailable()\n",
    replacement: '    if (false) throw walletUnavailable()\n',
    test: 'fails closed when unknown outcome ownership or transaction type is inconsistent',
  },
  {
    id: 'unknown-requires-account-owner',
    search:
      '    if (String(account.customerId) !== String(existing.customer_id)) throw walletUnavailable()\n',
    replacement: '',
    test: 'fails closed when unknown outcome ownership or transaction type is inconsistent',
  },
]) {
  add({ group: 'resolve-guard', file: ledgerFile, ...mutation })
}

for (const mutation of [
  {
    id: 'entry-update-hook',
    search: "        if (operation === 'update') {\n",
    replacement: '        if (false) {\n',
  },
  {
    id: 'entry-delete-hook',
    search:
      "      () => {\n        throw new AppError('WALLET_ENTRY_APPEND_ONLY', '钱包账本只允许追加', 409)\n      },\n",
    replacement: '      () => undefined,\n',
  },
]) {
  add({
    group: 'append-only',
    file: collectionFile,
    testFile: unitTest,
    test: 'rejects wallet entry updates and deletes in collection hooks',
    ...mutation,
  })
}

const accessLine =
  "  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },\n"
for (const [collectionIndex, collectionName] of [
  [1, 'accounts'],
  [2, 'transactions'],
  [3, 'entries'],
]) {
  for (const operation of ['create', 'delete', 'update']) {
    add({
      group: 'write-access',
      id: `${collectionName}-${operation}-deny-callpoint`,
      file: collectionFile,
      search: accessLine,
      replacement: accessLine.replace(`${operation}: deny`, `${operation}: () => true`),
      occurrence: collectionIndex,
      expectedOccurrences: 3,
      testFile: unitTest,
      test: 'denies generic creates, updates, and deletes at every wallet collection callpoint',
    })
  }
  add({
    group: 'read-access',
    id: `${collectionName}-owner-read-callpoint`,
    file: collectionFile,
    search: accessLine,
    replacement: accessLine.replace("read: ownOrSystem('customer')", 'read: deny'),
    occurrence: collectionIndex,
    expectedOccurrences: 3,
    testFile: unitTest,
    test: 'scopes every wallet collection read to the customer owner',
  })
}

for (const mutation of [
  {
    id: 'job-exclusive',
    search: '    exclusive: true,\n',
    replacement: '    exclusive: false,\n',
    expectedOccurrences: 11,
    occurrence: 10,
  },
  {
    id: 'job-key',
    search: "    key: () => 'wallet:ledger-consistency',\n",
    replacement: "    key: () => 'wallet:mutated',\n",
  },
  {
    id: 'job-supersedes',
    search: '    supersedes: true,\n',
    replacement: '    supersedes: false,\n',
    expectedOccurrences: 11,
    occurrence: 10,
  },
  {
    id: 'job-background-queue',
    search:
      "  queue: 'background',\n  retries: 0,\n  schedule: [{ cron: '0 30 2 * * *', queue: 'background' }],\n",
    replacement:
      "  queue: 'publishing',\n  retries: 0,\n  schedule: [{ cron: '0 30 2 * * *', queue: 'background' }],\n",
  },
  {
    id: 'job-no-retry',
    search: "  retries: 0,\n  schedule: [{ cron: '0 30 2 * * *', queue: 'background' }],\n",
    replacement: "  retries: 1,\n  schedule: [{ cron: '0 30 2 * * *', queue: 'background' }],\n",
  },
  {
    id: 'job-schedule-cron',
    search: "  schedule: [{ cron: '0 30 2 * * *', queue: 'background' }],\n",
    replacement: "  schedule: [{ cron: '0 31 2 * * *', queue: 'background' }],\n",
  },
  {
    id: 'job-schedule-background-queue',
    search: "  schedule: [{ cron: '0 30 2 * * *', queue: 'background' }],\n",
    replacement: "  schedule: [{ cron: '0 30 2 * * *', queue: 'publishing' }],\n",
  },
]) {
  add({
    group: 'job-config',
    file: jobFile,
    testFile: unitTest,
    test: 'runs the invariant checker exclusively on the background queue without retries',
    ...mutation,
  })
}
add({
  group: 'job-callpoint',
  id: 'job-invokes-ledger-check',
  file: jobFile,
  search: '    await runWalletLedgerConsistencyCheck(req)\n',
  replacement: '    return\n',
  test: 'detects a manufactured opening-credit-debit-ending mismatch and appends audit evidence',
})

for (const mutation of [
  {
    id: 'invariant-sequence',
    search: '      if (sequence !== state.expectedSequence) {\n',
    replacement: '      if (false) {\n',
  },
  {
    id: 'invariant-entry-customer',
    search: '      if (id(row.customer_id) !== state.customerId) {\n',
    replacement: '      if (false) {\n',
  },
  {
    id: 'invariant-posted-equation',
    search: '      if (integer(row.posted_balance_after_fen) !== state.postedBalance) {\n',
    replacement: '      if (false) {\n',
  },
  {
    id: 'invariant-held-equation',
    search: '      if (integer(row.held_balance_after_fen) !== state.heldBalance) {\n',
    replacement: '      if (false) {\n',
  },
  {
    id: 'invariant-account-version',
    search: '      if (state.ledgerVersion !== state.expectedSequence - 1n) {\n',
    replacement: '      if (false) {\n',
  },
  {
    id: 'invariant-transaction-customer',
    search: '      if (accountState.get(accountId)?.customerId !== customerId) {\n',
    replacement: '      if (false) {\n',
  },
  {
    id: 'invariant-entry-account-link',
    search: '            id(entry.account_id) !== accountId ||\n',
    replacement: '',
  },
  {
    id: 'invariant-entry-customer-link',
    search: '            id(entry.customer_id) !== customerId ||\n',
    replacement: '',
  },
  {
    id: 'invariant-entry-amount-link',
    search: '            integer(entry.amount_fen) !== amount,\n',
    replacement: '            false,\n',
  },
]) {
  add({
    group: 'invariant-decision',
    file: invariantFile,
    test: 'reports every independently corruptible ledger invariant against the affected account',
    ...mutation,
  })
}
for (const mutation of [
  {
    id: 'invariant-history-state-map',
    search: '        !expectedEntryTypes ||\n',
    replacement: '        true ||\n',
    test: 'detects a manufactured opening-credit-debit-ending mismatch and appends audit evidence',
  },
  {
    id: 'invariant-history-length',
    search: '        entryTypes.length !== expectedEntryTypes.length ||\n',
    replacement: '',
    test: 'reports every independently corruptible ledger invariant against the affected account',
  },
  {
    id: 'invariant-history-order-and-type',
    search:
      '        entryTypes.some((entryType, index) => entryType !== expectedEntryTypes[index])\n',
    replacement: '        false\n',
    test: 'reports every independently corruptible ledger invariant against the affected account',
  },
  {
    id: 'invariant-healthy-early-return',
    search: '  if (inspection.discrepancies.length === 0) return inspection.result\n',
    replacement: '  if (true) return inspection.result\n',
    test: 'detects a manufactured opening-credit-debit-ending mismatch and appends audit evidence',
  },
  {
    id: 'invariant-audit-evidence',
    search: '  await recordAuditEvent(req, {\n',
    replacement: '  await Promise.resolve(); void ({\n',
    test: 'detects a manufactured opening-credit-debit-ending mismatch and appends audit evidence',
  },
  {
    id: 'invariant-failure-result',
    search:
      "  throw new AppError('WALLET_LEDGER_INVARIANT_VIOLATION', '钱包账本一致性检查发现差异', 500)\n",
    replacement: '  return inspection.result\n',
    test: 'detects a manufactured opening-credit-debit-ending mismatch and appends audit evidence',
  },
  {
    id: 'invariant-query-error-fail-closed',
    search: '    throw walletCheckUnavailable()\n',
    replacement: '    throw error\n',
    test: 'fails closed when the consistency task cannot query every required ledger relation',
  },
]) {
  add({ group: 'invariant-task', file: invariantFile, ...mutation })
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

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.group}\t${mutation.id}\t${mutation.file}\t${mutation.test}\n`)
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
const selected = selectors.length
  ? mutations.filter(
      (mutation) => selectors.includes(mutation.group) || selectors.includes(mutation.id),
    )
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-B-1 decision mutations matched: ${selectors.join(', ')}\n`)
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
  const behaviorFailure = output.includes('AssertionError:')
  const failureLine = output.split('\n').find((line) => line.includes('AssertionError:')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(`TEST ${mutation.testFile ?? integrationTest} :: ${mutation.test}\n`)
  process.stdout.write(`RAW_FAILURE ${failureLine}\n`)
  if (result?.status !== 0 && behaviorFailure) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}

process.stdout.write(`\nD9B1_DECISION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
