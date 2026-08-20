import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationPath = `${repositoryRoot}/apps/web/migrations/20260820_090731_d9e3_permanent_vip.ts`
const policyPath = `${repositoryRoot}/deploy/release-policy.json`
const manifestPath = `${repositoryRoot}/deploy/release-manifest.example.json`
const verifier = `${repositoryRoot}/scripts/verify-d9e3-vip-migration.mjs`
const migrationName = '20260820_090731_d9e3_permanent_vip'
const mutations = []
const add = (mutation) => mutations.push({ group: 'migration', ...mutation })

for (const table of [
  'vip_tier_rule_versions',
  'vip_tier_rule_levels',
  'vip_spend_entries',
  'vip_tier_events',
  'vip_tier_appeals',
]) {
  add({
    id: `table-${table.replaceAll('_', '-')}`,
    predicate: `${table} is part of the five-table append-only VIP schema`,
    transform: (source) => source.replaceAll(`"${table}"`, `"${table}_mutated"`),
  })
}

for (const [kind, values] of [
  [
    'event-source',
    ['natural_achievement', 'operational_promotion', 'data_correction', 'fraud_reversal'],
  ],
  ['spend-type', ['succeeded_order', 'order_reversal', 'data_correction', 'fraud_reversal']],
  ['payment-channel', ['native', 'h5', 'balance']],
  ['event-type', ['tier_achievement', 'tier_correction']],
]) {
  for (const value of values) {
    add({
      id: `${kind}-${value.replaceAll('_', '-')}`,
      predicate: `${value} remains an exact database enum member`,
      transform: (source) => source.replaceAll(`'${value}'`, `'${value}_mutated'`),
    })
  }
}
add({
  id: 'notification-type',
  predicate: 'VIP benefit changes retain their dedicated advance transactional notification type',
  transform: (source) =>
    source.replaceAll(`'vip_benefit_change_advance'`, `'vip_benefit_change_mutated'`),
})

add({
  id: 'notification-transactional-category',
  predicate: 'VIP advance notifications cannot be categorized as marketing',
  search: `("category" = 'marketing' AND "notification_type"::text IN ('product_updates', 'promotions'))`,
  replacement: `("category" = 'marketing' AND "notification_type"::text IN ('vip_benefit_change_advance', 'product_updates', 'promotions'))`,
  occurrence: 1,
  expectedOccurrences: 2,
})

for (const [id, index, predicate] of [
  ['rule-version-unique', 'version_1_idx', 'published rule versions are globally unique'],
  ['tier-rank-unique', 'ruleVersion_tierRank_idx', 'one rule cannot repeat a tier rank'],
  ['tier-code-unique', 'ruleVersion_tierCode_idx', 'one rule cannot repeat a tier code'],
  ['spend-entry-key-unique', 'vip_spend_entries_entry_key_idx', 'spend entry keys are idempotent'],
  ['spend-order-type-unique', 'sourceOrder_entryType_idx', 'one order has one fact of each type'],
  ['tier-event-key-unique', 'vip_tier_events_event_key_idx', 'tier event keys are idempotent'],
  ['appeal-key-unique', 'vip_tier_appeals_appeal_key_idx', 'appeal keys are idempotent'],
  [
    'appeal-customer-event-unique',
    'customer_tierEvent_idx',
    'one customer can append one appeal for a correction event',
  ],
]) {
  add({
    id,
    predicate,
    search: `CREATE UNIQUE INDEX "${index}"`,
    replacement: `CREATE INDEX "${index}"`,
  })
}

