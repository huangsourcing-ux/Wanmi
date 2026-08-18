import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationFile = 'apps/web/migrations/20260818_032334_d9b2_wallet_top_up_orders.ts'
const migrationPath = `${repositoryRoot}/${migrationFile}`
const releasePolicyPath = `${repositoryRoot}/deploy/release-policy.json`
const releaseManifestPath = `${repositoryRoot}/deploy/release-manifest.example.json`
const mutations = []
const add = (mutation) => mutations.push({ file: migrationFile, ...mutation })

for (const mutation of [
  {
    id: 'amount-integer',
    search: '\t  "amount_fen" = trunc("amount_fen") AND\n',
    label: 'amount integer',
  },
  {
    id: 'amount-positive',
    search: '\t  "amount_fen" >= 1 AND\n',
    label: 'amount positive',
  },
  {
    id: 'amount-safe-maximum',
    search: '\t  "amount_fen" <= 9007199254740991\n',
    replacement: '\t  TRUE\n',
    label: 'amount safe maximum',
  },
  {
    id: 'platform-order-number-format',
    search: '\t  "top_up_order_number" ~ \'^WT[0-9a-f]{30}$\' AND\n',
    label: 'platform order number format',
  },
  {
    id: 'ledger-key-nonblank',
    search: '\t  length(trim("ledger_transaction_key")) > 0 AND\n',
    label: 'ledger key nonblank',
  },
  {
    id: 'wechat-transaction-nonblank',
    search:
      '\t  ("wechat_transaction_id" IS NULL OR length(trim("wechat_transaction_id")) > 0) AND\n',
    label: 'wechat transaction id nonblank',
  },
  {
    id: 'refund-number-nonblank',
    search:
      '\t  ("original_refund_number" IS NULL OR length(trim("original_refund_number")) > 0)\n',
    replacement: '\t  TRUE\n',
    label: 'original refund number nonblank',
  },
]) {
  add({ group: 'check', replacement: '', ...mutation })
}

const branches = {
  created: `\t  (
\t    "status" = 'created' AND
\t    "payment_channel" IS NULL AND
\t    "payment_expires_at" IS NULL AND
\t    "wechat_transaction_id" IS NULL AND
\t    "provider_paid_at" IS NULL AND
\t    "provider_confirmed_at" IS NULL AND
\t    "credited_at" IS NULL AND
\t    "original_refund_number" IS NULL AND
\t    "refunded_at" IS NULL
\t  ) OR (
`,
  pending: `\t    "status" IN ('payment_pending', 'closed', 'unknown') AND
\t    "payment_channel" IS NOT NULL AND
\t    "payment_expires_at" IS NOT NULL AND
\t    "wechat_transaction_id" IS NULL AND
\t    "provider_paid_at" IS NULL AND
\t    "provider_confirmed_at" IS NULL AND
\t    "credited_at" IS NULL AND
\t    "original_refund_number" IS NULL AND
\t    "refunded_at" IS NULL
\t  ) OR (
`,
  confirmed: `\t    "status" = 'provider_confirmed' AND
\t    "payment_channel" IS NOT NULL AND
\t    "payment_expires_at" IS NOT NULL AND
\t    "wechat_transaction_id" IS NOT NULL AND
\t    "provider_paid_at" IS NOT NULL AND
\t    "provider_confirmed_at" IS NOT NULL AND
\t    "credited_at" IS NULL AND
\t    "original_refund_number" IS NULL AND
\t    "refunded_at" IS NULL
\t  ) OR (
`,
  credited: `\t    "status" = 'credited' AND
\t    "payment_channel" IS NOT NULL AND
\t    "payment_expires_at" IS NOT NULL AND
\t    "wechat_transaction_id" IS NOT NULL AND
\t    "provider_paid_at" IS NOT NULL AND
\t    "provider_confirmed_at" IS NOT NULL AND
\t    "credited_at" IS NOT NULL AND
\t    "original_refund_number" IS NULL AND
\t    "refunded_at" IS NULL
\t  ) OR (
`,
  refundPending: `\t    "status" = 'refund_pending' AND
\t    "payment_channel" IS NOT NULL AND
\t    "payment_expires_at" IS NOT NULL AND
\t    "original_refund_number" IS NOT NULL AND
\t    "refunded_at" IS NULL
\t  ) OR (
`,
  refunded: `\t    "status" = 'refunded' AND
\t    "payment_channel" IS NOT NULL AND
\t    "payment_expires_at" IS NOT NULL AND
\t    "original_refund_number" IS NOT NULL AND
\t    "refunded_at" IS NOT NULL
\t  )
`,
}

