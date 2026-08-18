import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const migrationPath = `${repositoryRoot}/apps/web/migrations/20260818_121910_d9c2_automatic_renewal.ts`
const migrationVerifier = 'scripts/verify-d9c2-automatic-renewal-migration.mjs'
const releasePolicyPath = `${repositoryRoot}/deploy/release-policy.json`
const releaseManifestPath = `${repositoryRoot}/deploy/release-manifest.example.json`
const releaseVerifier = 'scripts/verify-d9c2-release-metadata.mjs'
const packageJsonPath = `${repositoryRoot}/package.json`
const mutations = []
const add = (mutation) =>
  mutations.push({ path: migrationPath, verifier: migrationVerifier, ...mutation })

const enumMutation = (id, declaration, from, to = `${from}_mutated`, changes = []) =>
  add({
    changes: [
      { search: declaration, replacement: declaration.replace(`'${from}'`, `'${to}'`) },
      ...changes,
    ],
    group: 'migration-up-enum',
    id,
    predicate: `${from} remains an exact persisted enum value`,
  })

const reminderValues = [
  'expiry',
  'automatic_renewal_enabled',
  'automatic_renewal_due',
  'automatic_renewal_balance_insufficient',
  'automatic_renewal_price_changed',
  'automatic_renewal_blocked',
]
const reminderDeclaration = `CREATE TYPE "public"."enum_domain_expiry_reminders_notice_type" AS ENUM(${reminderValues.map((value) => `'${value}'`).join(', ')});`
for (const value of reminderValues) {
  enumMutation(
    `notice-${value.replaceAll('_', '-')}`,
    reminderDeclaration,
    value,
    `${value}_mutated`,
    value === 'expiry'
      ? [
          {
            search: `"enum_domain_expiry_reminders_notice_type" DEFAULT 'expiry' NOT NULL`,
            replacement: `"enum_domain_expiry_reminders_notice_type" DEFAULT 'expiry_mutated' NOT NULL`,
          },
        ]
      : [],
  )
}

enumMutation(
  'mandate-scope-renew-one-year',
  `CREATE TYPE "public"."enum_renewal_mandates_scope" AS ENUM('renew_one_year');`,
  'renew_one_year',
)
enumMutation(
  'mandate-currency-cny',
  `CREATE TYPE "public"."enum_renewal_mandates_currency" AS ENUM('CNY');`,
  'CNY',
)
const mandateEventDeclaration = `CREATE TYPE "public"."enum_renewal_mandates_event_type" AS ENUM('authorized', 'revoked');`
for (const value of ['authorized', 'revoked']) {
  enumMutation(`mandate-event-${value}`, mandateEventDeclaration, value)
}

const executionEvents = [
  'attempt_claimed',
  'balance_insufficient',
  'price_changed',
  'order_queued',
  'skipped_invalid_mandate',
  'skipped_account_restricted',
  'skipped_identity_cooldown',
  'skipped_not_owned',
  'skipped_domain_status',
  'skipped_job_revalidation',
]
const executionEventDeclaration = `CREATE TYPE "public"."enum_automatic_renewal_events_event_type" AS ENUM(${executionEvents.map((value) => `'${value}'`).join(', ')});`
for (const value of executionEvents) {
  enumMutation(`execution-event-${value.replaceAll('_', '-')}`, executionEventDeclaration, value)
}

