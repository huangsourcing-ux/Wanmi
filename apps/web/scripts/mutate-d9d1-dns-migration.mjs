import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationPath = `${repositoryRoot}/apps/web/migrations/20260817_065450_d9d1_dns_record_management.ts`
const verifier = 'scripts/verify-d9d1-dns-migration.mjs'

const mutations = []
const add = (mutation) => mutations.push(mutation)

for (const value of ['add', 'modify', 'delete', 'pause', 'resume']) {
  const values = ['add', 'modify', 'delete', 'pause', 'resume']
  add({
    group: 'migration-up-enum',
    id: `change-operation-${value}`,
    predicate: `DNS change operation enum retains ${value}`,
    search:
      'CREATE TYPE "public"."enum_dns_record_changes_operation" AS ENUM(\'add\', \'modify\', \'delete\', \'pause\', \'resume\');',
    replacement: `CREATE TYPE "public"."enum_dns_record_changes_operation" AS ENUM(${values
      .filter((item) => item !== value)
      .map((item) => `'${item}'`)
      .join(', ')});`,
  })
}

for (const value of ['requested', 'confirmed', 'failed', 'pending_query']) {
  const values = ['requested', 'confirmed', 'failed', 'pending_query']
  add({
    group: 'migration-up-enum',
    id: `change-event-${value}`,
    predicate: `DNS change event enum retains ${value}`,
    search:
      'CREATE TYPE "public"."enum_dns_record_changes_event" AS ENUM(\'requested\', \'confirmed\', \'failed\', \'pending_query\');',
    replacement: `CREATE TYPE "public"."enum_dns_record_changes_event" AS ENUM(${values
      .filter((item) => item !== value)
      .map((item) => `'${item}'`)
      .join(', ')});`,
  })
}

for (const operation of [
  'dns_record_add',
  'dns_record_modify',
  'dns_record_delete',
  'dns_record_pause',
]) {
  add({
    group: 'migration-up-provider-enum',
    id: `provider-operation-${operation}`,
    predicate: `provider operation enum retains ${operation}`,
    search: `  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE '${operation}';\n`,
    replacement: '',
  })
}

for (const [id, column] of [
  ['event-key-required', 'event_key'],
  ['customer-required', 'customer_id'],
  ['asset-required', 'asset_id'],
  ['operation-required', 'operation'],
  ['event-required', 'event'],
  ['occurred-at-required', 'occurred_at'],
  ['updated-at-required', 'updated_at'],
]) {
  const types = {
    asset_id: 'integer',
    created_at: 'timestamp(3) with time zone DEFAULT now()',
    customer_id: 'integer',
    event: '"enum_dns_record_changes_event"',
    event_key: 'varchar',
    occurred_at: 'timestamp(3) with time zone',
    operation: '"enum_dns_record_changes_operation"',
    updated_at: 'timestamp(3) with time zone DEFAULT now()',
  }
  add({
    group: 'migration-up-required-column',
    id,
    predicate: `${column} remains NOT NULL`,
    search: `  \t"${column}" ${types[column]} NOT NULL,\n`,
    replacement: `  \t"${column}" ${types[column]},\n`,
  })
}
add({
  group: 'migration-up-required-column',
  id: 'created-at-required',
  predicate: 'created_at remains NOT NULL',
  search: '  \t"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL\n',
  replacement: '  \t"created_at" timestamp(3) with time zone DEFAULT now()\n',
})

