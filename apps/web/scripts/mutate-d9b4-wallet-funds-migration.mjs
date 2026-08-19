import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationFile = 'apps/web/migrations/20260819_012641_d9b4_wallet_funds_policy.ts'
const migrationPath = `${repositoryRoot}/${migrationFile}`
const verifier = 'scripts/verify-d9b4-wallet-funds-migration.mjs'
const releasePolicyPath = `${repositoryRoot}/deploy/release-policy.json`
const releaseManifestPath = `${repositoryRoot}/deploy/release-manifest.example.json`
const releaseVerifier = 'scripts/verify-d9b4-release-metadata.mjs'
const mutations = []

const add = (group, id, label, search, replacement, options = {}) =>
  mutations.push({ group, id, label, replacement, search, ...options })

for (const [id, label, search, replacement] of [
  [
    'recovery-type-enum',
    'payment recovery reasons remain provider_refund or dispute only',
    `AS ENUM('provider_refund', 'dispute');`,
    `AS ENUM('provider_refund', 'dispute', 'mutant');`,
  ],
  [
    'currency-enum',
    'P1 wallet currency remains CNY only',
    `AS ENUM('CNY');`,
    `AS ENUM('CNY', 'USD');`,
  ],
  [
    'expiration-enum',
    'P1 balances remain non-expiring only',
    `AS ENUM('never');`,
    `AS ENUM('never', 'daily');`,
  ],
  [
    'timezone-enum',
    'the financial day remains Asia/Shanghai only',
    `AS ENUM('Asia/Shanghai');`,
    `AS ENUM('Asia/Shanghai', 'UTC');`,
  ],
  [
    'statement-calculation-enum',
    'the statement calculation remains the approved ledger formula only',
    `AS ENUM('ledger_entries_start_inclusive_end_exclusive');`,
    `AS ENUM('ledger_entries_start_inclusive_end_exclusive', 'mutant');`,
  ],
  [
    'transaction-recovery-enum',
    'wallet transactions support the recovery fact',
    `ALTER TYPE "public"."enum_wallet_transactions_type" ADD VALUE 'recovery';`,
    `ALTER TYPE "public"."enum_wallet_transactions_type" ADD VALUE 'recovery_mutant';`,
  ],
  [
    'entry-recovery-enum',
    'wallet entries support the recovery fact',
    `ALTER TYPE "public"."enum_wallet_entries_entry_type" ADD VALUE 'recovery';`,
    `ALTER TYPE "public"."enum_wallet_entries_entry_type" ADD VALUE 'recovery_mutant';`,
  ],
  [
    'provider-target-enum',
    'provider operations can target a wallet top-up',
    `ALTER TYPE "public"."enum_provider_operations_target_type" ADD VALUE 'wallet_top_up';`,
    `ALTER TYPE "public"."enum_provider_operations_target_type" ADD VALUE 'wallet_top_up_mutant';`,
  ],
]) {
  add('enum', id, label, search, replacement)
}

const trueCondition = (group, id, label, search, options = {}) =>
  add(group, id, label, search, 'TRUE', options)

for (const [id, label, search, replacement] of [
  [
    'policy-version-integer',
    'policy version is an integer',
    `"version" = trunc("version")`,
    'TRUE',
  ],
  [
    'policy-version-positive',
    'policy version is positive',
    `"version" BETWEEN 1 AND 9007199254740991`,
    `"version" <= 9007199254740991`,
  ],
  [
    'policy-version-safe',
    'policy version stays within the JavaScript safe range',
    `"version" BETWEEN 1 AND 9007199254740991`,
    `"version" >= 1`,
  ],
  ['policy-schema-version', 'policy schema version remains one', `"schema_version" = 1`, 'TRUE'],
  [
    'top-up-limit-integer',
    'single top-up limit is an integer fen value',
    `"single_top_up_limit_fen" = trunc("single_top_up_limit_fen")`,
    'TRUE',
  ],
  [
    'top-up-limit-positive',
    'single top-up limit is positive',
    `"single_top_up_limit_fen" >= 1`,
    'TRUE',
  ],
  [
    'account-limit-integer',
    'account balance limit is an integer fen value',
    `"account_balance_limit_fen" = trunc("account_balance_limit_fen")`,
    'TRUE',
  ],
  [
    'account-limit-safe',
    'account balance limit stays within the safe range',
    `"account_balance_limit_fen" <= 9007199254740991`,
    'TRUE',
  ],
  [
    'spend-limit-integer',
    'single spend limit is an integer fen value',
    `"single_spend_limit_fen" = trunc("single_spend_limit_fen")`,
    'TRUE',
  ],
  [
    'spend-limit-positive',
    'single spend limit is positive',
    `"single_spend_limit_fen" >= 1`,
    'TRUE',
  ],
  [
    'top-up-account-coupling',
    'single top-up limit cannot exceed the account limit',
    `"single_top_up_limit_fen" <= "account_balance_limit_fen"`,
    'TRUE',
  ],
  [
    'spend-account-coupling',
    'single spend limit cannot exceed the account limit',
    `"single_spend_limit_fen" <= "account_balance_limit_fen"`,
    'TRUE',
  ],
  [
    'policy-actor-nonblank',
    'policy change actor is nonblank',
    `length(trim("changed_by")) > 0`,
    'TRUE',
  ],
  [
    'policy-note-length',
    'policy change note is meaningful',
    `length(trim("change_note")) >= 8`,
    'TRUE',
  ],
]) {
  add('policy-values', id, label, search, replacement)
}

