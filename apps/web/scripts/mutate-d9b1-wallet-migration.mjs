import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationFile = 'apps/web/migrations/20260817_040409_d9b1_wallet_ledger.ts'
const migrationPath = `${repositoryRoot}/${migrationFile}`

const mutations = []
const add = (mutation) => mutations.push({ file: migrationFile, ...mutation })

for (const mutation of [
  {
    id: 'account-ledger-version-integer',
    search: '\t\t  "ledger_version" = trunc("ledger_version") AND\n',
    label: 'wallet account integer ledger version',
  },
  {
    id: 'account-ledger-version-nonnegative',
    search: '\t\t  "ledger_version" >= 0 AND\n',
    label: 'wallet account nonnegative ledger version',
  },
  {
    id: 'account-ledger-version-safe-maximum',
    search: '\t\t  "ledger_version" <= 9007199254740991\n',
    replacement: '      TRUE\n',
    label: 'wallet account safe ledger version maximum',
  },
  {
    id: 'transaction-amount-integer',
    search: '\t\t  "amount_fen" = trunc("amount_fen") AND\n',
    occurrence: 1,
    expectedOccurrences: 2,
    label: 'wallet transaction integer amount',
  },
  {
    id: 'transaction-amount-positive',
    search: '\t\t  "amount_fen" >= 1 AND\n',
    occurrence: 1,
    expectedOccurrences: 2,
    label: 'wallet transaction positive amount',
  },
  {
    id: 'transaction-amount-safe-maximum',
    search: '\t\t  "amount_fen" <= 9007199254740991\n',
    replacement: '      TRUE\n',
    label: 'wallet transaction safe amount maximum',
  },
  {
    id: 'entry-amount-integer',
    search: '\t\t  "amount_fen" = trunc("amount_fen") AND\n',
    occurrence: 2,
    expectedOccurrences: 2,
    label: 'wallet entry integer amount',
  },
  {
    id: 'entry-amount-positive',
    search: '\t\t  "amount_fen" >= 1 AND\n',
    occurrence: 2,
    expectedOccurrences: 2,
    label: 'wallet entry positive amount',
  },
  {
    id: 'entry-amount-safe-maximum',
    search: '\t\t  "amount_fen" <= 9007199254740991 AND\n',
    label: 'wallet entry safe amount maximum',
  },
  {
    id: 'entry-sequence-integer',
    search: '\t\t  "ledger_sequence" = trunc("ledger_sequence") AND\n',
    label: 'wallet entry integer sequence',
  },
  {
    id: 'entry-sequence-positive',
    search: '\t\t  "ledger_sequence" >= 1 AND\n',
    label: 'wallet entry positive sequence',
  },
  {
    id: 'entry-sequence-safe-maximum',
    search: '\t\t  "ledger_sequence" <= 9007199254740991 AND\n',
    label: 'wallet entry safe sequence maximum',
  },
  {
    id: 'entry-posted-snapshot-integer',
    search: '\t\t  "posted_balance_after_fen" = trunc("posted_balance_after_fen") AND\n',
    label: 'wallet entry integer posted snapshot',
  },
  {
    id: 'entry-posted-snapshot-safe-maximum',
    search: '\t\t  "posted_balance_after_fen" <= 9007199254740991 AND\n',
    label: 'wallet entry safe posted snapshot maximum',
  },
  {
    id: 'entry-held-snapshot-integer',
    search: '\t\t  "held_balance_after_fen" = trunc("held_balance_after_fen") AND\n',
    label: 'wallet entry integer held snapshot',
  },
  {
    id: 'entry-held-snapshot-nonnegative',
    search: '\t\t  "held_balance_after_fen" >= 0 AND\n',
    label: 'wallet entry nonnegative held snapshot',
  },
  {
    id: 'entry-held-does-not-exceed-posted',
    search: '\t  "held_balance_after_fen" <= "posted_balance_after_fen"\n',
    replacement: '      TRUE\n',
    label: 'wallet held snapshot cannot exceed posted snapshot',
  },
]) {
  add({ group: 'check', replacement: '', ...mutation })
}

const stateConstraint = {
  credit: `\t  ("type" = 'credit' AND "status" = 'posted' AND "resolved_at" IS NULL) OR\n`,
  held: `\t  ("type" = 'hold' AND "status" = 'held' AND "resolved_at" IS NULL) OR\n`,
  terminal: `\t  ("type" = 'hold' AND "status" IN ('captured', 'released') AND "resolved_at" IS NOT NULL)\n`,
}
for (const mutation of [
  {
    id: 'credit-state-type',
    search: stateConstraint.credit,
    replacement: `      ("status" = 'posted' AND "resolved_at" IS NULL) OR\n`,
    label: 'credit branch requires credit type',
  },
  {
    id: 'credit-state-posted',
    search: stateConstraint.credit,
    replacement: `      ("type" = 'credit' AND "resolved_at" IS NULL) OR\n`,
    label: 'credit branch requires posted status',
  },
  {
    id: 'credit-state-unresolved',
    search: stateConstraint.credit,
    replacement: `      ("type" = 'credit' AND "status" = 'posted') OR\n`,
    label: 'credit branch requires unresolved timestamp',
  },
  {
    id: 'held-state-type',
    search: stateConstraint.held,
    replacement: `      ("status" = 'held' AND "resolved_at" IS NULL) OR\n`,
    label: 'held branch requires hold type',
  },
  {
    id: 'held-state-held',
    search: stateConstraint.held,
    replacement: `      ("type" = 'hold' AND "resolved_at" IS NULL) OR\n`,
    label: 'held branch requires held status',
  },
  {
    id: 'held-state-unresolved',
    search: stateConstraint.held,
    replacement: `      ("type" = 'hold' AND "status" = 'held') OR\n`,
    label: 'held branch requires unresolved timestamp',
  },
  {
    id: 'terminal-state-type',
    search: stateConstraint.terminal,
    replacement: `      ("status" IN ('captured', 'released') AND "resolved_at" IS NOT NULL)\n`,
    label: 'terminal branch requires hold type',
  },
  {
    id: 'terminal-state-status',
    search: stateConstraint.terminal,
    replacement: `      ("type" = 'hold' AND "resolved_at" IS NOT NULL)\n`,
    label: 'terminal branch requires a terminal status',
  },
  {
    id: 'terminal-state-resolved',
    search: stateConstraint.terminal,
    replacement: `      ("type" = 'hold' AND "status" IN ('captured', 'released'))\n`,
    label: 'terminal branch requires a resolution timestamp',
  },
]) {
  add({ group: 'state', ...mutation })
}