for (const [id, constraint] of [
  [
    'customer-foreign-key',
    '  ALTER TABLE "dns_record_changes" ADD CONSTRAINT "dns_record_changes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
  [
    'asset-foreign-key',
    '  ALTER TABLE "dns_record_changes" ADD CONSTRAINT "dns_record_changes_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
  [
    'provider-operation-foreign-key',
    '  ALTER TABLE "dns_record_changes" ADD CONSTRAINT "dns_record_changes_provider_operation_id_provider_operations_id_fk" FOREIGN KEY ("provider_operation_id") REFERENCES "public"."provider_operations"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
]) {
  add({
    group: 'migration-up-foreign-key',
    id,
    predicate: `${id} remains enforced`,
    search: constraint,
    replacement: '',
  })
}

add({
  group: 'migration-up-unique',
  id: 'event-key-unique',
  predicate: 'event_key remains globally unique',
  search:
    '  CREATE UNIQUE INDEX "dns_record_changes_event_key_idx" ON "dns_record_changes" USING btree ("event_key");\n',
  replacement:
    '  CREATE INDEX "dns_record_changes_event_key_idx" ON "dns_record_changes" USING btree ("event_key");\n',
})

for (const [id, index] of [
  [
    'asset-occurred-index',
    '  CREATE INDEX "asset_occurredAt_idx" ON "dns_record_changes" USING btree ("asset_id","occurred_at");\n',
  ],
  [
    'customer-occurred-index',
    '  CREATE INDEX "customer_occurredAt_1_idx" ON "dns_record_changes" USING btree ("customer_id","occurred_at");\n',
  ],
  [
    'lease-key-index',
    '  CREATE INDEX "domain_assets_dns_mutation_lease_key_idx" ON "domain_assets" USING btree ("dns_mutation_lease_key");',
  ],
]) {
  add({
    group: 'migration-up-index',
    id,
    predicate: `${id} remains present`,
    search: index,
    replacement: '',
  })
}

add({
  changes: [
    {
      search: '  ALTER TABLE "domain_assets" ADD COLUMN "dns_mutation_lease_key" varchar;\n',
      replacement: '',
    },
    {
      search:
        '  CREATE INDEX "domain_assets_dns_mutation_lease_key_idx" ON "domain_assets" USING btree ("dns_mutation_lease_key");',
      replacement: '',
    },
  ],
  group: 'migration-up-domain-state',
  id: 'lease-key-column',
  predicate: 'domain asset lease key column remains present',
})
for (const [id, line] of [
  [
    'lease-expiry-column',
    '  ALTER TABLE "domain_assets" ADD COLUMN "dns_mutation_lease_expires_at" timestamp(3) with time zone;\n',
  ],
  [
    'rate-window-column',
    '  ALTER TABLE "domain_assets" ADD COLUMN "dns_change_window_started_at" timestamp(3) with time zone;\n',
  ],
]) {
  add({
    group: 'migration-up-domain-state',
    id,
    predicate: `${id} remains present`,
    search: line,
    replacement: '',
  })
}
add({
  group: 'migration-up-domain-state',
  id: 'rate-count-default',
  predicate: 'dns_change_count starts at zero',
  search: '  ALTER TABLE "domain_assets" ADD COLUMN "dns_change_count" numeric DEFAULT 0;\n',
  replacement: '  ALTER TABLE "domain_assets" ADD COLUMN "dns_change_count" numeric DEFAULT 1;\n',
})

add({
  group: 'migration-down-cleanup',
  id: 'down-change-table',
  predicate: 'DOWN removes the append-only DNS change table',
  search: '  DROP TABLE "dns_record_changes" CASCADE;\n',
  replacement:
    '  ALTER TABLE "dns_record_changes" ALTER COLUMN "operation" SET DATA TYPE text USING "operation"::text;\n  ALTER TABLE "dns_record_changes" ALTER COLUMN "event" SET DATA TYPE text USING "event"::text;\n',
})
add({
  group: 'migration-down-cleanup',
  id: 'down-dns-provider-operations',
  predicate: 'DOWN deletes DNS provider operations before narrowing the enum',
  search:
    '  DELETE FROM "provider_operations"\n  WHERE "operation"::text IN (\'dns_record_add\', \'dns_record_modify\', \'dns_record_delete\', \'dns_record_pause\');\n',
  replacement:
    '  UPDATE "provider_operations" SET "operation" = \'query\'\n  WHERE "operation"::text IN (\'dns_record_add\', \'dns_record_modify\', \'dns_record_delete\', \'dns_record_pause\');\n',
})

for (const column of [
  'dns_mutation_lease_key',
  'dns_mutation_lease_expires_at',
  'dns_change_window_started_at',
  'dns_change_count',
]) {
  add({
    group: 'migration-down-cleanup',
    id: `down-${column.replaceAll('_', '-')}`,
    predicate: `DOWN removes ${column}`,
    search: `  ALTER TABLE "domain_assets" DROP COLUMN "${column}";\n`,
    replacement: '',
  })
}

for (const name of ['operation']) {
  add({
    group: 'migration-down-cleanup',
    id: `down-change-${name}-enum`,
    predicate: `DOWN removes the DNS change ${name} enum`,
    search: `  DROP TYPE "public"."enum_dns_record_changes_${name}";\n`,
    replacement: '',
  })
}
add({
  group: 'migration-down-cleanup',
  id: 'down-change-event-enum',
  predicate: 'DOWN removes the DNS change event enum',
  search: '  DROP TYPE "public"."enum_dns_record_changes_event";',
  replacement: '',
})

add({
  group: 'migration-down-provider-enum',
  id: 'down-provider-enum-exact',
  predicate: 'DOWN restores the exact pre-D9-D provider operation enum',
  search:
    '  CREATE TYPE "public"."enum_provider_operations_operation" AS ENUM(\'realname\', \'register\', \'renew\', \'refund\', \'nameserver\', \'query\');\n',
  replacement:
    '  CREATE TYPE "public"."enum_provider_operations_operation" AS ENUM(\'realname\', \'register\', \'renew\', \'refund\', \'nameserver\', \'query\', \'dns_record_add\');\n',
})

function occurrences(source, search) {
  return source.split(search).length - 1
}

function applyChange(source, change) {
  return source.replace(change.search, change.replacement)
}

function changesFor(mutation) {
  return mutation.changes ?? [mutation]
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(
      `${mutation.group}\t${mutation.id}\t${mutation.predicate}\t${verifier}\n`,
    )
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}

if (selectors.includes('--validate')) {
  const source = readFileSync(migrationPath, 'utf8')
  let invalid = 0
  for (const mutation of mutations) {
    for (const change of changesFor(mutation)) {
      const found = occurrences(source, change.search)
      if (found !== 1) {
        invalid += 1
        process.stderr.write(
          `MUTATION SETUP FAILED ${mutation.id}: expected 1 occurrence, found ${found}\n`,
        )
      }
    }
  }
  process.stdout.write(`VALIDATED\t${mutations.length - invalid}/${mutations.length}\n`)
  if (invalid) process.exitCode = 1
  process.exit()
}

const selected = selectors.length
  ? mutations.filter((mutation) => selectors.includes(mutation.id))
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-D-1 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const original = readFileSync(migrationPath, 'utf8')
  let mutated = original
  let setupFailed = false
  for (const change of changesFor(mutation)) {
    const found = occurrences(mutated, change.search)
    if (found !== 1) {
      process.stderr.write(
        `MUTATION SETUP FAILED ${mutation.id}: expected 1 occurrence, found ${found}\n`,
      )
      setupFailed = true
      break
    }
    mutated = applyChange(mutated, change)
  }
  if (setupFailed) {
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
  process.stdout.write(`PREDICATE ${mutation.predicate}\n`)
  process.stdout.write(`TEST ${verifier}\nRAW_FAILURE ${failure}\n`)
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
  `\nD9D1_MIGRATION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