add(
  'policy-head',
  'head-singleton-key',
  'the policy head has one fixed singleton key',
  `"singleton_key" = 'cny-wallet-funds-policy'`,
  'TRUE',
)

trueCondition(
  'recovery-ledger',
  'recovery-transaction-posted',
  'a recovery transaction is posted',
  `"status"::text = 'posted'`,
)
trueCondition(
  'recovery-ledger',
  'recovery-transaction-unresolved',
  'a recovery transaction has no resolution timestamp',
  `"resolved_at" IS NULL`,
  { expectedOccurrences: 4, occurrence: 1 },
)
add(
  'recovery-ledger',
  'negative-posted-safe-minimum',
  'a recovered negative posted balance remains in the safe range',
  `"posted_balance_after_fen" BETWEEN -9007199254740991 AND 9007199254740991`,
  `"posted_balance_after_fen" <= 9007199254740991`,
)
trueCondition(
  'recovery-ledger',
  'positive-posted-covers-held',
  'a positive posted balance covers all held funds',
  `"held_balance_after_fen" <= "posted_balance_after_fen"`,
  { expectedOccurrences: 2, occurrence: 1 },
)

add(
  'refund-target',
  'exactly-one-refund-target',
  'a refund references exactly one order kind',
  `("order_id" IS NOT NULL)::integer + ("wallet_top_up_order_id" IS NOT NULL)::integer = 1`,
  'TRUE',
)

for (const [id, label, search, replacement] of [
  [
    'refund-amount-integer',
    'a top-up refund amount is an integer fen value',
    `"refunded_amount_fen" = trunc("refunded_amount_fen")`,
    'TRUE',
  ],
  [
    'refund-amount-positive',
    'a top-up refund amount is positive',
    `"refunded_amount_fen" BETWEEN 1 AND "amount_fen"`,
    `"refunded_amount_fen" <= "amount_fen"`,
  ],
  [
    'refund-amount-ceiling',
    'a top-up refund does not exceed its frozen amount',
    `"refunded_amount_fen" BETWEEN 1 AND "amount_fen"`,
    `"refunded_amount_fen" >= 1`,
  ],
]) {
  add('refund-amount', id, label, search, replacement)
}

const stateFields = [
  ['refund-amount', `"refunded_amount_fen" IS NULL`, 7],
  ['recovery-key', `"payment_recovery_key" IS NULL`, 6],
  ['recovery-type', `"payment_recovery_type" IS NULL`, 6],
  ['recovered-time', `"payment_recovered_at" IS NULL`, 7],
]
for (const [state, occurrence] of [
  ['created', 1],
  ['payment-pending', 2],
  ['provider-confirmed', 3],
  ['credited', 4],
]) {
  for (const [field, search, expectedOccurrences] of stateFields) {
    trueCondition(
      'top-up-state',
      `${state}-${field}-absent`,
      `${state} excludes ${field} evidence`,
      search,
      { expectedOccurrences, occurrence },
    )
  }
}