const branchPredicates = {
  created: [
    ['status', '"status" = \'created\'', 'created branch status'],
    ['payment-channel-absent', '"payment_channel" IS NULL', 'created payment channel absent'],
    ['payment-expiry-absent', '"payment_expires_at" IS NULL', 'created payment expiry absent'],
    ['transaction-absent', '"wechat_transaction_id" IS NULL', 'created transaction absent'],
    ['provider-paid-absent', '"provider_paid_at" IS NULL', 'created provider paid absent'],
    [
      'provider-confirmation-absent',
      '"provider_confirmed_at" IS NULL',
      'created provider confirmation absent',
    ],
    ['credit-absent', '"credited_at" IS NULL', 'created credit absent'],
    ['refund-number-absent', '"original_refund_number" IS NULL', 'created refund number absent'],
    ['refund-time-absent', '"refunded_at" IS NULL', 'created refund timestamp absent'],
  ],
  pending: [
    [
      'status',
      "\"status\" IN ('payment_pending', 'closed', 'unknown')",
      'pending branch status set',
    ],
    ['payment-channel-present', '"payment_channel" IS NOT NULL', 'pending payment channel present'],
    [
      'payment-expiry-present',
      '"payment_expires_at" IS NOT NULL',
      'pending payment expiry present',
    ],
    ['transaction-absent', '"wechat_transaction_id" IS NULL', 'pending transaction absent'],
    ['provider-paid-absent', '"provider_paid_at" IS NULL', 'pending provider paid absent'],
    [
      'provider-confirmation-absent',
      '"provider_confirmed_at" IS NULL',
      'pending provider confirmation absent',
    ],
    ['credit-absent', '"credited_at" IS NULL', 'pending credit absent'],
    ['refund-number-absent', '"original_refund_number" IS NULL', 'pending refund number absent'],
    ['refund-time-absent', '"refunded_at" IS NULL', 'pending refund timestamp absent'],
  ],
  confirmed: [
    ['status', '"status" = \'provider_confirmed\'', 'confirmed branch status'],
    [
      'payment-channel-present',
      '"payment_channel" IS NOT NULL',
      'confirmed payment channel present',
    ],
    [
      'payment-expiry-present',
      '"payment_expires_at" IS NOT NULL',
      'confirmed payment expiry present',
    ],
    ['transaction-present', '"wechat_transaction_id" IS NOT NULL', 'confirmed transaction present'],
    ['provider-paid-present', '"provider_paid_at" IS NOT NULL', 'confirmed provider paid present'],
    [
      'provider-confirmation-present',
      '"provider_confirmed_at" IS NOT NULL',
      'confirmed provider confirmation present',
    ],
    ['credit-absent', '"credited_at" IS NULL', 'confirmed credit absent'],
    ['refund-number-absent', '"original_refund_number" IS NULL', 'confirmed refund number absent'],
    ['refund-time-absent', '"refunded_at" IS NULL', 'confirmed refund timestamp absent'],
  ],
  credited: [
    ['status', '"status" = \'credited\'', 'credited branch status'],
    [
      'payment-channel-present',
      '"payment_channel" IS NOT NULL',
      'credited payment channel present',
    ],
    [
      'payment-expiry-present',
      '"payment_expires_at" IS NOT NULL',
      'credited payment expiry present',
    ],
    ['transaction-present', '"wechat_transaction_id" IS NOT NULL', 'credited transaction present'],
    ['provider-paid-present', '"provider_paid_at" IS NOT NULL', 'credited provider paid present'],
    [
      'provider-confirmation-present',
      '"provider_confirmed_at" IS NOT NULL',
      'credited provider confirmation present',
    ],
    ['credit-present', '"credited_at" IS NOT NULL', 'credited timestamp present'],
    ['refund-number-absent', '"original_refund_number" IS NULL', 'credited refund number absent'],
    ['refund-time-absent', '"refunded_at" IS NULL', 'credited refund timestamp absent'],
  ],
  refundPending: [
    ['status', '"status" = \'refund_pending\'', 'refund-pending branch status'],
    [
      'payment-channel-present',
      '"payment_channel" IS NOT NULL',
      'refund-pending payment channel present',
    ],
    [
      'payment-expiry-present',
      '"payment_expires_at" IS NOT NULL',
      'refund-pending payment expiry present',
    ],
    [
      'refund-number-present',
      '"original_refund_number" IS NOT NULL',
      'refund-pending refund number present',
    ],
    ['refund-time-absent', '"refunded_at" IS NULL', 'refund-pending refund timestamp absent'],
  ],
  refunded: [
    ['status', '"status" = \'refunded\'', 'refunded branch status'],
    [
      'payment-channel-present',
      '"payment_channel" IS NOT NULL',
      'refunded payment channel present',
    ],
    [
      'payment-expiry-present',
      '"payment_expires_at" IS NOT NULL',
      'refunded payment expiry present',
    ],
    [
      'refund-number-present',
      '"original_refund_number" IS NOT NULL',
      'refunded refund number present',
    ],
    ['refund-time-present', '"refunded_at" IS NOT NULL', 'refunded refund timestamp present'],
  ],
}

