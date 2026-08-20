import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationName = '20260820_090731_d9e3_permanent_vip'
const migrationPath = fileURLToPath(
  new URL(`../apps/web/migrations/${migrationName}.ts`, import.meta.url),
)
const databaseName = `wanmi_d9e3_vip_migration_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9e3_vip_migration_[0-9]+_[0-9]+$/u)

const decodeOverride = (name, fallbackPath) =>
  process.env[name]
    ? Buffer.from(process.env[name], 'base64').toString('utf8')
    : readFileSync(fallbackPath, 'utf8')
const source = decodeOverride('D9E3_MIGRATION_SOURCE_BASE64', migrationPath)
const releasePolicy = JSON.parse(
  decodeOverride(
    'D9E3_RELEASE_POLICY_BASE64',
    fileURLToPath(new URL('../deploy/release-policy.json', import.meta.url)),
  ),
)
const releaseManifest = JSON.parse(
  decodeOverride(
    'D9E3_RELEASE_MANIFEST_BASE64',
    fileURLToPath(new URL('../deploy/release-manifest.example.json', import.meta.url)),
  ),
)
const releaseRule = releasePolicy.migrations?.[migrationName]
assert.equal(releaseRule?.phase, 'expand', 'D9-E-3 must be an expand migration')
assert.equal(releaseRule?.newCodeCompatibleBeforeUp, true)
assert.equal(releaseRule?.oldCodeCompatible, true)
assert.equal(releaseRule?.rollback, 'retain')
assert.equal(
  releaseManifest.migrations?.filter((name) => name === migrationName).length,
  1,
  'D9-E-3 release manifest must contain the migration exactly once',
)

const functionBody = (name) => {
  const start = source.indexOf(`export async function ${name}`)
  const end = source.indexOf(
    `export async function ${name === 'up' ? 'down' : '__end__'}`,
    start + 1,
  )
  return source.slice(start, end < 0 ? source.length : end)
}
const statements = (name) =>
  [...functionBody(name).matchAll(/await db\.execute\(sql`([\s\S]*?)`\)/gu)].map(
    (match) => match[1],
  )
const upStatements = statements('up')
const downStatements = statements('down')
assert.equal(upStatements.length, 2, 'D9-E-3 UP must separate generated DDL and invariant checks')
assert.equal(downStatements.length, 1, 'D9-E-3 DOWN must be one guarded transaction')
assert.ok(
  [...upStatements, ...downStatements].every((statement) => !statement.includes('${')),
  'D9-E-3 migration SQL must not interpolate values',
)
const upSql = upStatements.join('\n')
const downSql = downStatements.join('\n')

const docker = (args, capture = false) =>
  execFileSync('docker', ['compose', 'exec', '-T', 'postgres', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })
const psqlArgs = (statement) => [
  'compose',
  'exec',
  '-T',
  'postgres',
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
]
const psql = (statement, capture = false) =>
  execFileSync('docker', psqlArgs(statement), {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })
const psqlFailure = (statement) =>
  spawnSync('docker', psqlArgs(statement), {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  })
const scalar = (statement) => psql(statement, true).trim()
const rejectsWrite = (statement, label) => {
  assert.notEqual(psqlFailure(statement).status, 0, `accepted invalid D9-E-3 write: ${label}`)
}

const baseSchema = `
CREATE TYPE enum_notification_outbox_events_category AS ENUM('transactional', 'marketing');
CREATE TYPE enum_notification_outbox_events_notification_type AS ENUM(
  'admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed',
  'invitation_reward_withheld', 'product_updates', 'promotions'
);
CREATE TABLE customers (id serial PRIMARY KEY);
CREATE TABLE orders (id serial PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers(id));
CREATE TABLE admin_approval_requests (id serial PRIMARY KEY);
CREATE TABLE notification_outbox_events (
  id serial PRIMARY KEY,
  category enum_notification_outbox_events_category NOT NULL,
  notification_type enum_notification_outbox_events_notification_type NOT NULL,
  CONSTRAINT notification_outbox_events_category_type_valid CHECK (
    (category = 'transactional' AND notification_type IN (
      'admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed',
      'invitation_reward_withheld'
    )) OR
    (category = 'marketing' AND notification_type IN ('product_updates', 'promotions'))
  )
);
INSERT INTO customers (id) VALUES (1), (2);
INSERT INTO orders (id, customer_id) VALUES (1, 1), (2, 1);
INSERT INTO admin_approval_requests (id) VALUES (1);
`

try {
  docker(['createdb', '--username', 'wanmi', databaseName])
  psql(baseSchema)
  assert.doesNotThrow(() => psql(upSql), 'D9-E-3 UP must apply to the predecessor schema')

  assert.equal(
    scalar(`SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'vip_tier_rule_versions', 'vip_tier_rule_levels', 'vip_spend_entries',
        'vip_tier_events', 'vip_tier_appeals'
      );`),
    '5',
  )
  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_vip_tier_events_source), ',');`),
    'natural_achievement,operational_promotion,data_correction,fraud_reversal',
    'D9-E-3 must have exactly the four approved tier-event sources',
  )
  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_vip_spend_entries_entry_type), ',');`),
    'succeeded_order,order_reversal,data_correction,fraud_reversal',
    'D9-E-3 must have exactly the four cumulative-spend fact types',
  )
  assert.equal(
    scalar(
      `SELECT array_to_string(enum_range(NULL::enum_vip_spend_entries_payment_channel), ',');`,
    ),
    'native,h5,balance',
    'D9-E-3 must retain all three order payment channels',
  )
  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_vip_tier_events_event_type), ',');`),
    'tier_achievement,tier_correction',
    'D9-E-3 must separate achievements from corrections',
  )
  assert.equal(
    scalar(
      `SELECT array_to_string(enum_range(NULL::enum_notification_outbox_events_notification_type), ',');`,
    ),
    'admin_high_risk_operation_submitted,admin_high_risk_operation_executed,invitation_reward_withheld,vip_benefit_change_advance,product_updates,promotions',
    'D9-E-3 must add exactly one transactional notification type',
  )
  psql(`INSERT INTO notification_outbox_events (category, notification_type)
    VALUES ('transactional', 'vip_benefit_change_advance');`)
  rejectsWrite(
    `INSERT INTO notification_outbox_events (category, notification_type)
     VALUES ('marketing', 'vip_benefit_change_advance');`,
    'VIP advance notification categorized as marketing',
  )

  psql(`INSERT INTO vip_tier_rule_versions (
      id, version, schema_version, effective_at, notice_published_at,
      changed_by, change_note, updated_at, created_at
    ) VALUES (1, 1, 1, NOW() + INTERVAL '2 days', NOW(),
      'fixture-admin', 'valid versioned rule', NOW(), NOW());`)
  psql(`INSERT INTO vip_tier_rule_levels (
      id, rule_version_id, version_number, tier_code, tier_rank, display_name,
      threshold_fen, quota_benefits, service_content, updated_at, created_at
    ) VALUES
      (1, 1, 1, 'bronze', 1, 'Bronze', 1000, '{"quota":10}', 'Base', NOW(), NOW()),
      (2, 1, 1, 'silver', 2, 'Silver', 5000, '{"quota":30}', 'Plus', NOW(), NOW());`)
  psql(`INSERT INTO vip_spend_entries (
      entry_key, customer_id, source_order_id, entry_type, payment_channel,
      amount_fen, reference, occurred_at, updated_at, created_at
    ) VALUES ('order:1:success', 1, 1, 'succeeded_order', 'balance',
      5000, 'event:1', NOW(), NOW(), NOW());`)
  psql(`INSERT INTO vip_tier_events (
      event_key, customer_id, event_type, source, trigger_order_id,
      rule_version_id, rule_version_number, tier_code, tier_rank,
      tier_name_snapshot, quota_benefits_snapshot, service_content_snapshot,
      cumulative_spend_fen_snapshot, previous_tier_rank, reason,
      occurred_at, updated_at, created_at
    ) VALUES ('tier:1:silver', 1, 'tier_achievement', 'natural_achievement', 1,
      1, 1, 'silver', 2, 'Silver', '{"quota":30}', 'Plus', 5000, 0,
      'threshold reached', NOW(), NOW(), NOW());`)
  psql(`INSERT INTO vip_spend_entries (
      entry_key, customer_id, entry_type, amount_fen, approval_request_id,
      reference, occurred_at, updated_at, created_at
    ) VALUES ('correction:1:spend', 1, 'data_correction', 1000, 1,
      'ticket:1', NOW(), NOW(), NOW());`)
  psql(`INSERT INTO vip_tier_events (
      event_key, customer_id, event_type, source, rule_version_id,
      rule_version_number, tier_code, tier_rank, tier_name_snapshot,
      quota_benefits_snapshot, service_content_snapshot,
      cumulative_spend_fen_snapshot, previous_tier_rank, reason,
      approval_request_id, correction_reference, occurred_at, updated_at, created_at
    ) VALUES ('tier:1:correction', 1, 'tier_correction', 'data_correction', 1,
      1, 'bronze', 1, 'Bronze', '{"quota":10}', 'Base', 4000, 2,
      'duplicate amount removed', 1, 'ticket:1', NOW(), NOW(), NOW());`)
  psql(`INSERT INTO vip_tier_appeals (
      appeal_key, customer_id, tier_event_id, statement, submitted_at, updated_at, created_at
    ) VALUES ('appeal:1', 1, 2, 'Please review this correction.', NOW(), NOW(), NOW());`)
  psql(`SELECT setval(pg_get_serial_sequence('vip_tier_rule_versions', 'id'),
      (SELECT MAX(id) FROM vip_tier_rule_versions));`)
  psql(`SELECT setval(pg_get_serial_sequence('vip_tier_rule_levels', 'id'),
      (SELECT MAX(id) FROM vip_tier_rule_levels));`)

  rejectsWrite(
    `INSERT INTO vip_tier_rule_versions (
      version, schema_version, effective_at, changed_by, change_note, updated_at, created_at
    ) VALUES (2.5, 1, NOW(), 'admin', 'fractional version', NOW(), NOW());`,
    'fractional rule version',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_versions (
      version, schema_version, effective_at, changed_by, change_note, updated_at, created_at
    ) VALUES (2, 2, NOW(), 'admin', 'invalid schema version', NOW(), NOW());`,
    'unsupported rule schema version',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_versions (
      version, schema_version, effective_at, notice_published_at,
      changed_by, change_note, updated_at, created_at
    ) VALUES (2, 1, NOW(), NOW() + INTERVAL '1 second',
      'admin', 'notice after effective time', NOW(), NOW());`,
    'notice after effective time',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_versions (
      version, schema_version, effective_at, changed_by, change_note, updated_at, created_at
    ) VALUES (2, 1, NOW(), '', 'valid change note', NOW(), NOW());`,
    'blank rule publisher',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_versions (
      version, schema_version, effective_at, changed_by, change_note, updated_at, created_at
    ) VALUES (2, 1, NOW(), 'admin', 'short', NOW(), NOW());`,
    'short rule change note',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_versions (
      version, schema_version, effective_at, changed_by, change_note, updated_at, created_at
    ) VALUES (1, 1, NOW(), 'admin', 'duplicate version', NOW(), NOW());`,
    'duplicate rule version',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_levels (
      rule_version_id, version_number, tier_code, tier_rank, display_name,
      threshold_fen, quota_benefits, service_content, updated_at, created_at
    ) VALUES (1, 1, 'bad-code', 3, 'Bad', 6000, '{}', 'Bad', NOW(), NOW());`,
    'invalid tier code',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_levels (
      rule_version_id, version_number, tier_code, tier_rank, display_name,
      threshold_fen, quota_benefits, service_content, updated_at, created_at
    ) VALUES (1, 1.5, 'gold', 3, 'Gold', 6000, '{}', 'Gold', NOW(), NOW());`,
    'fractional rule-level version',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_levels (
      rule_version_id, version_number, tier_code, tier_rank, display_name,
      threshold_fen, quota_benefits, service_content, updated_at, created_at
    ) VALUES (1, 1, 'gold', 0, 'Gold', 6000, '{}', 'Gold', NOW(), NOW());`,
    'zero tier rank',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_levels (
      rule_version_id, version_number, tier_code, tier_rank, display_name,
      threshold_fen, quota_benefits, service_content, updated_at, created_at
    ) VALUES (1, 1, 'gold', 3, 'Gold', 0, '{}', 'Gold', NOW(), NOW());`,
    'zero tier threshold',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_levels (
      rule_version_id, version_number, tier_code, tier_rank, display_name,
      threshold_fen, quota_benefits, service_content, updated_at, created_at
    ) VALUES (1, 1, 'gold', 3, '', 6000, '{}', 'Gold', NOW(), NOW());`,
    'blank tier display name',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_levels (
      rule_version_id, version_number, tier_code, tier_rank, display_name,
      threshold_fen, quota_benefits, service_content, updated_at, created_at
    ) VALUES (1, 1, 'gold', 3, 'Gold', 6000, '{}', '', NOW(), NOW());`,
    'blank tier service content',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_levels (
      rule_version_id, version_number, tier_code, tier_rank, display_name,
      threshold_fen, quota_benefits, service_content, updated_at, created_at
    ) VALUES (1, 1, 'gold', 3, 'Gold', 6000, '[]', 'Gold', NOW(), NOW());`,
    'non-object tier benefits',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_levels (
      rule_version_id, version_number, tier_code, tier_rank, display_name,
      threshold_fen, quota_benefits, service_content, updated_at, created_at
    ) VALUES (1, 1, 'gold', 1, 'Gold', 6000, '{}', 'Gold', NOW(), NOW());`,
    'duplicate tier rank in one version',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_rule_levels (
      rule_version_id, version_number, tier_code, tier_rank, display_name,
      threshold_fen, quota_benefits, service_content, updated_at, created_at
    ) VALUES (1, 1, 'bronze', 3, 'Gold', 6000, '{}', 'Gold', NOW(), NOW());`,
    'duplicate tier code in one version',
  )
  rejectsWrite(
    `INSERT INTO vip_spend_entries (
      entry_key, customer_id, source_order_id, entry_type, payment_channel,
      amount_fen, reference, occurred_at, updated_at, created_at
    ) VALUES ('order:1:duplicate', 1, 1, 'succeeded_order', 'native',
      5000, 'event:duplicate', NOW(), NOW(), NOW());`,
    'duplicate source order fact',
  )
  rejectsWrite(
    `INSERT INTO vip_spend_entries (
      entry_key, customer_id, source_order_id, entry_type, payment_channel,
      amount_fen, reference, occurred_at, updated_at, created_at
    ) VALUES ('order:2:fractional', 1, 2, 'succeeded_order', 'native',
      1.5, 'fractional amount', NOW(), NOW(), NOW());`,
    'fractional spend amount',
  )
  rejectsWrite(
    `INSERT INTO vip_spend_entries (
      entry_key, customer_id, source_order_id, entry_type, payment_channel,
      amount_fen, reference, occurred_at, updated_at, created_at
    ) VALUES ('order:2:blank-reference', 1, 2, 'succeeded_order', 'native',
      1000, '', NOW(), NOW(), NOW());`,
    'blank spend reference',
  )
  rejectsWrite(
    `INSERT INTO vip_spend_entries (
      entry_key, customer_id, source_order_id, entry_type, amount_fen,
      reference, occurred_at, updated_at, created_at
    ) VALUES ('bad-success-shape', 1, 2, 'succeeded_order', 1000,
      'event:bad', NOW(), NOW(), NOW());`,
    'successful spend without payment channel',
  )
  rejectsWrite(
    `INSERT INTO vip_spend_entries (
      entry_key, customer_id, source_order_id, entry_type, payment_channel,
      amount_fen, reference, occurred_at, updated_at, created_at
    ) VALUES ('bad-reversal-shape', 1, 2, 'order_reversal', 'native', 1000,
      'bad reversal', NOW(), NOW(), NOW());`,
    'order reversal carrying a payment channel',
  )
  rejectsWrite(
    `INSERT INTO vip_spend_entries (
      entry_key, customer_id, source_order_id, entry_type, amount_fen,
      reference, occurred_at, updated_at, created_at
    ) VALUES ('bad-correction-spend-shape', 1, 2, 'data_correction', 1000,
      'bad correction spend', NOW(), NOW(), NOW());`,
    'data correction spend without approval and with an order',
  )
  rejectsWrite(
    `INSERT INTO vip_spend_entries (
      entry_key, customer_id, source_order_id, entry_type, payment_channel,
      amount_fen, reference, occurred_at, updated_at, created_at
    ) VALUES ('order:1:success', 1, 2, 'succeeded_order', 'native',
      1000, 'duplicate entry key', NOW(), NOW(), NOW());`,
    'duplicate spend entry key',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_events (
      event_key, customer_id, event_type, source, rule_version_id,
      rule_version_number, tier_code, tier_rank, tier_name_snapshot,
      quota_benefits_snapshot, service_content_snapshot,
      cumulative_spend_fen_snapshot, previous_tier_rank, reason,
      approval_request_id, correction_reference, occurred_at, updated_at, created_at
    ) VALUES ('bad-correction-direction', 1, 'tier_correction', 'data_correction', 1,
      1, 'silver', 2, 'Silver', '{}', 'Plus', 4000, 1, 'raises instead',
      1, 'ticket:direction', NOW(), NOW(), NOW());`,
    'approved correction that does not lower tier',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_events (
      event_key, customer_id, event_type, source, rule_version_id,
      rule_version_number, tier_code, tier_rank, tier_name_snapshot,
      quota_benefits_snapshot, service_content_snapshot,
      cumulative_spend_fen_snapshot, previous_tier_rank, reason,
      correction_reference, occurred_at, updated_at, created_at
    ) VALUES ('bad-correction-approval', 1, 'tier_correction', 'data_correction', 1,
      1, 'bronze', 1, 'Bronze', '{}', 'Base', 4000, 2, 'missing approval',
      'ticket:approval', NOW(), NOW(), NOW());`,
    'correction without approval',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_events (
      event_key, customer_id, event_type, source, rule_version_id,
      rule_version_number, tier_code, tier_rank, tier_name_snapshot,
      quota_benefits_snapshot, service_content_snapshot,
      cumulative_spend_fen_snapshot, previous_tier_rank, reason,
      approval_request_id, occurred_at, updated_at, created_at
    ) VALUES ('bad-correction-reference', 1, 'tier_correction', 'data_correction', 1,
      1, 'bronze', 1, 'Bronze', '{}', 'Base', 4000, 2, 'missing reference',
      1, NOW(), NOW(), NOW());`,
    'correction without a visible reference',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_events (
      event_key, customer_id, event_type, source, rule_version_id,
      rule_version_number, tier_code, tier_rank, tier_name_snapshot,
      quota_benefits_snapshot, service_content_snapshot,
      cumulative_spend_fen_snapshot, previous_tier_rank, reason,
      approval_request_id, correction_reference, occurred_at, updated_at, created_at
    ) VALUES ('bad-correction-source', 1, 'tier_correction', 'operational_promotion', 1,
      1, 'bronze', 1, 'Bronze', '{}', 'Base', 4000, 2, 'invalid correction source',
      1, 'ticket:source', NOW(), NOW(), NOW());`,
    'correction using a promotion source',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_events (
      event_key, customer_id, event_type, source, trigger_order_id, rule_version_id,
      rule_version_number, tier_code, tier_rank, tier_name_snapshot,
      quota_benefits_snapshot, service_content_snapshot,
      cumulative_spend_fen_snapshot, previous_tier_rank, reason,
      occurred_at, updated_at, created_at
    ) VALUES ('bad-achievement-source', 1, 'tier_achievement', 'data_correction', 2, 1,
      1, 'silver', 2, 'Silver', '{}', 'Plus', 5000, 1, 'bad source',
      NOW(), NOW(), NOW());`,
    'achievement using a correction source',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_events (
      event_key, customer_id, event_type, source, trigger_order_id, rule_version_id,
      rule_version_number, tier_code, tier_rank, tier_name_snapshot,
      quota_benefits_snapshot, service_content_snapshot,
      cumulative_spend_fen_snapshot, previous_tier_rank, reason,
      occurred_at, updated_at, created_at
    ) VALUES ('bad-promotion-trigger', 1, 'tier_achievement', 'operational_promotion', 2, 1,
      1, 'silver', 2, 'Silver', '{}', 'Plus', 5000, 1, 'promotion without order',
      NOW(), NOW(), NOW());`,
    'promotion achievement carrying a triggering order',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_events (
      event_key, customer_id, event_type, source, rule_version_id,
      rule_version_number, tier_code, tier_rank, tier_name_snapshot,
      quota_benefits_snapshot, service_content_snapshot,
      cumulative_spend_fen_snapshot, previous_tier_rank, reason,
      approval_request_id, correction_reference, occurred_at, updated_at, created_at
    ) VALUES ('bad-zero-code', 1, 'tier_correction', 'data_correction', 1,
      1, 'bronze', 0, 'None', '{}', 'None', 0, 1, 'zero rank with code',
      1, 'ticket:zero', NOW(), NOW(), NOW());`,
    'zero tier rank carrying a tier code',
  )
  for (const [eventKey, tierName, benefits, serviceContent, cumulative, reason, label] of [
    ['bad-event-name', '', '{}', 'Plus', 5000, 'valid reason', 'blank event tier name'],
    [
      'bad-event-benefits',
      'Silver',
      '[]',
      'Plus',
      5000,
      'valid reason',
      'non-object event benefits',
    ],
    ['bad-event-service', 'Silver', '{}', '', 5000, 'valid reason', 'blank event service'],
    [
      'bad-event-cumulative',
      'Silver',
      '{}',
      'Plus',
      -1,
      'valid reason',
      'negative event cumulative',
    ],
    ['bad-event-reason', 'Silver', '{}', 'Plus', 5000, '', 'blank event reason'],
  ]) {
    rejectsWrite(
      `INSERT INTO vip_tier_events (
        event_key, customer_id, event_type, source, trigger_order_id, rule_version_id,
        rule_version_number, tier_code, tier_rank, tier_name_snapshot,
        quota_benefits_snapshot, service_content_snapshot,
        cumulative_spend_fen_snapshot, previous_tier_rank, reason,
        occurred_at, updated_at, created_at
      ) VALUES ('${eventKey}', 1, 'tier_achievement', 'natural_achievement', 2, 1,
        1, 'silver', 2, '${tierName}', '${benefits}', '${serviceContent}', ${cumulative}, 1,
        '${reason}', NOW(), NOW(), NOW());`,
      label,
    )
  }
  rejectsWrite(
    `INSERT INTO vip_tier_events (
      event_key, customer_id, event_type, source, trigger_order_id, rule_version_id,
      rule_version_number, tier_code, tier_rank, tier_name_snapshot,
      quota_benefits_snapshot, service_content_snapshot,
      cumulative_spend_fen_snapshot, previous_tier_rank, reason,
      occurred_at, updated_at, created_at
    ) VALUES ('tier:1:silver', 1, 'tier_achievement', 'natural_achievement', 2, 1,
      1, 'silver', 2, 'Silver', '{}', 'Plus', 5000, 1, 'duplicate event key',
      NOW(), NOW(), NOW());`,
    'duplicate tier event key',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_appeals (
      appeal_key, customer_id, tier_event_id, statement, submitted_at, updated_at, created_at
    ) VALUES ('short-appeal', 2, 2, 'short', NOW(), NOW(), NOW());`,
    'short appeal statement',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_appeals (
      appeal_key, customer_id, tier_event_id, statement, submitted_at, updated_at, created_at
    ) VALUES ('appeal:1', 2, 2, 'Duplicate appeal key.', NOW(), NOW(), NOW());`,
    'duplicate appeal key',
  )
  rejectsWrite(
    `INSERT INTO vip_tier_appeals (
      appeal_key, customer_id, tier_event_id, statement, submitted_at, updated_at, created_at
    ) VALUES ('appeal:2', 1, 2, 'Duplicate customer event appeal.', NOW(), NOW(), NOW());`,
    'duplicate customer tier-event appeal',
  )

  const deleteHistoricalSourceOrder = psqlFailure(`DELETE FROM orders WHERE id = 1;`)
  assert.equal(
    deleteHistoricalSourceOrder.status,
    0,
    'deleting an order must not be blocked by retained VIP history',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM vip_spend_entries
      WHERE entry_key = 'order:1:success' AND source_order_id IS NULL;`),
    '1',
    'deleting an order must retain the immutable spend fact and clear only its relation',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM vip_tier_events
      WHERE event_key = 'tier:1:silver' AND trigger_order_id IS NULL;`),
    '1',
    'deleting an order must retain the immutable tier event and clear only its relation',
  )
  psql(`DELETE FROM orders WHERE id = 2;`)
  const deleteHistoricalCustomer = psqlFailure(`DELETE FROM customers WHERE id = 1;`)
  assert.equal(
    deleteHistoricalCustomer.status,
    0,
    'deleting a customer must not be blocked by retained anonymized VIP history',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM vip_spend_entries
      WHERE entry_key = 'order:1:success' AND customer_id IS NULL;`),
    '1',
    'deleting a customer must retain the immutable spend fact and clear only its relation',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM vip_tier_events
      WHERE event_key = 'tier:1:silver' AND customer_id IS NULL;`),
    '1',
    'deleting a customer must retain the immutable tier event and clear only its relation',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM vip_tier_appeals
      WHERE appeal_key = 'appeal:1' AND customer_id IS NULL;`),
    '1',
    'deleting a customer must retain the immutable appeal and clear only its relation',
  )
  psql(`DELETE FROM vip_tier_rule_levels WHERE rule_version_id = 1;`)
  const deleteHistoricalRuleVersion = psqlFailure(
    `DELETE FROM vip_tier_rule_versions WHERE id = 1;`,
  )
  assert.equal(
    deleteHistoricalRuleVersion.status,
    0,
    'deleting a rule version must not be blocked by retained VIP history',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM vip_tier_events
      WHERE event_key = 'tier:1:silver'
        AND rule_version_id IS NULL
        AND rule_version_number = 1
        AND tier_code = 'silver'
        AND tier_rank = 2
        AND tier_name_snapshot = 'Silver'
        AND quota_benefits_snapshot = '{"quota": 30}'::jsonb
        AND service_content_snapshot = 'Plus'
        AND cumulative_spend_fen_snapshot = 5000;`),
    '1',
    'deleting a rule version must retain the immutable achievement snapshot and clear only its relation',
  )

  const refusedDown = psqlFailure(downSql)
  assert.notEqual(
    refusedDown.status,
    0,
    'D9-E-3 DOWN must refuse to discard queued VIP advance notifications',
  )
  assert.match(
    refusedDown.stderr,
    /cannot roll back D9-E-3 while VIP advance notifications exist/u,
    'D9-E-3 DOWN must fail at the queued-notification guard',
  )
  psql(`DELETE FROM notification_outbox_events
    WHERE notification_type = 'vip_benefit_change_advance';`)
  assert.doesNotThrow(() => psql(downSql), 'D9-E-3 DOWN must succeed after facts are drained')
  assert.equal(
    scalar(`SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'vip_%';`),
    '0',
  )
  assert.equal(
    scalar(
      `SELECT array_to_string(enum_range(NULL::enum_notification_outbox_events_notification_type), ',');`,
    ),
    'admin_high_risk_operation_submitted,admin_high_risk_operation_executed,invitation_reward_withheld,product_updates,promotions',
  )

  process.stdout.write('D9-E-3 VIP migration verification passed.\n')
} finally {
  docker(['dropdb', '--username', 'wanmi', '--if-exists', databaseName])
}
