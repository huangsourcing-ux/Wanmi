import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL('../apps/web/migrations/20260818_121910_d9c2_automatic_renewal.ts', import.meta.url),
)
const databaseName = `wanmi_d9c2_renewal_migration_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9c2_renewal_migration_[0-9]+_[0-9]+$/u)

const source = readFileSync(migrationPath, 'utf8')
const upSql = source.match(
  /export async function up[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
const downSql = source.match(
  /export async function down[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
assert.ok(upSql, 'D9-C-2 migration UP SQL must be extractable')
assert.ok(downSql, 'D9-C-2 migration DOWN SQL must be extractable')
assert.ok(!upSql.includes('${'), 'D9-C-2 migration UP SQL must not interpolate values')
assert.ok(!downSql.includes('${'), 'D9-C-2 migration DOWN SQL must not interpolate values')

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

const quoted = (values) => values.map((value) => `'${value}'`).join(', ')
const stepUpPurposes = [
  'dns_record_change',
  'nameserver_change',
  'mx_record_change',
  'dns_bulk_delete',
  'domain_lock_change',
  'realname_change',
  'domain_management_password',
  'balance_spend',
  'account_deletion',
]
const workflowSlugs = [
  'publishingProbe',
  'contentScheduledPublish',
  'backgroundProbe',
  'advertisingMaintenance',
  'smsReceiptReconciliation',
  'realnameCleanup',
  'westdigitalBalanceMonitoring',
  'domainExpiryReminders',
  'domainAssetSynchronization',
  'walletLedgerConsistencyCheck',
  'commerceFulfillment',
  'commerceWorkerHeartbeat',
  'nameserverChange',
  'wechatRefund',
  'paymentTimeoutClose',
]

const baseSchema = `
CREATE TYPE enum_sms_challenges_step_up_purpose AS ENUM(${quoted(stepUpPurposes)});
CREATE TYPE enum_step_up_grants_purpose AS ENUM(${quoted(stepUpPurposes)});
CREATE TYPE enum_payload_jobs_workflow_slug AS ENUM(${quoted(workflowSlugs)});
CREATE TABLE customers (id serial PRIMARY KEY);
CREATE TABLE domain_assets (id serial PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers(id));
CREATE TABLE orders (id serial PRIMARY KEY);
CREATE TABLE domain_expiry_reminders (
  id serial PRIMARY KEY,
  asset_id integer NOT NULL REFERENCES domain_assets(id),
  expires_at_snapshot timestamp(3) with time zone NOT NULL
);
CREATE TABLE sms_challenges (id serial PRIMARY KEY, step_up_purpose enum_sms_challenges_step_up_purpose);
CREATE TABLE step_up_grants (id serial PRIMARY KEY, purpose enum_step_up_grants_purpose NOT NULL);
CREATE TABLE payload_jobs (id serial PRIMARY KEY, workflow_slug enum_payload_jobs_workflow_slug);
`

const enumValues = (type) =>
  psql(`SELECT array_to_string(enum_range(NULL::${type}), ',');`, true).trim()

const columns = (table) =>
  psql(
    `SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY ordinal_position)
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = '${table}';`,
    true,
  ).trim()

function verifyUp(stage) {
  assert.equal(
    enumValues('enum_domain_expiry_reminders_notice_type'),
    'expiry,automatic_renewal_enabled,automatic_renewal_due,automatic_renewal_balance_insufficient,automatic_renewal_price_changed,automatic_renewal_blocked',
    `D9-C-2 migration ${stage} reminder notice enum mismatch`,
  )
  assert.equal(
    enumValues('enum_renewal_mandates_scope'),
    'renew_one_year',
    `D9-C-2 migration ${stage} mandate scope mismatch`,
  )
  assert.equal(
    enumValues('enum_renewal_mandates_currency'),
    'CNY',
    `D9-C-2 migration ${stage} mandate currency mismatch`,
  )
  assert.equal(
    enumValues('enum_renewal_mandates_event_type'),
    'authorized,revoked',
    `D9-C-2 migration ${stage} mandate event enum mismatch`,
  )
  assert.equal(
    enumValues('enum_automatic_renewal_events_event_type'),
    'attempt_claimed,balance_insufficient,price_changed,order_queued,skipped_invalid_mandate,skipped_account_restricted,skipped_identity_cooldown,skipped_not_owned,skipped_domain_status,skipped_job_revalidation',
    `D9-C-2 migration ${stage} execution event enum mismatch`,
  )
  assert.equal(
    enumValues('enum_sms_challenges_step_up_purpose'),
    [...stepUpPurposes.slice(0, -1), 'renewal_mandate_change', stepUpPurposes.at(-1)].join(','),
    `D9-C-2 migration ${stage} SMS step-up enum mismatch`,
  )
  assert.equal(
    enumValues('enum_step_up_grants_purpose'),
    [...stepUpPurposes.slice(0, -1), 'renewal_mandate_change', stepUpPurposes.at(-1)].join(','),
    `D9-C-2 migration ${stage} grant purpose enum mismatch`,
  )
  assert.equal(
    enumValues('enum_payload_jobs_workflow_slug'),
    [...workflowSlugs.slice(0, 11), 'automaticRenewalScheduling', ...workflowSlugs.slice(11)].join(
      ',',
    ),
    `D9-C-2 migration ${stage} workflow enum mismatch`,
  )

  assert.equal(
    columns('renewal_mandates'),
    'id:integer:NO,mandate_key:character varying:NO,customer_id:integer:NO,asset_id:integer:NO,domain_ascii_snapshot:character varying:NO,scope:USER-DEFINED:NO,max_debit_fen:numeric:NO,currency:USER-DEFINED:NO,authorized_at:timestamp with time zone:NO,valid_until:timestamp with time zone:NO,rules_version:character varying:NO,revision:numeric:NO,event_type:USER-DEFINED:NO,revoked_at:timestamp with time zone:YES,previous_mandate_id:integer:YES,step_up_grant_id:character varying:NO,preview_digest:character varying:NO,created_trace_id:character varying:NO,updated_at:timestamp with time zone:NO,created_at:timestamp with time zone:NO',
    `D9-C-2 migration ${stage} mandate columns mismatch`,
  )
  assert.equal(
    columns('automatic_renewal_events'),
    'id:integer:NO,event_key:character varying:NO,customer_id:integer:NO,asset_id:integer:NO,mandate_id:integer:NO,attempt_key:character varying:YES,attempt_slot_days:numeric:YES,expires_at_snapshot:timestamp with time zone:NO,event_type:USER-DEFINED:NO,amount_fen:numeric:YES,authorized_max_amount_fen:numeric:YES,available_balance_fen:numeric:YES,order_id:integer:YES,reason_code:character varying:YES,occurred_at:timestamp with time zone:NO,trace_id:character varying:YES,updated_at:timestamp with time zone:NO,created_at:timestamp with time zone:NO',
    `D9-C-2 migration ${stage} execution event columns mismatch`,
  )

  const extensions = psql(
    `SELECT string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable,
       ',' ORDER BY table_name, ordinal_position)
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'orders' AND column_name IN (
         'automatic_renewal_mandate_id','automatic_renewal_attempt_key',
         'automatic_renewal_rules_version','balance_hold_transaction_key'))
       OR (table_name = 'domain_expiry_reminders' AND column_name IN (
         'notice_type','mandate_id','amount_fen','authorized_max_amount_fen')));`,
    true,
  ).trim()
  assert.equal(
    extensions,
    'domain_expiry_reminders.notice_type:USER-DEFINED:NO,domain_expiry_reminders.mandate_id:integer:YES,domain_expiry_reminders.amount_fen:numeric:YES,domain_expiry_reminders.authorized_max_amount_fen:numeric:YES,orders.automatic_renewal_mandate_id:integer:YES,orders.automatic_renewal_attempt_key:character varying:YES,orders.automatic_renewal_rules_version:character varying:YES,orders.balance_hold_transaction_key:character varying:YES',
    `D9-C-2 migration ${stage} extension columns mismatch`,
  )

  const foreignKeys = psql(
    `SELECT string_agg(conrelid::regclass::text || ':' || conname || ':' || confdeltype::text,
       ',' ORDER BY conrelid::regclass::text, conname)
     FROM pg_constraint
     WHERE contype = 'f' AND conname IN (
       'renewal_mandates_customer_id_customers_id_fk',
       'renewal_mandates_asset_id_domain_assets_id_fk',
       'renewal_mandates_previous_mandate_id_renewal_mandates_id_fk',
       'automatic_renewal_events_customer_id_customers_id_fk',
       'automatic_renewal_events_asset_id_domain_assets_id_fk',
       'automatic_renewal_events_mandate_id_renewal_mandates_id_fk',
       'automatic_renewal_events_order_id_orders_id_fk',
       'orders_automatic_renewal_mandate_id_renewal_mandates_id_fk',
       'domain_expiry_reminders_mandate_id_renewal_mandates_id_fk');`,
    true,
  ).trim()
  assert.equal(
    foreignKeys,
    'automatic_renewal_events:automatic_renewal_events_asset_id_domain_assets_id_fk:n,automatic_renewal_events:automatic_renewal_events_customer_id_customers_id_fk:n,automatic_renewal_events:automatic_renewal_events_mandate_id_renewal_mandates_id_fk:n,automatic_renewal_events:automatic_renewal_events_order_id_orders_id_fk:n,domain_expiry_reminders:domain_expiry_reminders_mandate_id_renewal_mandates_id_fk:n,orders:orders_automatic_renewal_mandate_id_renewal_mandates_id_fk:n,renewal_mandates:renewal_mandates_asset_id_domain_assets_id_fk:n,renewal_mandates:renewal_mandates_customer_id_customers_id_fk:n,renewal_mandates:renewal_mandates_previous_mandate_id_renewal_mandates_id_fk:n',
    `D9-C-2 migration ${stage} foreign keys mismatch`,
  )

  const indexes = psql(
    `SELECT string_agg(tablename || ':' || indexname || ':' ||
       (indexdef LIKE 'CREATE UNIQUE INDEX%')::text, ',' ORDER BY tablename, indexname)
     FROM pg_indexes
     WHERE schemaname = 'public' AND (
       tablename IN ('renewal_mandates','automatic_renewal_events')
       OR indexname IN (
         'orders_automatic_renewal_mandate_idx',
         'orders_automatic_renewal_attempt_key_idx','orders_balance_hold_transaction_key_idx',
         'domain_expiry_reminders_mandate_idx','asset_noticeType_expiresAtSnapshot_idx'));`,
    true,
  ).trim()
  assert.equal(
    indexes,
    'automatic_renewal_events:asset_expiresAtSnapshot_1_idx:false,automatic_renewal_events:automatic_renewal_events_asset_idx:false,automatic_renewal_events:automatic_renewal_events_attempt_key_idx:false,automatic_renewal_events:automatic_renewal_events_created_at_idx:false,automatic_renewal_events:automatic_renewal_events_customer_idx:false,automatic_renewal_events:automatic_renewal_events_event_key_idx:true,automatic_renewal_events:automatic_renewal_events_expires_at_snapshot_idx:false,automatic_renewal_events:automatic_renewal_events_mandate_idx:false,automatic_renewal_events:automatic_renewal_events_occurred_at_idx:false,automatic_renewal_events:automatic_renewal_events_order_idx:false,automatic_renewal_events:automatic_renewal_events_pkey:true,automatic_renewal_events:automatic_renewal_events_reason_code_idx:false,automatic_renewal_events:automatic_renewal_events_trace_id_idx:false,automatic_renewal_events:automatic_renewal_events_updated_at_idx:false,automatic_renewal_events:customer_occurredAt_4_idx:false,domain_expiry_reminders:asset_noticeType_expiresAtSnapshot_idx:false,domain_expiry_reminders:domain_expiry_reminders_mandate_idx:false,orders:orders_automatic_renewal_attempt_key_idx:true,orders:orders_automatic_renewal_mandate_idx:false,orders:orders_balance_hold_transaction_key_idx:false,renewal_mandates:asset_revision_idx:true,renewal_mandates:customer_authorizedAt_idx:false,renewal_mandates:renewal_mandates_asset_idx:false,renewal_mandates:renewal_mandates_authorized_at_idx:false,renewal_mandates:renewal_mandates_created_at_idx:false,renewal_mandates:renewal_mandates_customer_idx:false,renewal_mandates:renewal_mandates_domain_ascii_snapshot_idx:false,renewal_mandates:renewal_mandates_mandate_key_idx:false,renewal_mandates:renewal_mandates_pkey:true,renewal_mandates:renewal_mandates_previous_mandate_idx:false,renewal_mandates:renewal_mandates_revoked_at_idx:false,renewal_mandates:renewal_mandates_updated_at_idx:false,renewal_mandates:renewal_mandates_valid_until_idx:false',
    `D9-C-2 migration ${stage} indexes mismatch`,
  )
}

try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  psql(baseSchema)
  psql(upSql)
  verifyUp('up')
  psql(`
    INSERT INTO customers DEFAULT VALUES;
    INSERT INTO domain_assets (customer_id) VALUES (1);
    INSERT INTO orders DEFAULT VALUES;
    INSERT INTO renewal_mandates (
      mandate_key, customer_id, asset_id, domain_ascii_snapshot, scope, max_debit_fen,
      currency, authorized_at, valid_until, rules_version, revision, event_type,
      step_up_grant_id, preview_digest, created_trace_id
    ) VALUES (
      'mandate-1', 1, 1, 'example.com', 'renew_one_year', 3500, 'CNY', NOW(),
      NOW() + INTERVAL '1 year', '2026-08-18.1', 1, 'authorized', 'grant-1', 'digest', 'trace'
    );
    INSERT INTO automatic_renewal_events (
      event_key, customer_id, asset_id, mandate_id, expires_at_snapshot, event_type,
      occurred_at, trace_id
    ) VALUES ('event-1', 1, 1, 1, NOW() + INTERVAL '7 days', 'attempt_claimed', NOW(), 'trace');
    UPDATE orders SET automatic_renewal_mandate_id = 1,
      automatic_renewal_attempt_key = 'attempt-1', automatic_renewal_rules_version = '2026-08-18.1',
      balance_hold_transaction_key = 'hold-1' WHERE id = 1;
    INSERT INTO domain_expiry_reminders (
      asset_id, expires_at_snapshot, notice_type, mandate_id, amount_fen,
      authorized_max_amount_fen
    ) VALUES (1, NOW() + INTERVAL '7 days', 'automatic_renewal_due', 1, 3500, 5000);
  `)
  const persisted = psql(
    `SELECT (SELECT count(*) FROM renewal_mandates) || ':' ||
      (SELECT count(*) FROM automatic_renewal_events) || ':' ||
      (SELECT automatic_renewal_attempt_key FROM orders WHERE id = 1) || ':' ||
      (SELECT notice_type::text FROM domain_expiry_reminders WHERE id = 1);`,
    true,
  ).trim()
  assert.equal(
    persisted,
    '1:1:attempt-1:automatic_renewal_due',
    `D9-C-2 migration data behavior mismatch: ${persisted}`,
  )

  psql(downSql)
  const downObserved = psql(
    `SELECT
       (to_regclass('public.renewal_mandates') IS NULL)::text || ':' ||
       (to_regclass('public.automatic_renewal_events') IS NULL)::text || ':' ||
       (to_regtype('public.enum_domain_expiry_reminders_notice_type') IS NULL)::text || ':' ||
       (to_regtype('public.enum_renewal_mandates_scope') IS NULL)::text || ':' ||
       (to_regtype('public.enum_renewal_mandates_currency') IS NULL)::text || ':' ||
       (to_regtype('public.enum_renewal_mandates_event_type') IS NULL)::text || ':' ||
       (to_regtype('public.enum_automatic_renewal_events_event_type') IS NULL)::text || ':' ||
       (NOT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_name = 'orders' AND column_name IN (
           'automatic_renewal_mandate_id','automatic_renewal_attempt_key',
           'automatic_renewal_rules_version','balance_hold_transaction_key')))::text || ':' ||
       (NOT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_name = 'domain_expiry_reminders' AND column_name IN (
           'notice_type','mandate_id','amount_fen','authorized_max_amount_fen')))::text || ':' ||
       (SELECT count(*) FROM orders)::text || ':' ||
       (SELECT count(*) FROM domain_expiry_reminders)::text;`,
    true,
  ).trim()
  assert.equal(
    downObserved,
    'true:true:true:true:true:true:true:true:true:1:1',
    `D9-C-2 migration down mismatch: ${downObserved}`,
  )
  assert.equal(
    enumValues('enum_sms_challenges_step_up_purpose'),
    stepUpPurposes.join(','),
    'D9-C-2 DOWN must restore the prior SMS step-up enum',
  )
  assert.equal(
    enumValues('enum_step_up_grants_purpose'),
    stepUpPurposes.join(','),
    'D9-C-2 DOWN must restore the prior grant-purpose enum',
  )
  assert.equal(
    enumValues('enum_payload_jobs_workflow_slug'),
    workflowSlugs.join(','),
    'D9-C-2 DOWN must restore the prior workflow enum',
  )

  psql(upSql)
  verifyUp('re-up')
  console.log('D9-C-2 automatic renewal migration up/down/re-up verification passed')
} finally {
  postgres(['dropdb', '--username', 'wanmi', '--if-exists', databaseName])
}
