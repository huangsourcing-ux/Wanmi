import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationPath = `${repositoryRoot}/apps/web/migrations/20260818_072324_d9c1_domain_center.ts`
const verifier = 'scripts/verify-d9c1-domain-center-migration.mjs'
const mutations = []
const add = (mutation) => mutations.push(mutation)

for (const [id, search, replacement] of [
  [
    'reminder-channel-enum-in-app',
    `CREATE TYPE "public"."enum_domain_assets_expiry_reminder_channels" AS ENUM('in_app', 'sms');`,
    `CREATE TYPE "public"."enum_domain_assets_expiry_reminder_channels" AS ENUM('mutated', 'sms');`,
  ],
  [
    'reminder-channel-enum-sms',
    `CREATE TYPE "public"."enum_domain_assets_expiry_reminder_channels" AS ENUM('in_app', 'sms');`,
    `CREATE TYPE "public"."enum_domain_assets_expiry_reminder_channels" AS ENUM('in_app', 'mutated');`,
  ],
  [
    'lock-status-enum-locked',
    `CREATE TYPE "public"."enum_domain_assets_domain_lock_status" AS ENUM('locked', 'unlocked', 'unknown');`,
    `CREATE TYPE "public"."enum_domain_assets_domain_lock_status" AS ENUM('mutated', 'unlocked', 'unknown');`,
  ],
  [
    'lock-status-enum-unlocked',
    `CREATE TYPE "public"."enum_domain_assets_domain_lock_status" AS ENUM('locked', 'unlocked', 'unknown');`,
    `CREATE TYPE "public"."enum_domain_assets_domain_lock_status" AS ENUM('locked', 'mutated', 'unknown');`,
  ],
  [
    'lock-status-enum-unknown',
    `CREATE TYPE "public"."enum_domain_assets_domain_lock_status" AS ENUM('locked', 'unlocked', 'unknown');`,
    `CREATE TYPE "public"."enum_domain_assets_domain_lock_status" AS ENUM('locked', 'unlocked', 'mutated');`,
  ],
]) {
  add({
    changes:
      id === 'lock-status-enum-unknown'
        ? [
            { replacement, search },
            { replacement: `DEFAULT 'mutated';`, search: `DEFAULT 'unknown';` },
          ]
        : undefined,
    group: 'migration-up-enum',
    id,
    predicate: `${id} remains exact`,
    replacement,
    search,
  })
}

for (const [id, line] of [
  [
    'provider-operation-domain-lock',
    `  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'domain_lock' BEFORE 'domain_management_password';\n`,
  ],
  [
    'management-operation-domain-lock',
    `  ALTER TYPE "public"."enum_domain_management_events_operation" ADD VALUE 'domain_lock_change' BEFORE 'management_password_read';\n`,
  ],
  [
    'management-operation-reminder-preferences',
    `  ALTER TYPE "public"."enum_domain_management_events_operation" ADD VALUE 'expiry_reminder_preferences_update' BEFORE 'management_password_read';\n`,
  ],
  [
    'management-operation-tags',
    `  ALTER TYPE "public"."enum_domain_management_events_operation" ADD VALUE 'tags_update' BEFORE 'template_transfer';\n`,
  ],
]) {
  add({
    group: 'migration-up-enum-extension',
    id,
    predicate: `${id} remains present and ordered`,
    replacement: '',
    search: line,
  })
}

for (const [id, line, coupled = []] of [
  [
    'domain-lock-status-column',
    `  ALTER TABLE "domain_assets" ADD COLUMN "domain_lock_status" "enum_domain_assets_domain_lock_status" DEFAULT 'unknown';\n`,
    [
      `  CREATE INDEX "domain_assets_domain_lock_status_idx" ON "domain_assets" USING btree ("domain_lock_status");\n`,
    ],
  ],
  [
    'domain-lock-updated-at-column',
    `  ALTER TABLE "domain_assets" ADD COLUMN "domain_lock_updated_at" timestamp(3) with time zone;\n`,
    [
      `  CREATE INDEX "domain_assets_domain_lock_updated_at_idx" ON "domain_assets" USING btree ("domain_lock_updated_at");`,
    ],
  ],
  [
    'event-previous-value-column',
    `  ALTER TABLE "domain_management_events" ADD COLUMN "previous_value" jsonb;\n`,
  ],
  [
    'event-requested-value-column',
    `  ALTER TABLE "domain_management_events" ADD COLUMN "requested_value" jsonb;\n`,
  ],
  [
    'event-requested-locked-column',
    `  ALTER TABLE "domain_management_events" ADD COLUMN "requested_locked" boolean;\n`,
  ],
]) {
  add({
    changes: [
      { replacement: '', search: line },
      ...coupled.map((search) => ({ replacement: '', search })),
    ],
    group: 'migration-up-column',
    id,
    predicate: `${id} remains present`,
  })
}

add({
  group: 'migration-up-default',
  id: 'domain-lock-fail-closed-default',
  predicate: 'new and historical assets default to unknown lock state',
  replacement: `DEFAULT 'locked';`,
  search: `DEFAULT 'unknown';`,
})