for (const [id, line] of [
  [
    'sms-step-up-purpose-extension',
    `  ALTER TYPE "public"."enum_sms_challenges_step_up_purpose" ADD VALUE 'renewal_mandate_change' BEFORE 'account_deletion';\n`,
  ],
  [
    'grant-purpose-extension',
    `  ALTER TYPE "public"."enum_step_up_grants_purpose" ADD VALUE 'renewal_mandate_change' BEFORE 'account_deletion';\n`,
  ],
  [
    'automatic-renewal-workflow-extension',
    `  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'automaticRenewalScheduling' BEFORE 'commerceWorkerHeartbeat';\n`,
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

for (const [table, fields] of [
  [
    'renewal_mandates',
    [
      ['mandate_key', 'varchar'],
      ['customer_id', 'integer'],
      ['asset_id', 'integer'],
      ['domain_ascii_snapshot', 'varchar'],
      ['scope', '"enum_renewal_mandates_scope"'],
      ['max_debit_fen', 'numeric'],
      ['currency', '"enum_renewal_mandates_currency"'],
      ['authorized_at', 'timestamp(3) with time zone'],
      ['valid_until', 'timestamp(3) with time zone'],
      ['rules_version', 'varchar'],
      ['revision', 'numeric'],
      ['event_type', '"enum_renewal_mandates_event_type"'],
      ['step_up_grant_id', 'varchar'],
      ['preview_digest', 'varchar'],
      ['created_trace_id', 'varchar'],
      ['updated_at', 'timestamp(3) with time zone DEFAULT now()'],
      ['created_at', 'timestamp(3) with time zone DEFAULT now()'],
    ],
  ],
  [
    'automatic_renewal_events',
    [
      ['event_key', 'varchar'],
      ['customer_id', 'integer'],
      ['asset_id', 'integer'],
      ['mandate_id', 'integer'],
      ['expires_at_snapshot', 'timestamp(3) with time zone'],
      ['event_type', '"enum_automatic_renewal_events_event_type"'],
      ['occurred_at', 'timestamp(3) with time zone'],
      ['updated_at', 'timestamp(3) with time zone DEFAULT now()'],
      ['created_at', 'timestamp(3) with time zone DEFAULT now()'],
    ],
  ],
]) {
  for (const [field, type] of fields) {
    add({
      group: 'migration-up-nullability',
      id: `${table.replaceAll('_', '-')}-${field.replaceAll('_', '-')}-required`,
      predicate: `${table}.${field} remains required`,
      search: `\t"${field}" ${type} NOT NULL`,
      replacement: `\t"${field}" ${type}`,
      expectedOccurrences: ['customer_id', 'asset_id', 'updated_at', 'created_at'].includes(field)
        ? 2
        : 1,
      occurrence:
        table === 'automatic_renewal_events' &&
        ['customer_id', 'asset_id', 'updated_at', 'created_at'].includes(field)
          ? 2
          : 1,
    })
  }
}

for (const [id, search, replacement] of [
  [
    'mandate-revoked-at-type',
    `\t"revoked_at" timestamp(3) with time zone,`,
    `\t"revoked_at" date,`,
  ],
  ['execution-attempt-key-type', `\t"attempt_key" varchar,`, `\t"attempt_key" text,`],
  [
    'execution-attempt-slot-type',
    `\t"attempt_slot_days" numeric,`,
    `\t"attempt_slot_days" varchar,`,
  ],
  ['execution-amount-type', `\t"amount_fen" numeric,`, `\t"amount_fen" varchar,`],
  [
    'execution-authorized-max-type',
    `\t"authorized_max_amount_fen" numeric,`,
    `\t"authorized_max_amount_fen" varchar,`,
  ],
  [
    'execution-available-balance-type',
    `\t"available_balance_fen" numeric,`,
    `\t"available_balance_fen" varchar,`,
  ],
  ['execution-reason-code-type', `\t"reason_code" varchar,`, `\t"reason_code" text,`],
  ['execution-trace-id-type', `\t"trace_id" varchar,`, `\t"trace_id" text,`],
  [
    'order-attempt-key-type',
    `  ALTER TABLE "orders" ADD COLUMN "automatic_renewal_attempt_key" varchar;`,
    `  ALTER TABLE "orders" ADD COLUMN "automatic_renewal_attempt_key" text;`,
  ],
  [
    'order-rules-version-type',
    `  ALTER TABLE "orders" ADD COLUMN "automatic_renewal_rules_version" varchar;`,
    `  ALTER TABLE "orders" ADD COLUMN "automatic_renewal_rules_version" text;`,
  ],
  [
    'order-hold-key-type',
    `  ALTER TABLE "orders" ADD COLUMN "balance_hold_transaction_key" varchar;`,
    `  ALTER TABLE "orders" ADD COLUMN "balance_hold_transaction_key" text;`,
  ],
  [
    'reminder-notice-type-source',
    `  ALTER TABLE "domain_expiry_reminders" ADD COLUMN "notice_type" "enum_domain_expiry_reminders_notice_type" DEFAULT 'expiry' NOT NULL;`,
    `  ALTER TABLE "domain_expiry_reminders" ADD COLUMN "notice_type" varchar DEFAULT 'expiry' NOT NULL;`,
  ],
  [
    'reminder-amount-type',
    `  ALTER TABLE "domain_expiry_reminders" ADD COLUMN "amount_fen" numeric;`,
    `  ALTER TABLE "domain_expiry_reminders" ADD COLUMN "amount_fen" varchar;`,
  ],
  [
    'reminder-authorized-max-type',
    `  ALTER TABLE "domain_expiry_reminders" ADD COLUMN "authorized_max_amount_fen" numeric;`,
    `  ALTER TABLE "domain_expiry_reminders" ADD COLUMN "authorized_max_amount_fen" varchar;`,
  ],
]) {
  add({
    group: 'migration-up-column-type',
    id,
    predicate: `${id} remains exact`,
    replacement,
    search,
  })
}

for (const [id, line] of [
  [
    'mandate-customer-fk',
    `  ALTER TABLE "renewal_mandates" ADD CONSTRAINT "renewal_mandates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n`,
  ],
  [
    'mandate-asset-fk',
    `  ALTER TABLE "renewal_mandates" ADD CONSTRAINT "renewal_mandates_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;\n`,
  ],
  [
    'mandate-previous-fk',
    `  ALTER TABLE "renewal_mandates" ADD CONSTRAINT "renewal_mandates_previous_mandate_id_renewal_mandates_id_fk" FOREIGN KEY ("previous_mandate_id") REFERENCES "public"."renewal_mandates"("id") ON DELETE set null ON UPDATE no action;\n`,
  ],
  [
    'event-customer-fk',
    `  ALTER TABLE "automatic_renewal_events" ADD CONSTRAINT "automatic_renewal_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n`,
  ],
  [
    'event-asset-fk',
    `  ALTER TABLE "automatic_renewal_events" ADD CONSTRAINT "automatic_renewal_events_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;\n`,
  ],
  [
    'event-mandate-fk',
    `  ALTER TABLE "automatic_renewal_events" ADD CONSTRAINT "automatic_renewal_events_mandate_id_renewal_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."renewal_mandates"("id") ON DELETE set null ON UPDATE no action;\n`,
  ],
  [
    'event-order-fk',
    `  ALTER TABLE "automatic_renewal_events" ADD CONSTRAINT "automatic_renewal_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;\n`,
  ],
  [
    'order-mandate-fk',
    `  ALTER TABLE "orders" ADD CONSTRAINT "orders_automatic_renewal_mandate_id_renewal_mandates_id_fk" FOREIGN KEY ("automatic_renewal_mandate_id") REFERENCES "public"."renewal_mandates"("id") ON DELETE set null ON UPDATE no action;\n`,
  ],
  [
    'reminder-mandate-fk',
    `  ALTER TABLE "domain_expiry_reminders" ADD CONSTRAINT "domain_expiry_reminders_mandate_id_renewal_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."renewal_mandates"("id") ON DELETE set null ON UPDATE no action;\n`,
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

const indexLines = [
  [
    'renewal-mandate-key',
    `  CREATE INDEX "renewal_mandates_mandate_key_idx" ON "renewal_mandates" USING btree ("mandate_key");\n`,
  ],
  [
    'renewal-customer',
    `  CREATE INDEX "renewal_mandates_customer_idx" ON "renewal_mandates" USING btree ("customer_id");\n`,
  ],
  [
    'renewal-asset',
    `  CREATE INDEX "renewal_mandates_asset_idx" ON "renewal_mandates" USING btree ("asset_id");\n`,
  ],
  [
    'renewal-domain',
    `  CREATE INDEX "renewal_mandates_domain_ascii_snapshot_idx" ON "renewal_mandates" USING btree ("domain_ascii_snapshot");\n`,
  ],
  [
    'renewal-authorized-at',
    `  CREATE INDEX "renewal_mandates_authorized_at_idx" ON "renewal_mandates" USING btree ("authorized_at");\n`,
  ],
  [
    'renewal-valid-until',
    `  CREATE INDEX "renewal_mandates_valid_until_idx" ON "renewal_mandates" USING btree ("valid_until");\n`,
  ],
  [
    'renewal-revoked-at',
    `  CREATE INDEX "renewal_mandates_revoked_at_idx" ON "renewal_mandates" USING btree ("revoked_at");\n`,
  ],
  [
    'renewal-previous',
    `  CREATE INDEX "renewal_mandates_previous_mandate_idx" ON "renewal_mandates" USING btree ("previous_mandate_id");\n`,
  ],
  [
    'renewal-updated-at',
    `  CREATE INDEX "renewal_mandates_updated_at_idx" ON "renewal_mandates" USING btree ("updated_at");\n`,
  ],
  [
    'renewal-created-at',
    `  CREATE INDEX "renewal_mandates_created_at_idx" ON "renewal_mandates" USING btree ("created_at");\n`,
  ],
  [
    'renewal-asset-revision-unique',
    `  CREATE UNIQUE INDEX "asset_revision_idx" ON "renewal_mandates" USING btree ("asset_id","revision");\n`,
  ],
  [
    'renewal-customer-authorized',
    `  CREATE INDEX "customer_authorizedAt_idx" ON "renewal_mandates" USING btree ("customer_id","authorized_at");\n`,
  ],
  [
    'event-key-unique',
    `  CREATE UNIQUE INDEX "automatic_renewal_events_event_key_idx" ON "automatic_renewal_events" USING btree ("event_key");\n`,
  ],
  [
    'event-customer',
    `  CREATE INDEX "automatic_renewal_events_customer_idx" ON "automatic_renewal_events" USING btree ("customer_id");\n`,
  ],
  [
    'event-asset',
    `  CREATE INDEX "automatic_renewal_events_asset_idx" ON "automatic_renewal_events" USING btree ("asset_id");\n`,
  ],
  [
    'event-mandate',
    `  CREATE INDEX "automatic_renewal_events_mandate_idx" ON "automatic_renewal_events" USING btree ("mandate_id");\n`,
  ],
  [
    'event-attempt-key',
    `  CREATE INDEX "automatic_renewal_events_attempt_key_idx" ON "automatic_renewal_events" USING btree ("attempt_key");\n`,
  ],
  [
    'event-expires-at',
    `  CREATE INDEX "automatic_renewal_events_expires_at_snapshot_idx" ON "automatic_renewal_events" USING btree ("expires_at_snapshot");\n`,
  ],
  [
    'event-order',
    `  CREATE INDEX "automatic_renewal_events_order_idx" ON "automatic_renewal_events" USING btree ("order_id");\n`,
  ],
  [
    'event-reason',
    `  CREATE INDEX "automatic_renewal_events_reason_code_idx" ON "automatic_renewal_events" USING btree ("reason_code");\n`,
  ],
  [
    'event-occurred-at',
    `  CREATE INDEX "automatic_renewal_events_occurred_at_idx" ON "automatic_renewal_events" USING btree ("occurred_at");\n`,
  ],
  [
    'event-trace',
    `  CREATE INDEX "automatic_renewal_events_trace_id_idx" ON "automatic_renewal_events" USING btree ("trace_id");\n`,
  ],
  [
    'event-updated-at',
    `  CREATE INDEX "automatic_renewal_events_updated_at_idx" ON "automatic_renewal_events" USING btree ("updated_at");\n`,
  ],
  [
    'event-created-at',
    `  CREATE INDEX "automatic_renewal_events_created_at_idx" ON "automatic_renewal_events" USING btree ("created_at");\n`,
  ],
  [
    'event-asset-cycle',
    `  CREATE INDEX "asset_expiresAtSnapshot_1_idx" ON "automatic_renewal_events" USING btree ("asset_id","expires_at_snapshot");\n`,
  ],
  [
    'event-customer-time',
    `  CREATE INDEX "customer_occurredAt_4_idx" ON "automatic_renewal_events" USING btree ("customer_id","occurred_at");\n`,
  ],
  [
    'order-mandate',
    `  CREATE INDEX "orders_automatic_renewal_mandate_idx" ON "orders" USING btree ("automatic_renewal_mandate_id");\n`,
  ],
  [
    'order-attempt-unique',
    `  CREATE UNIQUE INDEX "orders_automatic_renewal_attempt_key_idx" ON "orders" USING btree ("automatic_renewal_attempt_key");\n`,
  ],
  [
    'order-hold-key',
    `  CREATE INDEX "orders_balance_hold_transaction_key_idx" ON "orders" USING btree ("balance_hold_transaction_key");\n`,
  ],
  [
    'reminder-mandate',
    `  CREATE INDEX "domain_expiry_reminders_mandate_idx" ON "domain_expiry_reminders" USING btree ("mandate_id");\n`,
  ],
  [
    'reminder-asset-notice-cycle',
    `  CREATE INDEX "asset_noticeType_expiresAtSnapshot_idx" ON "domain_expiry_reminders" USING btree ("asset_id","notice_type","expires_at_snapshot");`,
  ],
]
for (const [id, line] of indexLines) {
  const unique = line.includes('CREATE UNIQUE INDEX')
  add({
    group: unique ? 'migration-up-unique-index' : 'migration-up-index',
    id,
    predicate: `${id} index remains ${unique ? 'unique' : 'present'}`,
    search: line,
    replacement: unique ? line.replace('CREATE UNIQUE INDEX', 'CREATE INDEX') : '',
  })
}

add({
  changes: [
    {
      search: `  DROP TABLE "automatic_renewal_events";\n`,
      replacement:
        `  ALTER TABLE "automatic_renewal_events" DROP CONSTRAINT "automatic_renewal_events_mandate_id_renewal_mandates_id_fk";\n` +
        `  ALTER TABLE "automatic_renewal_events" ALTER COLUMN "event_type" SET DATA TYPE text USING "event_type"::text;\n` +
        `  TRUNCATE TABLE "automatic_renewal_events";\n`,
    },
    {
      search: `  DROP TYPE "public"."enum_automatic_renewal_events_event_type";`,
      replacement: '',
    },
  ],
  group: 'migration-down-cleanup',
  id: 'down-execution-events-table',
  predicate: 'DOWN removes the automatic renewal execution event table',
})
add({
  changes: [
    {
      search: `  DROP TABLE "renewal_mandates";\n`,
      replacement:
        `  ALTER TABLE "renewal_mandates" DROP CONSTRAINT "renewal_mandates_previous_mandate_id_renewal_mandates_id_fk";\n` +
        `  ALTER TABLE "renewal_mandates" ALTER COLUMN "scope" SET DATA TYPE text USING "scope"::text;\n` +
        `  ALTER TABLE "renewal_mandates" ALTER COLUMN "currency" SET DATA TYPE text USING "currency"::text;\n` +
        `  ALTER TABLE "renewal_mandates" ALTER COLUMN "event_type" SET DATA TYPE text USING "event_type"::text;\n` +
        `  TRUNCATE TABLE "renewal_mandates";\n`,
    },
    { search: `  DROP TYPE "public"."enum_renewal_mandates_scope";\n`, replacement: '' },
    { search: `  DROP TYPE "public"."enum_renewal_mandates_currency";\n`, replacement: '' },
    { search: `  DROP TYPE "public"."enum_renewal_mandates_event_type";\n`, replacement: '' },
  ],
  group: 'migration-down-cleanup',
  id: 'down-renewal-mandates-table',
  predicate: 'DOWN removes the immutable renewal mandate table',
})

for (const [table, column, coupled = []] of [
  ['orders', 'automatic_renewal_mandate_id'],
  ['orders', 'automatic_renewal_attempt_key'],
  ['orders', 'automatic_renewal_rules_version'],
  ['orders', 'balance_hold_transaction_key'],
  [
    'domain_expiry_reminders',
    'notice_type',
    [`  DROP TYPE "public"."enum_domain_expiry_reminders_notice_type";\n`],
  ],
  ['domain_expiry_reminders', 'mandate_id'],
  ['domain_expiry_reminders', 'amount_fen'],
  ['domain_expiry_reminders', 'authorized_max_amount_fen'],
]) {
  add({
    changes: [
      {
        search: `  ALTER TABLE "${table}" DROP COLUMN "${column}";\n`,
        replacement: `  ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT;\n`,
      },
      ...coupled.map((search) => ({ search, replacement: '' })),
    ],
    group: 'migration-down-cleanup',
    id: `down-${table.replaceAll('_', '-')}-${column.replaceAll('_', '-')}`,
    predicate: `DOWN removes ${table}.${column}`,
  })
}

for (const type of [
  'enum_domain_expiry_reminders_notice_type',
  'enum_renewal_mandates_scope',
  'enum_renewal_mandates_currency',
  'enum_renewal_mandates_event_type',
  'enum_automatic_renewal_events_event_type',
]) {
  add({
    group: 'migration-down-cleanup',
    id: `down-type-${type.replace('enum_', '').replaceAll('_', '-')}`,
    predicate: `DOWN removes ${type}`,
    search: `  DROP TYPE "public"."${type}";${type === 'enum_automatic_renewal_events_event_type' ? '' : '\n'}`,
    replacement: '',
  })
}

for (const [id, search, replacement] of [
  [
    'down-sms-purpose-exact',
    `  CREATE TYPE "public"."enum_sms_challenges_step_up_purpose" AS ENUM('dns_record_change', 'nameserver_change', 'mx_record_change', 'dns_bulk_delete', 'domain_lock_change', 'realname_change', 'domain_management_password', 'balance_spend', 'account_deletion');\n`,
    `  CREATE TYPE "public"."enum_sms_challenges_step_up_purpose" AS ENUM('dns_record_change', 'nameserver_change', 'mx_record_change', 'dns_bulk_delete', 'domain_lock_change', 'realname_change', 'domain_management_password', 'balance_spend', 'renewal_mandate_change', 'account_deletion');\n`,
  ],
  [
    'down-grant-purpose-exact',
    `  CREATE TYPE "public"."enum_step_up_grants_purpose" AS ENUM('dns_record_change', 'nameserver_change', 'mx_record_change', 'dns_bulk_delete', 'domain_lock_change', 'realname_change', 'domain_management_password', 'balance_spend', 'account_deletion');\n`,
    `  CREATE TYPE "public"."enum_step_up_grants_purpose" AS ENUM('dns_record_change', 'nameserver_change', 'mx_record_change', 'dns_bulk_delete', 'domain_lock_change', 'realname_change', 'domain_management_password', 'balance_spend', 'renewal_mandate_change', 'account_deletion');\n`,
  ],
  [
    'down-workflow-exact',
    `  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'westdigitalBalanceMonitoring', 'domainExpiryReminders', 'domainAssetSynchronization', 'walletLedgerConsistencyCheck', 'commerceFulfillment', 'commerceWorkerHeartbeat', 'nameserverChange', 'wechatRefund', 'paymentTimeoutClose');\n`,
    `  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'westdigitalBalanceMonitoring', 'domainExpiryReminders', 'domainAssetSynchronization', 'walletLedgerConsistencyCheck', 'commerceFulfillment', 'automaticRenewalScheduling', 'commerceWorkerHeartbeat', 'nameserverChange', 'wechatRefund', 'paymentTimeoutClose');\n`,
  ],
]) {
  add({
    group: 'migration-down-enum',
    id,
    predicate: `${id} restores the exact prior enum`,
    replacement,
    search,
  })
}

const releasePolicyEntry = `    "20260818_121910_d9c2_automatic_renewal": {
      "newCodeCompatibleBeforeUp": true,
      "oldCodeCompatible": true,
      "phase": "expand",
      "reason": "新增自动续费授权与执行事件表、订单授权快照、到期提醒扩展及调度工作流枚举；旧代码可忽略新增结构，新代码必须在迁移完成后启用授权和无人值守执行。",
      "rollback": "retain"
    }`
for (const [id, predicate, replacement] of [
  [
    'release-policy-name',
    'release policy names the D9-C-2 migration exactly',
    releasePolicyEntry.replace(
      '20260818_121910_d9c2_automatic_renewal',
      '20260818_121910_d9c2_missing',
    ),
  ],
  [
    'release-new-code-before-up',
    'new code requires D9-C-2 schema before promotion',
    releasePolicyEntry.replace(
      '"newCodeCompatibleBeforeUp": true',
      '"newCodeCompatibleBeforeUp": false',
    ),
  ],
  [
    'release-old-code-compatible',
    'the additive schema remains compatible with old code',
    releasePolicyEntry.replace('"oldCodeCompatible": true', '"oldCodeCompatible": false'),
  ],
  [
    'release-expand-phase',
    'D9-C-2 remains classified as expand',
    releasePolicyEntry.replace('"phase": "expand"', '"phase": "data"'),
  ],
  [
    'release-specific-reason',
    'release policy retains the specific D9-C-2 compatibility reason',
    releasePolicyEntry.replace(
      '新增自动续费授权与执行事件表、订单授权快照、到期提醒扩展及调度工作流枚举；旧代码可忽略新增结构，新代码必须在迁移完成后启用授权和无人值守执行。',
      'D9-C-2',
    ),
  ],
  [
    'release-retain-rollback',
    'expand rollback retains the additive D9-C-2 migration',
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
  id: 'release-manifest-name',
  path: releaseManifestPath,
  predicate: 'release manifest names D9-C-2 exactly and in order',
  search: '    "20260818_121910_d9c2_automatic_renewal"',
  replacement: '    "20260818_121910_d9c2_missing"',
  verifier: releaseVerifier,
})
for (const [id, predicate, search] of [
  [
    'migration-gate-wiring',
    'the unified migration gate executes the D9-C-2 behavior verifier',
    ' && node scripts/verify-d9c2-automatic-renewal-migration.mjs',
  ],
  [
    'release-gate-wiring',
    'the unified release gate executes the D9-C-2 metadata verifier',
    ' && node scripts/verify-d9c2-release-metadata.mjs',
  ],
]) {
  add({
    group: 'gate-wiring',
    id,
    path: packageJsonPath,
    predicate,
    replacement: '',
    search,
    verifier: releaseVerifier,
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

function mutateSource(source, mutation) {
  let result = source
  for (const change of mutation.changes ?? [mutation]) {
    const found = occurrences(result, change.search)
    const expected = change.expectedOccurrences ?? mutation.expectedOccurrences ?? 1
    if (found !== expected) {
      throw new Error(
        `expected ${expected} occurrences of ${JSON.stringify(change.search)}, found ${found}`,
      )
    }
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
      `${mutation.group}\t${mutation.id}\t${mutation.predicate}\t${mutation.verifier}\n`,
    )
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of mutations) {
    try {
      mutateSource(readFileSync(mutation.path, 'utf8'), mutation)
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
  process.stderr.write(`No D9-C-2 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const original = readFileSync(mutation.path, 'utf8')
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
    writeFileSync(mutation.path, mutated, 'utf8')
    result = spawnSync(process.execPath, [mutation.verifier], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
    })
  } finally {
    writeFileSync(mutation.path, original, 'utf8')
  }
  const output = stripAnsi(`${result?.stdout ?? ''}${result?.stderr ?? ''}`)
  const failure = output.split('\n').find((line) => line.includes('AssertionError')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(
    `PREDICATE ${mutation.predicate}\nTEST ${mutation.verifier}\nRAW_FAILURE ${failure}\n`,
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
  `\nD9C2_MIGRATION_MUTATION_MATRIX_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`,
)
if (failed) process.exitCode = 1
