import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL('../apps/web/migrations/20260820_051725_d9e1_invitations_abuse.ts', import.meta.url),
)
const releasePolicyPath = fileURLToPath(new URL('../deploy/release-policy.json', import.meta.url))
const releaseManifestPath = fileURLToPath(
  new URL('../deploy/release-manifest.example.json', import.meta.url),
)
const migrationName = '20260820_051725_d9e1_invitations_abuse'
const databaseName = `wanmi_d9e1_invitations_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9e1_invitations_[0-9]+_[0-9]+$/u)

const source = process.env.D9E1_MIGRATION_SOURCE_BASE64
  ? Buffer.from(process.env.D9E1_MIGRATION_SOURCE_BASE64, 'base64').toString('utf8')
  : readFileSync(migrationPath, 'utf8')
const releasePolicy = JSON.parse(
  process.env.D9E1_RELEASE_POLICY_BASE64
    ? Buffer.from(process.env.D9E1_RELEASE_POLICY_BASE64, 'base64').toString('utf8')
    : readFileSync(releasePolicyPath, 'utf8'),
)
const releaseManifest = JSON.parse(
  process.env.D9E1_RELEASE_MANIFEST_BASE64
    ? Buffer.from(process.env.D9E1_RELEASE_MANIFEST_BASE64, 'base64').toString('utf8')
    : readFileSync(releaseManifestPath, 'utf8'),
)
const releaseRule = releasePolicy.migrations?.[migrationName]
assert.equal(releaseRule?.phase, 'expand', 'D9-E-1 migration must use the expand phase')
assert.equal(releaseRule?.newCodeCompatibleBeforeUp, true)
assert.equal(releaseRule?.oldCodeCompatible, true)
assert.equal(releaseRule?.rollback, 'retain')
assert.equal(
  releaseManifest.migrations?.filter((name) => name === migrationName).length,
  1,
  'D9-E-1 release manifest must contain the migration exactly once',
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
const upSql = statements('up').join('\n')
const downSql = statements('down').join('\n')
assert.ok(upSql, 'D9-E-1 migration UP SQL must be extractable')
assert.ok(downSql, 'D9-E-1 migration DOWN SQL must be extractable')
assert.ok(!upSql.includes('${'), 'D9-E-1 migration UP SQL must not interpolate values')
assert.ok(!downSql.includes('${'), 'D9-E-1 migration DOWN SQL must not interpolate values')

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
  const result = psqlFailure(statement)
  assert.notEqual(result.status, 0, `accepted an invalid write: ${label}`)
}

const baseSchema = `
CREATE TYPE enum_points_batches_source_type AS ENUM('order_reward');
CREATE TYPE enum_notification_outbox_events_category AS ENUM('transactional', 'marketing');
CREATE TYPE enum_notification_outbox_events_notification_type AS ENUM(
  'admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed',
  'product_updates', 'promotions'
);
CREATE TABLE customers (
  id serial PRIMARY KEY,
  invite_code varchar UNIQUE,
  invited_by_customer_id integer REFERENCES customers(id),
  created_at timestamptz DEFAULT NOW() NOT NULL,
  updated_at timestamptz DEFAULT NOW() NOT NULL
);
CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id)
);
CREATE TABLE realname_templates (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id)
);
CREATE TABLE points_batches (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id),
  source_type enum_points_batches_source_type NOT NULL,
  created_at timestamptz DEFAULT NOW() NOT NULL
);
CREATE TABLE payment_notifications (id serial PRIMARY KEY);
CREATE TABLE payment_notification_archives (id serial PRIMARY KEY);
CREATE TABLE wallet_top_up_orders (id serial PRIMARY KEY);
CREATE TABLE manual_reviews (id serial PRIMARY KEY);
CREATE TABLE notification_outbox_events (
  id serial PRIMARY KEY,
  category enum_notification_outbox_events_category NOT NULL,
  notification_type enum_notification_outbox_events_notification_type NOT NULL,
  CONSTRAINT notification_outbox_events_category_type_valid CHECK (
    (category = 'transactional' AND notification_type IN (
      'admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed'
    )) OR
    (category = 'marketing' AND notification_type IN ('product_updates', 'promotions'))
  )
);
INSERT INTO customers (id, invite_code) VALUES
  (1, 'ABCDEF123456'), (3, 'ABCDEF123453'), (4, 'ABCDEF123454'),
  (5, 'ABCDEF123455'), (6, 'ABCDEF12345678');
