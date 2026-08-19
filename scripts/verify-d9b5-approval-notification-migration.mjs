import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL(
    '../apps/web/migrations/20260819_065615_d9b5_admin_approvals_notifications.ts',
    import.meta.url,
  ),
)
const databaseName = `wanmi_d9b5_approval_migration_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9b5_approval_migration_[0-9]+_[0-9]+$/u)

const source = readFileSync(migrationPath, 'utf8')
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
assert.ok(upSql, 'D9-B-5 migration UP SQL must be extractable')
assert.ok(downSql, 'D9-B-5 migration DOWN SQL must be extractable')
assert.ok(!upSql.includes('${'), 'D9-B-5 migration UP SQL must not interpolate values')
assert.ok(!downSql.includes('${'), 'D9-B-5 migration DOWN SQL must not interpolate values')

const postgres = (args, capture = false) =>
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
const rejectsDown = (label) => {
  const result = psqlFailure(downSql)
  assert.notEqual(result.status, 0, `accepted an unsafe down migration: ${label}`)
  assert.match(
    `${result.stderr}${result.stdout}`,
    /D9-B-5 down migration refused/u,
    `down migration bypassed its explicit refusal: ${label}`,
  )
}

const baseSchema = `
CREATE TABLE admins (id serial PRIMARY KEY);
CREATE TABLE admins_roles (
  "order" integer NOT NULL,
  parent_id integer NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  value varchar NOT NULL
);
CREATE TABLE customers (id serial PRIMARY KEY);
CREATE TABLE site_settings (
  id serial PRIMARY KEY,
  key varchar NOT NULL UNIQUE,
  value jsonb NOT NULL,
  description varchar,
  updated_at timestamptz DEFAULT NOW() NOT NULL,
  created_at timestamptz DEFAULT NOW() NOT NULL
);
CREATE TYPE enum_payload_jobs_workflow_slug AS ENUM('commerceFulfillment');
CREATE TABLE payload_jobs (
  id serial PRIMARY KEY,
  workflow_slug enum_payload_jobs_workflow_slug
);
CREATE TABLE payload_locked_documents_rels (id serial PRIMARY KEY);
INSERT INTO admins (id) VALUES (1), (2), (3);
INSERT INTO admins_roles ("order", parent_id, value)
VALUES (1, 1, 'system_admin'), (1, 2, 'system_admin'), (1, 3, 'content_editor');
INSERT INTO customers (id) VALUES (1);
`

const approvalInsert = (overrides = {}) => {
  const values = {
    amount: 'NULL',
    approvedAt: 'NULL',
    approvedBy: 'NULL',
    cooldown: '900',
    executedBy: 'NULL',
    executionClaimedAt: 'NULL',
    executionClaimKey: 'NULL',
    operation: `'original_refund'`,
    requestKey: `'approval-${Date.now()}-${Math.random()}'`,
    requiresDifferent: 'true',
    requestedBy: '1',
    status: `'pending_approval'`,
    ...overrides,
  }
  return `INSERT INTO admin_approval_requests (
    request_key, operation_type, status, customer_id, target_type, target_id,
    amount_fen, operation_data, reason_note, requested_by_id, approved_by_id,
    executed_by_id, requires_different_approver, cooldown_seconds, approved_at,
    execution_claim_key, execution_claimed_at
  ) VALUES (
    ${values.requestKey}, ${values.operation}, ${values.status}, 1, 'order', 'fixture-target',
    ${values.amount}, '{}'::jsonb, 'migration verifier reason', ${values.requestedBy},
    ${values.approvedBy}, ${values.executedBy}, ${values.requiresDifferent}, ${values.cooldown},
    ${values.approvedAt}, ${values.executionClaimKey}, ${values.executionClaimedAt}
  )`
}

const outboxInsert = (overrides = {}) => {
  const values = {
    body: `'Body snapshot'`,
    category: `'transactional'`,
    eventKey: `'event-${Date.now()}-${Math.random()}'`,
    hash: `'${'a'.repeat(64)}'`,
    subject: `'Subject snapshot'`,
    type: `'admin_high_risk_operation_submitted'`,
    version: '1',
    ...overrides,
  }
  return `INSERT INTO notification_outbox_events (
    event_key, domain_event_type, category, notification_type, customer_id,
    template_key, template_version, subject_snapshot, body_snapshot, message_hash, trace_id
  ) VALUES (
    ${values.eventKey}, 'fixture.event', ${values.category}, ${values.type}, 1,
    'fixture-template', ${values.version}, ${values.subject}, ${values.body},
    ${values.hash}, 'migration-verifier-trace'
  )`
}

try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  psql(baseSchema)
  psql(upSql)

  assert.equal(
    scalar(`SELECT (value->>'requiresDifferentApprover') || ':' || (value->>'cooldownSeconds')
      FROM site_settings WHERE key = 'admin.high-risk-approval-policy';`),
    'true:900',
    'production migration defaults must require a different approver and positive cooldown',
  )
  assert.equal(
    scalar(`SELECT parent_id || ':' || string_agg(value::text, ',' ORDER BY "order")
      FROM admins_operational_scopes GROUP BY parent_id ORDER BY parent_id;`),
    '1:funds_operations,system_configuration\n2:funds_operations,system_configuration',
    'only existing system admins receive both minimal operation scopes',
  )
  assert.equal(
    scalar(
      `SELECT array_to_string(enum_range(NULL::enum_admin_approval_requests_operation_type), ',');`,
    ),
    'large_balance_adjustment,original_refund,account_recovery,identity_conflict_resolution,vip_fraud_correction,high_risk_account_unfreeze,domain_management_credential_disposition,bulk_customer_asset_operation',
    'the approval operation list must cover exactly the eight approved categories',
  )
  assert.equal(
    scalar(
      `SELECT array_to_string(enum_range(NULL::enum_notification_marketing_preferences_enabled_marketing_types), ',');`,
    ),
    'product_updates,promotions',
    'preference storage must contain marketing types only',
  )

  rejectsWrite(approvalInsert({ cooldown: '0' }), 'approval cooldown positive')
  rejectsWrite(approvalInsert({ cooldown: '1.5' }), 'approval cooldown integer')
  rejectsWrite(
    approvalInsert({ amount: '1.5', operation: `'large_balance_adjustment'` }),
    'large balance amount integer fen',
  )
  rejectsWrite(
    approvalInsert({ amount: '0', operation: `'large_balance_adjustment'` }),
    'large balance amount positive',
  )
  rejectsWrite(
    approvalInsert({ amount: '1', operation: `'original_refund'` }),
    'non-balance operation excludes amount',
  )
  rejectsWrite(
    approvalInsert({
      approvedAt: 'NOW()',
      approvedBy: '1',
      requiresDifferent: 'true',
      requestedBy: '1',
      status: `'approved'`,
    }),
    'different approver database invariant',
  )
  rejectsWrite(
    approvalInsert({ approvedAt: 'NOW()', status: `'pending_approval'` }),
    'pending approval excludes approval evidence',
  )
  rejectsWrite(
    approvalInsert({
      approvedAt: 'NOW()',
      approvedBy: '2',
      executedBy: '2',
      status: `'executing'`,
    }),
    'executing state requires claim evidence',
  )
  psql(`INSERT INTO admin_approval_requests (
    request_key, operation_type, customer_id, target_type, target_id, operation_data,
    reason_note, requested_by_id, cooldown_seconds
  ) VALUES (
    'default-approval-policy-snapshot', 'original_refund', 1, 'order', 'default-target',
    '{}'::jsonb, 'migration verifier default', 1, 900
  );`)
  assert.equal(
    scalar(`SELECT requires_different_approver FROM admin_approval_requests
      WHERE request_key = 'default-approval-policy-snapshot';`),
    't',
    'approval rows must default to requiring a different approver',
  )
  const approvalId = scalar(
    `${approvalInsert({ requestKey: `'unique-approval-request'` })} RETURNING id;`,
  ).split('\n')[0]
  rejectsWrite(
    approvalInsert({ requestKey: `'unique-approval-request'` }),
    'approval request key idempotency',
  )
  psql(`INSERT INTO admin_access_events (
    event_key, event_type, approval_request_id, actor_id, trace_id
  ) VALUES ('unique-access-event', 'requested', ${approvalId}, 1, 'migration-verifier');`)
  rejectsWrite(
    `INSERT INTO admin_access_events (
      event_key, event_type, approval_request_id, actor_id, trace_id
    ) VALUES ('unique-access-event', 'requested', ${approvalId}, 1, 'migration-verifier-two');`,
    'admin access event idempotency',
  )

  rejectsWrite(
    outboxInsert({ category: `'marketing'`, type: `'admin_high_risk_operation_submitted'` }),
    'transactional type cannot enter marketing category',
  )
  rejectsWrite(outboxInsert({ version: '0' }), 'template version positive')
  rejectsWrite(outboxInsert({ subject: `''` }), 'subject snapshot nonblank')
  rejectsWrite(outboxInsert({ hash: `'short'` }), 'message hash length')

  const outboxId = scalar(`${outboxInsert()} RETURNING id;`).split('\n')[0]
  rejectsWrite(
    outboxInsert({
      eventKey: `(SELECT event_key FROM notification_outbox_events WHERE id = ${outboxId})`,
    }),
    'outbox event key idempotency',
  )
  const delivery = ({
    attempts = '0',
    channel = `'sms'`,
    claimedAt = 'NULL',
    deliveredAt = 'NULL',
    encrypted = `'encrypted-recipient'`,
    key = `'delivery-${Date.now()}-${Math.random()}'`,
    max = '3',
    status = `'pending'`,
  } = {}) => `INSERT INTO notification_deliveries (
    delivery_key, outbox_event_id, customer_id, channel, recipient_encrypted,
    recipient_masked, recipient_identity_hash, status, attempt_count, max_attempts,
    next_attempt_at, claimed_at, delivered_at
  ) VALUES (
    ${key}, ${outboxId}, 1, ${channel}, ${encrypted}, '+86139****5678', 'identity-hash',
    ${status}, ${attempts}, ${max}, NOW(), ${claimedAt}, ${deliveredAt}
  )`
  rejectsWrite(
    delivery({ attempts: '1.5', claimedAt: 'NOW()', status: `'sending'` }),
    'delivery attempt integer',
  )
  rejectsWrite(
    delivery({ attempts: '4', claimedAt: 'NOW()', max: '3', status: `'sending'` }),
    'delivery attempts bounded by maximum',
  )
  rejectsWrite(delivery({ channel: `'sms'`, encrypted: 'NULL' }), 'external channel recipient')
  rejectsWrite(
    delivery({ channel: `'in_app'`, encrypted: `'must-not-exist'` }),
    'in-app channel excludes encrypted recipient',
  )
  rejectsWrite(delivery({ attempts: '1', status: `'pending'` }), 'pending state evidence')
  rejectsWrite(
    delivery({ attempts: '1', claimedAt: 'NOW()', status: `'delivered'` }),
    'delivered state requires delivered timestamp',
  )

  const deliveryId = scalar(`${delivery()} RETURNING id;`).split('\n')[0]
  rejectsWrite(
    delivery({
      key: `(SELECT delivery_key FROM notification_deliveries WHERE id = ${deliveryId})`,
    }),
    'delivery key idempotency',
  )
  rejectsWrite(
    `INSERT INTO notification_provider_receipts (
      receipt_key, delivery_id, channel, attempt_number, outcome, observed_at
    ) VALUES ('invalid-receipt-attempt', ${deliveryId}, 'sms', 0, 'failed', NOW());`,
    'provider receipt attempt positive',
  )
  psql(`INSERT INTO notification_provider_receipts (
    receipt_key, delivery_id, channel, attempt_number, outcome, observed_at
  ) VALUES ('unique-receipt', ${deliveryId}, 'sms', 1, 'failed', NOW());`)
  rejectsWrite(
    `INSERT INTO notification_provider_receipts (
      receipt_key, delivery_id, channel, attempt_number, outcome, observed_at
    ) VALUES ('unique-receipt', ${deliveryId}, 'sms', 1, 'failed', NOW());`,
    'provider receipt key idempotency',
  )
  psql(`INSERT INTO notification_read_states (read_key, outbox_event_id, customer_id, read_at)
    VALUES ('read-key', ${outboxId}, 1, NOW());`)
  rejectsWrite(
    `INSERT INTO notification_read_states (read_key, outbox_event_id, customer_id, read_at)
     VALUES ('read-key-two', ${outboxId}, 1, NOW());`,
    'one read state per event and customer',
  )
  psql(`INSERT INTO notification_marketing_preferences (customer_id) VALUES (1);`)
  rejectsWrite(
    `INSERT INTO notification_marketing_preferences (customer_id) VALUES (1);`,
    'one marketing preference row per customer',
  )

  rejectsDown('approval data exists')
  psql(`DELETE FROM notification_provider_receipts;
    DELETE FROM notification_read_states;
    DELETE FROM notification_deliveries;
    DELETE FROM notification_outbox_events;
    DELETE FROM admin_access_events;
    DELETE FROM admin_approval_requests;
    DELETE FROM notification_marketing_preferences_enabled_marketing_types;
    DELETE FROM notification_marketing_preferences;`)
  psql(`UPDATE site_settings
    SET value = jsonb_set(value, '{requiresDifferentApprover}', 'false'::jsonb)
    WHERE key = 'admin.high-risk-approval-policy';`)
  rejectsDown('approval policy changed from production default')
  psql(`UPDATE site_settings
    SET value = jsonb_set(value, '{requiresDifferentApprover}', 'true'::jsonb)
    WHERE key = 'admin.high-risk-approval-policy';`)
  psql(`DELETE FROM admins_operational_scopes
    WHERE parent_id = 1 AND value = 'funds_operations';`)
  rejectsDown('system administrator scope backfill changed')
  psql(`INSERT INTO admins_operational_scopes ("order", parent_id, value)
    VALUES (1, 1, 'funds_operations');`)
  psql(downSql)
  assert.equal(
    scalar(`SELECT COUNT(*) FROM pg_class WHERE relname IN (
      'admin_approval_requests', 'notification_outbox_events', 'notification_deliveries'
    );`),
    '0',
    'clean down migration must remove D9-B-5 tables',
  )

  process.stdout.write('D9-B-5 approval and notification migration verification passed\n')
} finally {
  postgres(['dropdb', '--if-exists', '--username', 'wanmi', databaseName])
}
