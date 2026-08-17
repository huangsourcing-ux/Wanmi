import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL(
    '../apps/web/migrations/20260817_065450_d9d1_dns_record_management.ts',
    import.meta.url,
  ),
)
const databaseName = `wanmi_d9d1_dns_migration_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9d1_dns_migration_[0-9]+_[0-9]+$/u)

const source = readFileSync(migrationPath, 'utf8')
const upSql = source.match(
  /export async function up[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
const downSql = source.match(
  /export async function down[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
assert.ok(upSql, 'D9-D-1 migration UP SQL must be extractable')
assert.ok(downSql, 'D9-D-1 migration DOWN SQL must be extractable')
assert.ok(!upSql.includes('${'), 'D9-D-1 migration UP SQL must not interpolate values')
assert.ok(!downSql.includes('${'), 'D9-D-1 migration DOWN SQL must not interpolate values')

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

const baseSchema = `
CREATE TYPE enum_provider_operations_operation AS ENUM(
  'realname', 'register', 'renew', 'refund', 'nameserver', 'query'
);
CREATE TABLE customers (id serial PRIMARY KEY);
CREATE TABLE domain_assets (
  id serial PRIMARY KEY,
  updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
  created_at timestamp(3) with time zone DEFAULT now() NOT NULL
);
CREATE TABLE provider_operations (
  id serial PRIMARY KEY,
  operation enum_provider_operations_operation NOT NULL
);
`

function verifyUpSchema(stage) {
  const observed = psql(
    `SELECT
       (to_regclass('public.dns_record_changes') IS NOT NULL)::text || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dns_record_changes') || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dns_record_changes'
          AND is_nullable = 'NO') || ':' ||
       (SELECT count(*)::text FROM pg_constraint
        WHERE conrelid = 'dns_record_changes'::regclass AND contype = 'f') || ':' ||
       (EXISTS (SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'dns_record_changes'
          AND indexname = 'dns_record_changes_event_key_idx'
          AND indexdef LIKE 'CREATE UNIQUE INDEX%'))::text || ':' ||
       (to_regclass('public."asset_occurredAt_idx"') IS NOT NULL)::text || ':' ||
       (to_regclass('public."customer_occurredAt_1_idx"') IS NOT NULL)::text || ':' ||
       (to_regclass('public.domain_assets_dns_mutation_lease_key_idx') IS NOT NULL)::text || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name IN (
            'dns_mutation_lease_key', 'dns_mutation_lease_expires_at',
            'dns_change_window_started_at', 'dns_change_count'
          )) || ':' ||
       (EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name = 'dns_change_count' AND data_type = 'numeric'
          AND column_default = '0'::text))::text || ':' ||
       array_to_string(enum_range(NULL::enum_dns_record_changes_operation), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_dns_record_changes_event), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_provider_operations_operation), ',')`,
    true,
  ).trim()
  assert.equal(
    observed,
    'true:18:9:3:true:true:true:true:4:true:add,modify,delete,pause,resume:requested,confirmed,failed,pending_query:realname,register,renew,refund,nameserver,query,dns_record_add,dns_record_modify,dns_record_delete,dns_record_pause',
    `D9-D-1 migration UP schema invalid after ${stage}`,
  )
}

function verifyConstraintBehavior() {
  psql(`
    INSERT INTO customers DEFAULT VALUES;
    INSERT INTO domain_assets DEFAULT VALUES;
    INSERT INTO provider_operations (operation) VALUES ('dns_record_delete');
    INSERT INTO dns_record_changes (
      event_key, customer_id, asset_id, operation, event,
      provider_operation_id, occurred_at
    ) VALUES ('d9d1-migration-event', 1, 1, 'delete', 'requested', 1, NOW());
  `)
  assert.throws(
    () =>
      psql(
        `INSERT INTO dns_record_changes (
          event_key, customer_id, asset_id, operation, event, occurred_at
        ) VALUES ('d9d1-migration-event', 1, 1, 'add', 'confirmed', NOW());`,
        true,
      ),
    'D9-D-1 event key uniqueness must reject a duplicate append event',
  )
  assert.throws(
    () =>
      psql(
        `INSERT INTO dns_record_changes (
          event_key, customer_id, asset_id, operation, event, occurred_at
        ) VALUES ('d9d1-invalid-owner', 999, 1, 'add', 'requested', NOW());`,
        true,
      ),
    'D9-D-1 customer foreign key must reject an unknown owner',
  )
  assert.throws(
    () =>
      psql(
        `INSERT INTO dns_record_changes (
          event_key, customer_id, asset_id, operation, event, occurred_at
        ) VALUES ('d9d1-invalid-asset', 1, 999, 'add', 'requested', NOW());`,
        true,
      ),
    'D9-D-1 asset foreign key must reject an unknown domain asset',
  )
}

function verifyDownSchema() {
  const observed = psql(
    `SELECT
       (to_regclass('public.dns_record_changes') IS NULL)::text || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name IN (
            'dns_mutation_lease_key', 'dns_mutation_lease_expires_at',
            'dns_change_window_started_at', 'dns_change_count'
          )) || ':' ||
       (to_regtype('public.enum_dns_record_changes_operation') IS NULL)::text || ':' ||
       (to_regtype('public.enum_dns_record_changes_event') IS NULL)::text || ':' ||
       array_to_string(enum_range(NULL::enum_provider_operations_operation), ',') || ':' ||
       (SELECT count(*)::text FROM provider_operations)`,
    true,
  ).trim()
  assert.equal(
    observed,
    'true:0:true:true:realname,register,renew,refund,nameserver,query:0',
    'D9-D-1 migration DOWN must remove only its schema and DNS provider operations',
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
    'Verified D9-D-1 DNS migration UP constraints, append uniqueness, foreign keys, DOWN cleanup, and DOWN/UP round trip.\n',
  )
} finally {
  if (created) {
    postgres(['dropdb', '--force', '--username', 'wanmi', databaseName])
  }
}
