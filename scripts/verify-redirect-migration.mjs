import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHmac } from 'node:crypto'

const databaseName = `wanmi_redirect_migration_${process.pid}_${Date.now()}`
if (!/^wanmi_redirect_migration_[0-9]+_[0-9]+$/.test(databaseName)) {
  throw new Error(`Unexpected migration verification database name: ${databaseName}`)
}

const expectedPhoneIdentityInstance =
  process.env.CUSTOMER_PHONE_IDENTITY_INSTANCE_ID || 'wanmi-sms-cn'
if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(expectedPhoneIdentityInstance)) {
  throw new Error('Unexpected CUSTOMER_PHONE_IDENTITY_INSTANCE_ID for migration verification')
}

const migrationSessionPepper = process.env.SESSION_PEPPER
if (!migrationSessionPepper) {
  throw new Error('SESSION_PEPPER is required for migration verification')
}

const migrationIdentityKeyEncoded =
  process.env.CUSTOMER_IDENTITY_ENCRYPTION_KEY ?? process.env.TOTP_ENCRYPTION_KEY ?? ''
const migrationIdentityKey = Buffer.from(migrationIdentityKeyEncoded, 'base64')
if (
  migrationIdentityKey.length !== 32 ||
  migrationIdentityKey.toString('base64') !== migrationIdentityKeyEncoded
) {
  migrationIdentityKey.fill(0)
  throw new Error('A valid customer identity encryption key is required for migration verification')
}

const normalizablePhoneFixtures = [
  { expected: '+8613900000001', stored: '13900000001' },
  { expected: '+8613900000002', stored: '+8613900000002' },
  { expected: '+8613900000003', stored: '8613900000003' },
  { expected: '+8613900000004', stored: '008613900000004' },
  { expected: '+8613900000005', stored: ' +86 139 0000 0005 ' },
  { expected: '+8613900000006', stored: '139-0000-0006' },
  { expected: '+8613900000007', stored: '(+86) (139) 0000 0007' },
  { expected: '+8613900000008', stored: '＋８６（１３９）００００－０００８' },
]
const duplicateNormalizedPhoneFixture = {
  expected: '+8613900000099',
  firstStored: '13900000099',
  conflictingStored: '(139) 0000-0099',
}
const isolatedPhoneFixtures = [
  '013900000009',
  '+852390000010',
  '1390000001',
  '',
  'not-provided',
  '139/0000/0012',
]

const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`
const sqlValues = (values) => values.map((value) => `(${sqlLiteral(value)})`).join(',\n')

function decryptMigrationIdentifier(value) {
  const envelope = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  const decipher = createDecipheriv(
    'aes-256-gcm',
    migrationIdentityKey,
    Buffer.from(envelope.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
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

function verifyPriceRuleSchema(stage) {
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
      `SELECT
         (is_nullable = 'YES')::text || ':' ||
         (EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'price_rules'
             AND column_name = 'effective_at' AND is_nullable = 'NO'
         ))::text
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'price_rules'
         AND column_name = 'fixed_amount_minor'`,
    ],
    { capture: true },
  ).trim()
  if (columns !== 'true:true') {
    throw new Error(`D5-05 price rule amount/effective columns invalid after ${stage}: ${columns}`)
  }

  const enums = postgres(
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
         array_to_string(enum_range(NULL::enum_quotes_rule_source), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_price_snapshots_rule_source), ',')`,
    ],
    { capture: true },
  ).trim()
  if (enums !== 'wanmi_fixture,price_rule_collection:wanmi_fixture,price_rule_collection') {
    throw new Error(`D5-05 rule source enums invalid after ${stage}: ${enums}`)
  }

  const index = postgres(
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
       WHERE schemaname = 'public' AND tablename = 'price_rules'
         AND indexname = 'price_rules_effective_at_idx'`,
    ],
    { capture: true },
  ).trim()
  if (!/\(effective_at\)$/.test(index)) {
    throw new Error(`D5-05 effective time index missing after ${stage}: ${index}`)
  }
}

function verifyPaymentFrontendTimeoutSchema(stage) {
  const shape = postgres(
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
         (EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orders'
             AND column_name = 'payment_status_polled_at'
         ))::text || ':' ||
         (array_to_string(enum_range(NULL::enum_payload_jobs_workflow_slug), ',')
           LIKE '%paymentTimeoutClose%')::text`,
    ],
    { capture: true },
  ).trim()
  if (shape !== 'true:true') {
    throw new Error(`D5-06 payment polling/job schema invalid after ${stage}: ${shape}`)
  }
}

function verifyPaymentRecoveryAuditSchema(stage) {
  const shape = postgres(
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
         (COUNT(*) FILTER (WHERE table_name = 'payment_notification_archives' AND column_name IN (
           'notification_id', 'order_id', 'payload_digest', 'merchant_order_number',
           'wechat_transaction_id', 'amount_minor', 'currency', 'paid_at', 'received_at',
           'verified_at', 'signature_verified', 'processing_status', 'last_processed_at',
           'last_replay_at', 'replay_count'
         )))::text || ':' ||
         (COUNT(*) FILTER (WHERE table_name = 'order_manual_actions' AND column_name IN (
           'action_key', 'order_id', 'action_type', 'amount_minor', 'currency', 'reason',
           'evidence', 'operator_id', 'recorded_at'
         )))::text
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('payment_notification_archives', 'order_manual_actions')`,
    ],
    { capture: true },
  ).trim()
  if (shape !== '15:9') {
    throw new Error(`D5-07 payment recovery/audit columns invalid after ${stage}: ${shape}`)
  }
  const constraints = postgres(
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
         (EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
           AND tablename = 'payment_notification_archives'
           AND indexname = 'payment_notification_archives_notification_id_idx'
           AND indexdef LIKE 'CREATE UNIQUE INDEX%'))::text || ':' ||
         (EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
           AND tablename = 'order_manual_actions'
           AND indexname = 'order_manual_actions_action_key_idx'
           AND indexdef LIKE 'CREATE UNIQUE INDEX%'))::text || ':' ||
         array_to_string(enum_range(NULL::enum_payment_notification_archives_processing_status), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_order_manual_actions_action_type), ',')`,
    ],
    { capture: true },
  ).trim()
  if (constraints !== 'true:true:pending,processed,failed:special_refund,invoice_note') {
    throw new Error(
      `D5-07 payment recovery/audit constraints invalid after ${stage}: ${constraints}`,
    )
  }
}

