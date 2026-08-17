import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationPath = `${repositoryRoot}/apps/web/migrations/20260817_150002_d9d2_domain_management_sync.ts`
const releaseManifestPath = `${repositoryRoot}/deploy/release-manifest.example.json`
const releasePolicyPath = `${repositoryRoot}/deploy/release-policy.json`
const verifier = 'scripts/verify-d9d2-domain-management-migration.mjs'
const releaseVerifier = 'scripts/verify-d9d2-release-metadata.mjs'
const mutations = []
const add = (mutation) => mutations.push(mutation)

for (const [type, values] of [
  ['enum_domain_assets_upstream_ownership_status', ['confirmed', 'not_owned', 'unknown']],
  ['enum_domain_assets_sync_review_status', ['none', 'matched', 'pending']],
  [
    'enum_domain_management_events_operation',
    [
      'management_password_read',
      'management_password_modify',
      'contact_information_update',
      'template_transfer',
      'certificate_download',
    ],
  ],
  ['enum_domain_management_events_event', ['requested', 'confirmed', 'failed', 'pending_query']],
  ['enum_domain_management_events_contact_type', ['dom_id', 'admin_id', 'tech_id', 'bill_id']],
  [
    'enum_domain_asset_sync_events_outcome',
    ['matched', 'difference', 'not_owned', 'ownership_unknown'],
  ],
  ['enum_domain_asset_sync_events_resolution_status', ['not_required', 'pending']],
]) {
  const declaration = `CREATE TYPE "public"."${type}" AS ENUM(${values.map((value) => `'${value}'`).join(', ')});`
  for (const value of values) {
    const enumMutation = {
      group: 'migration-up-enum',
      id: `${type.replace('enum_', '').replaceAll('_', '-')}-${value.replaceAll('_', '-')}`,
      predicate: `${type} retains ${value}`,
      search: declaration,
      replacement: `CREATE TYPE "public"."${type}" AS ENUM(${values
        .filter((item) => item !== value)
        .map((item) => `'${item}'`)
        .join(', ')});`,
    }
    if (type === 'enum_domain_assets_upstream_ownership_status' && value === 'unknown') {
      enumMutation.changes = [
        { search: enumMutation.search, replacement: enumMutation.replacement },
        {
          search: "DEFAULT 'unknown' NOT NULL;",
          replacement: "DEFAULT 'confirmed' NOT NULL;",
        },
      ]
    }
    if (type === 'enum_domain_assets_sync_review_status' && value === 'none') {
      enumMutation.changes = [
        { search: enumMutation.search, replacement: enumMutation.replacement },
        {
          search: "DEFAULT 'none' NOT NULL;",
          replacement: "DEFAULT 'matched' NOT NULL;",
        },
      ]
    }
    add(enumMutation)
  }
}

for (const operation of [
  'domain_management_password',
  'domain_contact_update',
  'domain_template_transfer',
]) {
  add({
    group: 'migration-up-provider-enum',
    id: `provider-operation-${operation.replaceAll('_', '-')}`,
    predicate: `provider operation enum retains ${operation}`,
    search: `  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE '${operation}';\n`,
    replacement: '',
  })
}
add({
  group: 'migration-up-job-enum',
  id: 'workflow-domain-asset-synchronization',
  predicate: 'Payload Jobs workflow enum retains domainAssetSynchronization before wallet checks',
  search:
    '  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE \'domainAssetSynchronization\' BEFORE \'walletLedgerConsistencyCheck\';\n',
  replacement: '',
})

const requiredColumns = [
  ['domain-management', 'event_key', 'varchar'],
  ['domain-management', 'customer_id', 'integer'],
  ['domain-management', 'asset_id', 'integer'],
  ['domain-management', 'operation', '"enum_domain_management_events_operation"'],
  ['domain-management', 'event', '"enum_domain_management_events_event"'],
  ['domain-management', 'occurred_at', 'timestamp(3) with time zone'],
  ['domain-management', 'updated_at', 'timestamp(3) with time zone DEFAULT now()'],
  ['domain-management', 'created_at', 'timestamp(3) with time zone DEFAULT now()'],
  ['domain-sync', 'event_key', 'varchar'],
  ['domain-sync', 'customer_id', 'integer'],
  ['domain-sync', 'asset_id', 'integer'],
  ['domain-sync', 'outcome', '"enum_domain_asset_sync_events_outcome"'],
  ['domain-sync', 'resolution_status', '"enum_domain_asset_sync_events_resolution_status"'],
  ['domain-sync', 'observed_at', 'timestamp(3) with time zone'],
  ['domain-sync', 'updated_at', 'timestamp(3) with time zone DEFAULT now()'],
  ['domain-sync', 'created_at', 'timestamp(3) with time zone DEFAULT now()'],
]
for (const [table, column, type] of requiredColumns) {
  const trailing = column === 'created_at' ? '\n' : ',\n'
  add({
    group: 'migration-up-required-column',
    id: `${table}-${column.replaceAll('_', '-')}-required`,
    predicate: `${table}.${column} remains NOT NULL`,
    search: `  \t"${column}" ${type} NOT NULL${trailing}`,
    replacement: `  \t"${column}" ${type}${trailing}`,
    occurrence: ['event_key', 'customer_id', 'asset_id', 'updated_at', 'created_at'].includes(
      column,
    )
      ? table === 'domain-management'
        ? 1
        : 2
      : 1,
    expectedOccurrences: [
      'event_key',
      'customer_id',
      'asset_id',
      'updated_at',
      'created_at',
    ].includes(column)
      ? 2
      : 1,
  })
}