for (const [id, label, search, expectedOccurrences, occurrence] of [
  [
    'ordinary-pending-refund-number',
    'ordinary pending refund has a refund number',
    `"original_refund_number" IS NOT NULL`,
    4,
    1,
  ],
  [
    'ordinary-pending-refund-amount',
    'ordinary pending refund has an amount',
    `"refunded_amount_fen" IS NOT NULL`,
    3,
    1,
  ],
  [
    'ordinary-pending-no-recovery-key',
    'ordinary pending refund excludes a recovery key',
    `"payment_recovery_key" IS NULL`,
    6,
    5,
  ],
  [
    'ordinary-pending-no-recovery-type',
    'ordinary pending refund excludes a recovery type',
    `"payment_recovery_type" IS NULL`,
    6,
    5,
  ],
  [
    'ordinary-pending-no-recovered-time',
    'ordinary pending refund excludes a recovered timestamp',
    `"payment_recovered_at" IS NULL`,
    7,
    5,
  ],
  [
    'ordinary-pending-no-refunded-time',
    'ordinary pending refund excludes a refunded timestamp',
    `"refunded_at" IS NULL`,
    10,
    5,
  ],
  [
    'recovery-pending-no-refund-number',
    'pending recovery excludes an ordinary refund number',
    `"original_refund_number" IS NULL`,
    10,
    5,
  ],
  [
    'recovery-pending-no-refund-amount',
    'pending recovery excludes an ordinary refund amount',
    `"refunded_amount_fen" IS NULL`,
    7,
    5,
  ],
  [
    'recovery-pending-key',
    'pending recovery has a recovery key',
    `"payment_recovery_key" IS NOT NULL`,
    3,
    1,
  ],
  [
    'recovery-pending-type',
    'pending recovery has a recovery type',
    `"payment_recovery_type" IS NOT NULL`,
    3,
    1,
  ],
  [
    'recovery-pending-no-recovered-time',
    'pending recovery excludes a recovered timestamp',
    `"payment_recovered_at" IS NULL`,
    7,
    6,
  ],
  [
    'ordinary-refunded-refund-number',
    'ordinary refunded state has a refund number',
    `"original_refund_number" IS NOT NULL`,
    4,
    2,
  ],
  [
    'ordinary-refunded-refund-amount',
    'ordinary refunded state has an amount',
    `"refunded_amount_fen" IS NOT NULL`,
    3,
    2,
  ],
  [
    'ordinary-refunded-no-recovery-key',
    'ordinary refunded state excludes a recovery key',
    `"payment_recovery_key" IS NULL`,
    6,
    6,
  ],
  [
    'ordinary-refunded-no-recovery-type',
    'ordinary refunded state excludes a recovery type',
    `"payment_recovery_type" IS NULL`,
    6,
    6,
  ],
  [
    'ordinary-refunded-no-recovered-time',
    'ordinary refunded state excludes a recovered timestamp',
    `"payment_recovered_at" IS NULL`,
    7,
    7,
  ],
  [
    'recovery-refunded-no-refund-number',
    'refunded recovery excludes an ordinary refund number',
    `"original_refund_number" IS NULL`,
    10,
    6,
  ],
  [
    'recovery-refunded-no-refund-amount',
    'refunded recovery excludes an ordinary refund amount',
    `"refunded_amount_fen" IS NULL`,
    7,
    6,
  ],
  [
    'recovery-refunded-key',
    'refunded recovery has a recovery key',
    `"payment_recovery_key" IS NOT NULL`,
    3,
    2,
  ],
  [
    'recovery-refunded-type',
    'refunded recovery has a recovery type',
    `"payment_recovery_type" IS NOT NULL`,
    3,
    2,
  ],
  [
    'recovery-refunded-recovered-time',
    'refunded recovery has a recovered timestamp',
    `"payment_recovered_at" IS NOT NULL`,
    2,
    1,
  ],
  [
    'refunded-state-refunded-time',
    'every refunded top-up has a refunded timestamp',
    `"refunded_at" IS NOT NULL`,
    2,
    1,
  ],
]) {
  trueCondition('top-up-state', id, label, search, { expectedOccurrences, occurrence })
}

