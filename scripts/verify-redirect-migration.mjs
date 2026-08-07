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
           'client_id', 'cookie', 'cross_site_id', 'customer_id', 'device_id',
           'domain', 'full_domain', 'ip', 'query', 'referrer', 'session_id',
           'url', 'user_agent', 'user_id'
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
  if (
    !/\(event, created_at\)/.test(indexes) ||
    !/\(tool, created_at\)/.test(indexes) ||
    !/\(campaign_id, event, created_at\)/.test(indexes)
  ) {
    throw new Error(`D1-08 aggregation indexes missing after ${stage}: ${indexes}`)
  }

  const advertisingColumns = postgres(
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
         AND column_name IN ('campaign_id', 'conversion_type', 'placement_code')`,
    ],
    { capture: true },
  ).trim()
  if (advertisingColumns !== 'campaign_id,conversion_type,placement_code') {
    throw new Error(`D3-04 advertising event columns missing after ${stage}: ${advertisingColumns}`)
  }

  const eventValues = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT array_to_string(enum_range(NULL::enum_first_party_events_event), ',')`,
    ],
    { capture: true },
  ).trim()
  for (const event of ['ad_requested', 'ad_served', 'ad_viewable', 'ad_clicked', 'ad_converted']) {
    if (!eventValues.split(',').includes(event)) {
      throw new Error(`D3-04 advertising event ${event} missing after ${stage}: ${eventValues}`)
    }
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

function verifyContentCmsSchema(stage) {
  const tables = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(table_name, ',' ORDER BY table_name)
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           '_help_pages_v', 'articles_rels', 'categories', 'help_pages', 'tags'
         )`,
    ],
    { capture: true },
  ).trim()
  if (tables !== '_help_pages_v,articles_rels,categories,help_pages,tags') {
    throw new Error(`D3-01 content CMS tables incomplete after ${stage}: ${tables}`)
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
         AND table_name = 'articles'
         AND column_name IN (
           'published_at', 'revision_by', 'scheduled_publish_at',
           'source', 'workflow_status'
         )`,
    ],
    { capture: true },
  ).trim()
  if (columns !== 'published_at,revision_by,scheduled_publish_at,source,workflow_status') {
    throw new Error(`D3-01 article workflow columns incomplete after ${stage}: ${columns}`)
  }

  const workflowValues = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT array_to_string(enum_range(NULL::enum_payload_jobs_workflow_slug), ',')`,
    ],
    { capture: true },
  ).trim()
  if (!workflowValues.split(',').includes('contentScheduledPublish')) {
    throw new Error(`D3-01 publishing workflow missing after ${stage}: ${workflowValues}`)
  }
}

function verifyContentRelationsSeoSchema(stage) {
  const toolDirectory = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(slug || ':' || href, ',' ORDER BY slug) FROM tool_pages`,
    ],
    { capture: true },
  ).trim()
  if (
    toolDirectory !==
    'dns:/tools/dns,domain-search:/tools/domain-search,idn:/tools/idn,pricing:/pricing,ssl-check:/tools/ssl-check,whois:/tools/whois'
  ) {
    throw new Error(`D3-02 fixed tool directory is incomplete after ${stage}: ${toolDirectory}`)
  }

  const seoColumns = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(table_name || '.' || column_name, ',' ORDER BY table_name, column_name)
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('categories', 'help_pages', 'tags')
         AND column_name IN (
           'meta_canonical', 'meta_description', 'meta_image_id', 'meta_no_index', 'meta_title'
         )`,
    ],
    { capture: true },
  ).trim()
  if (seoColumns.split(',').filter(Boolean).length !== 15) {
    throw new Error(`D3-02 SEO columns are incomplete after ${stage}: ${seoColumns}`)
  }

  const relationColumns = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(table_name || '.' || column_name, ',' ORDER BY table_name, column_name)
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name IN ('articles_rels', 'help_pages_rels', 'topics_rels')
             AND column_name IN ('tld_pages_id', 'tool_pages_id'))
           OR (table_name = 'tld_pages_rels' AND column_name = 'tool_pages_id')
           OR (table_name = 'redirects_rels'
             AND column_name IN ('categories_id', 'help_pages_id', 'tags_id', 'tool_pages_id'))
         )`,
    ],
    { capture: true },
  ).trim()
  if (relationColumns.split(',').filter(Boolean).length !== 11) {
    throw new Error(`D3-02 relationship columns are incomplete after ${stage}: ${relationColumns}`)
  }
}

