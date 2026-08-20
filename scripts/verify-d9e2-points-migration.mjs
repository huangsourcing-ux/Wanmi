import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL('../apps/web/migrations/20260820_000011_d9e2_points_ledger.ts', import.meta.url),
)
const releasePolicyPath = fileURLToPath(new URL('../deploy/release-policy.json', import.meta.url))
const releaseManifestPath = fileURLToPath(
  new URL('../deploy/release-manifest.example.json', import.meta.url),
)
const databaseName = `wanmi_d9e2_points_migration_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9e2_points_migration_[0-9]+_[0-9]+$/u)

const source = process.env.D9E2_MIGRATION_SOURCE_BASE64
  ? Buffer.from(process.env.D9E2_MIGRATION_SOURCE_BASE64, 'base64').toString('utf8')
  : readFileSync(migrationPath, 'utf8')
const releasePolicy = JSON.parse(
  process.env.D9E2_RELEASE_POLICY_BASE64
    ? Buffer.from(process.env.D9E2_RELEASE_POLICY_BASE64, 'base64').toString('utf8')
    : readFileSync(releasePolicyPath, 'utf8'),
)
const releaseManifest = JSON.parse(
  process.env.D9E2_RELEASE_MANIFEST_BASE64
    ? Buffer.from(process.env.D9E2_RELEASE_MANIFEST_BASE64, 'base64').toString('utf8')
    : readFileSync(releaseManifestPath, 'utf8'),
)
const migrationName = '20260820_000011_d9e2_points_ledger'
const releaseRule = releasePolicy.migrations?.[migrationName]
assert.equal(releaseRule?.phase, 'expand', 'D9-E-2 migration must use the expand phase')
assert.equal(
  releaseRule?.newCodeCompatibleBeforeUp,
  true,
  'D9-E-2 new code must remain gated until the expand migration is applied',
)
assert.equal(
  releaseRule?.oldCodeCompatible,
  true,
  'D9-E-2 additive schema must stay compatible with the preceding code',
)
assert.equal(releaseRule?.rollback, 'retain', 'D9-E-2 rollback must retain append-only facts')
assert.equal(
  releaseManifest.migrations?.filter((name) => name === migrationName).length,
  1,
  'D9-E-2 release manifest must contain the migration exactly once',
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
const downStatements = statements('down')
assert.ok(upSql, 'D9-E-2 migration UP SQL must be extractable')
assert.equal(downStatements.length, 2, 'D9-E-2 down must clean jobs before shrinking the enum')
assert.ok(!upSql.includes('${'), 'D9-E-2 migration UP SQL must not interpolate values')
assert.ok(
  downStatements.every((statement) => !statement.includes('${')),
  'D9-E-2 migration DOWN SQL must not interpolate values',
)

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
const returnedId = (statement) => scalar(statement).split('\n')[0]
const rejectsWrite = (statement, label) => {
  const result = psqlFailure(statement)
  assert.notEqual(result.status, 0, `accepted an invalid write: ${label}`)
}

const baseSchema = `
CREATE TYPE enum_payload_jobs_workflow_slug AS ENUM(
  'publishingProbe', 'contentScheduledPublish', 'backgroundProbe',
  'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup',
  'westdigitalBalanceMonitoring', 'domainExpiryReminders',
  'domainAssetSynchronization', 'walletLedgerConsistencyCheck', 'notificationDelivery',
  'commerceFulfillment', 'automaticRenewalScheduling', 'commerceWorkerHeartbeat',
  'nameserverChange', 'wechatRefund', 'paymentTimeoutClose'
);
CREATE TABLE payload_jobs (
  id serial PRIMARY KEY,
  workflow_slug enum_payload_jobs_workflow_slug NOT NULL
);
CREATE TABLE customers (id serial PRIMARY KEY);
CREATE TABLE orders (id serial PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers(id));
INSERT INTO customers SELECT generate_series(1, 40);
INSERT INTO orders (customer_id) VALUES (1), (2), (3);
`

try {
  docker(['createdb', '--username', 'wanmi', databaseName])
  psql(baseSchema)
  assert.doesNotThrow(() => psql(upSql), 'D9-E-2 UP migration must apply successfully')

  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_points_ledger_entry_type), ',') || ':' ||
      array_to_string(enum_range(NULL::enum_points_redemptions_target), ',') || ':' ||
      array_to_string(enum_range(NULL::enum_tool_quota_ledger_target), ',') || ':' ||
      array_to_string(enum_range(NULL::enum_points_batches_source_type), ',') || ':' ||
      array_to_string(enum_range(NULL::enum_tool_quota_ledger_entry_type), ',');`),
    'pending,available,held,consumed,expired,reversed:advanced_whois,bulk_query,ai_domain_analysis:advanced_whois,bulk_query,ai_domain_analysis:order_reward:grant,consume',
    'D9-E-2 lifecycle or approved quota targets mismatch',
  )
  assert.equal(
    scalar(
      `SELECT 'pointsExpiration' = ANY(enum_range(NULL::enum_payload_jobs_workflow_slug)::text[]);`,
    ),
    't',
    'D9-E-2 UP must register the points expiration workflow',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'points_accounts', 'points_batches', 'points_redemptions', 'points_ledger',
        'points_consumption_allocations', 'tool_quota_ledger'
      );`),
    '6',
    'D9-E-2 must create all six independent points/quota tables',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('points_accounts', 'points_batches', 'points_redemptions',
          'points_ledger', 'points_consumption_allocations', 'tool_quota_ledger')
        AND (column_name LIKE '%fen%' OR column_name LIKE '%currency%' OR column_name LIKE '%wallet%');`),
    '0',
    'D9-E-2 data schema must not contain wallet or money conversion columns',
  )
  assert.equal(
    scalar(`SELECT COALESCE(string_agg(table_name || '.' || column_name, ',' ORDER BY table_name, ordinal_position), '')
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('points_accounts', 'points_batches', 'points_redemptions',
          'points_ledger', 'points_consumption_allocations', 'tool_quota_ledger')
        AND is_nullable = 'YES';`),
    'points_ledger.redemption_id,tool_quota_ledger.redemption_id',
    'D9-E-2 must keep every fact column required except the two state-dependent redemption links',
  )

  const accountId = returnedId(`INSERT INTO points_accounts (
      customer_id, ledger_version, quota_ledger_version, updated_at, created_at
    ) VALUES (1, 0, 0, NOW(), NOW()) RETURNING id;`)
  const batchId = returnedId(`INSERT INTO points_batches (
      earning_key, customer_id, account_id, source_type, source_order_id, points,
      expires_at, updated_at, created_at
    ) VALUES ('earning-valid', 1, ${accountId}, 'order_reward', 1, 100,
      NOW() + INTERVAL '1 day', NOW(), NOW()) RETURNING id;`)
  const redemptionId = returnedId(`INSERT INTO points_redemptions (
      redemption_key, customer_id, account_id, target, points_cost, quota_units,
      updated_at, created_at
    ) VALUES ('redemption-valid', 1, ${accountId}, 'advanced_whois', 10, 1,
      NOW(), NOW()) RETURNING id;`)
  psql(`INSERT INTO points_ledger (
    entry_key, customer_id, account_id, batch_id, redemption_id, entry_type, points,
    ledger_sequence, updated_at, created_at
  ) VALUES ('entry-valid', 1, ${accountId}, ${batchId}, NULL, 'pending', 100, 1, NOW(), NOW());`)
  psql(`INSERT INTO points_consumption_allocations (
    allocation_key, customer_id, account_id, redemption_id, batch_id, points,
    updated_at, created_at
  ) VALUES ('allocation-valid', 1, ${accountId}, ${redemptionId}, ${batchId}, 10, NOW(), NOW());`)
  psql(`INSERT INTO tool_quota_ledger (
    entry_key, customer_id, account_id, redemption_id, target, entry_type, quota_units,
    ledger_sequence, updated_at, created_at
  ) VALUES ('quota-valid', 1, ${accountId}, ${redemptionId}, 'advanced_whois', 'grant', 1, 1, NOW(), NOW());`)

  const accountInsert = (customer, ledger, quota) => `INSERT INTO points_accounts (
    customer_id, ledger_version, quota_ledger_version, updated_at, created_at
  ) VALUES (${customer}, ${ledger}, ${quota}, NOW(), NOW());`
  rejectsWrite(accountInsert(2, '-1', '0'), 'negative points ledger version')
  rejectsWrite(accountInsert(2, '0.5', '0'), 'fractional points ledger version')
  rejectsWrite(accountInsert(2, '9007199254740992', '0'), 'oversized points ledger version')
  rejectsWrite(accountInsert(2, '0', '-1'), 'negative quota ledger version')
  rejectsWrite(accountInsert(2, '0', '0.5'), 'fractional quota ledger version')
  rejectsWrite(accountInsert(2, '0', '9007199254740992'), 'oversized quota ledger version')

  const batchInsert = ({
    account = accountId,
    customer = 2,
    expires = `NOW() + INTERVAL '1 day'`,
    key,
    order = 2,
    points = '1',
  }) => `INSERT INTO points_batches (
    earning_key, customer_id, account_id, source_type, source_order_id, points,
    expires_at, updated_at, created_at
  ) VALUES ('${key}', ${customer}, ${account}, 'order_reward', ${order}, ${points},
    ${expires}, NOW(), NOW());`
  rejectsWrite(batchInsert({ key: 'batch-zero', points: '0' }), 'zero batch points')
  rejectsWrite(batchInsert({ key: 'batch-fractional', points: '1.5' }), 'fractional batch points')
  rejectsWrite(
    batchInsert({ key: 'batch-oversized', points: '9007199254740992' }),
    'oversized batch points',
  )
  rejectsWrite(batchInsert({ expires: 'NOW()', key: 'batch-expired' }), 'batch expiry at creation')

  const redemptionInsert = ({
    account = accountId,
    customer = 2,
    key,
    points = '1',
    quota = '1',
  }) => `INSERT INTO points_redemptions (
    redemption_key, customer_id, account_id, target, points_cost, quota_units,
    updated_at, created_at
  ) VALUES ('${key}', ${customer}, ${account}, 'advanced_whois', ${points}, ${quota}, NOW(), NOW());`
  rejectsWrite(
    redemptionInsert({ key: 'redemption-zero-points', points: '0' }),
    'zero redemption points',
  )
  rejectsWrite(
    redemptionInsert({ key: 'redemption-fractional-points', points: '1.5' }),
    'fractional redemption points',
  )
  rejectsWrite(
    redemptionInsert({ key: 'redemption-oversized-points', points: '9007199254740992' }),
    'oversized redemption points',
  )
  rejectsWrite(
    redemptionInsert({ key: 'redemption-zero-quota', quota: '0' }),
    'zero redemption quota',
  )
  rejectsWrite(
    redemptionInsert({ key: 'redemption-fractional-quota', quota: '1.5' }),
    'fractional redemption quota',
  )
  rejectsWrite(
    redemptionInsert({ key: 'redemption-oversized-quota', quota: '9007199254740992' }),
    'oversized redemption quota',
  )

  const ledgerInsert = ({
    entry = 'entry-invalid',
    points = '1',
    redemption = 'NULL',
    sequence = '2',
    type = `'pending'`,
  }) => `INSERT INTO points_ledger (
    entry_key, customer_id, account_id, batch_id, redemption_id, entry_type, points,
    ledger_sequence, updated_at, created_at
  ) VALUES ('${entry}', 1, ${accountId}, ${batchId}, ${redemption}, ${type}, ${points}, ${sequence}, NOW(), NOW());`
  rejectsWrite(ledgerInsert({ entry: 'entry-zero', points: '0' }), 'zero ledger points')
  rejectsWrite(
    ledgerInsert({ entry: 'entry-fractional', points: '1.5' }),
    'fractional ledger points',
  )
  rejectsWrite(
    ledgerInsert({ entry: 'entry-oversized', points: '9007199254740992' }),
    'oversized ledger points',
  )
  rejectsWrite(
    ledgerInsert({ entry: 'entry-sequence-zero', sequence: '0' }),
    'zero ledger sequence',
  )
  rejectsWrite(
    ledgerInsert({ entry: 'entry-sequence-fractional', sequence: '1.5' }),
    'fractional ledger sequence',
  )
  rejectsWrite(
    ledgerInsert({ entry: 'entry-sequence-oversized', sequence: '9007199254740992' }),
    'oversized ledger sequence',
  )
  rejectsWrite(
    ledgerInsert({ entry: 'entry-held-no-redemption', type: `'held'` }),
    'held entry without redemption',
  )
  rejectsWrite(
    ledgerInsert({ entry: 'entry-pending-redemption', redemption: redemptionId }),
    'pending entry with redemption',
  )

  psql(batchInsert({ customer: 1, key: 'allocation-test-batch', order: 1 }))
  const allocationTestBatchId = scalar(
    `SELECT id FROM points_batches WHERE earning_key = 'allocation-test-batch';`,
  )
  const allocationInsert = (
    key,
    points = '1',
    allocationBatch = batchId,
  ) => `INSERT INTO points_consumption_allocations (
    allocation_key, customer_id, account_id, redemption_id, batch_id, points,
    updated_at, created_at
  ) VALUES ('${key}', 1, ${accountId}, ${redemptionId}, ${allocationBatch}, ${points}, NOW(), NOW());`
  rejectsWrite(
    allocationInsert('allocation-zero', '0', allocationTestBatchId),
    'zero allocation points',
  )
  rejectsWrite(
    allocationInsert('allocation-fractional', '1.5', allocationTestBatchId),
    'fractional allocation points',
  )
  rejectsWrite(
    allocationInsert('allocation-oversized', '9007199254740992', allocationTestBatchId),
    'oversized allocation points',
  )

  const quotaInsert = ({
    entry,
    redemption = 'NULL',
    sequence = '2',
    type = `'consume'`,
    units = '1',
  }) => `INSERT INTO tool_quota_ledger (
    entry_key, customer_id, account_id, redemption_id, target, entry_type, quota_units,
    ledger_sequence, updated_at, created_at
  ) VALUES ('${entry}', 1, ${accountId}, ${redemption}, 'advanced_whois', ${type}, ${units}, ${sequence}, NOW(), NOW());`
  rejectsWrite(quotaInsert({ entry: 'quota-zero', units: '0' }), 'zero quota units')
  rejectsWrite(quotaInsert({ entry: 'quota-fractional', units: '1.5' }), 'fractional quota units')
  rejectsWrite(
    quotaInsert({ entry: 'quota-oversized', units: '9007199254740992' }),
    'oversized quota units',
  )
  rejectsWrite(quotaInsert({ entry: 'quota-sequence-zero', sequence: '0' }), 'zero quota sequence')
  rejectsWrite(
    quotaInsert({ entry: 'quota-sequence-fractional', sequence: '1.5' }),
    'fractional quota sequence',
  )
  rejectsWrite(
    quotaInsert({ entry: 'quota-sequence-oversized', sequence: '9007199254740992' }),
    'oversized quota sequence',
  )
  rejectsWrite(
    quotaInsert({ entry: 'quota-grant-no-redemption', type: `'grant'` }),
    'grant without redemption',
  )
  rejectsWrite(
    quotaInsert({ entry: 'quota-consume-redemption', redemption: redemptionId }),
    'consume with redemption',
  )

  rejectsWrite(accountInsert(1, '0', '0'), 'duplicate customer points account')
  rejectsWrite(
    batchInsert({ customer: 1, key: 'earning-valid', order: 1 }),
    'duplicate earning key',
  )
  rejectsWrite(
    redemptionInsert({ customer: 1, key: 'redemption-valid' }),
    'duplicate redemption key',
  )
  rejectsWrite(ledgerInsert({ entry: 'entry-valid', sequence: '2' }), 'duplicate ledger entry key')
  rejectsWrite(
    ledgerInsert({ entry: 'entry-sequence-duplicate', sequence: '1' }),
    'duplicate account ledger sequence',
  )
  rejectsWrite(
    allocationInsert('allocation-valid', '1', allocationTestBatchId),
    'duplicate allocation key',
  )
  rejectsWrite(
    allocationInsert('allocation-pair-duplicate'),
    'duplicate redemption batch allocation',
  )
  rejectsWrite(quotaInsert({ entry: 'quota-valid' }), 'duplicate quota entry key')
  rejectsWrite(
    quotaInsert({ entry: 'quota-sequence-duplicate', sequence: '1' }),
    'duplicate quota ledger sequence',
  )

  const foreignKeyWrites = [
    accountInsert(999999, '0', '0'),
    batchInsert({ customer: 999999, key: 'fk-batch-customer' }),
    batchInsert({ account: 999999, key: 'fk-batch-account' }),
    batchInsert({ key: 'fk-batch-order', order: 999999 }),
    redemptionInsert({ customer: 999999, key: 'fk-redemption-customer' }),
    redemptionInsert({ account: 999999, key: 'fk-redemption-account' }),
    ledgerInsert({ entry: 'fk-ledger-redemption', redemption: '999999', type: `'held'` }),
    `INSERT INTO points_ledger (entry_key, customer_id, account_id, batch_id, entry_type, points, ledger_sequence, updated_at, created_at) VALUES ('fk-ledger-customer', 999999, ${accountId}, ${batchId}, 'pending', 1, 2, NOW(), NOW());`,
    `INSERT INTO points_ledger (entry_key, customer_id, account_id, batch_id, entry_type, points, ledger_sequence, updated_at, created_at) VALUES ('fk-ledger-account', 1, 999999, ${batchId}, 'pending', 1, 2, NOW(), NOW());`,
    `INSERT INTO points_ledger (entry_key, customer_id, account_id, batch_id, entry_type, points, ledger_sequence, updated_at, created_at) VALUES ('fk-ledger-batch', 1, ${accountId}, 999999, 'pending', 1, 2, NOW(), NOW());`,
    `INSERT INTO points_consumption_allocations (allocation_key, customer_id, account_id, redemption_id, batch_id, points, updated_at, created_at) VALUES ('fk-allocation-customer', 999999, ${accountId}, ${redemptionId}, ${allocationTestBatchId}, 1, NOW(), NOW());`,
    `INSERT INTO points_consumption_allocations (allocation_key, customer_id, account_id, redemption_id, batch_id, points, updated_at, created_at) VALUES ('fk-allocation-account', 1, 999999, ${redemptionId}, ${allocationTestBatchId}, 1, NOW(), NOW());`,
    `INSERT INTO points_consumption_allocations (allocation_key, customer_id, account_id, redemption_id, batch_id, points, updated_at, created_at) VALUES ('fk-allocation-redemption', 1, ${accountId}, 999999, ${allocationTestBatchId}, 1, NOW(), NOW());`,
    `INSERT INTO points_consumption_allocations (allocation_key, customer_id, account_id, redemption_id, batch_id, points, updated_at, created_at) VALUES ('fk-allocation-batch', 1, ${accountId}, ${redemptionId}, 999999, 1, NOW(), NOW());`,
    `INSERT INTO tool_quota_ledger (entry_key, customer_id, account_id, target, entry_type, quota_units, ledger_sequence, updated_at, created_at) VALUES ('fk-quota-customer', 999999, ${accountId}, 'advanced_whois', 'consume', 1, 2, NOW(), NOW());`,
    `INSERT INTO tool_quota_ledger (entry_key, customer_id, account_id, target, entry_type, quota_units, ledger_sequence, updated_at, created_at) VALUES ('fk-quota-account', 1, 999999, 'advanced_whois', 'consume', 1, 2, NOW(), NOW());`,
    `INSERT INTO tool_quota_ledger (entry_key, customer_id, account_id, redemption_id, target, entry_type, quota_units, ledger_sequence, updated_at, created_at) VALUES ('fk-quota-redemption', 1, ${accountId}, 999999, 'advanced_whois', 'grant', 1, 2, NOW(), NOW());`,
  ]
  foreignKeyWrites.forEach((statement, index) =>
    rejectsWrite(statement, `foreign key ${index + 1}`),
  )

  psql(`INSERT INTO payload_jobs (workflow_slug) VALUES ('pointsExpiration');`)
  assert.doesNotThrow(
    () => psql(downStatements[0]),
    'D9-E-2 DOWN job cleanup must execute successfully',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM payload_jobs;`),
    '0',
    'D9-E-2 down must remove queued expiration jobs before enum shrink',
  )
  assert.doesNotThrow(
    () => psql(downStatements[1]),
    'D9-E-2 DOWN schema cleanup must execute successfully',
  )
  assert.equal(
    scalar(
      `SELECT COUNT(*) FROM pg_type WHERE typname LIKE 'enum_points_%' OR typname LIKE 'enum_tool_quota_%';`,
    ),
    '0',
    'D9-E-2 down must remove points and quota enum types',
  )
  assert.equal(
    scalar(
      `SELECT COUNT(*) FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN (
         'points_accounts', 'points_batches', 'points_redemptions', 'points_ledger',
         'points_consumption_allocations', 'tool_quota_ledger'
       );`,
    ),
    '0',
    'D9-E-2 down must remove all six points and quota tables',
  )
  assert.equal(
    scalar(
      `SELECT 'pointsExpiration' = ANY(enum_range(NULL::enum_payload_jobs_workflow_slug)::text[]);`,
    ),
    'f',
    'D9-E-2 down must remove the workflow enum value',
  )
  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_payload_jobs_workflow_slug), ',');`),
    'publishingProbe,contentScheduledPublish,backgroundProbe,advertisingMaintenance,smsReceiptReconciliation,realnameCleanup,westdigitalBalanceMonitoring,domainExpiryReminders,domainAssetSynchronization,walletLedgerConsistencyCheck,notificationDelivery,commerceFulfillment,automaticRenewalScheduling,commerceWorkerHeartbeat,nameserverChange,wechatRefund,paymentTimeoutClose',
    'D9-E-2 down must restore the exact preceding workflow enum',
  )

  process.stdout.write(
    'Verified D9-E-2 points migration checks, unique keys, foreign keys, isolation, and down cleanup.\n',
  )
} finally {
  try {
    docker(['dropdb', '--username', 'wanmi', '--if-exists', databaseName])
  } catch {
    // Preserve the primary verification failure.
  }
}