for (const [branchName, predicates] of Object.entries(branchPredicates)) {
  const branch = branches[branchName]
  for (const [suffix, condition, label] of predicates) {
    add({
      group: 'state',
      id: `${branchName}-${suffix}`,
      label,
      replacement: branch.replace(condition, 'TRUE'),
      search: branch,
    })
  }
}

for (const mutation of [
  {
    id: 'platform-order-number-unique',
    search:
      '  CREATE UNIQUE INDEX "wallet_top_up_orders_top_up_order_number_idx" ON "wallet_top_up_orders" USING btree ("top_up_order_number");\n',
    label: 'global platform top-up order number',
  },
  {
    id: 'wechat-transaction-unique',
    search:
      '  CREATE UNIQUE INDEX "wallet_top_up_orders_wechat_transaction_id_idx" ON "wallet_top_up_orders" USING btree ("wechat_transaction_id");\n',
    label: 'global WeChat transaction id',
  },
  {
    id: 'ledger-key-unique',
    search:
      '  CREATE UNIQUE INDEX "wallet_top_up_orders_ledger_transaction_key_idx" ON "wallet_top_up_orders" USING btree ("ledger_transaction_key");\n',
    label: 'global ledger idempotency key',
  },
  {
    id: 'refund-number-unique',
    search:
      '  CREATE UNIQUE INDEX "wallet_top_up_orders_original_refund_number_idx" ON "wallet_top_up_orders" USING btree ("original_refund_number");\n',
    label: 'global original refund number',
  },
]) {
  add({ group: 'unique', replacement: '', ...mutation })
}

for (const mutation of [
  {
    id: 'top-up-customer-fk',
    search:
      '  ALTER TABLE "wallet_top_up_orders" ADD CONSTRAINT "wallet_top_up_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n',
    label: 'top-up customer foreign key',
  },
  {
    id: 'top-up-account-fk',
    search:
      '  ALTER TABLE "wallet_top_up_orders" ADD CONSTRAINT "wallet_top_up_orders_account_id_wallet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE set null ON UPDATE no action;\n',
    label: 'top-up wallet account foreign key',
  },
  {
    id: 'notification-archive-top-up-fk',
    search:
      '  ALTER TABLE "payment_notification_archives" ADD CONSTRAINT "payment_notification_archives_wallet_top_up_order_id_wallet_top_up_orders_id_fk" FOREIGN KEY ("wallet_top_up_order_id") REFERENCES "public"."wallet_top_up_orders"("id") ON DELETE set null ON UPDATE no action;\n',
    label: 'notification archive top-up foreign key',
  },
  {
    id: 'manual-review-top-up-fk',
    search:
      '  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_wallet_top_up_order_id_wallet_top_up_orders_id_fk" FOREIGN KEY ("wallet_top_up_order_id") REFERENCES "public"."wallet_top_up_orders"("id") ON DELETE set null ON UPDATE no action;\n',
    label: 'manual review top-up foreign key',
  },
]) {
  add({ group: 'foreign-key', replacement: '', ...mutation })
}

