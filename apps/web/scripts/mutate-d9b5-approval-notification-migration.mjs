import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationFile = 'apps/web/migrations/20260819_065615_d9b5_admin_approvals_notifications.ts'
const migrationPath = `${repositoryRoot}/${migrationFile}`
const verifier = 'scripts/verify-d9b5-approval-notification-migration.mjs'
const mutations = []

const edit = (search, replacement, options = {}) => ({ search, replacement, ...options })
const add = (group, id, predicate, edits) => mutations.push({ edits, group, id, predicate })

add('enum', 'operation-list', 'the workflow covers exactly the eight approved operation types', [
  edit(
    "'bulk_customer_asset_operation');",
    "'bulk_customer_asset_operation', 'mutant_operation');",
    { expectedOccurrences: 1 },
  ),
])
add('enum', 'marketing-preference-types', 'preference persistence contains marketing types only', [
  edit(
    "AS ENUM('product_updates', 'promotions');",
    "AS ENUM('product_updates', 'promotions', 'admin_high_risk_operation_submitted');",
  ),
])
add('defaults', 'policy-different-approver', 'production policy defaults to a different approver', [
  edit("'requiresDifferentApprover', true,", "'requiresDifferentApprover', false,"),
])
add('defaults', 'policy-positive-cooldown', 'production policy defaults to a positive cooldown', [
  edit("'cooldownSeconds', 900,", "'cooldownSeconds', 0,"),
])
add('defaults', 'request-different-approver', 'approval rows default to different approver true', [
  edit(
    '"requires_different_approver" boolean DEFAULT true NOT NULL,',
    '"requires_different_approver" boolean DEFAULT false NOT NULL,',
  ),
])
add('role-backfill', 'funds-scope', 'existing system admins receive the funds scope', [
  edit(
    "(VALUES (1, 'funds_operations'), (2, 'system_configuration'))",
    "(VALUES (2, 'system_configuration'))",
  ),
])
add(
  'role-backfill',
  'configuration-scope',
  'existing system admins receive the configuration scope',
  [
    edit(
      "(VALUES (1, 'funds_operations'), (2, 'system_configuration'))",
      "(VALUES (1, 'funds_operations'))",
    ),
  ],
)

for (const [id, predicate, search, replacement] of [
  [
    'cooldown-integer',
    'approval cooldown is an integer number of seconds',
    '"cooldown_seconds" = trunc("cooldown_seconds")',
    'TRUE',
  ],
  [
    'cooldown-positive',
    'approval cooldown is positive and bounded',
    '"cooldown_seconds" BETWEEN 1 AND 604800',
    '"cooldown_seconds" <= 604800',
  ],
  [
    'amount-integer',
    'large adjustment amount is integer fen',
    '"amount_fen" = trunc("amount_fen")',
    'TRUE',
  ],
  [
    'amount-positive',
    'large adjustment amount is positive and safe',
    '"amount_fen" BETWEEN 1 AND 9007199254740991',
    '"amount_fen" <= 9007199254740991',
  ],
  [
    'non-balance-amount-null',
    'non-balance operations cannot carry a second amount source',
    '("operation_type" <> \'large_balance_adjustment\' AND "amount_fen" IS NULL)',
    '("operation_type" <> \'large_balance_adjustment\')',
  ],
  [
    'different-approver-row',
    'a different-approver row cannot persist self-approval',
    '(NOT "requires_different_approver" OR "approved_by_id" IS NULL OR "approved_by_id" <> "requested_by_id")',
    'TRUE',
  ],
]) {
  add('approval-values', id, predicate, [edit(search, replacement)])
}
add('approval-state', 'pending-evidence', 'pending approval excludes approval evidence', [
  edit(
    '"status" = \'pending_approval\' AND "approved_by_id" IS NULL AND "approved_at" IS NULL AND',
    '"status" = \'pending_approval\' AND "approved_by_id" IS NULL AND TRUE AND',
  ),
])
add('approval-state', 'executing-claim-evidence', 'executing state requires claim evidence', [
  edit('"execution_claim_key" IS NOT NULL AND "execution_claimed_at" IS NOT NULL AND', 'TRUE AND', {
    expectedOccurrences: 3,
    occurrence: 1,
  }),
])

add('outbox-values', 'category-type-coupling', 'transactional and marketing types cannot cross', [
  edit(
    "(\"category\" = 'marketing' AND \"notification_type\" IN ('product_updates', 'promotions'))",
    '("category" = \'marketing\')',
  ),
])
for (const [id, predicate, search, replacement] of [
  [
    'template-version-positive',
    'template version is a positive safe integer',
    '"template_version" BETWEEN 1 AND 9007199254740991',
    '"template_version" <= 9007199254740991',
  ],
  [
    'subject-nonblank',
    'subject snapshot is nonblank',
    'length(trim("subject_snapshot")) > 0',
    'TRUE',
  ],
  ['message-hash-length', 'message hash is complete', 'length("message_hash") = 64', 'TRUE'],
]) {
  add('outbox-values', id, predicate, [edit(search, replacement)])
}