for (const mutation of [
  {
    id: 'rule-version-integer',
    predicate: 'rule version is an integer',
    search: `"version" = trunc("version")`,
    replacement: `"version" = "version"`,
  },
  {
    id: 'rule-schema-version',
    predicate: 'only rule schema version one is accepted',
    search: `"schema_version" = 1`,
    replacement: `TRUE`,
  },
  {
    id: 'rule-notice-before-effect',
    predicate: 'rule notice is published no later than effect',
    search: `("notice_published_at" IS NULL OR "notice_published_at" <= "effective_at")`,
    replacement: `TRUE`,
  },
  {
    id: 'rule-publisher-required',
    predicate: 'rule publisher identity is nonblank',
    search: `length(trim("changed_by")) > 0`,
    replacement: `TRUE`,
  },
  {
    id: 'rule-change-note-required',
    predicate: 'rule change note carries reviewable context',
    search: `length(trim("change_note")) >= 8`,
    replacement: `TRUE`,
  },
  {
    id: 'level-version-integer',
    predicate: 'tier level version is an integer',
    search: `"version_number" = trunc("version_number")`,
    replacement: `"version_number" = "version_number"`,
  },
  {
    id: 'level-rank-positive',
    predicate: 'tier rank is positive and bounded',
    search: `"tier_rank" BETWEEN 1 AND 100`,
    replacement: `"tier_rank" BETWEEN 0 AND 100`,
  },
  {
    id: 'level-threshold-positive',
    predicate: 'tier threshold is positive and bounded',
    search: `"threshold_fen" BETWEEN 1 AND 9007199254740991`,
    replacement: `"threshold_fen" BETWEEN 0 AND 9007199254740991`,
  },
  {
    id: 'level-code-format',
    predicate: 'tier codes use the stable machine-code format',
    search: `"tier_code" ~ '^[a-z][a-z0-9_]{1,31}$'`,
    replacement: `TRUE`,
    occurrence: 1,
    expectedOccurrences: 2,
  },
  {
    id: 'level-display-name-required',
    predicate: 'tier display name is nonblank',
    search: `length(trim("display_name")) > 0`,
    replacement: `TRUE`,
  },
  {
    id: 'level-service-required',
    predicate: 'tier service content is nonblank',
    search: `length(trim("service_content")) > 0`,
    replacement: `TRUE`,
  },
  {
    id: 'level-benefits-object',
    predicate: 'tier quota benefits snapshot is an object',
    search: `jsonb_typeof("quota_benefits") = 'object'`,
    replacement: `TRUE`,
  },
  {
    id: 'spend-amount-integer',
    predicate: 'spend facts use positive integer fen',
    search: `"amount_fen" = trunc("amount_fen")`,
    replacement: `"amount_fen" = "amount_fen"`,
  },
  {
    id: 'spend-reference-required',
    predicate: 'spend facts carry a nonblank reference',
    search: `length(trim("reference")) > 0`,
    replacement: `TRUE`,
  },
  {
    id: 'spend-success-channel',
    predicate: 'succeeded-order facts snapshot an order payment channel',
    search: `"payment_channel" IS NOT NULL AND "approval_request_id" IS NULL`,
    replacement: `TRUE AND "approval_request_id" IS NULL`,
  },
  {
    id: 'spend-reversal-no-channel',
    predicate: 'ordinary reversal facts cannot impersonate paid-channel facts',
    search: `("entry_type" = 'order_reversal' AND\n        "payment_channel" IS NULL AND "approval_request_id" IS NULL)`,
    replacement: `("entry_type" = 'order_reversal' AND\n        "approval_request_id" IS NULL)`,
  },
  {
    id: 'spend-correction-approval',
    predicate: 'data/fraud spend corrections carry an approval request',
    search: `"payment_channel" IS NULL AND "approval_request_id" IS NOT NULL))`,
    replacement: `"payment_channel" IS NULL))`,
  },
  {
    id: 'achievement-source',
    predicate: 'achievements only use natural or operational-promotion sources',
    transform: (source) =>
      source
        .replace(`"source" IN ('natural_achievement', 'operational_promotion')`, `TRUE`)
        .replace(
          `(("source" = 'natural_achievement') OR\n         ("source" = 'operational_promotion' AND "trigger_order_id" IS NULL))`,
          `TRUE`,
        ),
  },
  {
    id: 'spend-source-order-set-null',
    predicate: 'deleting an order retains its spend facts with a cleared relation',
    search: `CONSTRAINT "vip_spend_entries_source_order_id_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."orders"("id") ON DELETE set null`,
    replacement: `CONSTRAINT "vip_spend_entries_source_order_id_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict`,
  },
  {
    id: 'tier-trigger-order-set-null',
    predicate: 'deleting an order retains its tier history with a cleared relation',
    search: `CONSTRAINT "vip_tier_events_trigger_order_id_orders_id_fk" FOREIGN KEY ("trigger_order_id") REFERENCES "public"."orders"("id") ON DELETE set null`,
    replacement: `CONSTRAINT "vip_tier_events_trigger_order_id_orders_id_fk" FOREIGN KEY ("trigger_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict`,
  },
  {
    id: 'tier-rule-version-set-null',
    predicate: 'deleting a rule version retains its tier history and immutable rule snapshot',
    search: `CONSTRAINT "vip_tier_events_rule_version_id_vip_tier_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."vip_tier_rule_versions"("id") ON DELETE set null`,
    replacement: `CONSTRAINT "vip_tier_events_rule_version_id_vip_tier_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."vip_tier_rule_versions"("id") ON DELETE restrict`,
  },
  {
    id: 'spend-customer-set-null',
    predicate: 'deleting a customer retains anonymized spend facts with a cleared relation',
    search: `CONSTRAINT "vip_spend_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null`,
    replacement: `CONSTRAINT "vip_spend_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict`,
  },
  {
    id: 'tier-customer-set-null',
    predicate: 'deleting a customer retains anonymized tier history with a cleared relation',
    search: `CONSTRAINT "vip_tier_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null`,
    replacement: `CONSTRAINT "vip_tier_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict`,
  },
  {
    id: 'appeal-customer-set-null',
    predicate: 'deleting a customer retains anonymized tier appeals with a cleared relation',
    search: `CONSTRAINT "vip_tier_appeals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null`,
    replacement: `CONSTRAINT "vip_tier_appeals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict`,
  },
  {
    id: 'promotion-no-order',
    predicate: 'operational promotions cannot claim a triggering order',
    search: `("source" = 'operational_promotion' AND "trigger_order_id" IS NULL)`,
    replacement: `("source" = 'operational_promotion')`,
  },
  {
    id: 'zero-tier-no-code',
    predicate: 'tier rank zero has no tier identity code',
    search: `("tier_rank" = 0 AND "tier_code" IS NULL)`,
    replacement: `("tier_rank" = 0)`,
  },
  {
    id: 'correction-source',
    predicate: 'corrections only use data-correction or fraud-reversal sources',
    search: `"source" IN ('data_correction', 'fraud_reversal')`,
    replacement: `TRUE`,
  },
  {
    id: 'correction-lowers-tier',
    predicate: 'corrections lower rather than grant a tier',
    search: `"tier_rank" < "previous_tier_rank"`,
    replacement: `TRUE`,
  },
  {
    id: 'correction-approval',
    predicate: 'tier correction events carry the B-5 approval record',
    search: `"approval_request_id" IS NOT NULL AND "correction_reference" IS NOT NULL AND`,
    replacement: `"correction_reference" IS NOT NULL AND`,
  },
  {
    id: 'correction-visible-reference',
    predicate: 'tier correction events carry a visible reference',
    search: `"correction_reference" IS NOT NULL AND\n        length(trim("correction_reference")) > 0))`,
    replacement: `TRUE))`,
  },
  {
    id: 'event-tier-name-required',
    predicate: 'tier event name snapshot is nonblank',
    search: `length(trim("tier_name_snapshot")) > 0`,
    replacement: `TRUE`,
  },
  {
    id: 'event-service-required',
    predicate: 'tier event service snapshot is nonblank',
    search: `length(trim("service_content_snapshot")) > 0`,
    replacement: `TRUE`,
  },
  {
    id: 'event-reason-required',
    predicate: 'tier event reason is nonblank',
    search: `length(trim("reason")) > 0`,
    replacement: `TRUE`,
  },
  {
    id: 'event-benefits-object',
    predicate: 'tier event quota snapshot is an object',
    search: `jsonb_typeof("quota_benefits_snapshot") = 'object'`,
    replacement: `TRUE`,
  },
  {
    id: 'event-cumulative-nonnegative',
    predicate: 'tier event cumulative snapshot is nonnegative integer fen',
    search: `"cumulative_spend_fen_snapshot" BETWEEN 0 AND 9007199254740991`,
    replacement: `TRUE`,
  },
  {
    id: 'appeal-statement-minimum',
    predicate: 'customer-visible correction appeal includes a reviewable statement',
    search: `length(trim("statement")) >= 8`,
    replacement: `TRUE`,
  },
  {
    id: 'down-notification-drain-guard',
    predicate: 'rollback refuses to discard queued advance notifications',
    search: `     IF EXISTS (\n`,
    replacement: `     IF FALSE AND EXISTS (\n`,
  },
]) {
  add(mutation)
}