for (const mutation of [
  {
    id: 'notification-archive-column',
    search: '  ALTER TABLE "payment_notification_archives" DROP COLUMN "wallet_top_up_order_id";\n',
    label: 'down removes notification archive relation column',
  },
  {
    id: 'manual-review-column',
    search: '  ALTER TABLE "manual_reviews" DROP COLUMN "wallet_top_up_order_id";\n',
    label: 'down removes manual review relation column',
  },
  {
    id: 'top-up-table',
    search: '  DROP TABLE "wallet_top_up_orders" CASCADE;\n',
    label: 'down removes top-up table',
  },
  ...['currency', 'funding_source', 'payment_channel', 'status'].map((type) => ({
    id: `${type}-enum`,
    search: `  DROP TYPE "public"."enum_wallet_top_up_orders_${type}";${type === 'status' ? '' : '\n'}`,
    label: `down removes ${type} enum`,
  })),
]) {
  add({ group: 'down', replacement: '', ...mutation })
}

const releasePolicyEntry = `    "20260818_032334_d9b2_wallet_top_up_orders": {
      "newCodeCompatibleBeforeUp": true,
      "oldCodeCompatible": true,
      "phase": "expand",
      "reason": "新增独立钱包充值订单表及支付通知、人工复核的可空关联；旧代码可忽略新增结构，新代码仅在迁移完成后启用充值入账。",
      "rollback": "retain"
    }`
for (const [id, label, replacement] of [
  [
    'release-policy-entry-exact',
    'release policy names the D9-B-2 migration exactly',
    releasePolicyEntry.replace(
      '20260818_032334_d9b2_wallet_top_up_orders',
      '20260818_032334_d9b2_wallet_top_up_orders_missing',
    ),
  ],
  [
    'release-policy-new-code-compatible-before-up',
    'expand policy requires the migration before new code promotion',
    releasePolicyEntry.replace(
      '"newCodeCompatibleBeforeUp": true',
      '"newCodeCompatibleBeforeUp": false',
    ),
  ],
  [
    'release-policy-old-code-compatible',
    'expand policy keeps old code compatible during rollback',
    releasePolicyEntry.replace('"oldCodeCompatible": true', '"oldCodeCompatible": false'),
  ],
  [
    'release-policy-expand-phase',
    'schema-only additions remain classified as expand',
    releasePolicyEntry.replace('"phase": "expand"', '"phase": "data"'),
  ],
  [
    'release-policy-specific-reason',
    'release policy retains a specific compatibility reason',
    releasePolicyEntry.replace(
      '新增独立钱包充值订单表及支付通知、人工复核的可空关联；旧代码可忽略新增结构，新代码仅在迁移完成后启用充值入账。',
      'D9-B-2',
    ),
  ],
  [
    'release-policy-retain-rollback',
    'expand rollback retains the additive migration',
    releasePolicyEntry.replace('"rollback": "retain"', '"rollback": "down"'),
  ],
]) {
  add({
    group: 'release-metadata',
    id,
    label,
    path: releasePolicyPath,
    replacement,
    search: releasePolicyEntry,
    verifier: 'scripts/verify-release-contract.mjs',
  })
}
add({
  group: 'release-metadata',
  id: 'release-manifest-entry-exact',
  label: 'release manifest names the D9-B-2 migration exactly and in order',
  path: releaseManifestPath,
  replacement: '    "20260818_032334_d9b2_wallet_top_up_orders_missing"',
  search: '    "20260818_032334_d9b2_wallet_top_up_orders"',
  verifier: 'scripts/verify-release-contract.mjs',
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
  process.stderr.write(`No D9-B-2 migration mutations matched: ${selectors.join(', ')}\n`)
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
    result = spawnSync(
      'node',
      [mutation.verifier ?? 'scripts/verify-d9b2-wallet-top-up-migration.mjs'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: process.env,
      },
    )
  } finally {
    writeFileSync(path, original, 'utf8')
  }
  const output = `${result?.stdout ?? ''}${result?.stderr ?? ''}`
  const behaviorFailure =
    output.includes('accepted an invalid write') ||
    output.includes('migration up schema mismatch') ||
    output.includes('migration down schema mismatch') ||
    (mutation.group === 'down' && output.includes('cannot drop type')) ||
    (mutation.group === 'release-metadata' && output.includes('Error:'))
  const failureLine =
    output
      .split('\n')
      .find(
        (line) =>
          line.includes('accepted an invalid write') ||
          line.includes('migration up schema mismatch') ||
          line.includes('migration down schema mismatch') ||
          line.includes('cannot drop type') ||
          (mutation.group === 'release-metadata' && line.includes('Error:')),
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

process.stdout.write(`\nD9B2_MIGRATION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
