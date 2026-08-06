import { execFileSync } from 'node:child_process'

const databaseName = `wanmi_redirect_migration_${process.pid}_${Date.now()}`
if (!/^wanmi_redirect_migration_[0-9]+_[0-9]+$/.test(databaseName)) {
  throw new Error(`Unexpected migration verification database name: ${databaseName}`)
}

const databaseUrl = `postgresql://wanmi:wanmi_local_only@127.0.0.1:55432/${databaseName}`
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: options.capture ? 'pipe' : 'inherit',
  })

const postgres = (args, options) =>
  run('docker', ['compose', 'exec', '-T', 'postgres', ...args], options)

function verifyAuditReaderIndex(stage) {
  const indexDefinition = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'audit_logs'
         AND indexname = 'actorType_actorId_createdAt_idx'`,
    ],
    { capture: true },
  ).trim()
  if (!/\(actor_type, actor_id, created_at\)$/.test(indexDefinition)) {
    throw new Error(`D1-07 audit reader index missing after ${stage}: ${indexDefinition}`)
  }
}

function verifyFirstPartyEventSchema(stage) {
  const forbiddenColumns = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(column_name, ',' ORDER BY column_name)
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'first_party_events'
         AND column_name IN (
           'client_id', 'cookie', 'domain', 'ip', 'query', 'referrer',
           'session_id', 'url', 'user_agent'
         )`,
    ],
    { capture: true },
  ).trim()
  if (forbiddenColumns) {
    throw new Error(
      `D1-08 first-party event table has forbidden columns after ${stage}: ${forbiddenColumns}`,
    )
  }

  const indexes = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(indexdef, E'\n' ORDER BY indexname)
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'first_party_events'`,
    ],
    { capture: true },
  ).trim()
  if (!/\(event, created_at\)/.test(indexes) || !/\(tool, created_at\)/.test(indexes)) {
    throw new Error(`D1-08 aggregation indexes missing after ${stage}: ${indexes}`)
  }
}

function verifyPriceSnapshotSchema(stage) {
  const columns = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(column_name, ',' ORDER BY column_name)
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'price_snapshots'
         AND column_name IN (
           'calculation_hash', 'calculation_version', 'created_trace_id',
           'one_year_total_minor', 'provider_observed_at', 'provider_product_id',
           'provider_request_id', 'registration_price_minor', 'renewal_price_minor',
           'representative_domain_ascii', 'rounding_mode', 'rule_fixed_amount_minor',
           'rule_key', 'rule_mode', 'rule_percentage_basis_points', 'rule_source',
           'rule_version', 'schema_version', 'snapshot_ref', 'three_year_total_minor',
           'tld', 'upstream_registration_price_minor', 'upstream_renewal_price_minor'
         )`,
    ],
    { capture: true },
  ).trim()
  if (columns.split(',').filter(Boolean).length !== 23) {
    throw new Error(`D2-07 price snapshot columns incomplete after ${stage}: ${columns}`)
  }

  const indexes = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(indexdef, E'\n' ORDER BY indexname)
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'price_snapshots'`,
    ],
    { capture: true },
  ).trim()
  if (
    !/UNIQUE INDEX .*\(calculation_hash\)/.test(indexes) ||
    !/UNIQUE INDEX .*\(snapshot_ref\)/.test(indexes) ||
    !/\(tld, rule_key, provider_observed_at\)/.test(indexes)
  ) {
    throw new Error(`D2-07 price snapshot indexes missing after ${stage}: ${indexes}`)
  }

  const lockRelation = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'payload_locked_documents_rels'
           AND column_name = 'price_snapshots_id'
       )`,
    ],
    { capture: true },
  ).trim()
  if (lockRelation !== 'f') {
    throw new Error(`D2-07 immutable snapshots unexpectedly enable document locking after ${stage}`)
  }
}

function verifyToolObservabilitySchema(stage) {
  const forbiddenColumns = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(column_name, ',' ORDER BY column_name)
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'tool_observability_buckets'
         AND column_name IN (
           'client_id', 'cookie', 'domain', 'domain_ascii', 'ip', 'query',
           'request_id', 'session_id', 'tld', 'trace_id', 'url', 'user_agent'
         )`,
    ],
    { capture: true },
  ).trim()
  if (forbiddenColumns) {
    throw new Error(
      `D2-11 observability table has forbidden dimensions after ${stage}: ${forbiddenColumns}`,
    )
  }

  const columns = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(column_name, ',' ORDER BY column_name)
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'tool_observability_buckets'
         AND column_name IN (
           'bucket_end', 'bucket_key', 'bucket_start', 'failure_count',
           'invalid_response_error_count', 'last_observed_at', 'last_queue_depth',
           'latency100_to299_ms_count', 'latency1000_to2999_ms_count',
           'latency300_to999_ms_count', 'latency3000_to9999_ms_count',
           'latency_gte10000_ms_count', 'latency_lt100_ms_count', 'max_queue_depth',
           'p50_bucket', 'p95_bucket', 'provider', 'provider_operation',
           'rate_limited_error_count', 'rejected_count', 'request_count',
           'schema_version', 'scope', 'success_count', 'success_rate_basis_points',
           'timeout_error_count', 'tool', 'upstream_error_count'
         )`,
    ],
    { capture: true },
  ).trim()
  if (columns.split(',').filter(Boolean).length !== 28) {
    throw new Error(`D2-11 observability columns incomplete after ${stage}: ${columns}`)
  }

  const indexes = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(indexdef, E'\n' ORDER BY indexname)
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'tool_observability_buckets'`,
    ],
    { capture: true },
  ).trim()
  if (
    !/UNIQUE INDEX .*\(bucket_key\)/.test(indexes) ||
    !/\(scope, bucket_start\)/.test(indexes) ||
    !/\(tool, bucket_start\)/.test(indexes) ||
    !/\(provider, bucket_start\)/.test(indexes)
  ) {
    throw new Error(`D2-11 observability indexes missing after ${stage}: ${indexes}`)
  }

  const lockRelation = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'payload_locked_documents_rels'
           AND column_name = 'tool_observability_buckets_id'
       )`,
    ],
    { capture: true },
  ).trim()
  if (lockRelation !== 'f') {
    throw new Error(`D2-11 aggregate buckets unexpectedly enable document locking after ${stage}`)
  }
}

