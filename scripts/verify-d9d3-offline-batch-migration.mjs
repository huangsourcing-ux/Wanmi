import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL(
    '../apps/web/migrations/20260818_010559_d9d3_offline_batch_operations.ts',
    import.meta.url,
  ),
)
const databaseName = `wanmi_d9d3_batch_migration_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9d3_batch_migration_[0-9]+_[0-9]+$/u)

const source = readFileSync(migrationPath, 'utf8')
const upSql = source.match(
  /export async function up[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
const downSql = source.match(
  /export async function down[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
assert.ok(upSql, 'D9-D-3 migration UP SQL must be extractable')
assert.ok(downSql, 'D9-D-3 migration DOWN SQL must be extractable')
assert.ok(!upSql.includes('${'), 'D9-D-3 migration UP SQL must not interpolate values')
assert.ok(!downSql.includes('${'), 'D9-D-3 migration DOWN SQL must not interpolate values')

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
  'domain_management_password',
  'domain_contact_update',
  'domain_template_transfer',
]
const quoted = (values) => values.map((value) => `'${value}'`).join(', ')

const baseSchema = `
CREATE TYPE enum_provider_operations_operation AS ENUM(${quoted(providerOperations)});
CREATE TABLE customers (id serial PRIMARY KEY);
CREATE TABLE domain_assets (id serial PRIMARY KEY);
CREATE TABLE nameserver_changes (id serial PRIMARY KEY);
CREATE TABLE provider_operations (
  id serial PRIMARY KEY,
  operation enum_provider_operations_operation NOT NULL
);
`

function verifyUp(stage) {
  const headline = psql(
    `SELECT
       (to_regclass('public.domain_batch_operation_events') IS NOT NULL)::text || ':' ||
       (SELECT count(*)::text FROM pg_constraint
        WHERE conrelid = 'domain_batch_operation_events'::regclass AND contype = 'f') || ':' ||
       (EXISTS (SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'domain_batch_operation_events'
          AND indexname = 'domain_batch_operation_events_event_key_idx'
          AND indexdef LIKE 'CREATE UNIQUE INDEX%'))::text || ':' ||
       (EXISTS (SELECT 1 FROM unnest(enum_range(NULL::enum_provider_operations_operation)) value
        WHERE value::text = 'dns_record_batch_delete'))::text || ':' ||
       array_to_string(enum_range(NULL::enum_domain_batch_operation_events_event), ',');`,
    true,
  ).trim()
  assert.equal(
    headline,
    'true:3:true:true:requested,pending_query,confirmed,failed',
    `D9-D-3 migration ${stage} schema mismatch: ${headline}`,
  )

  const columns = psql(
    `SELECT string_agg(column_name || ':' || is_nullable, ',' ORDER BY ordinal_position)
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'domain_batch_operation_events';`,
    true,
  ).trim()
  assert.equal(
    columns,
    'id:NO,event_key:NO,batch_key:NO,item_key:NO,customer_id:NO,asset_id:NO,nameserver_change_id:NO,operation:NO,event:NO,reason_code:YES,occurred_at:NO,trace_id:YES,updated_at:NO,created_at:NO',
    `D9-D-3 migration ${stage} column nullability mismatch: ${columns}`,
  )

  const operationValues = psql(
    `SELECT array_to_string(enum_range(NULL::enum_domain_batch_operation_events_operation), ',');`,
    true,
  ).trim()
  assert.equal(
    operationValues,
    'nameserver_change',
    `D9-D-3 migration ${stage} operation enum mismatch: ${operationValues}`,
  )

  const foreignKeys = psql(
    `SELECT string_agg(conname, ',' ORDER BY conname)
     FROM pg_constraint
     WHERE conrelid = 'domain_batch_operation_events'::regclass AND contype = 'f';`,
    true,
  ).trim()
  assert.equal(
    foreignKeys,
    'domain_batch_operation_events_asset_id_domain_assets_id_fk,domain_batch_operation_events_customer_id_customers_id_fk,domain_batch_operation_events_nameserver_change_id_nameserver_c',
    `D9-D-3 migration ${stage} foreign keys mismatch: ${foreignKeys}`,
  )

  const indexes = psql(
    `SELECT string_agg(indexname, ',' ORDER BY indexname)
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'domain_batch_operation_events';`,
    true,
  ).trim()
  assert.equal(
    indexes,
    'batchKey_occurredAt_idx,customer_occurredAt_3_idx,domain_batch_operation_events_asset_idx,domain_batch_operation_events_batch_key_idx,domain_batch_operation_events_created_at_idx,domain_batch_operation_events_customer_idx,domain_batch_operation_events_event_key_idx,domain_batch_operation_events_item_key_idx,domain_batch_operation_events_nameserver_change_idx,domain_batch_operation_events_occurred_at_idx,domain_batch_operation_events_pkey,domain_batch_operation_events_reason_code_idx,domain_batch_operation_events_trace_id_idx,domain_batch_operation_events_updated_at_idx',
    `D9-D-3 migration ${stage} indexes mismatch: ${indexes}`,
  )
}

try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  psql(baseSchema)
  psql(upSql)
  verifyUp('up')
  psql(downSql)
  const downObserved = psql(
    `SELECT
       (to_regclass('public.domain_batch_operation_events') IS NULL)::text || ':' ||
       (NOT EXISTS (SELECT 1 FROM unnest(enum_range(NULL::enum_provider_operations_operation)) value
        WHERE value::text = 'dns_record_batch_delete'))::text || ':' ||
       (to_regtype('public.enum_domain_batch_operation_events_operation') IS NULL)::text || ':' ||
       (to_regtype('public.enum_domain_batch_operation_events_event') IS NULL)::text;`,
    true,
  ).trim()
  assert.equal(
    downObserved,
    'true:true:true:true',
    `D9-D-3 migration down mismatch: ${downObserved}`,
  )
  psql(upSql)
  verifyUp('re-up')
  console.log('D9-D-3 offline batch migration up/down/re-up verification passed')
} finally {
  postgres(['dropdb', '--username', 'wanmi', '--if-exists', databaseName])
}