function verifyWestdigitalProviderOperationSchema(stage) {
  const shape = postgres(
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
         (is_nullable = 'YES')::text || ':' ||
         (SELECT COUNT(*)::text FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'provider_operations'
            AND column_name IN (
              'realname_template_id', 'target_type', 'target_id', 'attempt_count',
              'max_attempts', 'last_error_code'
            )) || ':' ||
         array_to_string(enum_range(NULL::enum_provider_operations_operation), ',')
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'provider_operations'
         AND column_name = 'order_id'`,
    ],
    { capture: true },
  ).trim()
  if (shape !== 'true:6:realname,register,renew,refund,nameserver,query') {
    throw new Error(`D6-01 provider-operation columns invalid after ${stage}: ${shape}`)
  }

  const constraints = postgres(
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
         (EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
           AND tablename = 'provider_operations'
           AND indexname = 'provider_operations_operation_key_idx'
           AND indexdef LIKE 'CREATE UNIQUE INDEX%'))::text || ':' ||
         (EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
           AND tablename = 'provider_operations'
           AND indexname = 'provider_operations_target_id_idx'))::text || ':' ||
         (EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
           AND tablename = 'provider_operations'
           AND indexname = 'provider_operations_last_error_code_idx'))::text`,
    ],
    { capture: true },
  ).trim()
  if (constraints !== 'true:true:true') {
    throw new Error(`D6-01 provider-operation indexes invalid after ${stage}: ${constraints}`)
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

function verifyFormBuilderEntrySchema(stage) {
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
         AND table_name = 'form_submissions'
         AND column_name IN (
           'client_key_hash', 'contact_masked', 'page_path', 'purpose', 'request_id',
           'status', 'status_updated_at', 'status_updated_by_id', 'summary', 'tool', 'trace_id'
         )`,
    ],
    { capture: true },
  ).trim()
  if (columns.split(',').filter(Boolean).length !== 11) {
    throw new Error(`D3-05 form submission columns incomplete after ${stage}: ${columns}`)
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
      `SELECT string_agg(indexdef, E'\n' ORDER BY tablename, indexname)
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND (
           (tablename = 'forms' AND indexname = 'forms_purpose_idx')
           OR (tablename = 'form_submissions' AND indexname IN (
             'form_submissions_client_key_hash_idx', 'form_submissions_purpose_idx',
             'form_submissions_status_idx', 'form_submissions_trace_id_idx'
           ))
         )`,
    ],
    { capture: true },
  ).trim()
  if (
    !/UNIQUE INDEX .*\(purpose\)/.test(indexes) ||
    !/\(client_key_hash\)/.test(indexes) ||
    !/\(status\)/.test(indexes) ||
    !/\(trace_id\)/.test(indexes)
  ) {
    throw new Error(`D3-05 form indexes incomplete after ${stage}: ${indexes}`)
  }

  const managedForms = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `WITH managed_fields AS (
         SELECT _parent_id AS form_id, name, 'checkbox' AS field_type FROM forms_blocks_checkbox
         UNION ALL SELECT _parent_id, name, 'email' FROM forms_blocks_email
         UNION ALL SELECT _parent_id, COALESCE(block_name, '__message__'), 'message'
         FROM forms_blocks_message
         UNION ALL SELECT _parent_id, name, 'number' FROM forms_blocks_number
         UNION ALL SELECT _parent_id, name, 'select' FROM forms_blocks_select
         UNION ALL SELECT _parent_id, name, 'text' FROM forms_blocks_text
         UNION ALL SELECT _parent_id, name, 'textarea' FROM forms_blocks_textarea
       )
       SELECT string_agg(form_record.purpose::text || ':' || field_count::text || ':' || field_names,
                         '|' ORDER BY form_record.purpose::text)
       FROM forms form_record
       JOIN LATERAL (
         SELECT count(*) AS field_count,
                string_agg(field.name || '=' || field.field_type, ',' ORDER BY field.name) AS field_names
         FROM managed_fields field WHERE field.form_id = form_record.id
       ) fields ON true
       WHERE form_record.purpose IN ('contact', 'feedback', 'request')`,
    ],
    { capture: true },
  ).trim()
  if (
    managedForms !==
    'contact:4:contact=text,message=textarea,name=text,topic=select|feedback:6:contact=text,feedbackType=select,message=textarea,pagePath=text,requestId=text,tool=select|request:4:consent=checkbox,contact=text,message=textarea,requestType=select'
  ) {
    throw new Error(`D3-05 approved forms incomplete after ${stage}: ${managedForms}`)
  }

  const unsafeConfiguration = postgres(
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
         (EXISTS (
           SELECT 1 FROM forms form_record
           WHERE form_record.purpose IN ('contact', 'feedback', 'request')
             AND (form_record.confirmation_type IS DISTINCT FROM 'message'
               OR form_record.redirect_url IS NOT NULL)
         ))::text || ':' ||
         (EXISTS (
           SELECT 1 FROM forms_emails email
           JOIN forms form_record ON form_record.id = email._parent_id
           WHERE form_record.purpose IN ('contact', 'feedback', 'request')
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (unsafeConfiguration !== 'false:false') {
    throw new Error(
      `D3-05 managed forms have unsafe delivery after ${stage}: ${unsafeConfiguration}`,
    )
  }
}

function verifyCustomerAuthSmsSchema(stage) {
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
         AND (
           (table_name = 'customers' AND column_name = 'deletion_requested_at')
           OR (table_name = 'sms_challenges' AND column_name IN (
             'delivery_failure_category', 'delivery_provider_code', 'delivery_status',
             'provider_message_id', 'provider_request_id', 'receipt_checked_at',
             'receipt_request_id', 'sent_at'
           ))
         )`,
    ],
    { capture: true },
  ).trim()
  if (
    columns !==
    'deletion_requested_at,delivery_failure_category,delivery_provider_code,delivery_status,provider_message_id,provider_request_id,receipt_checked_at,receipt_request_id,sent_at'
  ) {
    throw new Error(`D4-01 customer auth/SMS columns incomplete after ${stage}: ${columns}`)
  }

  const quotaSchema = postgres(
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
         (EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'sms_rate_limits'
             AND indexname = 'sms_rate_limits_bucket_key_idx' AND indexdef LIKE 'CREATE UNIQUE INDEX%'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'sms_rate_limits'
             AND column_name IN ('phone', 'ip', 'device_id', 'otp', 'code')
         ))::text || ':' ||
         array_to_string(enum_range(NULL::enum_sms_rate_limits_dimension), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_sms_challenges_delivery_failure_category), ',')`,
    ],
    { capture: true },
  ).trim()
  if (
    quotaSchema !==
    'true:true:phone,ip,device,global:balance_insufficient,template_unapproved,invalid_number,rate_limited,unknown'
  ) {
    throw new Error(
      `D4-01 rate-limit or failure-category schema invalid after ${stage}: ${quotaSchema}`,
    )
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
  if (!workflowValues.split(',').includes('smsReceiptReconciliation')) {
    throw new Error(`D4-01 receipt workflow missing after ${stage}: ${workflowValues}`)
  }
}

function verifyRealnameTemplateSchema(stage) {
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
         AND table_name = 'realname_templates'
         AND column_name IN (
           'address_chinese', 'address_english', 'city_chinese', 'city_english',
           'contact_first_name_chinese', 'contact_first_name_english',
           'contact_last_name_chinese', 'contact_last_name_english', 'country_code',
           'district_chinese', 'email', 'full_name_chinese',
           'identity_document_number', 'identity_document_type',
           'organization_name_chinese', 'organization_name_english', 'phone',
           'phone_area_code', 'phone_country_code', 'phone_extension', 'phone_type',
           'postal_code', 'provider_confirmed_at', 'provider_last_checked_at',
           'provider_request_id', 'provider_review_state', 'province_chinese',
           'province_english'
         )`,
    ],
    { capture: true },
  ).trim()
  if (columns.split(',').filter(Boolean).length !== 28) {
    throw new Error(`D4-02 real-name template columns incomplete after ${stage}: ${columns}`)
  }

  const constraints = postgres(
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
         array_to_string(enum_range(NULL::enum_realname_templates_status), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_realname_templates_provider_review_state), ',') || ':' ||
         (EXISTS (
           SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
             AND tablename = 'realname_templates' AND indexname = 'customer_status_idx'
         ))::text || ':' ||
         (EXISTS (
           SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'
             AND table_name = 'realname_templates_applicable_scopes'
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (
    constraints !==
    'draft,pending_review,approved,rejected,manual_review,disabled:unsubmitted,pending,approved,rejected,unknown:true:true'
  ) {
    throw new Error(`D4-02 real-name template constraints invalid after ${stage}: ${constraints}`)
  }
}

function verifyRealnameDocumentSchema(stage) {
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
         AND table_name = 'realname_documents'
         AND column_name IN (
           'auth_tag', 'encryption_version', 'file_kind', 'iv', 'storage_state', 'submitted_at'
         )`,
    ],
    { capture: true },
  ).trim()
  if (columns.split(',').filter(Boolean).length !== 6) {
    throw new Error(`D4-03 private document columns incomplete after ${stage}: ${columns}`)
  }

  const constraints = postgres(
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
         array_to_string(enum_range(NULL::enum_realname_documents_encryption_version), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_realname_documents_file_kind), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_realname_documents_storage_state), ',') || ':' ||
         (EXISTS (
           SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
             AND tablename = 'realname_documents'
             AND indexname = 'realname_documents_storage_state_idx'
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (
    constraints !==
    'aes-256-gcm-v1:jpeg,png,pdf:uploading,active,upload_failed,deleting,deleted:true'
  ) {
    throw new Error(`D4-03 private document constraints invalid after ${stage}: ${constraints}`)
  }
}

function verifyAppMasterKeySchema(stage) {
  const schema = postgres(
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
           AND table_name = 'realname_documents'
           AND column_name = 'master_key_version'
           AND is_nullable = 'YES'
       )`,
    ],
    { capture: true },
  ).trim()
  if (schema !== 't') {
    throw new Error(`D7-06 application master-key schema invalid after ${stage}: ${schema}`)
  }
}

