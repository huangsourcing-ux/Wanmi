import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL('../apps/web/migrations/20260818_072324_d9c1_domain_center.ts', import.meta.url),
)
const databaseName = `wanmi_d9c1_domain_migration_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9c1_domain_migration_[0-9]+_[0-9]+$/u)

const source = readFileSync(migrationPath, 'utf8')
const upSql = source.match(
  /export async function up[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
const downSql = source.match(
  /export async function down[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
assert.ok(upSql, 'D9-C-1 migration UP SQL must be extractable')
assert.ok(downSql, 'D9-C-1 migration DOWN SQL must be extractable')
assert.ok(!upSql.includes('${'), 'D9-C-1 migration UP SQL must not interpolate values')
assert.ok(!downSql.includes('${'), 'D9-C-1 migration DOWN SQL must not interpolate values')

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
  'dns_record_batch_delete',
  'dns_record_pause',
  'domain_management_password',
  'domain_contact_update',
  'domain_template_transfer',
]
const managementOperations = [
  'management_password_read',
  'management_password_modify',
  'contact_information_update',
  'template_transfer',
  'certificate_download',
]
const quoted = (values) => values.map((value) => `'${value}'`).join(', ')

const baseSchema = `
CREATE TYPE enum_provider_operations_operation AS ENUM(${quoted(providerOperations)});
CREATE TYPE enum_domain_management_events_operation AS ENUM(${quoted(managementOperations)});
CREATE TABLE domain_assets (
  id serial PRIMARY KEY,
  updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
  created_at timestamp(3) with time zone DEFAULT now() NOT NULL
);
CREATE TABLE domain_assets_texts (
  id serial PRIMARY KEY,
  "order" integer NOT NULL,
  parent_id integer NOT NULL REFERENCES domain_assets(id) ON DELETE cascade,
  path varchar NOT NULL,
  text varchar
);
CREATE TABLE provider_operations (
  id serial PRIMARY KEY,
  operation enum_provider_operations_operation NOT NULL
);
CREATE TABLE domain_management_events (
  id serial PRIMARY KEY,
  operation enum_domain_management_events_operation NOT NULL
);
`

function verifyUpSchema(stage) {
  const observed = psql(
    `SELECT
       (to_regclass('public.domain_assets_expiry_reminder_channels') IS NOT NULL)::text || ':' ||
       (to_regclass('public.domain_assets_numbers') IS NOT NULL)::text || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name IN ('domain_lock_status', 'domain_lock_updated_at')) || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_management_events'
          AND column_name IN ('previous_value', 'requested_value', 'requested_locked')) || ':' ||
       (SELECT count(*)::text FROM pg_constraint
        WHERE conrelid IN (
          'domain_assets_expiry_reminder_channels'::regclass,
          'domain_assets_numbers'::regclass
        ) AND contype = 'f') || ':' ||
       (SELECT count(*)::text FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'domain_assets_expiry_reminder_channels_order_idx',
          'domain_assets_expiry_reminder_channels_parent_idx',
          'domain_assets_numbers_order_parent_idx',
          'domain_assets_domain_lock_status_idx',
          'domain_assets_domain_lock_updated_at_idx'
        )) || ':' ||
       (EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name = 'domain_lock_status'
          AND column_default = '''unknown''::enum_domain_assets_domain_lock_status'))::text || ':' ||
       array_to_string(enum_range(NULL::enum_domain_assets_expiry_reminder_channels), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_domain_assets_domain_lock_status), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_provider_operations_operation), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_domain_management_events_operation), ',')`,
    true,
  ).trim()
  assert.equal(
    observed,
    `true:true:2:3:2:5:true:in_app,sms:locked,unlocked,unknown:` +
      `${providerOperations.slice(0, 11).join(',')},domain_lock,${providerOperations.slice(11).join(',')}:` +
      `domain_lock_change,expiry_reminder_preferences_update,${managementOperations.slice(0, 3).join(',')},tags_update,${managementOperations.slice(3).join(',')}`,
    `D9-C-1 migration UP schema invalid after ${stage}`,
  )
}

function seedSliceRows() {
  psql(`
    INSERT INTO domain_assets DEFAULT VALUES;
    INSERT INTO domain_assets_texts ("order", parent_id, path, text)
      VALUES (1, 1, 'nameservers', 'ns1.example'), (2, 1, 'tags', 'production');
    INSERT INTO domain_assets_expiry_reminder_channels ("order", parent_id, value)
      VALUES (1, 1, 'in_app'), (2, 1, 'sms');
    INSERT INTO domain_assets_numbers (number, "order", parent_id, path)
      VALUES (1, 1, 1, 'expiryReminderDays');
    INSERT INTO provider_operations (operation) VALUES ('query'), ('domain_lock');
    INSERT INTO domain_management_events (operation)
      VALUES ('management_password_read'), ('domain_lock_change'),
             ('expiry_reminder_preferences_update'), ('tags_update');
  `)
  assert.throws(() =>
    psql(
      `INSERT INTO domain_assets_expiry_reminder_channels ("order", parent_id, value)
       VALUES (1, 999, 'in_app')`,
      true,
    ),
  )
  assert.throws(() =>
    psql(
      `INSERT INTO domain_assets_numbers (number, "order", parent_id, path)
       VALUES (1, 1, 999, 'expiryReminderDays')`,
      true,
    ),
  )
}

function verifyDownSchema() {
  const observed = psql(
    `SELECT
       (to_regclass('public.domain_assets_expiry_reminder_channels') IS NULL)::text || ':' ||
       (to_regclass('public.domain_assets_numbers') IS NULL)::text || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_assets'
          AND column_name IN ('domain_lock_status', 'domain_lock_updated_at')) || ':' ||
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'domain_management_events'
          AND column_name IN ('previous_value', 'requested_value', 'requested_locked')) || ':' ||
       (SELECT count(*)::text FROM pg_type
        WHERE typname IN (
          'enum_domain_assets_expiry_reminder_channels',
          'enum_domain_assets_domain_lock_status'
        )) || ':' ||
       array_to_string(enum_range(NULL::enum_provider_operations_operation), ',') || ':' ||
       array_to_string(enum_range(NULL::enum_domain_management_events_operation), ',') || ':' ||
       (SELECT count(*)::text FROM provider_operations) || ':' ||
       (SELECT count(*)::text FROM domain_management_events) || ':' ||
       (SELECT count(*)::text FROM domain_assets_texts)`,
    true,
  ).trim()
  assert.equal(
    observed,
    `true:true:0:0:0:${providerOperations.join(',')}:${managementOperations.join(',')}:1:1:1`,
    'D9-C-1 migration DOWN must remove slice schema and only slice enum/tag rows',
  )
}

let created = false
try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  created = true
  psql(baseSchema)
  psql(upSql)
  verifyUpSchema('initial UP')
  seedSliceRows()
  psql(downSql)
  verifyDownSchema()
  psql(upSql)
  verifyUpSchema('DOWN/UP round trip')
  process.stdout.write(
    'Verified D9-C-1 domain-center migration UP defaults, enums, foreign keys, indexes, DOWN data cleanup, and DOWN/UP round trip.\n',
  )
} finally {
  if (created) postgres(['dropdb', '--force', '--username', 'wanmi', databaseName])
}
