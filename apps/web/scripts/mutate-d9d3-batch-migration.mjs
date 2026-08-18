import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationPath = `${repositoryRoot}/apps/web/migrations/20260818_010559_d9d3_offline_batch_operations.ts`
const verifier = 'scripts/verify-d9d3-offline-batch-migration.mjs'
const releaseManifestPath = `${repositoryRoot}/deploy/release-manifest.example.json`
const releasePolicyPath = `${repositoryRoot}/deploy/release-policy.json`
const releaseVerifier = 'scripts/verify-d9d3-release-metadata.mjs'
const mutations = []
const add = (mutation) => mutations.push(mutation)

add({
  group: 'migration-up-enum',
  id: 'operation-nameserver-change',
  predicate: 'batch event operation enum retains nameserver_change',
  search:
    'CREATE TYPE "public"."enum_domain_batch_operation_events_operation" AS ENUM(\'nameserver_change\');',
  replacement:
    'CREATE TYPE "public"."enum_domain_batch_operation_events_operation" AS ENUM(\'nameserver_change_mutated\');',
})

const eventValues = ['requested', 'pending_query', 'confirmed', 'failed']
const eventDeclaration = `CREATE TYPE "public"."enum_domain_batch_operation_events_event" AS ENUM(${eventValues
  .map((value) => `'${value}'`)
  .join(', ')});`
for (const value of eventValues) {
  add({
    group: 'migration-up-enum',
    id: `event-${value.replaceAll('_', '-')}`,
    predicate: `batch event enum retains ${value}`,
    search: eventDeclaration,
    replacement: `CREATE TYPE "public"."enum_domain_batch_operation_events_event" AS ENUM(${eventValues
      .filter((item) => item !== value)
      .map((item) => `'${item}'`)
      .join(', ')});`,
  })
}

add({
  group: 'migration-up-enum',
  id: 'provider-operation-dns-record-batch-delete',
  predicate: 'provider operation enum retains dns_record_batch_delete',
  search:
    '  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE \'dns_record_batch_delete\' BEFORE \'dns_record_pause\';\n',
  replacement: '',
})

for (const [column, type, trailing = ','] of [
  ['event_key', 'varchar'],
  ['batch_key', 'varchar'],
  ['item_key', 'varchar'],
  ['customer_id', 'integer'],
  ['asset_id', 'integer'],
  ['nameserver_change_id', 'integer'],
  ['operation', '"enum_domain_batch_operation_events_operation"'],
  ['event', '"enum_domain_batch_operation_events_event"'],
  ['occurred_at', 'timestamp(3) with time zone'],
  ['updated_at', 'timestamp(3) with time zone DEFAULT now()'],
  ['created_at', 'timestamp(3) with time zone DEFAULT now()', ''],
]) {
  add({
    group: 'migration-up-nullability',
    id: `${column.replaceAll('_', '-')}-required`,
    predicate: `domain_batch_operation_events.${column} remains NOT NULL`,
    search: `\t"${column}" ${type} NOT NULL${trailing}`,
    replacement: `\t"${column}" ${type}${trailing}`,
  })
}