for (const [id, label, search] of [
  [
    'policy-version-unique',
    'policy versions are globally unique',
    `  CREATE UNIQUE INDEX "wallet_policy_versions_version_idx" ON "wallet_policy_versions" USING btree ("version");\n`,
  ],
  [
    'refund-top-up-unique',
    'one refund fact targets a top-up at most once',
    `  CREATE UNIQUE INDEX "refunds_wallet_top_up_order_idx" ON "refunds" USING btree ("wallet_top_up_order_id");\n`,
  ],
  [
    'payment-recovery-key-unique',
    'a payment recovery key is consumed once',
    `  CREATE UNIQUE INDEX "wallet_top_up_orders_payment_recovery_key_idx" ON "wallet_top_up_orders" USING btree ("payment_recovery_key");\n`,
  ],
  [
    'policy-head-version-fk',
    'the policy head references an existing immutable version',
    `  ALTER TABLE "wallet_policy_heads" ADD CONSTRAINT "wallet_policy_heads_current_version_fk"\n\tFOREIGN KEY ("current_version") REFERENCES "wallet_policy_versions"("version")\n\tDEFERRABLE INITIALLY DEFERRED;\n`,
  ],
  [
    'refund-top-up-fk',
    'a top-up refund references an existing top-up',
    `  ALTER TABLE "refunds" ADD CONSTRAINT "refunds_wallet_top_up_order_id_wallet_top_up_orders_id_fk" FOREIGN KEY ("wallet_top_up_order_id") REFERENCES "public"."wallet_top_up_orders"("id") ON DELETE set null ON UPDATE no action;\n`,
  ],
]) {
  add('index-fk', id, label, search, '')
}

for (const [id, label, search, replacement] of [
  [
    'seed-top-up-limit',
    'the approved top-up limit is seeded',
    '5000000, 10000000, 3000000, true, false,',
    '4999999, 10000000, 3000000, true, false,',
  ],
  [
    'seed-account-limit',
    'the approved account limit is seeded',
    '5000000, 10000000, 3000000, true, false,',
    '5000000, 9999999, 3000000, true, false,',
  ],
  [
    'seed-spend-limit',
    'the approved spend limit is seeded',
    '5000000, 10000000, 3000000, true, false,',
    '5000000, 10000000, 2999999, true, false,',
  ],
  [
    'seed-negative-recovery',
    'negative recovery is enabled by default',
    '5000000, 10000000, 3000000, true, false,',
    '5000000, 10000000, 3000000, false, false,',
  ],
  [
    'seed-emergency-renewal',
    'restricted-account emergency renewal is disabled by default',
    '5000000, 10000000, 3000000, true, false,',
    '5000000, 10000000, 3000000, true, true,',
  ],
]) {
  add('seed', id, label, search, replacement)
}

for (const [id, label, search] of [
  [
    'down-policy-count',
    'down refuses additional policy versions',
    `(SELECT COUNT(*) FROM "wallet_policy_versions") <> 1 OR\n`,
  ],
  [
    'down-policy-seed',
    'down refuses a modified migration seed',
    `       NOT EXISTS (\n         SELECT 1 FROM "wallet_policy_versions"\n         WHERE "version" = 1 AND "changed_by" = 'system:migration'\n       ) OR\n`,
  ],
  [
    'down-refund-facts',
    'down refuses refund facts',
    `       EXISTS (SELECT 1 FROM "refunds" WHERE "wallet_top_up_order_id" IS NOT NULL OR "reason_code" IS NOT NULL) OR\n`,
  ],
  [
    'down-recovery-transactions',
    'down refuses recovery transactions',
    `       EXISTS (SELECT 1 FROM "wallet_transactions" WHERE "type"::text = 'recovery') OR\n`,
  ],
  [
    'down-recovery-entries',
    'down refuses recovery entries',
    `       EXISTS (SELECT 1 FROM "wallet_entries" WHERE "entry_type"::text = 'recovery') OR\n`,
  ],
  [
    'down-provider-operations',
    'down refuses wallet top-up provider facts',
    `       EXISTS (SELECT 1 FROM "provider_operations" WHERE "target_type"::text = 'wallet_top_up') OR\n`,
  ],
  [
    'down-top-up-evidence',
    'down refuses top-up refund or recovery evidence',
    `       EXISTS (\n         SELECT 1 FROM "wallet_top_up_orders"\n         WHERE "refunded_amount_fen" IS NOT NULL OR "payment_recovery_key" IS NOT NULL OR\n               "payment_recovery_type" IS NOT NULL OR "payment_recovered_at" IS NOT NULL\n       )`,
  ],
]) {
  add('down-guard', id, label, search, id === 'down-top-up-evidence' ? '       FALSE' : '')
}