for (const mutation of [
  {
    id: 'account-customer-currency-unique',
    search:
      '  CREATE UNIQUE INDEX "customer_currency_idx" ON "wallet_accounts" USING btree ("customer_id","currency");\n',
    label: 'one CNY account per customer',
  },
  {
    id: 'transaction-key-unique',
    search:
      '  CREATE UNIQUE INDEX "wallet_transactions_transaction_key_idx" ON "wallet_transactions" USING btree ("transaction_key");\n',
    label: 'global transaction idempotency key',
  },
  {
    id: 'entry-key-unique',
    search:
      '  CREATE UNIQUE INDEX "wallet_entries_entry_key_idx" ON "wallet_entries" USING btree ("entry_key");\n',
    label: 'global wallet entry key',
  },
  {
    id: 'account-sequence-unique',
    search:
      '  CREATE UNIQUE INDEX "account_ledgerSequence_idx" ON "wallet_entries" USING btree ("account_id","ledger_sequence");\n',
    label: 'account ledger sequence uniqueness',
  },
]) {
  add({ group: 'unique', replacement: '', ...mutation })
}

for (const mutation of [
  {
    id: 'account-customer-fk',
    search:
      '  ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n',
    label: 'wallet account customer foreign key',
  },
  {
    id: 'transaction-customer-fk',
    search:
      '  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n',
    label: 'wallet transaction customer foreign key',
  },
  {
    id: 'transaction-account-fk',
    search:
      '  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_account_id_wallet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE set null ON UPDATE no action;\n',
    label: 'wallet transaction account foreign key',
  },
  {
    id: 'entry-customer-fk',
    search:
      '  ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n',
    label: 'wallet entry customer foreign key',
  },
  {
    id: 'entry-account-fk',
    search:
      '  ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_account_id_wallet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE set null ON UPDATE no action;\n',
    label: 'wallet entry account foreign key',
  },
  {
    id: 'entry-transaction-fk',
    search:
      '  ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE set null ON UPDATE no action;\n',
    label: 'wallet entry transaction foreign key',
  },
]) {
  add({ group: 'foreign-key', replacement: '', ...mutation })
}

add({
  group: 'down-cleanup',
  id: 'scheduled-wallet-job-delete-before-enum-shrink',
  search:
    '   DELETE FROM "payload_jobs" WHERE "workflow_slug"::text = \'walletLedgerConsistencyCheck\';',
  replacement: '   SELECT 1;',
  label: 'wallet workflow rows are removed before the workflow enum is narrowed',
})

add({
  group: 'down-compatibility',
  id: 'scheduled-wallet-job-text-comparison-after-historical-enum-shrink',
  search: 'WHERE "workflow_slug"::text = \'walletLedgerConsistencyCheck\'',
  replacement: 'WHERE "workflow_slug" = \'walletLedgerConsistencyCheck\'',
  label: 'wallet workflow cleanup tolerates an enum already narrowed by a historical round trip',
})

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

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.group}\t${mutation.id}\t${mutation.label}\n`)
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
  process.stderr.write(`No D9-B-1 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let killed = 0
let failed = false
for (const mutation of selected) {
  const original = readFileSync(migrationPath, 'utf8')
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
    writeFileSync(migrationPath, mutated, 'utf8')
    result = spawnSync('node', ['scripts/verify-d9b1-wallet-migration.mjs'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })
  } finally {
    writeFileSync(migrationPath, original, 'utf8')
  }
  const output = `${result?.stdout ?? ''}${result?.stderr ?? ''}`
  const behaviorFailure =
    output.includes('accepted an invalid write') ||
    (mutation.group === 'down-cleanup' && output.includes('migration down left')) ||
    (mutation.group.startsWith('down-') &&
      output.includes('invalid input value for enum enum_payload_jobs_workflow_slug'))
  const failureLine =
    output
      .split('\n')
      .find(
        (line) =>
          line.includes('accepted an invalid write') ||
          line.includes('migration down left') ||
          line.includes('invalid input value for enum enum_payload_jobs_workflow_slug'),
      ) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(`BEHAVIOR ${mutation.label}\nRAW_FAILURE ${failureLine}\n`)
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

process.stdout.write(`\nD9B1_MIGRATION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
