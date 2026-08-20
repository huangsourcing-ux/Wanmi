import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationPath = `${repositoryRoot}/apps/web/migrations/20260819_104757_d9b6_wallet_reconciliation.ts`
const verifier = 'scripts/verify-d9b6-wallet-reconciliation-migration.mjs'
const mutations = []
const add = (group, id, predicate, changes) =>
  mutations.push({ changes: Array.isArray(changes) ? changes : [changes], group, id, predicate })
const edit = (search, replacement, options = {}) => ({ search, replacement, ...options })

add(
  'migration-enum',
  'wallet-kind',
  'the existing reconciliation kind enum gains wallet',
  edit(`   ALTER TYPE "public"."enum_reconciliations_kind" ADD VALUE 'wallet';\n`, ''),
)
add(
  'migration-enum',
  'wallet-balance-ledger',
  'the existing reconciliation ledger enum gains wallet_balance',
  edit(`  ALTER TYPE "public"."enum_reconciliations_ledger" ADD VALUE 'wallet_balance';\n`, ''),
)
add(
  'cache-default',
  'posted-cache-zero-default',
  'new wallet account posted cache snapshots start at zero',
  edit('numeric DEFAULT 0 NOT NULL;', 'numeric DEFAULT 1 NOT NULL;', {
    expectedOccurrences: 2,
    occurrence: 1,
  }),
)
add(
  'cache-default',
  'held-cache-zero-default',
  'new wallet account held cache snapshots start at zero',
  edit('numeric DEFAULT 0 NOT NULL;', 'numeric DEFAULT 1 NOT NULL;', {
    expectedOccurrences: 2,
    occurrence: 2,
  }),
)
add(
  'cache-backfill',
  'posted-backfill-wallet-entries',
  'posted cache backfill reads the append-only wallet entries',
  edit('      WHERE account_id = account.id\n', '      WHERE false AND account_id = account.id\n', {
    expectedOccurrences: 2,
    occurrence: 1,
  }),
)
add(
  'cache-backfill',
  'posted-credit-sign',
  'wallet credit entries add to the posted cache snapshot',
  edit(
    "          WHEN entry_type = 'credit' THEN amount_fen\n",
    "          WHEN entry_type = 'credit' THEN 0\n",
  ),
)
add(
  'cache-backfill',
  'posted-debit-sign',
  'wallet capture and recovery entries subtract from the posted cache snapshot',
  edit(
    "          WHEN entry_type IN ('capture', 'recovery') THEN -amount_fen\n",
    "          WHEN entry_type IN ('capture', 'recovery') THEN 0\n",
  ),
)
add(
  'cache-backfill',
  'held-backfill-wallet-entries',
  'held cache backfill reads the append-only wallet entries',
  edit('      WHERE account_id = account.id\n', '      WHERE false AND account_id = account.id\n', {
    expectedOccurrences: 2,
    occurrence: 2,
  }),
)
add(
  'cache-backfill',
  'held-hold-sign',
  'wallet hold entries add to the held cache snapshot',
  edit(
    "          WHEN entry_type = 'hold' THEN amount_fen\n",
    "          WHEN entry_type = 'hold' THEN amount_fen + 1\n",
  ),
)
add(
  'cache-backfill',
  'held-settlement-sign',
  'wallet capture and release entries subtract from the held cache snapshot',
  edit(
    "          WHEN entry_type IN ('capture', 'release') THEN -amount_fen\n",
    "          WHEN entry_type IN ('capture', 'release') THEN 0\n",
  ),
)
add(
  'cache-constraint',
  'posted-cache-integer',
  'posted cache values remain integer fen',
  edit('    posted_balance_cache_fen = trunc(posted_balance_cache_fen)\n', '    TRUE\n'),
)
add(
  'cache-constraint',
  'posted-cache-lower-bound',
  'posted cache values remain above the JavaScript safe-integer lower bound',
  edit(
    '    AND posted_balance_cache_fen BETWEEN -9007199254740991 AND 9007199254740991\n',
    '    AND posted_balance_cache_fen <= 9007199254740991\n',
  ),
)
add(
  'cache-constraint',
  'posted-cache-upper-bound',
  'posted cache values remain below the JavaScript safe-integer upper bound',
  edit(
    '    AND posted_balance_cache_fen BETWEEN -9007199254740991 AND 9007199254740991\n',
    '    AND posted_balance_cache_fen >= -9007199254740991\n',
  ),
)
add(
  'cache-constraint',
  'held-cache-integer',
  'held cache values remain integer fen',
  edit('    held_balance_cache_fen = trunc(held_balance_cache_fen)\n', '    TRUE\n'),
)
add(
  'cache-constraint',
  'held-cache-nonnegative',
  'held cache values cannot become negative',
  edit(
    '    AND held_balance_cache_fen BETWEEN 0 AND 9007199254740991\n',
    '    AND held_balance_cache_fen <= 9007199254740991\n',
  ),
)
add(
  'cache-constraint',
  'held-cache-upper-bound',
  'held cache values remain below the JavaScript safe-integer upper bound',
  edit(
    '    AND held_balance_cache_fen BETWEEN 0 AND 9007199254740991\n',
    '    AND held_balance_cache_fen >= 0\n',
  ),
)
add(
  'review-link',
  'wallet-account-foreign-key',
  'manual review wallet-account links cannot dangle',
  edit(
    '  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_wallet_account_id_wallet_accounts_id_fk" FOREIGN KEY ("wallet_account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE set null ON UPDATE no action;\n',
    '',
  ),
)
add(
  'review-link',
  'reconciliation-foreign-key',
  'manual review reconciliation links cannot dangle',
  edit(
    '  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE set null ON UPDATE no action;\n',
    '',
  ),
)
add(
  'review-link',
  'wallet-account-index',
  'wallet-linked manual reviews remain indexed for operations queries',
  edit(
    '  CREATE INDEX "manual_reviews_wallet_account_idx" ON "manual_reviews" USING btree ("wallet_account_id");\n',
    '',
  ),
)
add(
  'review-link',
  'one-review-per-reconciliation',
  'one reconciliation difference can create at most one manual review',
  edit(
    '  CREATE UNIQUE INDEX "manual_reviews_reconciliation_idx" ON "manual_reviews" USING btree ("reconciliation_id");',
    '  CREATE INDEX "manual_reviews_reconciliation_idx" ON "manual_reviews" USING btree ("reconciliation_id");',
  ),
)
add(
  'migration-down',
  'fourth-ledger-facts-block-down',
  'down migration refuses to erase the meaning of persisted fourth-ledger facts',
  [
    edit(
      `  CREATE TYPE "public"."enum_reconciliations_kind" AS ENUM('wechat', 'westdigital', 'three_way');\n`,
      `  CREATE TYPE "public"."enum_reconciliations_kind" AS ENUM('wechat', 'westdigital', 'three_way', 'wallet');\n`,
    ),
    edit(
      `  CREATE TYPE "public"."enum_reconciliations_ledger" AS ENUM('wechat_funds', 'westdigital_prepaid', 'internal_orders');\n`,
      `  CREATE TYPE "public"."enum_reconciliations_ledger" AS ENUM('wechat_funds', 'westdigital_prepaid', 'internal_orders', 'wallet_balance');\n`,
    ),
  ],
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

function mutateSource(source, mutation) {
  let result = source
  for (const change of mutation.changes) {
    const found = occurrences(result, change.search)
    const expected = change.expectedOccurrences ?? 1
    if (found !== expected) {
      throw new Error(
        `expected ${expected} occurrences of ${JSON.stringify(change.search)}, found ${found}`,
      )
    }
    result = replaceOccurrence(result, change.search, change.replacement, change.occurrence ?? 1)
  }
  return result
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.group}/${mutation.id}\t${mutation.predicate}\t${verifier}\n`)
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of mutations) {
    try {
      mutateSource(readFileSync(migrationPath, 'utf8'), mutation)
    } catch (error) {
      invalid += 1
      process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    }
  }
  process.stdout.write(`VALIDATED\t${mutations.length - invalid}/${mutations.length}\n`)
  if (invalid) process.exitCode = 1
  process.exit()
}

const selected = selectors.length
  ? mutations.filter(
      (mutation) => selectors.includes(mutation.id) || selectors.includes(mutation.group),
    )
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-B-6 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const original = readFileSync(migrationPath, 'utf8')
  let mutated
  try {
    mutated = mutateSource(original, mutation)
  } catch (error) {
    process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    failed = true
    continue
  }
  let result
  try {
    writeFileSync(migrationPath, mutated, 'utf8')
    result = spawnSync('node', [verifier], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })
  } finally {
    writeFileSync(migrationPath, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const failure = output.split('\n').find((line) => line.includes('AssertionError')) ?? ''
  process.stdout.write(
    `\nMUTATION ${mutation.group}/${mutation.id}\nPREDICATE ${mutation.predicate}\nTEST ${verifier}\nRAW_FAILURE ${failure}\n`,
  )
  if (result?.status !== 0 && output.includes('AssertionError')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(`RAW_OUTPUT ${output.split('\n').slice(-35).join('\n')}\n`)
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}
process.stdout.write(
  `\nD9B6_MIGRATION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