INSERT INTO customers (id, invite_code, invited_by_customer_id, created_at)
VALUES (2, '123456ABCDEF', 1, NOW() - INTERVAL '10 days');
INSERT INTO orders (id, customer_id) VALUES (1, 2), (2, 3), (3, 4), (4, 5);
INSERT INTO realname_templates (id, customer_id) VALUES (1, 2);
INSERT INTO points_batches (id, customer_id, source_type) VALUES (1, 2, 'order_reward');
`

try {
  docker(['createdb', '--username', 'wanmi', databaseName])
  psql(baseSchema)
  psql(upSql)

  assert.equal(
    scalar(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'
      AND table_name IN (
        'invitation_reward_rule_versions', 'invitation_relationships',
        'invitation_reward_claims', 'invitation_reward_events'
      );`),
    '4',
    'D9-E-1 must create all four versioned/append-only invitation tables',
  )
  assert.equal(
    scalar(`SELECT source_customer_id FROM points_batches WHERE id = 1;`),
    '2',
    'existing points batches must backfill source customer for attribution',
  )
  assert.equal(
    scalar(`SELECT inviter_customer_id || ':' || bind_source || ':' ||
      (bound_at = binding_window_ends_at)::text
      FROM invitation_relationships WHERE invitee_customer_id = 2;`),
    '1:legacy_backfill:true',
    'legacy invitation projections must backfill without rotating codes',
  )
  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_points_batches_source_type), ',');`),
    'order_reward,invitation_reward',
  )
  assert.equal(
    scalar(
      `SELECT array_to_string(enum_range(NULL::enum_notification_outbox_events_notification_type), ',');`,
    ),
    'admin_high_risk_operation_submitted,admin_high_risk_operation_executed,invitation_reward_withheld,product_updates,promotions',
  )
  psql(`INSERT INTO notification_outbox_events (category, notification_type)
    VALUES ('transactional', 'invitation_reward_withheld');`)
  rejectsWrite(
    `INSERT INTO notification_outbox_events (category, notification_type)
     VALUES ('marketing', 'invitation_reward_withheld');`,
    'invitation reward alert as marketing',
  )
  for (const table of [
    'payment_notifications',
    'payment_notification_archives',
    'wallet_top_up_orders',
  ]) {
    rejectsWrite(
      `INSERT INTO ${table} (payer_identifier_hash) VALUES ('raw-openid');`,
      `raw payer identifier in ${table}`,
    )
  }
  rejectsWrite(
    `INSERT INTO invitation_reward_rule_versions (
      version, schema_version, enabled, reward_points, reward_expiry_days,
      binding_window_hours, effective_at, changed_by, change_note
    ) VALUES (1, 1, true, 0, 365, 72, NOW(), 'admin', 'invalid');`,
    'zero reward points',
  )
  psql(`INSERT INTO invitation_reward_rule_versions (
    version, schema_version, enabled, reward_points, reward_expiry_days,
    binding_window_hours, effective_at, changed_by, change_note
  ) VALUES (1, 1, true, 88, 365, 72, NOW(), 'admin', 'valid fixture');`)
  const rule1 = scalar(`SELECT id FROM invitation_reward_rule_versions WHERE version = 1;`)
  rejectsWrite(
    `INSERT INTO invitation_reward_rule_versions (
      version, schema_version, enabled, reward_points, reward_expiry_days,
      binding_window_hours, effective_at, changed_by, change_note
    ) VALUES (1, 1, true, 88, 365, 72, NOW(), 'admin', 'duplicate');`,
    'duplicate rule version',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_rule_versions (
      version, schema_version, enabled, reward_points, reward_expiry_days,
      binding_window_hours, effective_at, changed_by, change_note
    ) VALUES (2, 1, true, 88.5, 365, 72, NOW(), 'admin', 'fractional');`,
    'fractional reward points',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_rule_versions (
      version, schema_version, enabled, reward_points, reward_expiry_days,
      binding_window_hours, effective_at, changed_by, change_note
    ) VALUES (2, 1, true, 88, 365, 721, NOW(), 'admin', 'oversized window');`,
    'oversized binding window',
  )
  for (const invitee of [3, 4, 5]) {
    psql(`INSERT INTO invitation_relationships (
      relationship_key, inviter_customer_id, invitee_customer_id, bind_source,
      bound_at, binding_window_ends_at
    ) VALUES ('invitee:${invitee}', 1, ${invitee}, 'post_registration', NOW(), NOW());`)
  }
  rejectsWrite(
    `INSERT INTO invitation_relationships (
      relationship_key, inviter_customer_id, invitee_customer_id, bind_source,
      bound_at, binding_window_ends_at
    ) VALUES ('self', 1, 1, 'post_registration', NOW(), NOW());`,
    'self invitation',
  )
  rejectsWrite(
    `INSERT INTO invitation_relationships (
      relationship_key, inviter_customer_id, invitee_customer_id, bind_source,
      bound_at, binding_window_ends_at
    ) VALUES ('invitee:2:duplicate', 1, 2, 'post_registration', NOW(), NOW());`,
    'second relationship for one invitee',
  )
  rejectsWrite(
    `INSERT INTO invitation_relationships (
      relationship_key, inviter_customer_id, invitee_customer_id, bind_source,
      bound_at, binding_window_ends_at
    ) VALUES ('invalid-window', 1, 6, 'post_registration', NOW(), NOW() - INTERVAL '1 second');`,
    'relationship window before binding time',
  )
  rejectsWrite(
    `INSERT INTO invitation_relationships (
      relationship_key, inviter_customer_id, invitee_customer_id, bind_source,
      bound_at, binding_window_ends_at
    ) VALUES ('invitee:3', 1, 6, 'post_registration', NOW(), NOW());`,
    'duplicate relationship key',
  )

  const relationship3 = scalar(
    `SELECT id FROM invitation_relationships WHERE invitee_customer_id = 3;`,
  )
  const relationship4 = scalar(
    `SELECT id FROM invitation_relationships WHERE invitee_customer_id = 4;`,
  )
  const relationship5 = scalar(
    `SELECT id FROM invitation_relationships WHERE invitee_customer_id = 5;`,
  )
  psql(`INSERT INTO invitation_reward_claims (
    claim_key, relationship_id, inviter_customer_id, invitee_customer_id,
    source_order_id, rule_version_id, rule_version_number, points, expires_at
  ) VALUES ('claim:3', ${relationship3}, 1, 3, 2, ${rule1}, 1, 88, NOW() + INTERVAL '1 day');`)
  rejectsWrite(
    `INSERT INTO invitation_reward_claims (
      claim_key, relationship_id, inviter_customer_id, invitee_customer_id,
      source_order_id, rule_version_id, rule_version_number, points, expires_at
    ) VALUES ('claim:duplicate-invitee', ${relationship4}, 1, 3, 3, ${rule1}, 1, 88,
      NOW() + INTERVAL '1 day');`,
    'second reward claim for one invitee',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_claims (
      claim_key, relationship_id, inviter_customer_id, invitee_customer_id,
      source_order_id, rule_version_id, rule_version_number, points, expires_at
    ) VALUES ('claim:duplicate-order', ${relationship4}, 1, 4, 2, ${rule1}, 1, 88,
      NOW() + INTERVAL '1 day');`,
    'second reward claim for one source order',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_claims (
      claim_key, relationship_id, inviter_customer_id, invitee_customer_id,
      source_order_id, rule_version_id, rule_version_number, points, expires_at
    ) VALUES ('claim:self', ${relationship5}, 5, 5, 4, ${rule1}, 1, 88,
      NOW() + INTERVAL '1 day');`,
    'self invitation reward claim',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_claims (
      claim_key, relationship_id, inviter_customer_id, invitee_customer_id,
      source_order_id, rule_version_id, rule_version_number, points, expires_at
    ) VALUES ('claim:fractional', ${relationship4}, 1, 4, 3, ${rule1}, 1, 88.5,
      NOW() + INTERVAL '1 day');`,
    'fractional reward claim points',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_claims (
      claim_key, relationship_id, inviter_customer_id, invitee_customer_id,
      source_order_id, rule_version_id, rule_version_number, points, expires_at
    ) VALUES ('claim:expired', ${relationship4}, 1, 4, 3, ${rule1}, 1, 88,
      NOW() - INTERVAL '1 day');`,
    'reward claim expiry before creation',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_claims (
      claim_key, relationship_id, inviter_customer_id, invitee_customer_id,
      source_order_id, rule_version_id, rule_version_number, points, expires_at
    ) VALUES ('claim:3', ${relationship4}, 1, 4, 3, ${rule1}, 1, 88,
      NOW() + INTERVAL '1 day');`,
    'duplicate reward claim key',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_claims (
      claim_key, relationship_id, inviter_customer_id, invitee_customer_id,
      source_order_id, rule_version_id, rule_version_number, points, expires_at
    ) VALUES ('claim:duplicate-relationship', ${relationship3}, 1, 4, 3, ${rule1}, 1, 88,
      NOW() + INTERVAL '1 day');`,
    'second reward claim for one relationship',
  )
  const claim3 = scalar(`SELECT id FROM invitation_reward_claims WHERE claim_key = 'claim:3';`)
  psql(`INSERT INTO invitation_reward_events (
    event_key, claim_id, inviter_customer_id, invitee_customer_id, event_type,
    points_batch_id, occurred_at
  ) VALUES ('event:3:pending', ${claim3}, 1, 3, 'pending', 1, NOW());`)
  rejectsWrite(
    `INSERT INTO invitation_reward_events (
      event_key, claim_id, inviter_customer_id, invitee_customer_id, event_type,
      points_batch_id, occurred_at
    ) VALUES ('event:3:pending:duplicate', ${claim3}, 1, 3, 'pending', 1, NOW());`,
    'duplicate reward lifecycle event type',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_events (
      event_key, claim_id, inviter_customer_id, invitee_customer_id, event_type,
      points_batch_id, occurred_at
    ) VALUES ('event:3:withheld:invalid', ${claim3}, 1, 3, 'withheld', 1, NOW());`,
    'withheld event linked to a points batch',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_events (
      event_key, claim_id, inviter_customer_id, invitee_customer_id, event_type,
      points_batch_id, occurred_at
    ) VALUES ('event:3:pending', ${claim3}, 1, 3, 'available', 1, NOW());`,
    'duplicate reward event key',
  )
  const event3 = scalar(
    `SELECT id FROM invitation_reward_events WHERE event_key = 'event:3:pending';`,
  )
  psql(`INSERT INTO invitation_reward_events_signals ("order", parent_id, value)
    VALUES (1, ${event3}, 'same_device_hash');`)
  rejectsWrite(
    `INSERT INTO invitation_reward_events_signals ("order", parent_id, value)
     VALUES (1, ${event3}, 'same_phone_hash');`,
    'duplicate signal order',
  )
  rejectsWrite(
    `INSERT INTO invitation_reward_events_signals ("order", parent_id, value)
     VALUES (2, ${event3}, 'same_device_hash');`,
    'duplicate signal value',
  )
  rejectsWrite(
    `UPDATE points_batches SET source_customer_id = 999999 WHERE id = 1;`,
    'points batch source customer without a customer fact',
  )
  psql(`UPDATE points_batches SET source_customer_id = NULL WHERE id = 1;`)
  rejectsWrite(
    `UPDATE points_batches SET source_type = 'invitation_reward' WHERE id = 1;`,
    'invitation points batch without a source customer',
  )
  psql(`UPDATE points_batches SET source_customer_id = 2 WHERE id = 1;`)

  psql(`DELETE FROM notification_outbox_events
    WHERE notification_type = 'invitation_reward_withheld';`)
  psql(`UPDATE points_batches SET source_type = 'invitation_reward' WHERE id = 1;`)
  const unsafeRewardDown = psqlFailure(downSql)
  assert.notEqual(unsafeRewardDown.status, 0, 'down must retain invitation points facts')
  assert.match(`${unsafeRewardDown.stderr}${unsafeRewardDown.stdout}`, /reward points batches/iu)
  psql(`UPDATE points_batches SET source_type = 'order_reward' WHERE id = 1;`)
  psql(`INSERT INTO notification_outbox_events (category, notification_type)
    VALUES ('transactional', 'invitation_reward_withheld');`)
  const unsafeNotificationDown = psqlFailure(downSql)
  assert.notEqual(unsafeNotificationDown.status, 0, 'down must retain invitation alert facts')
  assert.match(
    `${unsafeNotificationDown.stderr}${unsafeNotificationDown.stdout}`,
    /reward notifications/iu,
  )
  psql(`DELETE FROM notification_outbox_events
    WHERE notification_type = 'invitation_reward_withheld';`)
  psql(downSql)
  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_points_batches_source_type), ',');`),
    'order_reward',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM information_schema.columns
      WHERE (table_name = 'customers' AND column_name = 'invite_code_disabled_at')
         OR (table_name = 'points_batches' AND column_name = 'source_customer_id');`),
    '0',
    'clean down must restore the prior invitation/points columns',
  )

  process.stdout.write('D9-E-1 invitation and abuse migration verification passed\n')
} finally {
  try {
    docker(['dropdb', '--username', 'wanmi', '--if-exists', databaseName])
  } catch {
    // Preserve the primary verification failure.
  }
}
