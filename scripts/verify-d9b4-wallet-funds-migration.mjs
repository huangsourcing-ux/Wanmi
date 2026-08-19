import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL('../apps/web/migrations/20260819_012641_d9b4_wallet_funds_policy.ts', import.meta.url),
)
const databaseName = `wanmi_d9b4_funds_migration_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9b4_funds_migration_[0-9]+_[0-9]+$/u)

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
assert.ok(upSql, 'D9-B-4 migration UP SQL must be extractable')
assert.ok(downSql, 'D9-B-4 migration DOWN SQL must be extractable')
assert.ok(!upSql.includes('${'), 'D9-B-4 migration UP SQL must not interpolate values')
assert.ok(!downSql.includes('${'), 'D9-B-4 migration DOWN SQL must not interpolate values')

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

const baseSchema = `
CREATE TYPE enum_wallet_transactions_type AS ENUM('credit', 'hold');
CREATE TYPE enum_wallet_transactions_status AS ENUM('posted', 'held', 'captured', 'released');
CREATE TYPE enum_wallet_entries_entry_type AS ENUM('credit', 'hold', 'capture', 'release');
CREATE TYPE enum_provider_operations_target_type AS ENUM('order', 'realname_template', 'domain');
CREATE TYPE enum_wallet_top_up_orders_currency AS ENUM('CNY');
CREATE TYPE enum_wallet_top_up_orders_payment_channel AS ENUM('native', 'h5');
CREATE TYPE enum_wallet_top_up_orders_status AS ENUM(
  'created', 'payment_pending', 'provider_confirmed', 'credited',
  'refund_pending', 'refunded', 'closed', 'unknown'
);
CREATE TABLE orders (id serial PRIMARY KEY);
CREATE TABLE wallet_accounts (id serial PRIMARY KEY);
CREATE TABLE wallet_transactions (
  id serial PRIMARY KEY,
  transaction_key varchar NOT NULL,
  customer_id integer NOT NULL,
  account_id integer NOT NULL,
  type enum_wallet_transactions_type NOT NULL,
  status enum_wallet_transactions_status NOT NULL,
  amount_fen numeric NOT NULL,
  resolved_at timestamptz,
  updated_at timestamptz DEFAULT NOW() NOT NULL,
  created_at timestamptz DEFAULT NOW() NOT NULL,
  CONSTRAINT wallet_transactions_state_valid CHECK (
    (type = 'credit' AND status = 'posted' AND resolved_at IS NULL) OR
    (type = 'hold' AND status = 'held' AND resolved_at IS NULL) OR
    (type = 'hold' AND status IN ('captured', 'released') AND resolved_at IS NOT NULL)
  )
);
CREATE TABLE wallet_entries (
  id serial PRIMARY KEY,
  entry_key varchar NOT NULL,
  customer_id integer NOT NULL,
  account_id integer NOT NULL,
  transaction_id integer NOT NULL,
  entry_type enum_wallet_entries_entry_type NOT NULL,
  amount_fen numeric NOT NULL,
  ledger_sequence numeric NOT NULL,
  posted_balance_after_fen numeric NOT NULL,
  held_balance_after_fen numeric NOT NULL,
  updated_at timestamptz DEFAULT NOW() NOT NULL,
  created_at timestamptz DEFAULT NOW() NOT NULL,
  CONSTRAINT wallet_entries_safe_integers CHECK (
    amount_fen = trunc(amount_fen) AND amount_fen BETWEEN 1 AND 9007199254740991 AND
    ledger_sequence = trunc(ledger_sequence) AND ledger_sequence BETWEEN 1 AND 9007199254740991 AND
    posted_balance_after_fen = trunc(posted_balance_after_fen) AND
    posted_balance_after_fen <= 9007199254740991 AND
    held_balance_after_fen = trunc(held_balance_after_fen) AND
    held_balance_after_fen >= 0 AND held_balance_after_fen <= posted_balance_after_fen
  )
);
CREATE TABLE wallet_top_up_orders (
  id serial PRIMARY KEY,
  payment_channel enum_wallet_top_up_orders_payment_channel,
  payment_expires_at timestamptz,
  wechat_transaction_id varchar,
  provider_paid_at timestamptz,
  provider_confirmed_at timestamptz,
  credited_at timestamptz,
  original_refund_number varchar,
  refunded_at timestamptz,
  amount_fen numeric NOT NULL,
  status enum_wallet_top_up_orders_status NOT NULL,
  updated_at timestamptz DEFAULT NOW() NOT NULL,
  CONSTRAINT wallet_top_up_orders_state_evidence_valid CHECK (
    (status = 'credited' AND payment_channel IS NOT NULL AND payment_expires_at IS NOT NULL AND
      wechat_transaction_id IS NOT NULL AND provider_paid_at IS NOT NULL AND
      provider_confirmed_at IS NOT NULL AND credited_at IS NOT NULL AND
      original_refund_number IS NULL AND refunded_at IS NULL)
  )
);
CREATE TABLE refunds (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id),
  provider_refund_id varchar,
  refunded_at timestamptz
);
CREATE UNIQUE INDEX refunds_order_idx ON refunds(order_id);
CREATE TABLE provider_operations (
  id serial PRIMARY KEY,
  target_type enum_provider_operations_target_type NOT NULL,
  target_id varchar NOT NULL
);
`

const scalar = (statement) => psql(statement, true).trim()
const returnedId = (statement) => scalar(statement).split('\n')[0]
const rejectsWrite = (statement, label) => {
  const result = psqlFailure(statement)
  assert.notEqual(result.status, 0, `accepted an invalid write: ${label}`)
}
const rejectsDown = (label) => {
  const result = psqlFailure(downSql)
  assert.notEqual(result.status, 0, `accepted an unsafe down migration: ${label}`)
  assert.match(
    `${result.stderr}${result.stdout}`,
    /D9-B-4 down migration refused/u,
    `down migration bypassed its explicit refusal: ${label}`,
  )
}

const policyInsert = ({
  account = '10000000',
  changedBy = `'migration-verifier'`,
  changeNote = `'migration verifier policy'`,
  negative = 'true',
  schema = '1',
  spend = '3000000',
  topUp = '5000000',
  version = '2',
} = {}) => `
  INSERT INTO wallet_policy_versions (
    version, schema_version, currency, balance_expiration,
    single_top_up_limit_fen, account_balance_limit_fen, single_spend_limit_fen,
    allow_negative_balance_recovery, allow_restricted_account_emergency_renewal,
    financial_day_cut_timezone, statement_calculation, changed_by, change_note, effective_at
  ) VALUES (
    ${version}, ${schema}, 'CNY', 'never', ${topUp}, ${account}, ${spend}, ${negative}, false,
    'Asia/Shanghai', 'ledger_entries_start_inclusive_end_exclusive',
    ${changedBy}, ${changeNote}, NOW()
  );`

const topUpInsert = ({
  amount = '700',
  channel = `'native'`,
  creditedAt = 'NULL',
  expiresAt = 'NOW()',
  originalRefundNumber = 'NULL',
  paymentRecoveredAt = 'NULL',
  paymentRecoveryKey = 'NULL',
  paymentRecoveryType = 'NULL',
  providerConfirmedAt = 'NULL',
  providerPaidAt = 'NULL',
  refundedAmount = 'NULL',
  refundedAt = 'NULL',
  status,
  transactionId = 'NULL',
}) => `
  INSERT INTO wallet_top_up_orders (
    payment_channel, payment_expires_at, wechat_transaction_id, provider_paid_at,
    provider_confirmed_at, credited_at, original_refund_number, refunded_amount_fen,
    payment_recovery_key, payment_recovery_type, payment_recovered_at, refunded_at,
    amount_fen, status
  ) VALUES (
    ${channel}, ${expiresAt}, ${transactionId}, ${providerPaidAt}, ${providerConfirmedAt},
    ${creditedAt}, ${originalRefundNumber}, ${refundedAmount}, ${paymentRecoveryKey},
    ${paymentRecoveryType}, ${paymentRecoveredAt}, ${refundedAt}, ${amount}, '${status}'
  )`

try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  psql(baseSchema)
  try {
    psql(upSql)
  } catch {
    assert.fail('D9-B-4 migration up rejected the approved base schema')
  }

  assert.equal(
    scalar(`SELECT version || ':' || currency::text || ':' || balance_expiration::text || ':' ||
      allow_negative_balance_recovery::text || ':' || allow_restricted_account_emergency_renewal::text || ':' ||
      financial_day_cut_timezone::text || ':' || statement_calculation::text || ':' ||
      single_top_up_limit_fen || ':' || account_balance_limit_fen || ':' || single_spend_limit_fen
      FROM wallet_policy_versions WHERE version = 1;`),
    '1:CNY:never:true:false:Asia/Shanghai:ledger_entries_start_inclusive_end_exclusive:5000000:10000000:3000000',
    'D9-B-4 migration must seed the approved policy exactly',
  )
  assert.equal(
    scalar(`SELECT singleton_key || ':' || current_version FROM wallet_policy_heads;`),
    'cny-wallet-funds-policy:1',
    'D9-B-4 migration must point the singleton head to version 1',
  )
  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_wallet_transactions_type), ',') || ':' ||
      array_to_string(enum_range(NULL::enum_wallet_entries_entry_type), ',') || ':' ||
      array_to_string(enum_range(NULL::enum_provider_operations_target_type), ',');`),
    'credit,hold,recovery:credit,hold,capture,release,recovery:order,realname_template,domain,wallet_top_up',
    'D9-B-4 migration enum extensions mismatch',
  )
  assert.equal(
    scalar(`SELECT
      array_to_string(enum_range(NULL::enum_wallet_top_up_orders_payment_recovery_type), ',') || ':' ||
      array_to_string(enum_range(NULL::enum_wallet_policy_versions_currency), ',') || ':' ||
      array_to_string(enum_range(NULL::enum_wallet_policy_versions_balance_expiration), ',') || ':' ||
      array_to_string(enum_range(NULL::enum_wallet_policy_versions_financial_day_cut_timezone), ',') || ':' ||
      array_to_string(enum_range(NULL::enum_wallet_policy_versions_statement_calculation), ',');`),
    'provider_refund,dispute:CNY:never:Asia/Shanghai:ledger_entries_start_inclusive_end_exclusive',
    'D9-B-4 fixed policy and recovery enums mismatch',
  )

  for (const [label, value] of [
    ['policy version integer', { version: '2.5' }],
    ['policy version positive', { version: '0' }],
    ['policy version safe maximum', { version: '9007199254740992' }],
    ['policy schema fixed', { schema: '2' }],
    ['single top-up integer', { topUp: '1.5' }],
    ['single top-up positive', { topUp: '0' }],
    ['account balance integer', { account: '1.5', topUp: '1', spend: '1' }],
    ['account balance safe maximum', { account: '9007199254740992' }],
    ['single spend integer', { spend: '1.5' }],
    ['single spend positive', { spend: '0' }],
    ['single top-up bounded by account', { topUp: '101', account: '100', spend: '99' }],
    ['single spend bounded by account', { topUp: '99', account: '100', spend: '101' }],
    ['policy actor nonblank', { changedBy: `''` }],
    ['policy change note length', { changeNote: `'short'` }],
  ]) {
    rejectsWrite(policyInsert(value), label)
  }
  rejectsWrite(policyInsert({ version: '1' }), 'policy version uniqueness')
  rejectsWrite(
    `INSERT INTO wallet_policy_heads (singleton_key, current_version)
     VALUES ('not-the-cny-wallet-head', 1);`,
    'policy singleton head key',
  )
  psql(`DELETE FROM wallet_policy_heads;`)
  rejectsWrite(
    `INSERT INTO wallet_policy_heads (singleton_key, current_version)
     VALUES ('cny-wallet-funds-policy', 2);`,
    'head current version foreign key',
  )
  psql(`INSERT INTO wallet_policy_heads (singleton_key, current_version)
        VALUES ('cny-wallet-funds-policy', 1);`)

  rejectsWrite(
    `INSERT INTO wallet_transactions (
      transaction_key, customer_id, account_id, type, status, amount_fen
    ) VALUES ('invalid-recovery-status', 1, 1, 'recovery', 'held', 1);`,
    'recovery transaction posted state',
  )
  rejectsWrite(
    `INSERT INTO wallet_transactions (
      transaction_key, customer_id, account_id, type, status, amount_fen, resolved_at
    ) VALUES ('invalid-recovery-resolution', 1, 1, 'recovery', 'posted', 1, NOW());`,
    'recovery transaction unresolved state',
  )
  rejectsWrite(
    `INSERT INTO wallet_entries (
      entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
      ledger_sequence, posted_balance_after_fen, held_balance_after_fen
    ) VALUES ('invalid-negative-safe-limit', 1, 1, 1, 'recovery', 1, 1, -9007199254740992, 0);`,
    'negative posted balance safe minimum',
  )
  rejectsWrite(
    `INSERT INTO wallet_entries (
      entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
      ledger_sequence, posted_balance_after_fen, held_balance_after_fen
    ) VALUES ('invalid-positive-held-balance', 1, 1, 1, 'recovery', 1, 1, 100, 101);`,
    'positive posted balance covers held balance',
  )

  const stateRows = {
    created: returnedId(`${topUpInsert({ channel: 'NULL', expiresAt: 'NULL', status: 'created' })}
      RETURNING id;`),
    payment_pending: returnedId(`${topUpInsert({ status: 'payment_pending' })} RETURNING id;`),
    provider_confirmed: returnedId(
      `${topUpInsert({
        providerConfirmedAt: 'NOW()',
        providerPaidAt: 'NOW()',
        status: 'provider_confirmed',
        transactionId: `'wechat-valid-confirmed'`,
      })} RETURNING id;`,
    ),
    credited: returnedId(
      `${topUpInsert({
        creditedAt: 'NOW()',
        providerConfirmedAt: 'NOW()',
        providerPaidAt: 'NOW()',
        status: 'credited',
        transactionId: `'wechat-valid-credited'`,
      })} RETURNING id;`,
    ),
  }
  for (const [state, id] of Object.entries(stateRows)) {
    for (const [field, value] of [
      ['refunded_amount_fen', '1'],
      ['payment_recovery_key', `'unexpected-${state}-recovery-key'`],
      ['payment_recovery_type', `'dispute'`],
      ['payment_recovered_at', 'NOW()'],
    ]) {
      rejectsWrite(
        `UPDATE wallet_top_up_orders SET ${field} = ${value} WHERE id = ${id};`,
        `${state} excludes ${field}`,
      )
    }
  }
  psql(`INSERT INTO orders DEFAULT VALUES;`)
  rejectsWrite(
    `INSERT INTO refunds (order_id, wallet_top_up_order_id) VALUES (NULL, NULL);`,
    'refund requires one target',
  )
  rejectsWrite(
    `INSERT INTO refunds (order_id, wallet_top_up_order_id) VALUES (1, ${stateRows.credited});`,
    'refund forbids two targets',
  )
  rejectsWrite(
    `INSERT INTO refunds (wallet_top_up_order_id) VALUES (999999);`,
    'refund top-up target foreign key',
  )
  psql(`INSERT INTO refunds (wallet_top_up_order_id) VALUES (${stateRows.credited});`)
  rejectsWrite(
    `INSERT INTO refunds (wallet_top_up_order_id) VALUES (${stateRows.credited});`,
    'one refund fact per top-up target',
  )
  psql(`DELETE FROM refunds;`)

  for (const [label, refundedAmount] of [
    ['refund amount integer', '1.5'],
    ['refund amount positive', '0'],
    ['refund amount bounded by top-up', '701'],
  ]) {
    rejectsWrite(
      `INSERT INTO wallet_top_up_orders (
        payment_channel, payment_expires_at, original_refund_number,
        refunded_amount_fen, amount_fen, status
      ) VALUES ('native', NOW(), 'refund-${label.replaceAll(' ', '-')}',
        ${refundedAmount}, 700, 'refund_pending');`,
      label,
    )
  }
  const ordinaryPending = {
    originalRefundNumber: `'ordinary-pending'`,
    refundedAmount: '700',
    status: 'refund_pending',
  }
  const ordinaryRefunded = {
    ...ordinaryPending,
    originalRefundNumber: `'ordinary-refunded'`,
    refundedAt: 'NOW()',
    status: 'refunded',
  }
  const recoveryPending = {
    paymentRecoveryKey: `'recovery-pending'`,
    paymentRecoveryType: `'dispute'`,
    status: 'refund_pending',
  }
  const recoveryRefunded = {
    ...recoveryPending,
    paymentRecoveredAt: 'NOW()',
    paymentRecoveryKey: `'recovery-refunded'`,
    refundedAt: 'NOW()',
    status: 'refunded',
  }
  const invalidTopUpStates = [
    [
      'ordinary pending refund number required',
      { ...ordinaryPending, originalRefundNumber: 'NULL' },
    ],
    ['ordinary pending refund amount required', { ...ordinaryPending, refundedAmount: 'NULL' }],
    [
      'ordinary pending excludes recovery key',
      { ...ordinaryPending, paymentRecoveryKey: `'ordinary-pending-key'` },
    ],
    [
      'ordinary pending excludes recovery type',
      { ...ordinaryPending, paymentRecoveryType: `'dispute'` },
    ],
    [
      'ordinary pending excludes recovered timestamp',
      { ...ordinaryPending, paymentRecoveredAt: 'NOW()' },
    ],
    ['ordinary pending excludes refunded timestamp', { ...ordinaryPending, refundedAt: 'NOW()' }],
    ['ordinary refunded number required', { ...ordinaryRefunded, originalRefundNumber: 'NULL' }],
    ['ordinary refunded amount required', { ...ordinaryRefunded, refundedAmount: 'NULL' }],
    [
      'ordinary refunded excludes recovery key',
      { ...ordinaryRefunded, paymentRecoveryKey: `'ordinary-refunded-key'` },
    ],
    [
      'ordinary refunded excludes recovery type',
      { ...ordinaryRefunded, paymentRecoveryType: `'dispute'` },
    ],
    [
      'ordinary refunded excludes recovered timestamp',
      { ...ordinaryRefunded, paymentRecoveredAt: 'NOW()' },
    ],
    ['ordinary refunded timestamp required', { ...ordinaryRefunded, refundedAt: 'NULL' }],
    [
      'recovery pending excludes refund number',
      { ...recoveryPending, originalRefundNumber: `'recovery-pending-refund-number'` },
    ],
    ['recovery pending excludes refund amount', { ...recoveryPending, refundedAmount: '700' }],
    ['recovery pending key required', { ...recoveryPending, paymentRecoveryKey: 'NULL' }],
    ['recovery pending type required', { ...recoveryPending, paymentRecoveryType: 'NULL' }],
    [
      'recovery pending excludes recovered timestamp',
      { ...recoveryPending, paymentRecoveredAt: 'NOW()' },
    ],
    ['recovery pending excludes refunded timestamp', { ...recoveryPending, refundedAt: 'NOW()' }],
    [
      'recovery refunded excludes refund number',
      { ...recoveryRefunded, originalRefundNumber: `'recovery-refunded-number'` },
    ],
    ['recovery refunded excludes refund amount', { ...recoveryRefunded, refundedAmount: '700' }],
    ['recovery refunded key required', { ...recoveryRefunded, paymentRecoveryKey: 'NULL' }],
    ['recovery refunded type required', { ...recoveryRefunded, paymentRecoveryType: 'NULL' }],
    [
      'recovery refunded recovered timestamp required',
      { ...recoveryRefunded, paymentRecoveredAt: 'NULL' },
    ],
    ['recovery refunded refunded timestamp required', { ...recoveryRefunded, refundedAt: 'NULL' }],
  ]
  for (const [label, values] of invalidTopUpStates) {
    rejectsWrite(`${topUpInsert(values)};`, label)
  }
  psql(`
    INSERT INTO wallet_top_up_orders (
      payment_channel, payment_expires_at, amount_fen, status,
      payment_recovery_key, payment_recovery_type
    ) VALUES ('native', NOW(), 700, 'refund_pending', 'unique-recovery-key', 'dispute');
  `)
  rejectsWrite(
    `INSERT INTO wallet_top_up_orders (
      payment_channel, payment_expires_at, amount_fen, status,
      payment_recovery_key, payment_recovery_type
    ) VALUES ('native', NOW(), 700, 'refund_pending', 'unique-recovery-key', 'provider_refund');`,
    'payment recovery key uniqueness',
  )

  psql(`
    INSERT INTO wallet_transactions (
      transaction_key, customer_id, account_id, type, status, amount_fen
    ) VALUES ('recovery-fixture', 1, 1, 'recovery', 'posted', 700);
    INSERT INTO wallet_entries (
      entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
      ledger_sequence, posted_balance_after_fen, held_balance_after_fen
    ) VALUES ('recovery-fixture:recovery', 1, 1, 1, 'recovery', 700, 1, -200, 100);
    INSERT INTO wallet_top_up_orders (
      payment_channel, payment_expires_at, wechat_transaction_id, provider_paid_at,
      provider_confirmed_at, credited_at, original_refund_number, amount_fen, status,
      payment_recovery_key, payment_recovery_type
    ) VALUES (
      'native', NOW(), 'wechat-fixture', NOW(), NOW(), NOW(), NULL, 700,
      'refund_pending', 'dispute-fixture', 'dispute'
    );
    INSERT INTO orders DEFAULT VALUES;
    INSERT INTO refunds (order_id) VALUES (1);
  `)
  assert.equal(
    scalar(`SELECT (SELECT count(*) FROM wallet_entries WHERE entry_type = 'recovery') || ':' ||
      (SELECT count(*) FROM refunds WHERE order_id = 1 AND wallet_top_up_order_id IS NULL) || ':' ||
      (SELECT count(*) FROM wallet_top_up_orders WHERE payment_recovery_key = 'dispute-fixture');`),
    '1:1:1',
    'D9-B-4 migration must support the approved recovery and exclusive refund target facts',
  )
  const bothTargets = psqlFailure(
    `UPDATE refunds SET wallet_top_up_order_id = 1 WHERE order_id = 1;`,
  )
  assert.notEqual(bothTargets.status, 0, 'a refund must not reference both target kinds')

  psql(`
    DELETE FROM refunds;
    DELETE FROM orders;
    DELETE FROM wallet_entries;
    DELETE FROM wallet_transactions;
    DELETE FROM wallet_top_up_orders;
    DELETE FROM provider_operations;
  `)

  psql(policyInsert({ version: '2' }))
  rejectsDown('additional policy version')
  psql(`DELETE FROM wallet_policy_versions WHERE version = 2;`)

  psql(
    `UPDATE wallet_policy_versions SET changed_by = 'changed-after-migration' WHERE version = 1;`,
  )
  rejectsDown('modified migration seed')
  psql(`UPDATE wallet_policy_versions SET changed_by = 'system:migration' WHERE version = 1;`)

  psql(`INSERT INTO orders DEFAULT VALUES;
        INSERT INTO refunds (order_id, reason_code) VALUES (3, 'down-guard-refund');`)
  rejectsDown('refund target or reason fact')
  psql(`DELETE FROM refunds; DELETE FROM orders;`)

  psql(`INSERT INTO wallet_transactions (
    transaction_key, customer_id, account_id, type, status, amount_fen
  ) VALUES ('down-guard-recovery-transaction', 1, 1, 'recovery', 'posted', 1);`)
  rejectsDown('recovery transaction fact')
  psql(`DELETE FROM wallet_transactions;`)

  psql(`INSERT INTO wallet_transactions (
    transaction_key, customer_id, account_id, type, status, amount_fen
  ) VALUES ('down-guard-credit-transaction', 1, 1, 'credit', 'posted', 1);
  INSERT INTO wallet_entries (
    entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
    ledger_sequence, posted_balance_after_fen, held_balance_after_fen
  ) VALUES ('down-guard-recovery-entry', 1, 1, 2, 'recovery', 1, 1, 0, 0);`)
  rejectsDown('recovery entry fact')
  psql(`DELETE FROM wallet_entries; DELETE FROM wallet_transactions;`)

  psql(`INSERT INTO provider_operations (target_type, target_id)
        VALUES ('wallet_top_up', 'down-guard-top-up');`)
  rejectsDown('wallet top-up provider operation fact')
  psql(`DELETE FROM provider_operations;`)

  psql(`INSERT INTO wallet_top_up_orders (
    payment_channel, payment_expires_at, amount_fen, status,
    payment_recovery_key, payment_recovery_type
  ) VALUES ('native', NOW(), 1, 'refund_pending', 'down-guard-top-up-recovery', 'dispute');`)
  rejectsDown('top-up refund or recovery evidence')
  psql(`DELETE FROM wallet_top_up_orders;`)

  psql(downSql)
  assert.equal(
    scalar(`SELECT
      (to_regclass('public.wallet_policy_versions') IS NULL)::text || ':' ||
      (to_regclass('public.wallet_policy_heads') IS NULL)::text || ':' ||
      (NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'refunds' AND column_name IN ('wallet_top_up_order_id', 'reason_code')))::text || ':' ||
      (NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'wallet_top_up_orders' AND column_name IN (
          'refunded_amount_fen', 'payment_recovery_key', 'payment_recovery_type', 'payment_recovered_at'
        )))::text;`),
    'true:true:true:true',
    'D9-B-4 clean down must remove only its schema additions',
  )
} finally {
  postgres(['dropdb', '--username', 'wanmi', '--if-exists', databaseName])
}

console.log('D9-B-4 wallet funds migration verification passed')