const releasePolicyEntry = `    "20260819_012641_d9b4_wallet_funds_policy": {
      "newCodeCompatibleBeforeUp": true,
      "oldCodeCompatible": true,
      "phase": "expand",
      "reason": "新增版本化钱包资金规则、充值退款与争议追回证据、充值退款目标及 recovery 账本枚举；旧代码可忽略新增结构，新代码必须在迁移完成后启用 D9-B-4 资金场景。",
      "rollback": "retain"
    }`
for (const [id, label, replacement] of [
  [
    'release-policy-name',
    'release policy names the D9-B-4 migration exactly',
    releasePolicyEntry.replace(
      '20260819_012641_d9b4_wallet_funds_policy',
      '20260819_012641_d9b4_wallet_funds_policy_missing',
    ),
  ],
  [
    'release-policy-new-code-order',
    'new code requires the migration before promotion',
    releasePolicyEntry.replace(
      '"newCodeCompatibleBeforeUp": true',
      '"newCodeCompatibleBeforeUp": false',
    ),
  ],
  [
    'release-policy-old-code-compatible',
    'old code tolerates the expand migration',
    releasePolicyEntry.replace('"oldCodeCompatible": true', '"oldCodeCompatible": false'),
  ],
  [
    'release-policy-phase',
    'the additive schema remains expand phase',
    releasePolicyEntry.replace('"phase": "expand"', '"phase": "data"'),
  ],
  [
    'release-policy-reason',
    'release policy keeps the D9-B-4 compatibility reason',
    releasePolicyEntry.replace(
      '新增版本化钱包资金规则、充值退款与争议追回证据、充值退款目标及 recovery 账本枚举；旧代码可忽略新增结构，新代码必须在迁移完成后启用 D9-B-4 资金场景。',
      'D9-B-4',
    ),
  ],
  [
    'release-policy-rollback',
    'expand rollback retains the migration',
    releasePolicyEntry.replace('"rollback": "retain"', '"rollback": "down"'),
  ],
]) {
  add('release-metadata', id, label, releasePolicyEntry, replacement, {
    path: releasePolicyPath,
    verifier: releaseVerifier,
  })
}
add(
  'release-metadata',
  'release-manifest-name',
  'release manifest names the D9-B-4 migration exactly and in order',
  '    "20260819_012641_d9b4_wallet_funds_policy"',
  '    "20260819_012641_d9b4_wallet_funds_policy_missing"',
  { path: releaseManifestPath, verifier: releaseVerifier },
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

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.group}/${mutation.id}\t${mutation.label}\n`)
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of mutations) {
    const source = readFileSync(mutation.path ?? migrationPath, 'utf8')
    const found = occurrences(source, mutation.search)
    const expected = mutation.expectedOccurrences ?? 1
    if (found !== expected) {
      invalid += 1
      process.stderr.write(
        `MUTATION SETUP FAILED ${mutation.id}: expected ${expected} occurrences, found ${found}\n`,
      )
    }
  }
  process.stdout.write(`VALIDATED\t${mutations.length - invalid}/${mutations.length}\n`)
  if (invalid) process.exitCode = 1
  process.exit()
}

const selected = selectors.length
  ? mutations.filter(
      (mutation) => selectors.includes(mutation.group) || selectors.includes(mutation.id),
    )
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-B-4 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let killed = 0
let failed = false
for (const mutation of selected) {
  const path = mutation.path ?? migrationPath
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
    result = spawnSync('node', [mutation.verifier ?? verifier], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  const output = `${result?.stdout ?? ''}${result?.stderr ?? ''}`
  const failure =
    output
      .split('\n')
      .find(
        (line) =>
          line.includes('AssertionError') ||
          line.includes('accepted an invalid write') ||
          line.includes('mismatch') ||
          line.includes('accepted an unsafe down migration') ||
          line.includes('bypassed its explicit refusal'),
      ) ?? ''
  process.stdout.write(
    `\nMUTATION ${mutation.group}/${mutation.id}\nPREDICATE ${mutation.label}\nRAW_FAILURE ${failure}\n`,
  )
  if (result?.status !== 0 && output.includes('AssertionError')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}

process.stdout.write(`\nD9B4_MIGRATION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