function verifyRealnameLifecycleSchema(stage) {
  const schema = postgres(
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
         (EXISTS (
           SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'
             AND table_name = 'realname_documents_backup_objects'
         ))::text || ':' ||
         (EXISTS (
           SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'realname_documents' AND column_name = 'primary_object_deleted_at'
         ))::text || ':' ||
         (EXISTS (
           SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'realname_templates' AND column_name = 'cleanup_completed_at'
         ))::text || ':' ||
         (EXISTS (
           SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'manual_reviews' AND column_name = 'realname_template_id'
         ))::text || ':' ||
         (EXISTS (
           SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
             AND indexname = 'manual_reviews_one_open_realname_template_unique'
         ))::text || ':' ||
         (array_to_string(enum_range(NULL::enum_payload_jobs_workflow_slug), ',')
           LIKE '%realnameCleanup%')::text`,
    ],
    { capture: true },
  ).trim()
  if (schema !== 'true:true:true:true:true:true') {
    throw new Error(`D4-04 real-name lifecycle schema invalid after ${stage}: ${schema}`)
  }
}

function verifyCustomerQuoteSchema(stage) {
  const schema = postgres(
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
         (COUNT(*) FILTER (WHERE column_name IN (
           'availability_observed_at', 'availability_request_id', 'calculation_formula',
           'calculation_version', 'created_trace_id', 'price_class', 'provider',
           'provider_cache_status', 'provider_observed_at', 'provider_product_id',
           'provider_request_id', 'quote_integrity_hash', 'quote_ref', 'quoted_at',
           'registration_price_minor', 'renewal_price_minor', 'rounding_mode',
           'rule_key', 'rule_mode', 'rule_source', 'rule_version', 'schema_version',
           'source_calculation_hash', 'source_price_snapshot_ref', 'tld',
           'upstream_registration_price_minor', 'upstream_renewal_price_minor'
         )))::text || ':' ||
         (COUNT(*) FILTER (WHERE column_name = 'rule_snapshot'))::text
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'quotes'`,
    ],
    { capture: true },
  ).trim()
  if (schema !== '27:0') {
    throw new Error(`D5-01 customer quote columns invalid after ${stage}: ${schema}`)
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
       FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'quotes'`,
    ],
    { capture: true },
  ).trim()
  if (
    !/UNIQUE INDEX .*\(quote_ref\)/.test(indexes) ||
    !/\(customer_id, expires_at\)/.test(indexes) ||
    !/\(domain_ascii, quoted_at\)/.test(indexes)
  ) {
    throw new Error(`D5-01 customer quote indexes invalid after ${stage}: ${indexes}`)
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
           AND column_name = 'quotes_id'
       )`,
    ],
    { capture: true },
  ).trim()
  if (lockRelation !== 'f') {
    throw new Error(`D5-01 customer quotes unexpectedly enable document locking after ${stage}`)
  }
}

function verifyWechatPaymentSchema(stage) {
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
      `SELECT
         (COUNT(*) FILTER (WHERE table_name = 'orders' AND column_name IN (
           'merchant_order_number', 'payment_channel', 'payment_expires_at'
         )))::text || ':' ||
         (COUNT(*) FILTER (WHERE table_name = 'payment_notifications' AND column_name IN (
           'confirmation_status', 'currency', 'notification_id', 'order_id', 'paid_at',
           'provider_request_id', 'source'
         )))::text
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('orders', 'payment_notifications')`,
    ],
    { capture: true },
  ).trim()
  if (columns !== '3:7') {
    throw new Error(`D5-03 Wechat payment columns invalid after ${stage}: ${columns}`)
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
      `SELECT string_agg(indexdef, E'\n' ORDER BY tablename, indexname)
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND (
           (tablename = 'orders' AND indexname = 'orders_merchant_order_number_idx')
           OR (tablename = 'payment_notifications' AND indexname IN (
             'payment_notifications_merchant_order_number_idx',
             'payment_notifications_notification_id_idx',
             'payment_notifications_wechat_transaction_id_idx'
           ))
         )`,
    ],
    { capture: true },
  ).trim()
  const uniqueIndexes = indexes.match(/CREATE UNIQUE INDEX/g) ?? []
  if (
    uniqueIndexes.length !== 4 ||
    !/\(merchant_order_number\)/.test(indexes) ||
    !/\(notification_id\)/.test(indexes) ||
    !/\(wechat_transaction_id\)/.test(indexes)
  ) {
    throw new Error(`D5-03 payment uniqueness is incomplete after ${stage}: ${indexes}`)
  }

  const enums = postgres(
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
         array_to_string(enum_range(NULL::enum_orders_payment_channel), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_payment_notifications_source), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_payment_notifications_confirmation_status), ',')`,
    ],
    { capture: true },
  ).trim()
  if (enums !== 'native,h5:notification,query:confirmed,mismatch,not_paid,rejected,unknown') {
    throw new Error(`D5-03 payment enums invalid after ${stage}: ${enums}`)
  }
}

function verifyWechatRefundReconciliationSchema(stage) {
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
      `SELECT
         (COUNT(*) FILTER (WHERE table_name = 'refunds' AND column_name IN (
           'created_trace_id', 'currency', 'failure_category', 'last_checked_at',
           'refunded_at', 'submitted_at'
         )))::text || ':' ||
         (COUNT(*) FILTER (WHERE table_name = 'refund_notifications'))::text || ':' ||
         (COUNT(*) FILTER (WHERE table_name = 'reconciliations' AND column_name IN (
           'currency', 'difference_minor', 'ledger', 'reconciliation_key', 'record_key', 'trace_id'
         )))::text
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('refunds', 'refund_notifications', 'reconciliations')`,
    ],
    { capture: true },
  ).trim()
  if (columns !== '6:16:6') {
    throw new Error(`D5-04 refund/reconciliation columns invalid after ${stage}: ${columns}`)
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
      `SELECT string_agg(indexdef, E'\n' ORDER BY tablename, indexname)
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND (
           (tablename = 'refunds' AND indexname IN (
             'refunds_order_idx', 'refunds_provider_refund_id_idx', 'refunds_refund_number_idx'
           )) OR
           (tablename = 'refund_notifications' AND indexname = 'refund_notifications_notification_id_idx') OR
           (tablename = 'reconciliations' AND indexname = 'reconciliations_reconciliation_key_idx')
         )`,
    ],
    { capture: true },
  ).trim()
  const uniqueIndexes = indexes.match(/CREATE UNIQUE INDEX/g) ?? []
  if (
    uniqueIndexes.length !== 5 ||
    !/refunds_refund_number_idx/.test(indexes) ||
    !/refund_notifications_notification_id_idx/.test(indexes) ||
    !/reconciliations_reconciliation_key_idx/.test(indexes)
  ) {
    throw new Error(`D5-04 uniqueness is incomplete after ${stage}: ${indexes}`)
  }

  const enums = postgres(
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
         array_to_string(enum_range(NULL::enum_refund_notifications_confirmation_status), ',') || ':' ||
         array_to_string(enum_range(NULL::enum_reconciliations_ledger), ',') || ':' ||
         ('wechatRefund' = ANY(enum_range(NULL::enum_payload_jobs_workflow_slug)::text[]))::text`,
    ],
    { capture: true },
  ).trim()
  if (
    enums !==
    'confirmed,mismatch,failed,rejected,unknown:wechat_funds,westdigital_prepaid,internal_orders:true'
  ) {
    throw new Error(`D5-04 enums invalid after ${stage}: ${enums}`)
  }
}