for (const [id, predicate, search, replacement, options] of [
  [
    'attempt-integer',
    'delivery attempt count is an integer',
    '"attempt_count" = trunc("attempt_count")',
    'TRUE',
  ],
  [
    'attempt-maximum',
    'delivery attempts never exceed maxAttempts',
    '"attempt_count" <= "max_attempts"',
    'TRUE',
  ],
  [
    'external-recipient',
    'external channels require an encrypted recipient',
    '("channel" IN (\'sms\', \'wechat\') AND "recipient_encrypted" IS NOT NULL)',
    "(\"channel\" IN ('sms', 'wechat'))",
  ],
  [
    'in-app-recipient',
    'in-app delivery excludes an encrypted recipient',
    '("channel" = \'in_app\' AND "recipient_encrypted" IS NULL)',
    '("channel" = \'in_app\')',
  ],
  [
    'pending-attempt-evidence',
    'pending delivery has not been attempted',
    '"status" = \'pending\' AND "attempt_count" = 0 AND "claimed_at" IS NULL AND',
    '"status" = \'pending\' AND TRUE AND "claimed_at" IS NULL AND',
  ],
  [
    'delivered-time-evidence',
    'delivered state requires a delivered timestamp',
    '"delivered_at" IS NOT NULL AND "dead_lettered_at" IS NULL',
    'TRUE AND "dead_lettered_at" IS NULL',
    { expectedOccurrences: 1 },
  ],
]) {
  add('delivery-values', id, predicate, [edit(search, replacement, options)])
}
add('receipt-values', 'receipt-attempt-positive', 'provider receipt attempt is positive', [
  edit('"attempt_number" BETWEEN 1 AND 9007199254740991', '"attempt_number" <= 9007199254740991'),
])

for (const [id, predicate, search, replacement] of [
  [
    'approval-request-key',
    'approval request keys are unique',
    'CREATE UNIQUE INDEX "admin_approval_requests_request_key_idx"',
    'CREATE INDEX "admin_approval_requests_request_key_idx"',
  ],
  [
    'admin-access-event-key',
    'admin access event keys are unique',
    'CREATE UNIQUE INDEX "admin_access_events_event_key_idx"',
    'CREATE INDEX "admin_access_events_event_key_idx"',
  ],
  [
    'outbox-event-key',
    'outbox event keys are unique',
    'CREATE UNIQUE INDEX "notification_outbox_events_event_key_idx"',
    'CREATE INDEX "notification_outbox_events_event_key_idx"',
  ],
  [
    'delivery-key',
    'delivery keys are unique',
    'CREATE UNIQUE INDEX "notification_deliveries_delivery_key_idx"',
    'CREATE INDEX "notification_deliveries_delivery_key_idx"',
  ],
  [
    'receipt-key',
    'provider receipt keys are unique',
    'CREATE UNIQUE INDEX "notification_provider_receipts_receipt_key_idx"',
    'CREATE INDEX "notification_provider_receipts_receipt_key_idx"',
  ],
  [
    'read-event-customer',
    'read state is unique per event and customer',
    'CREATE UNIQUE INDEX "notification_read_states_event_customer_idx"',
    'CREATE INDEX "notification_read_states_event_customer_idx"',
  ],
  [
    'marketing-preference-customer',
    'marketing preferences are unique per customer',
    'CREATE UNIQUE INDEX "notification_marketing_preferences_customer_idx"',
    'CREATE INDEX "notification_marketing_preferences_customer_idx"',
  ],
]) {
  add('idempotency', id, predicate, [edit(search, replacement)])
}

add('down-guard', 'changed-policy', 'down refuses a policy changed from its exact seed', [
  edit("\"value\"->>'requiresDifferentApprover' <> 'true' OR", 'FALSE OR'),
])
add('down-guard', 'missing-admin-scope', 'down refuses an incomplete system-admin scope backfill', [
  edit(') <> 2\n       ) THEN', ') = -1\n       ) THEN'),
])

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
  for (const change of mutation.edits) {
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
    process.stdout.write(`${mutation.group}/${mutation.id}\t${mutation.predicate}\n`)
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  const source = readFileSync(migrationPath, 'utf8')
  for (const mutation of mutations) {
    try {
      mutateSource(source, mutation)
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
  process.stderr.write(`No D9-B-5 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const original = readFileSync(migrationPath, 'utf8')
  let result
  try {
    writeFileSync(migrationPath, mutateSource(original, mutation), 'utf8')
    result = spawnSync('node', [verifier], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env },
    })
  } finally {
    writeFileSync(migrationPath, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const failure = output.split('\n').find((line) => line.includes('AssertionError')) ?? ''
  process.stdout.write(
    `\nMUTATION ${mutation.group}/${mutation.id}\nPREDICATE ${mutation.predicate}\nRAW_FAILURE ${failure}\n`,
  )
  if (result?.status !== 0 && output.includes('AssertionError')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(`RAW_OUTPUT ${output.split('\n').slice(-30).join('\n')}\n`)
    process.stderr.write(
      `${result?.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}
process.stdout.write(
  `\nD9B5_MIGRATION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