function verifyAdvertisingSchema(stage) {
  const tables = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(table_name, ',' ORDER BY table_name)
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'ad_media', 'ad_placements_page_types', 'advertisers_allowed_hosts'
         )`,
    ],
    { capture: true },
  ).trim()
  if (tables !== 'ad_media,ad_placements_page_types,advertisers_allowed_hosts') {
    throw new Error(`D3-03 advertising tables incomplete after ${stage}: ${tables}`)
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
      `SELECT string_agg(table_name || '.' || column_name, ',' ORDER BY table_name, column_name)
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'advertisers'
             AND column_name IN ('contact_email', 'contact_name', 'contract_reference', 'legal_name'))
           OR (table_name = 'ad_creatives'
             AND column_name IN (
               'body', 'creative_type', 'headline', 'review_notes', 'reviewed_at',
               'reviewed_by', 'target_type'
             ))
           OR (table_name = 'ad_placements'
             AND column_name IN ('device_scope', 'height', 'name', 'position', 'width'))
           OR (table_name = 'ad_schedules'
             AND column_name IN ('advertiser_id', 'name', 'notes', 'priority', 'public_id'))
         )`,
    ],
    { capture: true },
  ).trim()
  if (columns.split(',').filter(Boolean).length !== 21) {
    throw new Error(`D3-03 advertising columns incomplete after ${stage}: ${columns}`)
  }

  const publicIdIndex = postgres(
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
         AND tablename = 'ad_schedules'
         AND indexname = 'ad_schedules_public_id_idx'`,
    ],
    { capture: true },
  ).trim()
  if (!/UNIQUE INDEX .*\(public_id\)/.test(publicIdIndex)) {
    throw new Error(`D3-03 schedule public ID is not unique after ${stage}: ${publicIdIndex}`)
  }

  const enumValues = postgres(
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
         array_to_string(enum_range(NULL::enum_advertisers_status), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_ad_creatives_status), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_ad_schedules_status), ',')`,
    ],
    { capture: true },
  ).trim()
  if (
    enumValues !==
    'draft,active,paused,disabled:draft,pending_review,approved,rejected,disabled:draft,scheduled,active,paused,ended,disabled'
  ) {
    throw new Error(`D3-03 advertising statuses incomplete after ${stage}: ${enumValues}`)
  }
}

function verifyAdvertisingMaintenanceSchema(stage) {
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
         AND table_name = 'ad_creatives'
         AND column_name IN (
           'target_check_failure', 'target_check_status', 'target_checked_at'
         )`,
    ],
    { capture: true },
  ).trim()
  if (columns !== 'target_check_failure,target_check_status,target_checked_at') {
    throw new Error(`D3-04 target check columns incomplete after ${stage}: ${columns}`)
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
       WHERE schemaname = 'public' AND tablename = 'ad_creatives'`,
    ],
    { capture: true },
  ).trim()
  if (!/\(target_check_status\)/.test(indexes) || !/\(target_checked_at\)/.test(indexes)) {
    throw new Error(`D3-04 target check indexes missing after ${stage}: ${indexes}`)
  }

  const jobsSchema = postgres(
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
         (to_regclass('public.payload_jobs_stats') IS NOT NULL)::text || ':' ||
         (EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'payload_jobs' AND column_name = 'meta'
         ))::text || ':' ||
         array_to_string(enum_range(NULL::enum_payload_jobs_workflow_slug), ',')`,
    ],
    { capture: true },
  ).trim()
  if (
    !jobsSchema.startsWith('true:true:') ||
    !jobsSchema.split(':')[2]?.split(',').includes('advertisingMaintenance')
  ) {
    throw new Error(`D3-04 scheduled advertising workflow missing after ${stage}: ${jobsSchema}`)
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
  verifyContentCmsSchema('empty-database migration')
  verifyContentRelationsSeoSchema('empty-database migration')
  verifyAdvertisingSchema('empty-database migration')
  verifyAdvertisingMaintenanceSchema('empty-database migration')
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
     WHERE name IN (
       '20260805_090521_d1_first_party_events',
       '20260807_042030_d3_ad_events_maintenance'
     )`,
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

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 7
     WHERE name IN (
       '20260806_141657_d3_content_cms_workflow',
       '20260807_004430_d3_content_relations_seo'
     )`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const cmsTableAfterDown = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT to_regclass('public.help_pages') IS NOT NULL`,
    ],
    { capture: true },
  ).trim()
  if (cmsTableAfterDown !== 'f') {
    throw new Error('D3-01 migration down did not remove the help page table')
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
    `INSERT INTO articles (
       title, slug, content, source, published_at, updated_at, created_at, _status
     ) VALUES
       ('legacy sourced', 'legacy-sourced', '{"root":{"type":"root","children":[]}}',
        'legacy source', NOW(), NOW(), NOW(), 'published'),
       ('legacy missing source', 'legacy-missing-source',
        '{"root":{"type":"root","children":[]}}', NULL, NOW(), NOW(), NOW(), 'published')`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  const contentBackfill = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT string_agg(slug || ':' || _status || ':' || workflow_status, ',' ORDER BY slug)
       FROM articles WHERE slug IN ('legacy-missing-source', 'legacy-sourced')`,
    ],
    { capture: true },
  ).trim()
  if (
    contentBackfill !== 'legacy-missing-source:draft:in_review,legacy-sourced:published:published'
  ) {
    throw new Error(`D3-01 legacy content backfill was unsafe: ${contentBackfill}`)
  }
  verifyContentCmsSchema('D3-01 migration round trip')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 8
     WHERE name = '20260807_004430_d3_content_relations_seo'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const relationsTableAfterDown = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT to_regclass('public.tool_pages') IS NOT NULL`,
    ],
    { capture: true },
  ).trim()
  if (relationsTableAfterDown !== 'f') {
    throw new Error('D3-02 migration down did not remove the tool directory table')
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyContentRelationsSeoSchema('D3-02 migration round trip')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 9
     WHERE name = '20260807_025608_d3_advertising_controlled_delivery'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const adMediaTableAfterDown = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT to_regclass('public.ad_media') IS NOT NULL`,
    ],
    { capture: true },
  ).trim()
  if (adMediaTableAfterDown !== 'f') {
    throw new Error('D3-03 migration down did not remove the independent ad media table')
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
    `DO $$
     DECLARE
       legacy_advertiser_id integer;
       legacy_media_id integer;
       safe_creative_id integer;
       unsafe_creative_id integer;
       legacy_placement_id integer;
     BEGIN
       INSERT INTO advertisers (name, status, updated_at, created_at)
       VALUES ('Legacy advertiser', 'active', NOW(), NOW())
       RETURNING id INTO legacy_advertiser_id;

       INSERT INTO media (alt, source, reviewed, updated_at, created_at)
       VALUES ('Legacy ad image', 'legacy fixture', true, NOW(), NOW())
       RETURNING id INTO legacy_media_id;

       INSERT INTO ad_creatives (
         name, advertiser_id, image_id, alt, target_url, status, updated_at, created_at
       ) VALUES (
         'Legacy safe creative', legacy_advertiser_id, legacy_media_id,
         'Safe creative', '/tools/dns', 'approved', NOW(), NOW()
       ) RETURNING id INTO safe_creative_id;

       INSERT INTO ad_creatives (
         name, advertiser_id, image_id, alt, target_url, status, updated_at, created_at
       ) VALUES (
         'Legacy unsafe creative', legacy_advertiser_id, legacy_media_id,
         'Unsafe creative', '//evil.example', 'approved', NOW(), NOW()
       ) RETURNING id INTO unsafe_creative_id;

       INSERT INTO ad_placements (code, description, enabled, updated_at, created_at)
       VALUES ('legacy-after-result', 'Legacy placement', true, NOW(), NOW())
       RETURNING id INTO legacy_placement_id;

       INSERT INTO ad_schedules (
         creative_id, placement_id, starts_at, ends_at, status, updated_at, created_at
       ) VALUES
         (safe_creative_id, legacy_placement_id, NOW() - INTERVAL '1 day',
          NOW() + INTERVAL '1 day', 'active', NOW(), NOW()),
         (unsafe_creative_id, legacy_placement_id, NOW() - INTERVAL '1 day',
          NOW() + INTERVAL '1 day', 'active', NOW(), NOW());
     END $$;`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyAdvertisingSchema('D3-03 migration round trip')
  const advertisingBackfill = postgres(
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
         string_agg(creative.name || ':' || creative.status || ':' || creative.target_type,
                    ',' ORDER BY creative.name) || ':' ||
         COUNT(DISTINCT ad_media.id) || ':' ||
         COUNT(DISTINCT schedule.public_id) || ':' ||
         COUNT(DISTINCT schedule.advertiser_id)
       FROM ad_creatives creative
       JOIN ad_media ON ad_media.id = creative.image_id
       JOIN ad_schedules schedule ON schedule.creative_id = creative.id
       WHERE creative.name IN ('Legacy safe creative', 'Legacy unsafe creative')`,
    ],
    { capture: true },
  ).trim()
  if (
    advertisingBackfill !==
    'Legacy safe creative:approved:internal,Legacy unsafe creative:disabled:internal:1:2:1'
  ) {
    throw new Error(`D3-03 legacy advertising backfill was unsafe: ${advertisingBackfill}`)
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
    `INSERT INTO first_party_events (
       schema_version, event, page_type, campaign_id, placement_code,
       conversion_type, trace_id, updated_at, created_at
     ) VALUES (
       1, 'ad_converted', 'content', gen_random_uuid()::text, 'content-inline',
       'landing_viewed', 'd3-04-round-trip-event', NOW(), NOW()
     );
     UPDATE payload_migrations SET batch = 10
     WHERE name = '20260807_042030_d3_ad_events_maintenance'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const maintenanceAfterDown = postgres(
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
         (to_regclass('public.payload_jobs_stats') IS NULL)::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'ad_creatives'
             AND column_name = 'target_check_status'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM first_party_events WHERE trace_id = 'd3-04-round-trip-event'
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (maintenanceAfterDown !== 'true:true:true') {
    throw new Error(`D3-04 migration down was incomplete: ${maintenanceAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyFirstPartyEventSchema('D3-04 migration round trip')
  verifyAdvertisingMaintenanceSchema('D3-04 migration round trip')
  const safeInternalHealth = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT target_check_status FROM ad_creatives WHERE name = 'Legacy safe creative'`,
    ],
    { capture: true },
  ).trim()
  if (safeInternalHealth !== 'reachable') {
    throw new Error(`D3-04 safe internal target backfill was not reachable: ${safeInternalHealth}`)
  }

  process.stdout.write(
    'Verified empty-database migrations, D1-03 legacy redirects, D1-05 legacy administrator MFA, the last-system-admin constraint, the D1-07 audit reader index, the D1-08 event schema, the D2-07 price snapshot schema, the D2-11 observability aggregate schema, the D3-01 content CMS backfill, the D3-02 relation/SEO migration, the D3-03 controlled-advertising migration, and the D3-04 event/maintenance migration round trips.\n',
  )
} finally {
  if (created) {
    postgres(['dropdb', '--force', '--username', 'wanmi', databaseName])
  }
}