function verifyDomainAssetOperationsSchema(stage) {
  const schema = postgres(
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
         (COUNT(*) FILTER (WHERE table_name = 'domain_expiry_reminders' AND column_name IN (
           'reminder_key', 'customer_id', 'asset_id', 'channel', 'threshold_days',
           'expires_at_snapshot', 'status', 'attempted_at', 'delivered_at',
           'failure_category', 'provider_code', 'provider_message_id',
           'provider_request_id', 'created_trace_id'
         )))::text || ':' ||
         (COUNT(*) FILTER (WHERE table_name = 'nameserver_changes' AND column_name IN (
           'change_key', 'requested_by_type', 'requested_by_id', 'requested_at',
           'job_queued_at', 'review_job_queued_at', 'last_checked_at', 'completed_at',
           'provider_operation_id', 'failure_code', 'created_trace_id'
         )))::text || ':' ||
         (COUNT(*) FILTER (WHERE table_name = 'manual_reviews' AND column_name IN (
           'domain_asset_id', 'nameserver_change_id'
         )))::text || ':' ||
         (to_regclass('public.domain_expiry_reminders_reminder_key_idx') IS NOT NULL)::text || ':' ||
         (to_regclass('public.nameserver_changes_change_key_idx') IS NOT NULL)::text || ':' ||
         ('domainExpiryReminders' = ANY(enum_range(NULL::enum_payload_jobs_workflow_slug)::text[]))::text || ':' ||
         ('nameserverChange' = ANY(enum_range(NULL::enum_payload_jobs_workflow_slug)::text[]))::text
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('domain_expiry_reminders', 'nameserver_changes', 'manual_reviews')`,
    ],
    { capture: true },
  ).trim()
  if (schema !== '14:11:2:true:true:true:true') {
    throw new Error(`D6-04 domain asset operations schema invalid after ${stage}: ${schema}`)
  }
}

function verifyProviderWriteBudgetSchema(stage) {
  const schema = postgres(
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
         (to_regclass('public.provider_write_budgets') IS NOT NULL)::text || ':' ||
         (to_regclass('public.provider_write_budget_debits') IS NOT NULL)::text || ':' ||
         (SELECT count(*)::text FROM provider_write_budgets) || ':' ||
         (SELECT count(*)::text FROM provider_write_budgets
          WHERE (scope_key, provider::text, capability::text) IN (
            ('westdigital:register_renew', 'westdigital', 'register_renew'),
            ('wechatpay:payment', 'wechatpay', 'payment'),
            ('wechatpay:refund', 'wechatpay', 'refund')
          ) AND used_operations = 0 AND used_amount_fen = 0) || ':' ||
         (to_regclass('public.provider_write_budgets_provider_capability_idx') IS NOT NULL)::text || ':' ||
         (SELECT count(*)::text FROM pg_constraint
          WHERE conname IN (
            'provider_write_budgets_scope_match',
            'provider_write_budgets_safe_integers',
            'provider_write_budget_debits_safe_integers'
          )) || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'payload_locked_documents_rels'
             AND column_name IN (
               'provider_write_budgets_id', 'provider_write_budget_debits_id'
             )
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (schema !== 'true:true:3:3:true:3:true') {
    throw new Error(`D7-05 provider write budget schema invalid after ${stage}: ${schema}`)
  }
}

function verifyWalletLedgerSchema(stage) {
  const schema = postgres(
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
         (to_regclass('public.wallet_accounts') IS NOT NULL)::text || ':' ||
         (to_regclass('public.wallet_transactions') IS NOT NULL)::text || ':' ||
         (to_regclass('public.wallet_entries') IS NOT NULL)::text || ':' ||
         (SELECT count(*)::text
          FROM pg_constraint
          WHERE conname IN (
            'wallet_accounts_ledger_version_safe_integer',
            'wallet_transactions_amount_safe_integer',
            'wallet_transactions_state_valid',
            'wallet_entries_safe_integers'
          )) || ':' ||
         (SELECT count(*)::text
          FROM pg_constraint
          WHERE conrelid IN (
            'wallet_accounts'::regclass,
            'wallet_transactions'::regclass,
            'wallet_entries'::regclass
          ) AND contype = 'f') || ':' ||
         (to_regclass('public.customer_currency_idx') IS NOT NULL)::text || ':' ||
         (to_regclass('public.wallet_transactions_transaction_key_idx') IS NOT NULL)::text || ':' ||
         (to_regclass('public.wallet_entries_entry_key_idx') IS NOT NULL)::text || ':' ||
         (to_regclass('public."account_ledgerSequence_idx"') IS NOT NULL)::text || ':' ||
         (NOT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'wallet_accounts'
             AND column_name IN (
               'posted_balance', 'posted_balance_fen',
               'held_balance', 'held_balance_fen',
               'available_balance', 'available_balance_fen'
             )
         ))::text || ':' ||
         ('walletLedgerConsistencyCheck' = ANY(
           enum_range(NULL::enum_payload_jobs_workflow_slug)::text[]
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'payload_locked_documents_rels'
             AND column_name IN (
               'wallet_accounts_id', 'wallet_transactions_id', 'wallet_entries_id'
             )
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (schema !== 'true:true:true:4:6:true:true:true:true:true:true:true') {
    throw new Error(`D9-B-1 wallet ledger schema invalid after ${stage}: ${schema}`)
  }
}

function verifyD9AIdentityRegistrationSchema(stage) {
  const shape = postgres(
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
         (COUNT(*) FILTER (WHERE table_name = 'customer_identities' AND column_name IN (
           'customer_id', 'provider', 'provider_instance_id', 'identifier_hash',
           'identifier_encrypted', 'unionid', 'status', 'verified_at', 'bound_at',
           'unbound_at', 'last_used_at'
         )))::text || ':' ||
         (COUNT(*) FILTER (WHERE table_name = 'consent_records' AND column_name IN (
           'customer_id', 'consent_type', 'document_version', 'document_hash',
           'accepted_at', 'revoked_at', 'source', 'ip_masked', 'user_agent_summary'
         )))::text || ':' ||
         (COUNT(*) FILTER (WHERE table_name = 'customers' AND column_name IN (
           'account_type', 'registration_source', 'default_customer_profile_type',
           'invite_code', 'invited_by_customer_id', 'identity_risk_cooldown_started_at'
         )))::text || ':' ||
         (COUNT(*) FILTER (WHERE table_name = 'manual_reviews' AND column_name IN (
           'customer_id', 'customer_identity_id'
         )))::text
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('customer_identities', 'consent_records', 'customers', 'manual_reviews')`,
    ],
    { capture: true },
  ).trim()
  if (shape !== '11:9:6:2') {
    throw new Error(`D9-A-1 identity/consent columns invalid after ${stage}: ${shape}`)
  }

  const tablesAndIndex = postgres(
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
         (to_regclass('public.customer_registration_intents') IS NOT NULL)::text || ':' ||
         (to_regclass('public.wechat_o_auth_states') IS NOT NULL)::text || ':' ||
         (to_regclass('public.wechat_authorization_codes') IS NOT NULL)::text || ':' ||
         (to_regclass('public.wechat_login_scenes') IS NOT NULL)::text || ':' ||
         (EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'customer_identities'
             AND indexname = 'provider_providerInstanceId_identifierHash_idx'
             AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
             AND indexdef LIKE '%(provider, provider_instance_id, identifier_hash)%'
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (tablesAndIndex !== 'true:true:true:true:true') {
    throw new Error(
      `D9-A-1 state tables or identity unique index invalid after ${stage}: ${tablesAndIndex}`,
    )
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
  verifyPriceRuleSchema('empty-database migration')
  verifyPaymentFrontendTimeoutSchema('empty-database migration')
  verifyPaymentRecoveryAuditSchema('empty-database migration')
  verifyToolObservabilitySchema('empty-database migration')
  verifyContentCmsSchema('empty-database migration')
  verifyContentRelationsSeoSchema('empty-database migration')
  verifyAdvertisingSchema('empty-database migration')
  verifyAdvertisingMaintenanceSchema('empty-database migration')
  verifyFormBuilderEntrySchema('empty-database migration')
  verifyCustomerAuthSmsSchema('empty-database migration')
  verifyRealnameTemplateSchema('empty-database migration')
  verifyRealnameDocumentSchema('empty-database migration')
  verifyAppMasterKeySchema('empty-database migration')
  verifyRealnameLifecycleSchema('empty-database migration')
  verifyCustomerQuoteSchema('empty-database migration')
  verifyWechatPaymentSchema('empty-database migration')
  verifyWechatRefundReconciliationSchema('empty-database migration')
  verifyDomainAssetOperationsSchema('empty-database migration')
  verifyProviderWriteBudgetSchema('empty-database migration')
  verifyD9AIdentityRegistrationSchema('empty-database migration')
  verifyWalletLedgerSchema('empty-database migration')
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 112
     WHERE name = '20260809_013335_d6_domain_assets_nameservers_reminders'`,
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

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 11
     WHERE name = '20260807_061433_d3_form_builder_entries'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const formSchemaAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'form_submissions'
             AND column_name = 'client_key_hash'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public' AND indexname = 'forms_purpose_idx'
         ))::text || ':' ||
         (SELECT count(*) FROM forms WHERE purpose IN ('contact', 'feedback', 'request'))::text`,
    ],
    { capture: true },
  ).trim()
  if (formSchemaAfterDown !== 'true:true:3') {
    throw new Error(`D3-05 migration down was incomplete or destructive: ${formSchemaAfterDown}`)
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
    `WITH legacy_submission AS (
       INSERT INTO form_submissions (form_id, updated_at, created_at)
       SELECT id, NOW(), NOW() FROM forms WHERE purpose = 'feedback'
       RETURNING id
     )
     INSERT INTO form_submissions_submission_data (
       _order, _parent_id, id, field, value
     )
     SELECT 0, id, 'd3-05-legacy-html', 'message', '<strong>legacy</strong>'
     FROM legacy_submission
     UNION ALL
     SELECT 1, id, 'd3-05-legacy-domain', 'queryDomain', 'legacy.example'
     FROM legacy_submission`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyFormBuilderEntrySchema('D3-05 migration round trip')
  const formBackfill = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT submission.purpose::text || ':' || submission.status::text || ':' ||
              submission.summary || ':' ||
              string_agg(data.value, ',' ORDER BY data._order)
       FROM form_submissions submission
       JOIN form_submissions_submission_data data ON data._parent_id = submission.id
       WHERE data.id IN ('d3-05-legacy-html', 'd3-05-legacy-domain')
       GROUP BY submission.id`,
    ],
    { capture: true },
  ).trim()
  if (
    formBackfill !==
    'feedback:new:[遗留提交，待系统管理员复核]:[遗留内容已隐藏，待人工复核],[遗留内容已隐藏，待人工复核]'
  ) {
    throw new Error(`D3-05 legacy form backfill was unsafe: ${formBackfill}`)
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
    `UPDATE payload_migrations SET batch = 99
     WHERE name = '20260807_095514_d4_customer_auth_sms'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const customerAuthAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'sms_rate_limits'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'customers'
             AND column_name = 'deletion_requested_at'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'payload_locked_documents_rels'
             AND column_name = 'sms_rate_limits_id'
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (customerAuthAfterDown !== 'true:true:true') {
    throw new Error(`D4-01 migration down was incomplete: ${customerAuthAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyCustomerAuthSmsSchema('D4-01 migration round trip')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 100
     WHERE name = '20260807_114644_d4_realname_templates'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const realnameAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'
             AND table_name = 'realname_templates_applicable_scopes'
         ))::text || ':' ||
         array_to_string(enum_range(NULL::enum_realname_templates_status), ',')`,
    ],
    { capture: true },
  ).trim()
  if (realnameAfterDown !== 'true:draft,pending_review,verified,rejected,manual_review,disabled') {
    throw new Error(`D4-02 migration down was incomplete: ${realnameAfterDown}`)
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
    `WITH legacy_customer AS (
       INSERT INTO customers (phone, phone_masked, status, updated_at, created_at)
       VALUES ('legacy-d4-02-phone', '***legacy', 'active', NOW(), NOW())
       RETURNING id
     )
     INSERT INTO realname_templates (
       customer_id, display_name, type, status, provider_template_id,
       safe_failure_reason, updated_at, created_at
     )
     SELECT id, 'legacy realname template', 'individual', 'verified', 'legacy-provider-id',
            'legacy unsafe provider detail', NOW(), NOW()
     FROM legacy_customer`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyRealnameTemplateSchema('D4-02 migration round trip')
  const realnameBackfill = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT template.status::text || ':' || template.provider_review_state::text || ':' ||
              COALESCE(template.safe_failure_reason::text, 'null') || ':' ||
              template.phone || ':' || template.identity_document_type || ':' || scope.value::text
       FROM realname_templates template
       JOIN realname_templates_applicable_scopes scope ON scope.parent_id = template.id
       WHERE template.display_name = 'legacy realname template'`,
    ],
    { capture: true },
  ).trim()
  if (realnameBackfill !== 'disabled:unknown:null:000:UNKNOWN:cg') {
    throw new Error(`D4-02 legacy template backfill was unsafe: ${realnameBackfill}`)
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
    `UPDATE payload_migrations SET batch = 101
     WHERE name = '20260807_125811_d4_private_realname_documents'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const documentAfterDown = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'realname_documents'
           AND column_name IN (
             'auth_tag', 'encryption_version', 'file_kind', 'iv', 'storage_state', 'submitted_at'
           )
       )`,
    ],
    { capture: true },
  ).trim()
  if (documentAfterDown !== 't') {
    throw new Error(`D4-03 migration down was incomplete: ${documentAfterDown}`)
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
    `INSERT INTO realname_documents (
       customer_id, template_id, object_key, encrypted_data_key, content_type,
       size_bytes, sha256, master_key_version, updated_at, created_at
     )
     SELECT customer_id, id, 'legacy/private/document', 'legacy-key', 'image/jpeg',
            128, repeat('0', 64), 'legacy-kms-unavailable', NOW(), NOW()
     FROM realname_templates
     WHERE display_name = 'legacy realname template'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyRealnameDocumentSchema('D4-03 migration round trip')
  const documentBackfill = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT storage_state::text || ':' || file_kind::text || ':' || iv || ':' || auth_tag
       FROM realname_documents
       WHERE object_key = 'legacy/private/document'`,
    ],
    { capture: true },
  ).trim()
  if (documentBackfill !== 'upload_failed:jpeg:legacy-unavailable:legacy-unavailable') {
    throw new Error(`D4-03 legacy document backfill was unsafe: ${documentBackfill}`)
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
    `UPDATE payload_migrations SET batch = 102
     WHERE name IN (
       '20260807_135646_d4_realname_lifecycle',
       '20260807_140407_d4_realname_cleanup_completion'
     )`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const lifecycleAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'
             AND table_name = 'realname_documents_backup_objects'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'realname_documents' AND column_name = 'primary_object_deleted_at'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'realname_templates' AND column_name = 'cleanup_completed_at'
         ))::text || ':' ||
         (array_to_string(enum_range(NULL::enum_payload_jobs_workflow_slug), ',')
           NOT LIKE '%realnameCleanup%')::text`,
    ],
    { capture: true },
  ).trim()
  if (lifecycleAfterDown !== 'true:true:true:true') {
    throw new Error(`D4-04 migration down was incomplete: ${lifecycleAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyRealnameLifecycleSchema('D4-04 migration round trip')
  const disabledRetention = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT COUNT(*) FILTER (WHERE disabled_at IS NULL OR cleanup_due_at IS NULL)
       FROM realname_templates WHERE status = 'disabled'`,
    ],
    { capture: true },
  ).trim()
  if (disabledRetention !== '0') {
    throw new Error(
      `D4-04 disabled-template retention backfill was incomplete: ${disabledRetention}`,
    )
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
    `UPDATE payload_migrations SET batch = 103
     WHERE name = '20260807_145526_d5_customer_quotes'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const quoteAfterDown = postgres(
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
         (EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'quotes'
             AND column_name = 'rule_snapshot'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'quotes'
             AND column_name = 'quote_ref'
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (quoteAfterDown !== 'true:true') {
    throw new Error(`D5-01 migration down was incomplete: ${quoteAfterDown}`)
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
    `WITH customer AS (
       INSERT INTO customers (phone, phone_masked, status)
       VALUES ('d5-legacy-customer', '***legacy', 'active')
       RETURNING id
     )
     INSERT INTO quotes (
       customer_id, domain_ascii, years, upstream_cost_minor, user_price_minor,
       currency, rule_snapshot, expires_at
     )
     SELECT id, 'legacy.example.com', 1, 100, 120, 'CNY', '{"legacy":true}'::jsonb,
       CURRENT_TIMESTAMP + interval '5 minutes'
     FROM customer`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyCustomerQuoteSchema('D5-01 migration round trip')
  const legacyQuote = postgres(
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
         (expires_at <= CURRENT_TIMESTAMP)::text || ':' ||
         (quote_ref ~ '^[0-9a-f-]{36}$')::text || ':' ||
         (quote_integrity_hash = repeat('f', 64))::text
       FROM quotes WHERE domain_ascii = 'legacy.example.com'`,
    ],
    { capture: true },
  ).trim()
  if (legacyQuote !== 'true:true:true') {
    throw new Error(`D5-01 legacy quotes were not failed closed: ${legacyQuote}`)
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
    `UPDATE payload_migrations SET batch = 104
     WHERE name = '20260808_015442_d5_wechat_payments'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const paymentAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orders'
             AND column_name = 'merchant_order_number'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'payment_notifications'
             AND column_name = 'notification_id'
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (paymentAfterDown !== 'true:true') {
    throw new Error(`D5-03 migration down was incomplete: ${paymentAfterDown}`)
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
    `INSERT INTO payment_notifications (
       wechat_transaction_id, merchant_order_number, signature_verified,
       amount_minor, received_at, payload_digest, updated_at, created_at
     ) VALUES (
       'legacy-wechat-transaction', 'legacy-merchant-order', true,
       120, NOW(), repeat('a', 64), NOW(), NOW()
     )`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyWechatPaymentSchema('D5-03 migration round trip')
  const legacyPayment = postgres(
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
         (notification_id = 'LEGACY-' || id::text)::text || ':' ||
         source::text || ':' || confirmation_status::text
       FROM payment_notifications
       WHERE merchant_order_number = 'legacy-merchant-order'`,
    ],
    { capture: true },
  ).trim()
  if (legacyPayment !== 'true:notification:confirmed') {
    throw new Error(`D5-03 legacy payment notification backfill failed: ${legacyPayment}`)
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
    `UPDATE payload_migrations SET batch = 105
     WHERE name = '20260808_031431_d5_wechat_refunds_reconciliation'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const refundAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'refund_notifications'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'reconciliations'
             AND column_name = 'ledger'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'refunds'
             AND column_name = 'created_trace_id'
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (refundAfterDown !== 'true:true:true') {
    throw new Error(`D5-04 migration down was incomplete: ${refundAfterDown}`)
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
    `INSERT INTO reconciliations (
       kind, period_start, period_end, status, summary, updated_at, created_at
     ) VALUES (
       'wechat', NOW() - INTERVAL '1 hour', NOW(), 'difference', '{"legacy":true}', NOW(), NOW()
     )`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyWechatRefundReconciliationSchema('D5-04 migration round trip')
  const legacyReconciliation = postgres(
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
         (reconciliation_key = 'LEGACY-RECONCILIATION-' || id::text)::text || ':' ||
         ledger::text || ':' || currency::text || ':' || difference_minor::text
       FROM reconciliations
       WHERE summary = '{"legacy":true}'::jsonb`,
    ],
    { capture: true },
  ).trim()
  if (legacyReconciliation !== 'true:wechat_funds:CNY:0') {
    throw new Error(`D5-04 legacy reconciliation backfill failed: ${legacyReconciliation}`)
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
    `INSERT INTO price_rules (
       tld, mode, fixed_amount_minor, percentage_basis_points, enabled,
       effective_at, updated_at, created_at
     ) VALUES (
       'd5-05-roundtrip.test', 'percentage', NULL, 1000, false,
       NOW(), NOW(), NOW()
     );
     UPDATE payload_migrations SET batch = 106
     WHERE name = '20260808_053208_d5_price_rules'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const priceRuleAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'price_rules'
             AND column_name = 'effective_at'
         ))::text || ':' ||
         (fixed_amount_minor = 0)::text || ':' ||
         array_to_string(enum_range(NULL::enum_quotes_rule_source), ',')
       FROM price_rules WHERE tld = 'd5-05-roundtrip.test'`,
    ],
    { capture: true },
  ).trim()
  if (priceRuleAfterDown !== 'true:true:wanmi_fixture') {
    throw new Error(`D5-05 migration down was incomplete: ${priceRuleAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyPriceRuleSchema('D5-05 migration round trip')
  const legacyRule = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT (effective_at = updated_at)::text
       FROM price_rules WHERE tld = 'd5-05-roundtrip.test'`,
    ],
    { capture: true },
  ).trim()
  if (legacyRule !== 'true') {
    throw new Error(`D5-05 effective time backfill failed: ${legacyRule}`)
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
    `UPDATE payload_migrations SET batch = 108
     WHERE name = '20260808_064925_d5_payment_frontend_timeout'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const paymentTimeoutAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orders'
             AND column_name = 'payment_status_polled_at'
         ))::text || ':' ||
         (array_to_string(enum_range(NULL::enum_payload_jobs_workflow_slug), ',')
           NOT LIKE '%paymentTimeoutClose%')::text`,
    ],
    { capture: true },
  ).trim()
  if (paymentTimeoutAfterDown !== 'true:true') {
    throw new Error(`D5-06 migration down was incomplete: ${paymentTimeoutAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyPaymentFrontendTimeoutSchema('D5-06 migration round trip')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 109
     WHERE name = '20260808_074845_d5_payment_recovery_manual_audit'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const paymentRecoveryAfterDown = postgres(
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
         (to_regclass('public.payment_notification_archives') IS NULL)::text || ':' ||
         (to_regclass('public.order_manual_actions') IS NULL)::text`,
    ],
    { capture: true },
  ).trim()
  if (paymentRecoveryAfterDown !== 'true:true') {
    throw new Error(`D5-07 migration down was incomplete: ${paymentRecoveryAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyPaymentRecoveryAuditSchema('D5-07 migration round trip')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `INSERT INTO provider_operations (
       operation_key, order_id, realname_template_id, target_type, target_id,
       provider, operation, status, attempt_count, max_attempts, updated_at, created_at
     )
     SELECT
       'd6-01-new-realname-operation', NULL, id, 'realname_template', id::text,
       'westdigital', 'realname', 'unknown', 1, 3, NOW(), NOW()
     FROM realname_templates
     LIMIT 1`,
  ])

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 110
     WHERE name = '20260808_104813_d6_westdigital_provider_operations'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const providerOperationAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'provider_operations'
             AND column_name = 'target_id'
         ))::text || ':' ||
         (EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'provider_operations'
             AND column_name = 'order_id' AND is_nullable = 'NO'
         ))::text || ':' ||
         (array_to_string(enum_range(NULL::enum_provider_operations_operation), ',')
           NOT LIKE '%realname%')::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM provider_operations
           WHERE operation_key = 'd6-01-new-realname-operation'
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (providerOperationAfterDown !== 'true:true:true:true') {
    throw new Error(`D6-01 migration down was incomplete: ${providerOperationAfterDown}`)
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
    `WITH legacy_order AS (
       INSERT INTO orders (
         order_number, customer_id, quote_id, realname_template_id, domain_ascii,
         status, amount_minor, currency, quote_snapshot, updated_at, created_at
       )
       SELECT
         'D6-01-LEGACY-ORDER', c.id, q.id, r.id, 'd6-01-legacy.example.com',
         'paid', 120, 'CNY', '{"legacy":true}'::jsonb, NOW(), NOW()
       FROM customers c
       CROSS JOIN quotes q
       CROSS JOIN realname_templates r
       LIMIT 1
       RETURNING id
     )
     INSERT INTO provider_operations (
       operation_key, order_id, provider, operation, status, updated_at, created_at
     )
     SELECT 'd6-01-legacy-provider-operation', id, 'westdigital', 'query', 'prepared',
            NOW(), NOW()
     FROM legacy_order`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyWestdigitalProviderOperationSchema('D6-01 migration round trip')
  const providerOperationBackfill = postgres(
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
         target_type::text || ':' || (target_id = order_id::text)::text || ':' ||
         attempt_count::text || ':' || max_attempts::text
       FROM provider_operations
       WHERE operation_key = 'd6-01-legacy-provider-operation'`,
    ],
    { capture: true },
  ).trim()
  if (providerOperationBackfill !== 'order:true:0:3') {
    throw new Error(`D6-01 legacy provider-operation backfill failed: ${providerOperationBackfill}`)
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
    `UPDATE payload_migrations SET batch = 111
     WHERE name = '20260808_124245_d6_commerce_fulfillment'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const fulfillmentAfterDown = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT (NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'orders'
           AND column_name = 'fulfillment_job_queued_at'
       ))::text`,
    ],
    { capture: true },
  ).trim()
  if (fulfillmentAfterDown !== 'true') {
    throw new Error(`D6-02 migration down was incomplete: ${fulfillmentAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  const fulfillmentAfterUp = postgres(
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
         (EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orders'
             AND column_name = 'fulfillment_job_queued_at'
         ))::text || ':' ||
         (to_regclass('public.orders_fulfillment_job_queued_at_idx') IS NOT NULL)::text`,
    ],
    { capture: true },
  ).trim()
  if (fulfillmentAfterUp !== 'true:true') {
    throw new Error(`D6-02 migration up was incomplete: ${fulfillmentAfterUp}`)
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
    `DELETE FROM payload_migrations
     WHERE name = '20260808_144932_d6_westdigital_balance_monitoring'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 112
     WHERE name = '20260809_013335_d6_domain_assets_nameservers_reminders'`,
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
    `INSERT INTO payload_jobs (input, workflow_slug, queue)
     VALUES ('{"verification":"d6-03-round-trip"}'::jsonb,
       'westdigitalBalanceMonitoring', 'background');
     UPDATE payload_migrations SET batch = 112
     WHERE name = '20260808_144932_d6_westdigital_balance_monitoring'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const balanceMonitoringAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM pg_enum
           JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
           WHERE pg_type.typname = 'enum_payload_jobs_workflow_slug'
             AND pg_enum.enumlabel = 'westdigitalBalanceMonitoring'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM payload_jobs
           WHERE input->>'verification' = 'd6-03-round-trip'
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (balanceMonitoringAfterDown !== 'true:true') {
    throw new Error(`D6-03 migration down was incomplete: ${balanceMonitoringAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  const balanceMonitoringAfterUp = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT (EXISTS (
         SELECT 1 FROM pg_enum
         JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
         WHERE pg_type.typname = 'enum_payload_jobs_workflow_slug'
           AND pg_enum.enumlabel = 'westdigitalBalanceMonitoring'
       ))::text`,
    ],
    { capture: true },
  ).trim()
  if (balanceMonitoringAfterUp !== 'true') {
    throw new Error(`D6-03 migration up was incomplete: ${balanceMonitoringAfterUp}`)
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
    `INSERT INTO payload_jobs (input, workflow_slug, queue)
     VALUES
       ('{"verification":"d6-04-reminder-round-trip"}'::jsonb,
         'domainExpiryReminders', 'background'),
       ('{"verification":"d6-04-nameserver-round-trip"}'::jsonb,
         'nameserverChange', 'commerce');
     UPDATE payload_migrations SET batch = 113
     WHERE name = '20260809_013335_d6_domain_assets_nameservers_reminders'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const domainAssetOperationsAfterDown = postgres(
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
         (to_regclass('public.domain_expiry_reminders') IS NULL)::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'nameserver_changes'
             AND column_name = 'change_key'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'manual_reviews'
             AND column_name IN ('domain_asset_id', 'nameserver_change_id')
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM pg_enum
           JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
           WHERE pg_type.typname = 'enum_payload_jobs_workflow_slug'
             AND pg_enum.enumlabel IN ('domainExpiryReminders', 'nameserverChange')
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM payload_jobs
           WHERE input->>'verification' IN (
             'd6-04-reminder-round-trip', 'd6-04-nameserver-round-trip'
           )
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (domainAssetOperationsAfterDown !== 'true:true:true:true:true') {
    throw new Error(`D6-04 migration down was incomplete: ${domainAssetOperationsAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyDomainAssetOperationsSchema('D6-04 migration round trip')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 114
     WHERE name = '20260809_053302_d6_active_renewals'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const activeRenewalsAfterDown = postgres(
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
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'renewals'
             AND column_name = 'previous_expires_at'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orders'
             AND column_name = 'operation'
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'quotes'
             AND column_name = 'domain_asset_id'
         ))::text || ':' ||
         (to_regclass('public.domain_expiry_reminders') IS NOT NULL)::text`,
    ],
    { capture: true },
  ).trim()
  if (activeRenewalsAfterDown !== 'true:true:true:true') {
    throw new Error(`D6-05 migration down was incomplete: ${activeRenewalsAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  const activeRenewalsAfterUp = postgres(
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
         (EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'renewals'
             AND column_name = 'previous_expires_at' AND is_nullable = 'NO'
         ))::text || ':' ||
         (EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'orders'
             AND column_name = 'operation'
         ))::text || ':' ||
         (EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'quotes'
             AND column_name = 'domain_asset_id'
         ))::text || ':' ||
         (EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'renewals'
             AND indexname = 'renewals_order_idx'
             AND indexdef ILIKE '%UNIQUE%'
         ))::text || ':' ||
         (to_regclass('public.domain_expiry_reminders') IS NOT NULL)::text`,
    ],
    { capture: true },
  ).trim()
  if (activeRenewalsAfterUp !== 'true:true:true:true:true') {
    throw new Error(`D6-05 migration up was incomplete: ${activeRenewalsAfterUp}`)
  }
  verifyDomainAssetOperationsSchema('D6-05 migration round trip dependency')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `WITH budget AS (
       UPDATE provider_write_budgets
       SET used_operations = 1, used_amount_fen = 100,
           configured_operation_limit = 2, configured_amount_limit_fen = 200
       WHERE scope_key = 'westdigital:register_renew'
       RETURNING id
     )
     INSERT INTO provider_write_budget_debits (
       debit_key, budget_id, operation_delta, amount_fen, updated_at, created_at
     )
     SELECT 'd7-05-migration-round-trip', id, 1, 100, NOW(), NOW() FROM budget;
     UPDATE payload_migrations SET batch = 115
     WHERE name = '20260810_021337_d7_provider_write_budgets';`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const providerBudgetsAfterDown = postgres(
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
         (to_regclass('public.provider_write_budgets') IS NULL)::text || ':' ||
         (to_regclass('public.provider_write_budget_debits') IS NULL)::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM pg_type
           WHERE typname IN (
             'enum_provider_write_budgets_provider',
             'enum_provider_write_budgets_capability'
           )
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (providerBudgetsAfterDown !== 'true:true:true') {
    throw new Error(`D7-05 migration down was incomplete: ${providerBudgetsAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyProviderWriteBudgetSchema('D7-05 historical zero backfill and down/up round trip')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 116
     WHERE name = '20260810_040217_d7_app_master_key';`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const appMasterKeyAfterDown = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'realname_documents'
           AND column_name = 'master_key_version'
       )`,
    ],
    { capture: true },
  ).trim()
  if (appMasterKeyAfterDown !== 't') {
    throw new Error(`D7-06 migration down was incomplete: ${appMasterKeyAfterDown}`)
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
    `UPDATE realname_documents SET storage_state = 'active'
     WHERE object_key = 'legacy/private/document';`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyAppMasterKeySchema('D7-06 historical mock-KMS invalidation and down/up round trip')
  const appMasterKeyBackfill = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT master_key_version || ':' || storage_state::text
       FROM realname_documents
       WHERE object_key = 'legacy/private/document'`,
    ],
    { capture: true },
  ).trim()
  if (appMasterKeyBackfill !== 'legacy-kms-unavailable:upload_failed') {
    throw new Error(`D7-06 legacy mock-KMS backfill was unsafe: ${appMasterKeyBackfill}`)
  }

  // Earlier migration fixtures predate D4's phone contract and intentionally use labels
  // instead of phone numbers. Normalize only those isolated verification rows before
  // exercising the D9 historical-account backfill; the dedicated row inserted below
  // remains the evidence for a real pre-D9 E.164 customer.
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `WITH invalid AS (
       SELECT id, row_number() OVER (ORDER BY id) AS position
       FROM customers
       WHERE phone !~ '^\\+861[3-9][0-9]{9}$'
     )
     UPDATE customers c
     SET
       phone = '+86188' || lpad(invalid.position::text, 8, '0'),
       phone_masked = '+86188****' || right(lpad(invalid.position::text, 8, '0'), 4),
       updated_at = NOW()
     FROM invalid
     WHERE c.id = invalid.id;`,
  ])
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 117
     WHERE name = '20260814_103904_d9a_identity_registration';`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const d9aAfterDown = postgres(
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
         (to_regclass('public.customer_identities') IS NULL)::text || ':' ||
         (to_regclass('public.consent_records') IS NULL)::text || ':' ||
         (to_regclass('public.customer_registration_intents') IS NULL)::text || ':' ||
         (to_regclass('public.wechat_o_auth_states') IS NULL)::text || ':' ||
         (to_regclass('public.wechat_authorization_codes') IS NULL)::text || ':' ||
         (to_regclass('public.wechat_login_scenes') IS NULL)::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'customers'
             AND column_name IN (
               'account_type', 'registration_source', 'default_customer_profile_type',
               'invite_code', 'invited_by_customer_id', 'identity_risk_cooldown_started_at'
             )
         ))::text || ':' ||
         (NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'manual_reviews'
             AND column_name IN ('customer_id', 'customer_identity_id')
         ))::text`,
    ],
    { capture: true },
  ).trim()
  if (d9aAfterDown !== 'true:true:true:true:true:true:true:true') {
    throw new Error(`D9-A-1 migration down was incomplete: ${d9aAfterDown}`)
  }
  const migrationPhoneFixtures = [
    ...normalizablePhoneFixtures.map(({ stored }) => stored),
    duplicateNormalizedPhoneFixture.firstStored,
    duplicateNormalizedPhoneFixture.conflictingStored,
    ...isolatedPhoneFixtures,
  ]
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `INSERT INTO customers (phone, phone_masked, status, updated_at, created_at)
     SELECT phone, 'migration-fixture', 'active', NOW(), NOW()
     FROM (VALUES ${sqlValues(migrationPhoneFixtures)}) AS fixtures(phone);`,
  ])
  const d9MigrationOutput = run('pnpm', ['--filter', '@wanmi/web', 'migrate'], { capture: true })
  const normalizationFailureCountMatch = d9MigrationOutput.match(
    /"normalizationFailureCount":(?<count>[0-9]+)/u,
  )
  if (normalizationFailureCountMatch?.groups?.count !== String(isolatedPhoneFixtures.length)) {
    throw new Error(
      `D9-A-1 migration normalization failure count mismatch: expected ${isolatedPhoneFixtures.length}, received ${normalizationFailureCountMatch?.groups?.count ?? 'missing'}`,
    )
  }
  const identityConflictCountMatch = d9MigrationOutput.match(
    /"identityConflictCount":(?<count>[0-9]+)/u,
  )
  if (identityConflictCountMatch?.groups?.count !== '1') {
    throw new Error(
      `D9-A-1 migration identity conflict count mismatch: expected 1, received ${identityConflictCountMatch?.groups?.count ?? 'missing'}`,
    )
  }
  verifyD9AIdentityRegistrationSchema('historical backfill and down/up round trip')

  const expectedIdentityRows = normalizablePhoneFixtures
    .map(({ expected, stored }, index) => {
      const identifierHash = createHmac('sha256', migrationSessionPepper)
        .update(expected)
        .digest('hex')
      return `(${index + 1}, ${sqlLiteral(stored)}, ${sqlLiteral(identifierHash)})`
    })
    .join(',\n')
  const normalizedIdentityResult = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `WITH expected(position, phone, identifier_hash) AS (
         VALUES ${expectedIdentityRows}
       ), observed AS (
         SELECT
           expected.position,
           c.id,
           c.account_type::text AS account_type,
           c.registration_source::text AS registration_source,
           c.invite_code,
           i.id AS identity_id,
           i.provider::text AS provider,
           i.provider_instance_id,
           i.identifier_hash,
           i.identifier_encrypted,
           COUNT(cr.id) OVER (PARTITION BY c.id) AS consent_count
         FROM expected
         JOIN customers c ON c.phone = expected.phone
         LEFT JOIN customer_identities i ON i.customer_id = c.id
         LEFT JOIN consent_records cr ON cr.customer_id = c.id
       )
       SELECT
         (COUNT(*) = ${normalizablePhoneFixtures.length})::text || ':' ||
         BOOL_AND(account_type = 'legacy_unknown')::text || ':' ||
         BOOL_AND(registration_source = 'legacy_unknown')::text || ':' ||
         BOOL_AND(length(invite_code) = 12)::text || ':' ||
         BOOL_AND(identity_id IS NOT NULL)::text || ':' ||
         BOOL_AND(provider = 'phone')::text || ':' ||
         BOOL_AND(provider_instance_id = '${expectedPhoneIdentityInstance}')::text || ':' ||
         BOOL_AND(observed.identifier_hash = expected.identifier_hash)::text || ':' ||
         BOOL_AND(consent_count = 0)::text
       FROM observed
       JOIN expected USING (position)`,
    ],
    { capture: true },
  ).trim()
  if (normalizedIdentityResult !== 'true:true:true:true:true:true:true:true:true') {
    throw new Error(
      `D9-A-1 unambiguous legacy phone normalization was unsafe: ${normalizedIdentityResult}`,
    )
  }

  const encryptedIdentifiers = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `WITH expected(position, phone) AS (
         VALUES ${normalizablePhoneFixtures
           .map(({ stored }, index) => `(${index + 1}, ${sqlLiteral(stored)})`)
           .join(',\n')}
       )
       SELECT i.identifier_encrypted
       FROM expected
       JOIN customers c ON c.phone = expected.phone
       JOIN customer_identities i ON i.customer_id = c.id
       ORDER BY expected.position`,
    ],
    { capture: true },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  const decryptedIdentifiers = encryptedIdentifiers.map(decryptMigrationIdentifier)
  if (
    decryptedIdentifiers.length !== normalizablePhoneFixtures.length ||
    !decryptedIdentifiers.every(
      (value, index) => value === normalizablePhoneFixtures[index].expected,
    )
  ) {
    throw new Error(
      'D9-A-1 normalized identity encryption did not contain the expected E.164 values',
    )
  }

  const isolatedCustomerResult = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `WITH fixtures(phone) AS (
         VALUES ${sqlValues(isolatedPhoneFixtures)}
       ), observed AS (
         SELECT
           c.id,
           COUNT(DISTINCT i.id) AS identity_count,
           COUNT(DISTINCT cr.id) AS consent_count,
           COUNT(DISTINCT r.id) AS review_count,
           COUNT(DISTINCT r.id) FILTER (
             WHERE r.reason_code = 'd9a_legacy_phone_normalization_failed'
               AND r.status::text = 'open'
               AND r.order_id IS NULL
               AND r.customer_identity_id IS NULL
               AND r.evidence IS NULL
           ) AS valid_review_count
         FROM fixtures
         JOIN customers c ON c.phone = fixtures.phone
         LEFT JOIN customer_identities i ON i.customer_id = c.id
         LEFT JOIN consent_records cr ON cr.customer_id = c.id
         LEFT JOIN manual_reviews r ON r.customer_id = c.id
         GROUP BY c.id
       )
       SELECT
         (COUNT(*) = ${isolatedPhoneFixtures.length})::text || ':' ||
         BOOL_AND(identity_count = 0)::text || ':' ||
         BOOL_AND(consent_count = 0)::text || ':' ||
         BOOL_AND(review_count = 1)::text || ':' ||
         BOOL_AND(valid_review_count = 1)::text
       FROM observed`,
    ],
    { capture: true },
  ).trim()
  if (isolatedCustomerResult !== 'true:true:true:true:true') {
    throw new Error(`D9-A-1 legacy phone isolation was unsafe: ${isolatedCustomerResult}`)
  }

  const duplicateIdentifierHash = createHmac('sha256', migrationSessionPepper)
    .update(duplicateNormalizedPhoneFixture.expected)
    .digest('hex')
  const duplicateIdentityResult = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `WITH observed AS (
         SELECT
           c.phone,
           COUNT(DISTINCT i.id) AS identity_count,
           MAX(i.identifier_hash) AS identifier_hash,
           COUNT(DISTINCT r.id) AS review_count,
           COUNT(DISTINCT r.id) FILTER (
             WHERE r.reason_code = 'd9a_legacy_phone_duplicate'
               AND r.status::text = 'open'
               AND r.order_id IS NULL
               AND r.customer_identity_id IS NULL
               AND r.evidence IS NULL
               AND r.resolution_note IS NULL
               AND r.resolved_by_id IS NULL
               AND r.resolved_at IS NULL
           ) AS valid_duplicate_review_count
         FROM customers c
         LEFT JOIN customer_identities i ON i.customer_id = c.id
         LEFT JOIN manual_reviews r ON r.customer_id = c.id
         WHERE c.phone IN (
           ${sqlLiteral(duplicateNormalizedPhoneFixture.firstStored)},
           ${sqlLiteral(duplicateNormalizedPhoneFixture.conflictingStored)}
         )
         GROUP BY c.phone
       )
       SELECT
         (COUNT(*) = 2)::text || ':' ||
         BOOL_AND(
           CASE
             WHEN phone = ${sqlLiteral(duplicateNormalizedPhoneFixture.firstStored)}
               THEN identity_count = 1
                 AND identifier_hash = ${sqlLiteral(duplicateIdentifierHash)}
                 AND review_count = 0
             WHEN phone = ${sqlLiteral(duplicateNormalizedPhoneFixture.conflictingStored)}
               THEN identity_count = 0
                 AND review_count = 1
                 AND valid_duplicate_review_count = 1
             ELSE false
           END
         )::text
       FROM observed`,
    ],
    { capture: true },
  ).trim()
  if (duplicateIdentityResult !== 'true:true') {
    throw new Error(
      `D9-A-1 duplicate normalized identity isolation was unsafe: ${duplicateIdentityResult}`,
    )
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
    `UPDATE payload_migrations SET batch = 117
     WHERE name = '20260814_103904_d9a_identity_registration';`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const isolatedReviewsAfterDown = postgres(
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
         COUNT(*) FILTER (
           WHERE reason_code = 'd9a_legacy_phone_normalization_failed'
         )::text || ':' ||
         COUNT(*) FILTER (
           WHERE reason_code = 'd9a_legacy_phone_duplicate'
         )::text
       FROM manual_reviews`,
    ],
    { capture: true },
  ).trim()
  if (isolatedReviewsAfterDown !== '0:0') {
    throw new Error(
      `D9-A-1 migration down left legacy phone isolation reviews behind: ${isolatedReviewsAfterDown}`,
    )
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyD9AIdentityRegistrationSchema('legacy phone isolation down/up round trip')

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 118
     WHERE name = '20260817_040409_d9b1_wallet_ledger';`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  const walletSchemaAfterDown = postgres(
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
         (to_regclass('public.wallet_accounts') IS NULL)::text || ':' ||
         (to_regclass('public.wallet_transactions') IS NULL)::text || ':' ||
         (to_regclass('public.wallet_entries') IS NULL)::text || ':' ||
         (NOT ('walletLedgerConsistencyCheck' = ANY(
           enum_range(NULL::enum_payload_jobs_workflow_slug)::text[]
         )))::text`,
    ],
    { capture: true },
  ).trim()
  if (walletSchemaAfterDown !== 'true:true:true:true') {
    throw new Error(`D9-B-1 migration down left wallet schema behind: ${walletSchemaAfterDown}`)
  }
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  verifyWalletLedgerSchema('D9-B-1 down/up round trip')

  process.stdout.write(
    'Verified empty-database migrations, D1-03 legacy redirects, D1-05 legacy administrator MFA, the last-system-admin constraint, the D1-07 audit reader index, the D1-08 event schema, the D2-07 price snapshot schema, the D2-11 observability aggregate schema, the D3-01 content CMS backfill, the D3-02 relation/SEO migration, the D3-03 controlled-advertising migration, the D3-04 event/maintenance migration, the D3-05 managed form migration, the D4-01 customer authentication/SMS migration, the D4-02 real-name template migration, the D4-03 private-document migration, the D4-04 real-name lifecycle migration, the D5-01 customer quote migration, the D5-03 Wechat payment migration, the D5-04 Wechat refund/reconciliation migration, the D5-05 price rule migration, the D5-06 payment front-end/timeout migration, the D5-07 payment recovery/manual audit migration, the D6-01 West Digital provider-operation migration, the D6-02 commerce-fulfillment migration, the D6-03 West Digital balance-monitoring workflow migration, the D6-04 domain-asset operations migration, the D6-05 active-renewal migration, the D7-05 provider write budget historical backfill/down-up round trips, the D7-06 application master-key historical invalidation/down-up round trip, the D9-A-1 identity/consent historical normalization, isolation, and down/up round trip without fabricated consent, and the D9-B-1 wallet ledger empty/down-up schema contract.\n',
  )
} finally {
  migrationIdentityKey.fill(0)
  if (created) {
    postgres(['dropdb', '--force', '--username', 'wanmi', databaseName])
  }
}