for (const [id, line] of [
  [
    'customer-foreign-key',
    '  ALTER TABLE "domain_batch_operation_events" ADD CONSTRAINT "domain_batch_operation_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
  [
    'asset-foreign-key',
    '  ALTER TABLE "domain_batch_operation_events" ADD CONSTRAINT "domain_batch_operation_events_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
  [
    'nameserver-change-foreign-key',
    '  ALTER TABLE "domain_batch_operation_events" ADD CONSTRAINT "domain_batch_operation_events_nameserver_change_id_nameserver_changes_id_fk" FOREIGN KEY ("nameserver_change_id") REFERENCES "public"."nameserver_changes"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
]) {
  add({
    group: 'migration-up-foreign-key',
    id,
    predicate: `${id} remains enforced`,
    search: line,
    replacement: '',
  })
}

add({
  group: 'migration-up-unique',
  id: 'event-key-unique',
  predicate: 'append-only event_key remains globally unique',
  search:
    '  CREATE UNIQUE INDEX "domain_batch_operation_events_event_key_idx" ON "domain_batch_operation_events" USING btree ("event_key");\n',
  replacement:
    '  CREATE INDEX "domain_batch_operation_events_event_key_idx" ON "domain_batch_operation_events" USING btree ("event_key");\n',
})

for (const [id, line] of [
  [
    'batch-key-index',
    '  CREATE INDEX "domain_batch_operation_events_batch_key_idx" ON "domain_batch_operation_events" USING btree ("batch_key");\n',
  ],
  [
    'item-key-index',
    '  CREATE INDEX "domain_batch_operation_events_item_key_idx" ON "domain_batch_operation_events" USING btree ("item_key");\n',
  ],
  [
    'customer-index',
    '  CREATE INDEX "domain_batch_operation_events_customer_idx" ON "domain_batch_operation_events" USING btree ("customer_id");\n',
  ],
  [
    'asset-index',
    '  CREATE INDEX "domain_batch_operation_events_asset_idx" ON "domain_batch_operation_events" USING btree ("asset_id");\n',
  ],
  [
    'nameserver-change-index',
    '  CREATE INDEX "domain_batch_operation_events_nameserver_change_idx" ON "domain_batch_operation_events" USING btree ("nameserver_change_id");\n',
  ],
  [
    'reason-code-index',
    '  CREATE INDEX "domain_batch_operation_events_reason_code_idx" ON "domain_batch_operation_events" USING btree ("reason_code");\n',
  ],
  [
    'occurred-at-index',
    '  CREATE INDEX "domain_batch_operation_events_occurred_at_idx" ON "domain_batch_operation_events" USING btree ("occurred_at");\n',
  ],
  [
    'trace-id-index',
    '  CREATE INDEX "domain_batch_operation_events_trace_id_idx" ON "domain_batch_operation_events" USING btree ("trace_id");\n',
  ],
  [
    'updated-at-index',
    '  CREATE INDEX "domain_batch_operation_events_updated_at_idx" ON "domain_batch_operation_events" USING btree ("updated_at");\n',
  ],
  [
    'created-at-index',
    '  CREATE INDEX "domain_batch_operation_events_created_at_idx" ON "domain_batch_operation_events" USING btree ("created_at");\n',
  ],
  [
    'batch-occurred-at-index',
    '  CREATE INDEX "batchKey_occurredAt_idx" ON "domain_batch_operation_events" USING btree ("batch_key","occurred_at");\n',
  ],
  [
    'customer-occurred-at-index',
    '  CREATE INDEX "customer_occurredAt_3_idx" ON "domain_batch_operation_events" USING btree ("customer_id","occurred_at");',
  ],
]) {
  add({
    group: 'migration-up-index',
    id,
    predicate: `${id} remains present`,
    search: line,
    replacement: '',
  })
}

add({
  group: 'migration-down-cleanup',
  id: 'down-events-table',
  predicate: 'DOWN removes domain_batch_operation_events',
  search: '   DROP TABLE "domain_batch_operation_events" CASCADE;\n',
  replacement:
    '   ALTER TABLE "domain_batch_operation_events" ALTER COLUMN "operation" SET DATA TYPE text USING "operation"::text;\n  ALTER TABLE "domain_batch_operation_events" ALTER COLUMN "event" SET DATA TYPE text USING "event"::text;\n',
})
add({
  group: 'migration-down-cleanup',
  id: 'down-provider-enum-exact',
  predicate: 'DOWN restores the exact pre-D9-D-3 provider operation enum',
  search:
    "  CREATE TYPE \"public\".\"enum_provider_operations_operation\" AS ENUM('realname', 'register', 'renew', 'refund', 'nameserver', 'query', 'dns_record_add', 'dns_record_modify', 'dns_record_delete', 'dns_record_pause', 'domain_management_password', 'domain_contact_update', 'domain_template_transfer');\n",
  replacement:
    "  CREATE TYPE \"public\".\"enum_provider_operations_operation\" AS ENUM('realname', 'register', 'renew', 'refund', 'nameserver', 'query', 'dns_record_add', 'dns_record_modify', 'dns_record_delete', 'dns_record_batch_delete', 'dns_record_pause', 'domain_management_password', 'domain_contact_update', 'domain_template_transfer');\n",
})
for (const type of [
  'enum_domain_batch_operation_events_operation',
  'enum_domain_batch_operation_events_event',
]) {
  add({
    group: 'migration-down-cleanup',
    id: `down-type-${type.replace('enum_', '').replaceAll('_', '-')}`,
    predicate: `DOWN removes ${type}`,
    search: `  DROP TYPE "public"."${type}";${type.endsWith('_event') ? '' : '\n'}`,
    replacement: '',
  })
}

const releasePolicyEntry = `    "20260818_010559_d9d3_offline_batch_operations": {
      "newCodeCompatibleBeforeUp": true,
      "oldCodeCompatible": true,
      "phase": "expand",
      "reason": "新增批量 Name Server 追加式事件表与 DNS 离线批量删除 provider 操作枚举；旧代码可忽略新增结构，新代码仅在迁移完成后启用离线任务和批量入口。",
      "rollback": "retain"
    }`
for (const [id, predicate, replacement] of [
  [
    'release-policy-entry-exact',
    'release policy names the D9-D-3 migration exactly',
    releasePolicyEntry.replace(
      '20260818_010559_d9d3_offline_batch_operations',
      '20260818_010559_d9d3_offline_batch_operations_missing',
    ),
  ],
  [
    'release-policy-new-code-compatible-before-up',
    'new code requires D9-D-3 schema before promotion',
    releasePolicyEntry.replace(
      '"newCodeCompatibleBeforeUp": true',
      '"newCodeCompatibleBeforeUp": false',
    ),
  ],
  [
    'release-policy-old-code-compatible',
    'additive D9-D-3 schema remains compatible with old code',
    releasePolicyEntry.replace('"oldCodeCompatible": true', '"oldCodeCompatible": false'),
  ],
  [
    'release-policy-expand-phase',
    'additive D9-D-3 migration remains classified as expand',
    releasePolicyEntry.replace('"phase": "expand"', '"phase": "data"'),
  ],
  [
    'release-policy-specific-reason',
    'release policy retains the D9-D-3 compatibility reason',
    releasePolicyEntry.replace(
      '新增批量 Name Server 追加式事件表与 DNS 离线批量删除 provider 操作枚举；旧代码可忽略新增结构，新代码仅在迁移完成后启用离线任务和批量入口。',
      'D9-D-3',
    ),
  ],
  [
    'release-policy-retain-rollback',
    'expand rollback retains the additive D9-D-3 migration',
    releasePolicyEntry.replace('"rollback": "retain"', '"rollback": "down"'),
  ],
]) {
  add({
    group: 'release-metadata',
    id,
    path: releasePolicyPath,
    predicate,
    replacement,
    search: releasePolicyEntry,
    verifier: releaseVerifier,
  })
}
add({
  group: 'release-metadata',
  id: 'release-manifest-entry-exact',
  path: releaseManifestPath,
  predicate: 'release manifest names the D9-D-3 migration exactly and in order',
  replacement: '    "20260818_010559_d9d3_offline_batch_operations_missing"',
  search: '    "20260818_010559_d9d3_offline_batch_operations"',
  verifier: releaseVerifier,
})

function occurrences(source, search) {
  return source.split(search).length - 1
}

function mutateSource(source, mutation) {
  const found = occurrences(source, mutation.search)
  if (found !== 1) throw new Error(`expected 1 occurrence, found ${found}`)
  return source.replace(mutation.search, mutation.replacement)
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(
      `${mutation.group}\t${mutation.id}\t${mutation.predicate}\t${mutation.verifier ?? verifier}\n`,
    )
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of mutations) {
    try {
      mutateSource(readFileSync(mutation.path ?? migrationPath, 'utf8'), mutation)
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
  process.stderr.write(`No D9-D-3 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const targetPath = mutation.path ?? migrationPath
  const mutationVerifier = mutation.verifier ?? verifier
  const original = readFileSync(targetPath, 'utf8')
  let result
  try {
    writeFileSync(targetPath, mutateSource(original, mutation), 'utf8')
    result = spawnSync('node', [mutationVerifier], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })
  } finally {
    writeFileSync(targetPath, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const assertion = output.split('\n').find((line) => line.includes('AssertionError')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(
    `PREDICATE ${mutation.predicate}\nTEST ${mutationVerifier}\nRAW_FAILURE ${assertion}\n`,
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
  `\nD9D3_MIGRATION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