let created = false
try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  created = true

  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyAuditReaderIndex('empty-database migration')
  verifyFirstPartyEventSchema('empty-database migration')
  verifyPriceSnapshotSchema('empty-database migration')
  verifyToolObservabilitySchema('empty-database migration')
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 2
     WHERE name = '20260805_005736_d1_redirect_foundation'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `INSERT INTO redirects ("from", to_type, to_url, "type", updated_at, created_at)
     VALUES ('/legacy-302', 'custom', '/current', '302', NOW(), NOW())`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])

  const result = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT r.type || ':' || array_to_string(enum_range(NULL::enum_redirects_type), ',')
       FROM redirects r WHERE r."from" = '/legacy-302'`,
    ],
    { capture: true },
  ).trim()
  if (result !== '301:301') {
    throw new Error(`Legacy redirect migration produced an unexpected result: ${result}`)
  }

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 3 WHERE name = '20260805_040152'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `DO $$
     DECLARE legacy_admin_id integer;
     BEGIN
       INSERT INTO admins (
         email, totp_secret_encrypted, totp_enabled, totp_last_used_step,
         updated_at, created_at, login_attempts
       ) VALUES (
         'legacy-admin@example.test', 'legacy-encrypted-secret', true, 4242,
         NOW(), NOW(), 0
       ) RETURNING id INTO legacy_admin_id;
       INSERT INTO admins_roles ("order", parent_id, value)
       VALUES (1, legacy_admin_id, 'system_admin');
       INSERT INTO admins_texts ("order", parent_id, path, text)
       VALUES (1, legacy_admin_id, 'recoveryCodeHashes', 'legacy-recovery-hash');
     END $$;`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  const adminMigration = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT
         admin_account.status || ':' || credentials.secret_encrypted || ':' ||
         credentials.last_used_step || ':' || recovery.text
       FROM admins admin_account
       JOIN admin_mfa_credentials credentials ON credentials.admin_id = admin_account.id
       JOIN admin_mfa_credentials_texts recovery ON recovery.parent_id = credentials.id
       WHERE admin_account.email = 'legacy-admin@example.test'
         AND recovery.path = 'recoveryCodeHashes'`,
    ],
    { capture: true },
  ).trim()
  if (adminMigration !== 'active:legacy-encrypted-secret:4242:legacy-recovery-hash') {
    throw new Error(
      `Legacy administrator migration produced an unexpected result: ${adminMigration}`,
    )
  }

  let lastSystemAdminProtected = false
  try {
    postgres(
      [
        'psql',
        '--username',
        'wanmi',
        '--dbname',
        databaseName,
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        `UPDATE admins SET status = 'disabled' WHERE email = 'legacy-admin@example.test'`,
      ],
      { capture: true },
    )
  } catch {
    lastSystemAdminProtected = true
  }
  if (!lastSystemAdminProtected) {
    throw new Error('Database allowed the last active system administrator to be disabled')
  }
  verifyAuditReaderIndex('legacy upgrade migration')
  verifyFirstPartyEventSchema('legacy upgrade migration')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 4
     WHERE name = '20260805_090521_d1_first_party_events'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const eventTableAfterDown = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT to_regclass('public.first_party_events') IS NOT NULL`,
    ],
    { capture: true },
  ).trim()
  if (eventTableAfterDown !== 'f') {
    throw new Error('D1-08 migration down did not remove the first-party event table')
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyFirstPartyEventSchema('D1-08 migration round trip')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 5
     WHERE name = '20260806_055310_d2_tld_price_snapshots'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const snapshotTableAfterDown = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT to_regclass('public.price_snapshots') IS NOT NULL`,
    ],
    { capture: true },
  ).trim()
  if (snapshotTableAfterDown !== 'f') {
    throw new Error('D2-07 migration down did not remove the price snapshot table')
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyPriceSnapshotSchema('D2-07 migration round trip')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 6
     WHERE name = '20260806_113033_d2_tool_observability'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const observabilityTableAfterDown = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT to_regclass('public.tool_observability_buckets') IS NOT NULL`,
    ],
    { capture: true },
  ).trim()
  if (observabilityTableAfterDown !== 'f') {
    throw new Error('D2-11 migration down did not remove the observability aggregate table')
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyToolObservabilitySchema('D2-11 migration round trip')

  process.stdout.write(
    'Verified empty-database migrations, D1-03 legacy redirects, D1-05 legacy administrator MFA, the last-system-admin constraint, the D1-07 audit reader index, the D1-08 event schema, the D2-07 price snapshot schema, and the D2-11 observability aggregate schema round trips.\n',
  )
} finally {
  if (created) {
    postgres(['dropdb', '--force', '--username', 'wanmi', databaseName])
  }
}