for (const [id, predicate, mutate] of [
  [
    'release-phase',
    'migration is released as expand',
    (value) => {
      value.migrations[migrationName].phase = 'data'
    },
  ],
  [
    'release-new-code-compatibility',
    'new code stays gated until the expand migration is present',
    (value) => {
      value.migrations[migrationName].newCodeCompatibleBeforeUp = false
    },
  ],
  [
    'release-old-code-compatibility',
    'old code ignores the additive VIP schema',
    (value) => {
      value.migrations[migrationName].oldCodeCompatible = false
    },
  ],
  [
    'release-retain-rollback',
    'expand rollback retains VIP facts',
    (value) => {
      value.migrations[migrationName].rollback = 'down'
    },
  ],
]) {
  mutations.push({ file: 'policy', group: 'release', id, mutate, predicate })
}
mutations.push({
  file: 'manifest',
  group: 'release',
  id: 'release-manifest-exactly-once',
  mutate: (value) => value.migrations.push(migrationName),
  predicate: 'release manifest applies the VIP migration exactly once',
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
function mutateText(source, mutation) {
  if (mutation.transform) return mutation.transform(source)
  const found = occurrences(source, mutation.search)
  const expected = mutation.expectedOccurrences ?? 1
  if (found !== expected) throw new Error(`expected ${expected} occurrences, found ${found}`)
  return replaceOccurrence(source, mutation.search, mutation.replacement, mutation.occurrence ?? 1)
}
function mutateJson(source, mutation) {
  const value = JSON.parse(source)
  mutation.mutate(value)
  return JSON.stringify(value)
}
const stripAnsi = (value) => value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
const originals = {
  manifest: readFileSync(manifestPath, 'utf8'),
  migration: readFileSync(migrationPath, 'utf8'),
  policy: readFileSync(policyPath, 'utf8'),
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.group}\t${mutation.id}\t${mutation.predicate}\n`)
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of mutations) {
    try {
      const file = mutation.file ?? 'migration'
      if (file === 'migration') mutateText(originals.migration, mutation)
      else mutateJson(originals[file], mutation)
    } catch (error) {
      invalid += 1
      process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    }
  }
  process.stdout.write(`VALIDATED\t${mutations.length - invalid}/${mutations.length}\n`)
  process.exit(invalid ? 1 : 0)
}
const selected = selectors.length
  ? mutations.filter(
      (mutation) => selectors.includes(mutation.group) || selectors.includes(mutation.id),
    )
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-E-3 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const file = mutation.file ?? 'migration'
  const mutated =
    file === 'migration'
      ? mutateText(originals.migration, mutation)
      : mutateJson(originals[file], mutation)
  const env = {
    ...process.env,
    ...(file === 'migration'
      ? { D9E3_MIGRATION_SOURCE_BASE64: Buffer.from(mutated).toString('base64') }
      : {}),
    ...(file === 'policy'
      ? { D9E3_RELEASE_POLICY_BASE64: Buffer.from(mutated).toString('base64') }
      : {}),
    ...(file === 'manifest'
      ? { D9E3_RELEASE_MANIFEST_BASE64: Buffer.from(mutated).toString('base64') }
      : {}),
  }
  const result = spawnSync('node', [verifier], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
  })
  const output = stripAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  const assertion =
    output
      .split('\n')
      .find((line) => line.includes('AssertionError') || line.includes('ERR_ASSERTION')) ?? ''
  process.stdout.write(
    `MUTATION ${mutation.group}/${mutation.id}\nPREDICATE ${mutation.predicate}\nRAW_FAILURE ${assertion}\n`,
  )
  if (result.status !== 0 && assertion) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(`${output.split('\n').slice(-30).join('\n')}\n`)
    process.stderr.write(
      `${result.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}
process.stdout.write(`D9E3_MIGRATION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