for (const [id, line] of [
  [
    'reminder-channel-parent-foreign-key',
    `  ALTER TABLE "domain_assets_expiry_reminder_channels" ADD CONSTRAINT "domain_assets_expiry_reminder_channels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."domain_assets"("id") ON DELETE cascade ON UPDATE no action;\n`,
  ],
  [
    'reminder-days-parent-foreign-key',
    `  ALTER TABLE "domain_assets_numbers" ADD CONSTRAINT "domain_assets_numbers_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."domain_assets"("id") ON DELETE cascade ON UPDATE no action;\n`,
  ],
]) {
  add({
    group: 'migration-up-foreign-key',
    id,
    predicate: `${id} remains enforced`,
    replacement: '',
    search: line,
  })
}

for (const [id, line] of [
  [
    'reminder-channel-order-index',
    `  CREATE INDEX "domain_assets_expiry_reminder_channels_order_idx" ON "domain_assets_expiry_reminder_channels" USING btree ("order");\n`,
  ],
  [
    'reminder-channel-parent-index',
    `  CREATE INDEX "domain_assets_expiry_reminder_channels_parent_idx" ON "domain_assets_expiry_reminder_channels" USING btree ("parent_id");\n`,
  ],
  [
    'reminder-days-order-parent-index',
    `  CREATE INDEX "domain_assets_numbers_order_parent_idx" ON "domain_assets_numbers" USING btree ("order","parent_id");\n`,
  ],
  [
    'domain-lock-status-index',
    `  CREATE INDEX "domain_assets_domain_lock_status_idx" ON "domain_assets" USING btree ("domain_lock_status");\n`,
  ],
  [
    'domain-lock-updated-at-index',
    `  CREATE INDEX "domain_assets_domain_lock_updated_at_idx" ON "domain_assets" USING btree ("domain_lock_updated_at");`,
  ],
]) {
  add({
    group: 'migration-up-index',
    id,
    predicate: `${id} remains present`,
    replacement: '',
    search: line,
  })
}

for (const [id, search, replacement] of [
  [
    'down-provider-lock-rows',
    `   DELETE FROM "provider_operations" WHERE "operation" = 'domain_lock';\n`,
    `   UPDATE "provider_operations" SET "operation" = 'query' WHERE "operation" = 'domain_lock';\n`,
  ],
  [
    'down-management-event-rows',
    `  DELETE FROM "domain_management_events" WHERE "operation" IN ('domain_lock_change', 'expiry_reminder_preferences_update', 'tags_update');\n`,
    `  UPDATE "domain_management_events" SET "operation" = 'management_password_read' WHERE "operation" IN ('domain_lock_change', 'expiry_reminder_preferences_update', 'tags_update');\n`,
  ],
  [
    'down-tag-rows',
    `  DELETE FROM "domain_assets_texts" WHERE "path" = 'tags';\n`,
    `  DELETE FROM "domain_assets_texts" WHERE "path" = 'mutated';\n`,
  ],
  [
    'down-reminder-channel-table',
    `  DROP TABLE "domain_assets_expiry_reminder_channels" CASCADE;\n`,
    `  ALTER TABLE "domain_assets_expiry_reminder_channels" ALTER COLUMN "value" SET DATA TYPE text USING "value"::text;\n`,
  ],
  ['down-reminder-days-table', `  DROP TABLE "domain_assets_numbers" CASCADE;\n`, ''],
  [
    'down-lock-status-column',
    `  ALTER TABLE "domain_assets" DROP COLUMN "domain_lock_status";\n`,
    `  ALTER TABLE "domain_assets" ALTER COLUMN "domain_lock_status" DROP DEFAULT;\n  ALTER TABLE "domain_assets" ALTER COLUMN "domain_lock_status" SET DATA TYPE text USING "domain_lock_status"::text;\n`,
  ],
  [
    'down-lock-updated-at-column',
    `  ALTER TABLE "domain_assets" DROP COLUMN "domain_lock_updated_at";\n`,
    '',
  ],
  [
    'down-event-previous-value-column',
    `  ALTER TABLE "domain_management_events" DROP COLUMN "previous_value";\n`,
    '',
  ],
  [
    'down-event-requested-value-column',
    `  ALTER TABLE "domain_management_events" DROP COLUMN "requested_value";\n`,
    '',
  ],
  [
    'down-event-requested-locked-column',
    `  ALTER TABLE "domain_management_events" DROP COLUMN "requested_locked";\n`,
    '',
  ],
  [
    'down-reminder-channel-type',
    `  DROP TYPE "public"."enum_domain_assets_expiry_reminder_channels";\n`,
    '',
  ],
  ['down-lock-status-type', `  DROP TYPE "public"."enum_domain_assets_domain_lock_status";`, ''],
]) {
  add({
    group: 'migration-down-cleanup',
    id,
    predicate: `${id} cleanup remains exact`,
    replacement,
    search,
  })
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

function changesFor(mutation) {
  return mutation.changes ?? [mutation]
}

function mutateSource(source, mutation) {
  let result = source
  for (const change of changesFor(mutation)) {
    const found = occurrences(result, change.search)
    const expected = change.expectedOccurrences ?? mutation.expectedOccurrences ?? 1
    if (found !== expected) throw new Error(`expected ${expected} occurrences, found ${found}`)
    result = replaceOccurrence(
      result,
      change.search,
      change.replacement,
      change.occurrence ?? mutation.occurrence ?? 1,
    )
  }
  return result
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.group}\t${mutation.id}\t${mutation.predicate}\t${verifier}\n`)
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
  process.stderr.write(`No D9-C-1 migration mutations matched: ${selectors.join(', ')}\n`)
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
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(
    `PREDICATE ${mutation.predicate}\nTEST ${verifier}\nRAW_FAILURE ${failure}\n`,
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
  `\nD9C1_MIGRATION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
