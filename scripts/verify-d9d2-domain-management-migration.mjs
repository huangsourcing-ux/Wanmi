import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL('../apps/web/migrations/20260817_150002_d9d2_domain_management_sync.ts', import.meta.url),
)
const databaseName = `wanmi_d9d2_domain_migration_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9d2_domain_migration_[0-9]+_[0-9]+$/u)

const source = readFileSync(migrationPath, 'utf8')
const upSql = source.match(
  /export async function up[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
const downSql = source.match(
  /export async function down[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
assert.ok(upSql, 'D9-D-2 migration UP SQL must be extractable')
assert.ok(downSql, 'D9-D-2 migration DOWN SQL must be extractable')
assert.ok(!upSql.includes('${'), 'D9-D-2 migration UP SQL must not interpolate values')
assert.ok(!downSql.includes('${'), 'D9-D-2 migration DOWN SQL must not interpolate values')

const postgres = (args, capture = false) =>
  execFileSync('docker', ['compose', 'exec', '-T', 'postgres', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })

const psql = (statement, capture = false) =>
  postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--set',
      'ON_ERROR_STOP=1',
      '--tuples-only',
      '--no-align',
      '--command',
      statement,
    ],
    capture,
  )

const providerOperations = [
  'realname',
  'register',
  'renew',
  'refund',
  'nameserver',
  'query',
  'dns_record_add',
  'dns_record_modify',
  'dns_record_delete',
  'dns_record_pause',
]
const workflows = [
  'publishingProbe',
  'contentScheduledPublish',
  'backgroundProbe',
  'advertisingMaintenance',
  'smsReceiptReconciliation',
  'realnameCleanup',
  'westdigitalBalanceMonitoring',
  'domainExpiryReminders',
  'walletLedgerConsistencyCheck',
  'commerceFulfillment',
  'commerceWorkerHeartbeat',
  'nameserverChange',
  'wechatRefund',
  'paymentTimeoutClose',
]
const quoted = (values) => values.map((value) => `'${value}'`).join(', ')

const baseSchema = `
CREATE TYPE enum_provider_operations_operation AS ENUM(${quoted(providerOperations)});
CREATE TYPE enum_payload_jobs_workflow_slug AS ENUM(${quoted(workflows)});
CREATE TABLE customers (id serial PRIMARY KEY);
CREATE TABLE realname_templates (id serial PRIMARY KEY);
CREATE TABLE domain_assets (
  id serial PRIMARY KEY,
  updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
  created_at timestamp(3) with time zone DEFAULT now() NOT NULL
);
CREATE TABLE provider_operations (
  id serial PRIMARY KEY,
  operation enum_provider_operations_operation NOT NULL
);
CREATE TABLE payload_jobs (
  id serial PRIMARY KEY,
  workflow_slug enum_payload_jobs_workflow_slug
);
`

function verifyUpSchema(stage) {
  const observed = psql(
    `SELECT
       (to_regclass('public.domain_management_events') IS NOT NULL)::text || ':' ||
       (to_regclass('public.domain_asset_sync_events') IS NOT NULL)::text || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_management_events') || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_management_events'
          AND is_nullable = 'NO') || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_asset_sync_events') || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_asset_sync_events'
          AND is_nullable = 'NO') || ':' ||
       (SELECT count(*)::text FROM pg_constraint
        WHERE conrelid = 'domain_management_events'::regclass AND contype = 'f') || ':' ||
       (SELECT count(*)::text FROM pg_constraint
        WHERE conrelid = 'domain_asset_sync_events'::regclass AND contype = 'f') || ':' ||
       (EXISTS (SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'domain_management_events'
          AND indexname = 'domain_management_events_event_key_idx'
          AND indexdef LIKE 'CREATE UNIQUE INDEX%'))::text || ':' ||
       (EXISTS (SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'domain_asset_sync_events'
          AND indexname = 'domain_asset_sync_events_event_key_idx'
          AND indexdef LIKE 'CREATE UNIQUE INDEX%'))::text || ':' ||
       (to_regclass('public.domain_assets_domain_management_lease_key_idx') IS NOT NULL)::text || ':' ||
       (SELECT count(*)::text FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'domain_assets'
          AND indexname IN (
            'domain_assets_last_ownership_checked_at_idx',
            'domain_assets_operation_blocked_at_idx',
            'domain_assets_domain_management_lease_key_idx'
          )) || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name IN (
            'upstream_ownership_status', 'sync_review_status', 'sync_version',
            'last_ownership_checked_at', 'operation_blocked_at', 'operation_block_reason',
            'domain_management_lease_key', 'domain_management_lease_expires_at'
          )) || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name IN ('upstream_ownership_status', 'sync_review_status', 'sync_version')
          AND is_nullable = 'NO') || ':' ||
       (EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name = 'upstream_ownership_status'
          AND column_default = '''unknown''::enum_domain_assets_upstream_ownership_status'))::text || ':' ||
       (EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name = 'sync_review_status'
          AND column_default = '''none''::enum_domain_assets_sync_review_status'))::text || ':' ||
       (EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name = 'sync_version' AND column_default = '0'))::text || ':' ||
       array_to_string(enum_range(NULL::enum_domain_assets_upstream_ownership_status), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_domain_assets_sync_review_status), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_domain_management_events_operation), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_domain_management_events_event), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_domain_management_events_contact_type), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_domain_asset_sync_events_outcome), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_domain_asset_sync_events_resolution_status), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_provider_operations_operation), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_payload_jobs_workflow_slug), ',')`,
    true,
  ).trim()
  assert.equal(
    observed,
    'true:true:15:9:14:9:4:2:true:true:true:3:8:3:true:true:true:' +
      'confirmed,not_owned,unknown:none,matched,pending:' +
      'management_password_read,management_password_modify,contact_information_update,template_transfer,certificate_download:' +
      'requested,confirmed,failed,pending_query:dom_id,admin_id,tech_id,bill_id:' +
      'matched,difference,not_owned,ownership_unknown:not_required,pending:' +
      `${providerOperations.join(',')},domain_management_password,domain_contact_update,domain_template_transfer:` +
      `${workflows.slice(0, 8).join(',')},domainAssetSynchronization,${workflows.slice(8).join(',')}`,
    `D9-D-2 migration UP schema invalid after ${stage}`,
  )
}

function verifyConstraintBehavior() {
  psql(`
    INSERT INTO customers DEFAULT VALUES;
    INSERT INTO realname_templates DEFAULT VALUES;
    INSERT INTO domain_assets DEFAULT VALUES;
    INSERT INTO provider_operations (operation) VALUES ('query'), ('domain_management_password');
    INSERT INTO payload_jobs (workflow_slug) VALUES ('backgroundProbe'), ('domainAssetSynchronization');
    INSERT INTO domain_management_events (
      event_key, customer_id, asset_id, operation, event,
      realname_template_id, provider_operation_id, occurred_at
    ) VALUES (
      'd9d2-management-event', 1, 1, 'management_password_modify', 'requested', 1, 2, NOW()
    );
    INSERT INTO domain_asset_sync_events (
      event_key, customer_id, asset_id, outcome, resolution_status, observed_at
    ) VALUES ('d9d2-sync-event', 1, 1, 'difference', 'pending', NOW());
  `)
  for (const statement of [
    `INSERT INTO domain_management_events (
      event_key, customer_id, asset_id, operation, event, occurred_at
    ) VALUES ('d9d2-management-event', 1, 1, 'certificate_download', 'confirmed', NOW());`,
    `INSERT INTO domain_asset_sync_events (
      event_key, customer_id, asset_id, outcome, resolution_status, observed_at
    ) VALUES ('d9d2-sync-event', 1, 1, 'matched', 'not_required', NOW());`,
    `INSERT INTO domain_management_events (
      event_key, customer_id, asset_id, operation, event, occurred_at
    ) VALUES ('d9d2-invalid-management-customer', 999, 1, 'certificate_download', 'requested', NOW());`,
    `INSERT INTO domain_management_events (
      event_key, customer_id, asset_id, operation, event, occurred_at
    ) VALUES ('d9d2-invalid-management-asset', 1, 999, 'certificate_download', 'requested', NOW());`,
    `INSERT INTO domain_management_events (
      event_key, customer_id, asset_id, operation, event, realname_template_id, occurred_at
    ) VALUES ('d9d2-invalid-management-template', 1, 1, 'template_transfer', 'requested', 999, NOW());`,
    `INSERT INTO domain_management_events (
      event_key, customer_id, asset_id, operation, event, provider_operation_id, occurred_at
    ) VALUES ('d9d2-invalid-management-provider-operation', 1, 1, 'management_password_modify', 'requested', 999, NOW());`,
    `INSERT INTO domain_asset_sync_events (
      event_key, customer_id, asset_id, outcome, resolution_status, observed_at
    ) VALUES ('d9d2-invalid-sync-customer', 999, 1, 'matched', 'not_required', NOW());`,
    `INSERT INTO domain_asset_sync_events (
      event_key, customer_id, asset_id, outcome, resolution_status, observed_at
    ) VALUES ('d9d2-invalid-sync-asset', 1, 999, 'matched', 'not_required', NOW());`,
  ]) {
    assert.throws(() => psql(statement, true))
  }
}

function verifyDownSchema() {
  const observed = psql(
    `SELECT
       (to_regclass('public.domain_management_events') IS NULL)::text || ':' ||
       (to_regclass('public.domain_asset_sync_events') IS NULL)::text || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name IN (
            'upstream_ownership_status', 'sync_review_status', 'sync_version',
            'last_ownership_checked_at', 'operation_blocked_at', 'operation_block_reason',
            'domain_management_lease_key', 'domain_management_lease_expires_at'
          )) || ':' ||
       (SELECT count(*)::text FROM pg_type
        WHERE typname IN (
          'enum_domain_assets_upstream_ownership_status',
          'enum_domain_assets_sync_review_status',
          'enum_domain_management_events_operation',
          'enum_domain_management_events_event',
          'enum_domain_management_events_contact_type',
          'enum_domain_asset_sync_events_outcome',
          'enum_domain_asset_sync_events_resolution_status'
        )) || ':' ||
       array_to_string(enum_range(NULL::enum_provider_operations_operation), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_payload_jobs_workflow_slug), ',') || ':' ||
       (SELECT count(*)::text FROM provider_operations) || ':' ||
       (SELECT count(*)::text FROM payload_jobs)`,
    true,
  ).trim()
  assert.equal(
    observed,
    `true:true:0:0:${providerOperations.join(',')}:${workflows.join(',')}:1:1`,
    'D9-D-2 migration DOWN must remove only its schema and D9-D-2 enum rows',
  )
}

let created = false
try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  created = true
  psql(baseSchema)
  psql(upSql)
  verifyUpSchema('initial UP')
  verifyConstraintBehavior()
  psql(downSql)
  verifyDownSchema()
  psql(upSql)
  verifyUpSchema('DOWN/UP round trip')
  process.stdout.write(
    'Verified D9-D-2 domain management migration UP constraints, append uniqueness, foreign keys, enum cleanup, DOWN cleanup, and DOWN/UP round trip.\n',
  )
} finally {
  if (created) postgres(['dropdb', '--force', '--username', 'wanmi', databaseName])
}
