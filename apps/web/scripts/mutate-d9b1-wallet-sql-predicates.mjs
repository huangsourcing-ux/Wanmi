import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const ledgerFile = 'src/services/wallet/ledger.ts'
const testFile = 'tests/integration/d9b1-wallet-ledger.integration.test.ts'

const mutations = [
  {
    id: 'derived-last-posted-account',
    predicate: 'last posted snapshot WHERE account_id = requested account',
    search: '        WHERE account_id = ${account.accountId}\n',
    replacement: '        WHERE TRUE\n',
    occurrence: 1,
    expectedOccurrences: 3,
    test: 'scopes a balance read to exactly the requested account',
  },
  {
    id: 'derived-last-held-account',
    predicate: 'last held snapshot WHERE account_id = requested account',
    search: '        WHERE account_id = ${account.accountId}\n',
    replacement: '        WHERE TRUE\n',
    occurrence: 2,
    expectedOccurrences: 3,
    test: 'scopes a balance read to exactly the requested account',
  },
  {
    id: 'derived-aggregate-account',
    predicate: 'aggregate entries WHERE account_id = requested account',
    search: '    FROM wallet_entries\n    WHERE account_id = ${account.accountId}\n',
    replacement: '    FROM wallet_entries\n    WHERE TRUE\n',
    test: 'scopes a balance read to exactly the requested account',
  },
  {
    id: 'exclusive-lock-account-id',
    predicate: 'FOR UPDATE account lookup WHERE id = requested account',
    search: '    WHERE id = ${accountId}\n    FOR UPDATE\n',
    replacement: '    WHERE TRUE\n    FOR UPDATE\n',
    test: 'scopes the credit ledger-version UPDATE to exactly the requested account',
  },
  {
    id: 'shared-lock-account-id',
    predicate: 'FOR SHARE account lookup WHERE id = requested account',
    search: '    WHERE id = ${accountId}\n    FOR SHARE\n',
    replacement: '    WHERE TRUE\n    FOR SHARE\n',
    test: 'scopes a balance read to exactly the requested account',
  },
  {
    id: 'closure-balance-customer-scope',
    predicate: 'account-closure balance lookup WHERE customer_id = requested customer',
    search: '      FROM wallet_accounts\n      WHERE customer_id = ${ownerId}\n      FOR SHARE\n',
    replacement: '      FROM wallet_accounts\n      WHERE TRUE\n      FOR SHARE\n',
    test: 'scopes the account-closure balance check and fails closed on an inconsistent ledger',
  },
  {
    id: 'transaction-lookup-key',
    predicate: 'wallet transaction lookup WHERE transaction_key = key',
    search: '    FROM wallet_transactions\n    WHERE transaction_key = ${key}\n',
    replacement: '    FROM wallet_transactions\n    WHERE TRUE\n',
    test: 'derives capture and release balances and rejects conflicting idempotency reuse',
  },
  {
    id: 'account-create-conflict-target',
    predicate: 'account INSERT ON CONFLICT customer and currency',
    search: '      ON CONFLICT (customer_id, currency) DO NOTHING\n',
    replacement: '',
    test: 'concurrently creates exactly one CNY wallet account for one customer',
  },
  {
    id: 'account-existing-customer',
    predicate: 'existing account SELECT WHERE customer_id = customer',
    search: "      WHERE customer_id = ${customerId}\n        AND currency = 'CNY'\n",
    replacement: "      WHERE currency = 'CNY'\n",
    test: 'concurrently creates exactly one CNY wallet account for one customer',
  },
  {
    id: 'account-existing-currency',
    predicate: "existing account SELECT AND currency = 'CNY'",
    search: "        AND currency = 'CNY'\n",
    replacement: '        AND FALSE\n',
    test: 'concurrently creates exactly one CNY wallet account for one customer',
  },
  {
    id: 'credit-update-account-id',
    predicate: 'credit ledger-version UPDATE WHERE id = locked account',
    search:
      '    UPDATE wallet_accounts\n    SET ledger_version = ledger_version + 1, updated_at = NOW()\n    WHERE id = ${account.accountId}\n    RETURNING ledger_version\n',
    replacement:
      '    UPDATE wallet_accounts\n    SET ledger_version = ledger_version + 1, updated_at = NOW()\n    WHERE TRUE\n    RETURNING ledger_version\n',
    test: 'scopes the credit ledger-version UPDATE to exactly the requested account',
  },
  {
    id: 'hold-update-account-id',
    predicate: 'hold reservation UPDATE WHERE id = locked account',
    search: '    WHERE id = ${account.accountId}\n      AND ${delta.toString()} <= (\n',
    replacement: '    WHERE TRUE\n      AND ${delta.toString()} <= (\n',
    test: 'scopes the hold ledger-version UPDATE to exactly the requested account',
  },
  {
    id: 'hold-update-available-ceiling',
    predicate: 'hold reservation AND delta <= ledger-derived available balance',
    search: '      AND ${delta.toString()} <= (\n',
    replacement: '      AND 0 <= (\n',
    test: 'allows exactly the funded number of N concurrent holds without exceeding available balance',
  },
  {
    id: 'hold-update-entry-account-scope',
    predicate: 'hold available subquery WHERE account_id = locked account',
    search: '        WHERE account_id = ${account.accountId}\n',
    replacement: '        WHERE TRUE\n',
    occurrence: 3,
    expectedOccurrences: 3,
    test: 'derives the hold ceiling from only the requested account entries',
  },
  {
    id: 'transaction-insert-idempotency-conflict',
    predicate: 'transaction INSERT ON CONFLICT transaction_key DO NOTHING',
    search: '    ON CONFLICT (transaction_key) DO NOTHING\n',
    replacement: '',
    test: 'makes a global idempotency key credit exactly one of two concurrent accounts',
  },
  {
    id: 'settlement-update-transaction-key',
    predicate: 'settlement UPDATE WHERE transaction_key = requested key',
    search: "      WHERE transaction_key = ${key}\n        AND status = 'held'\n",
    replacement: "      WHERE status = 'held'\n        AND status = 'held'\n",
    test: 'settles only the hold selected by its transaction key',
  },
  {
    id: 'settlement-update-held-status',
    predicate: "settlement UPDATE AND status = 'held'",
    search: "        AND status = 'held'\n",
    replacement: '        AND TRUE\n',
    expectedOccurrences: 1,
    test: 'lets exactly one concurrent capture or release settle the same hold',
  },
  {
    id: 'settlement-evidence-transaction-id',
    predicate: 'settlement evidence transaction_id = claimed transaction',
    search: '          WHERE transaction_id = wallet_transactions.id\n',
    replacement: '          WHERE TRUE\n',
    test: 'requires hold ledger evidence before an atomic settlement claim',
  },
  {
    id: 'settlement-evidence-entry-type',
    predicate: "settlement evidence entry_type = 'hold'",
    search: "            AND entry_type = 'hold'\n",
    replacement: '            AND TRUE\n',
    test: 'requires the atomic settlement evidence to be a hold entry',
  },
  {
    id: 'settlement-evidence-amount',
    predicate: 'settlement evidence amount_fen = transaction amount_fen',
    search: '            AND amount_fen = wallet_transactions.amount_fen\n',
    replacement: '            AND TRUE\n',
    test: 'requires hold evidence amount to match the claimed transaction amount',
  },
].map((mutation) => ({ file: ledgerFile, ...mutation }))

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
    process.stdout.write(`${mutation.id}\t${mutation.predicate}\t${mutation.test}\n`)
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
const selected = selectors.length
  ? mutations.filter((mutation) => selectors.includes(mutation.id))
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-B-1 SQL mutations matched: ${selectors.join(', ')}\n`)
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
        testFile,
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
  const failureLine =
    output.split('\n').find((line) => line.includes('AssertionError:')) ??
    output.split('\n').slice(-8).join(' | ')
  process.stdout.write(`\nMUTATION ${mutation.id}\nPREDICATE ${mutation.predicate}\n`)
  process.stdout.write(`TEST ${mutation.test}\nRAW_FAILURE ${failureLine}\n`)
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

process.stdout.write(`\nD9B1_SQL_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