for (const [id, constraint] of [
  [
    'management-customer-foreign-key',
    '  ALTER TABLE "domain_management_events" ADD CONSTRAINT "domain_management_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
  [
    'management-asset-foreign-key',
    '  ALTER TABLE "domain_management_events" ADD CONSTRAINT "domain_management_events_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
  [
    'management-template-foreign-key',
    '  ALTER TABLE "domain_management_events" ADD CONSTRAINT "domain_management_events_realname_template_id_realname_templates_id_fk" FOREIGN KEY ("realname_template_id") REFERENCES "public"."realname_templates"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
  [
    'management-provider-operation-foreign-key',
    '  ALTER TABLE "domain_management_events" ADD CONSTRAINT "domain_management_events_provider_operation_id_provider_operations_id_fk" FOREIGN KEY ("provider_operation_id") REFERENCES "public"."provider_operations"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
  [
    'sync-customer-foreign-key',
    '  ALTER TABLE "domain_asset_sync_events" ADD CONSTRAINT "domain_asset_sync_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n',
  ],
  [
    'sync-asset-foreign-key',
    '  ALTER TABLE "domain_asset_sync_events" ADD CONSTRAINT "domain_asset_sync_events_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;\n',
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

for (const table of ['domain_management_events', 'domain_asset_sync_events']) {
  add({
    group: 'migration-up-unique',
    id: `${table.replaceAll('_', '-')}-event-key-unique`,
    predicate: `${table}.event_key remains globally unique`,
    search: `  CREATE UNIQUE INDEX "${table}_event_key_idx" ON "${table}" USING btree ("event_key");\n`,
    replacement: `  CREATE INDEX "${table}_event_key_idx" ON "${table}" USING btree ("event_key");\n`,
  })
}

const domainColumns = [
  [
    'upstream-ownership-status',
    '  ALTER TABLE "domain_assets" ADD COLUMN "upstream_ownership_status" "enum_domain_assets_upstream_ownership_status" DEFAULT \'unknown\' NOT NULL;\n',
  ],
  [
    'sync-review-status',
    '  ALTER TABLE "domain_assets" ADD COLUMN "sync_review_status" "enum_domain_assets_sync_review_status" DEFAULT \'none\' NOT NULL;\n',
  ],
  [
    'sync-version',
    '  ALTER TABLE "domain_assets" ADD COLUMN "sync_version" numeric DEFAULT 0 NOT NULL;\n',
  ],
  [
    'last-ownership-checked-at',
    '  ALTER TABLE "domain_assets" ADD COLUMN "last_ownership_checked_at" timestamp(3) with time zone;\n',
  ],
  [
    'operation-blocked-at',
    '  ALTER TABLE "domain_assets" ADD COLUMN "operation_blocked_at" timestamp(3) with time zone;\n',
  ],
  [
    'operation-block-reason',
    '  ALTER TABLE "domain_assets" ADD COLUMN "operation_block_reason" varchar;\n',
  ],
  [
    'management-lease-key',
    '  ALTER TABLE "domain_assets" ADD COLUMN "domain_management_lease_key" varchar;\n',
  ],
  [
    'management-lease-expires-at',
    '  ALTER TABLE "domain_assets" ADD COLUMN "domain_management_lease_expires_at" timestamp(3) with time zone;\n',
  ],
]
const indexedDomainColumns = {
  'last-ownership-checked-at':
    '  CREATE INDEX "domain_assets_last_ownership_checked_at_idx" ON "domain_assets" USING btree ("last_ownership_checked_at");\n',
  'management-lease-key':
    '  CREATE INDEX "domain_assets_domain_management_lease_key_idx" ON "domain_assets" USING btree ("domain_management_lease_key");',
  'operation-blocked-at':
    '  CREATE INDEX "domain_assets_operation_blocked_at_idx" ON "domain_assets" USING btree ("operation_blocked_at");\n',
}
for (const [id, line] of domainColumns) {
  add({
    changes: [
      { search: line, replacement: '' },
      ...(indexedDomainColumns[id] ? [{ search: indexedDomainColumns[id], replacement: '' }] : []),
    ],
    group: 'migration-up-domain-state',
    id: `domain-state-${id}`,
    predicate: `domain asset ${id} column remains present`,
  })
}
for (const [id, search, replacement] of [
  ['upstream-ownership-default', "DEFAULT 'unknown' NOT NULL;", "DEFAULT 'confirmed' NOT NULL;"],
  ['sync-review-default', "DEFAULT 'none' NOT NULL;", "DEFAULT 'matched' NOT NULL;"],
  [
    'sync-version-default',
    '"sync_version" numeric DEFAULT 0 NOT NULL;',
    '"sync_version" numeric DEFAULT 1 NOT NULL;',
  ],
]) {
  add({
    group: 'migration-up-domain-default',
    id,
    predicate: `${id} remains fail-closed`,
    search,
    replacement,
  })
}
for (const [id, line] of Object.entries(indexedDomainColumns)) {
  add({
    group: 'migration-up-domain-index',
    id: `domain-index-${id}`,
    predicate: `domain asset ${id} index remains present`,
    search: line,
    replacement: '',
  })
}

add({
  group: 'migration-down-cleanup',
  id: 'down-management-events-table',
  predicate: 'DOWN removes domain_management_events',
  search: '  DROP TABLE "domain_management_events" CASCADE;\n',
  replacement:
    '  ALTER TABLE "domain_management_events" ALTER COLUMN "operation" SET DATA TYPE text USING "operation"::text;\n  ALTER TABLE "domain_management_events" ALTER COLUMN "event" SET DATA TYPE text USING "event"::text;\n  ALTER TABLE "domain_management_events" ALTER COLUMN "contact_type" SET DATA TYPE text USING "contact_type"::text;\n',
})
add({
  group: 'migration-down-cleanup',
  id: 'down-sync-events-table',
  predicate: 'DOWN removes domain_asset_sync_events',
  search: '  DROP TABLE "domain_asset_sync_events" CASCADE;\n',
  replacement:
    '  ALTER TABLE "domain_asset_sync_events" ALTER COLUMN "outcome" SET DATA TYPE text USING "outcome"::text;\n  ALTER TABLE "domain_asset_sync_events" ALTER COLUMN "resolution_status" SET DATA TYPE text USING "resolution_status"::text;\n',
})
add({
  group: 'migration-down-cleanup',
  id: 'down-provider-operation-rows',
  predicate: 'DOWN deletes D9-D-2 provider operation rows before narrowing the enum',
  search:
    "  DELETE FROM \"provider_operations\"\n  WHERE \"operation\"::text IN ('domain_management_password', 'domain_contact_update', 'domain_template_transfer');\n",
  replacement:
    "  UPDATE \"provider_operations\" SET \"operation\" = 'query'\n  WHERE \"operation\"::text IN ('domain_management_password', 'domain_contact_update', 'domain_template_transfer');\n",
})
add({
  group: 'migration-down-cleanup',
  id: 'down-synchronization-job-rows',
  predicate: 'DOWN deletes D9-D-2 scheduled job rows before narrowing the enum',
  search:
    '  DELETE FROM "payload_jobs"\n  WHERE "workflow_slug"::text = \'domainAssetSynchronization\';\n',
  replacement:
    '  UPDATE "payload_jobs" SET "workflow_slug" = \'backgroundProbe\'\n  WHERE "workflow_slug"::text = \'domainAssetSynchronization\';\n',
})

for (const [id, column, replacement] of [
  [
    'upstream-ownership-status',
    'upstream_ownership_status',
    '  ALTER TABLE "domain_assets" ALTER COLUMN "upstream_ownership_status" DROP DEFAULT;\n  ALTER TABLE "domain_assets" ALTER COLUMN "upstream_ownership_status" SET DATA TYPE text USING "upstream_ownership_status"::text;\n',
  ],
  [
    'sync-review-status',
    'sync_review_status',
    '  ALTER TABLE "domain_assets" ALTER COLUMN "sync_review_status" DROP DEFAULT;\n  ALTER TABLE "domain_assets" ALTER COLUMN "sync_review_status" SET DATA TYPE text USING "sync_review_status"::text;\n',
  ],
  ['sync-version', 'sync_version', ''],
  ['last-ownership-checked-at', 'last_ownership_checked_at', ''],
  ['operation-blocked-at', 'operation_blocked_at', ''],
  ['operation-block-reason', 'operation_block_reason', ''],
  ['management-lease-key', 'domain_management_lease_key', ''],
  ['management-lease-expires-at', 'domain_management_lease_expires_at', ''],
]) {
  add({
    group: 'migration-down-domain-state',
    id: `down-domain-state-${id}`,
    predicate: `DOWN removes domain_assets.${column}`,
    search: `  ALTER TABLE "domain_assets" DROP COLUMN "${column}";\n`,
    replacement,
  })
}

for (const type of [
  'enum_domain_assets_upstream_ownership_status',
  'enum_domain_assets_sync_review_status',
  'enum_domain_management_events_operation',
  'enum_domain_management_events_event',
  'enum_domain_management_events_contact_type',
  'enum_domain_asset_sync_events_outcome',
  'enum_domain_asset_sync_events_resolution_status',
]) {
  add({
    group: 'migration-down-type-cleanup',
    id: `down-type-${type.replace('enum_', '').replaceAll('_', '-')}`,
    predicate: `DOWN removes ${type}`,
    search: `  DROP TYPE "public"."${type}";${
      type === 'enum_domain_asset_sync_events_resolution_status' ? '' : '\n'
    }`,
    replacement: '',
  })
}
add({
  group: 'migration-down-enum-exact',
  id: 'down-provider-enum-exact',
  predicate: 'DOWN restores the exact pre-D9-D-2 provider operation enum',
  search:
    "  CREATE TYPE \"public\".\"enum_provider_operations_operation\" AS ENUM('realname', 'register', 'renew', 'refund', 'nameserver', 'query', 'dns_record_add', 'dns_record_modify', 'dns_record_delete', 'dns_record_pause');\n",
  replacement:
    "  CREATE TYPE \"public\".\"enum_provider_operations_operation\" AS ENUM('realname', 'register', 'renew', 'refund', 'nameserver', 'query', 'dns_record_add', 'dns_record_modify', 'dns_record_delete', 'dns_record_pause', 'domain_management_password');\n",
})
add({
  group: 'migration-down-enum-exact',
  id: 'down-workflow-enum-exact',
  predicate: 'DOWN restores the exact pre-D9-D-2 Payload Jobs enum',
  search:
    "  CREATE TYPE \"public\".\"enum_payload_jobs_workflow_slug\" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'westdigitalBalanceMonitoring', 'domainExpiryReminders', 'walletLedgerConsistencyCheck', 'commerceFulfillment', 'commerceWorkerHeartbeat', 'nameserverChange', 'wechatRefund', 'paymentTimeoutClose');\n",
  replacement:
    "  CREATE TYPE \"public\".\"enum_payload_jobs_workflow_slug\" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'westdigitalBalanceMonitoring', 'domainExpiryReminders', 'domainAssetSynchronization', 'walletLedgerConsistencyCheck', 'commerceFulfillment', 'commerceWorkerHeartbeat', 'nameserverChange', 'wechatRefund', 'paymentTimeoutClose');\n",
})

const releasePolicyEntry = `    "20260817_150002_d9d2_domain_management_sync": {
      "newCodeCompatibleBeforeUp": true,
      "oldCodeCompatible": true,
      "phase": "expand",
      "reason": "新增域名管理与资产同步追加式记录、上游归属和同步状态、管理互斥列及 provider/Job 枚举；旧代码可忽略新增结构，新代码仅在迁移完成后启用域名管理和同步。",
      "rollback": "retain"
    }`
for (const [id, predicate, replacement] of [
  [
    'release-policy-entry-exact',
    'release policy names the D9-D-2 migration exactly',
    releasePolicyEntry.replace(
      '20260817_150002_d9d2_domain_management_sync',
      '20260817_150002_d9d2_domain_management_sync_missing',
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
      '新增域名管理与资产同步追加式记录、上游归属和同步状态、管理互斥列及 provider/Job 枚举；旧代码可忽略新增结构，新代码仅在迁移完成后启用域名管理和同步。',
      'D9-D-2',
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
  predicate: 'release manifest names the D9-D-2 migration exactly and in order',
  replacement: '    "20260817_150002_d9d2_domain_management_sync_missing"',
  search: '    "20260817_150002_d9d2_domain_management_sync"',
  verifier: releaseVerifier,
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
  process.stderr.write(`No D9-D-2 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const targetPath = mutation.path ?? migrationPath
  const mutationVerifier = mutation.verifier ?? verifier
  const original = readFileSync(targetPath, 'utf8')
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
    writeFileSync(targetPath, mutated, 'utf8')
    result = spawnSync('node', [mutationVerifier], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })
  } finally {
    writeFileSync(targetPath, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const failure = output.split('\n').find((line) => line.includes('AssertionError')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(
    `PREDICATE ${mutation.predicate}\nTEST ${mutationVerifier}\nRAW_FAILURE ${failure}\n`,
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
  `\nD9D2_MIGRATION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
