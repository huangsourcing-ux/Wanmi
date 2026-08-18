import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL('../apps/web/migrations/20260818_032334_d9b2_wallet_top_up_orders.ts', import.meta.url),
)
const databaseName = `wanmi_d9b2_topup_migration_${process.pid}_${Date.now()}`
if (!/^wanmi_d9b2_topup_migration_[0-9]+_[0-9]+$/u.test(databaseName)) {
  throw new Error(`Unexpected D9-B-2 migration database name: ${databaseName}`)
}

const source = readFileSync(migrationPath, 'utf8')
const upSql = source.match(
  /export async function up[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
const downSql = source.match(
  /export async function down[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
if (!upSql || !downSql || upSql.includes('${') || downSql.includes('${')) {
  throw new Error('D9-B-2 migration SQL could not be extracted safely')
}

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

const invalidUpdates = [
  ['amount integer', 'UPDATE wallet_top_up_orders SET amount_fen = 1.5 WHERE id = 1'],
  ['amount positive', 'UPDATE wallet_top_up_orders SET amount_fen = 0 WHERE id = 1'],
  [
    'amount safe maximum',
    'UPDATE wallet_top_up_orders SET amount_fen = 9007199254740992 WHERE id = 1',
  ],
  [
    'platform order number format',
    "UPDATE wallet_top_up_orders SET top_up_order_number = 'BAD' WHERE id = 1",
  ],
  [
    'ledger key nonblank',
    "UPDATE wallet_top_up_orders SET ledger_transaction_key = ' ' WHERE id = 1",
  ],
  [
    'wechat transaction id nonblank',
    "UPDATE wallet_top_up_orders SET wechat_transaction_id = ' ' WHERE id = 5",
  ],
  [
    'original refund number nonblank',
    "UPDATE wallet_top_up_orders SET original_refund_number = ' ' WHERE id = 7",
  ],

  [
    'created branch status',
    "UPDATE wallet_top_up_orders SET status = 'payment_pending' WHERE id = 1",
  ],
  [
    'created payment channel absent',
    "UPDATE wallet_top_up_orders SET payment_channel = 'native' WHERE id = 1",
  ],
  [
    'created payment expiry absent',
    'UPDATE wallet_top_up_orders SET payment_expires_at = NOW() WHERE id = 1',
  ],
  [
    'created transaction absent',
    "UPDATE wallet_top_up_orders SET wechat_transaction_id = 'created-tx' WHERE id = 1",
  ],
  [
    'created provider paid absent',
    'UPDATE wallet_top_up_orders SET provider_paid_at = NOW() WHERE id = 1',
  ],
  [
    'created provider confirmation absent',
    'UPDATE wallet_top_up_orders SET provider_confirmed_at = NOW() WHERE id = 1',
  ],
  ['created credit absent', 'UPDATE wallet_top_up_orders SET credited_at = NOW() WHERE id = 1'],
  [
    'created refund number absent',
    "UPDATE wallet_top_up_orders SET original_refund_number = 'created-refund' WHERE id = 1",
  ],
  [
    'created refund timestamp absent',
    'UPDATE wallet_top_up_orders SET refunded_at = NOW() WHERE id = 1',
  ],

  [
    'pending branch status set',
    "UPDATE wallet_top_up_orders SET status = 'provider_confirmed' WHERE id = 2",
  ],
  [
    'pending payment channel present',
    'UPDATE wallet_top_up_orders SET payment_channel = NULL WHERE id = 2',
  ],
  [
    'pending payment expiry present',
    'UPDATE wallet_top_up_orders SET payment_expires_at = NULL WHERE id = 2',
  ],
  [
    'pending transaction absent',
    "UPDATE wallet_top_up_orders SET wechat_transaction_id = 'pending-tx' WHERE id = 2",
  ],
  [
    'pending provider paid absent',
    'UPDATE wallet_top_up_orders SET provider_paid_at = NOW() WHERE id = 2',
  ],
  [
    'pending provider confirmation absent',
    'UPDATE wallet_top_up_orders SET provider_confirmed_at = NOW() WHERE id = 2',
  ],
  ['pending credit absent', 'UPDATE wallet_top_up_orders SET credited_at = NOW() WHERE id = 2'],
  [
    'pending refund number absent',
    "UPDATE wallet_top_up_orders SET original_refund_number = 'pending-refund' WHERE id = 2",
  ],
  [
    'pending refund timestamp absent',
    'UPDATE wallet_top_up_orders SET refunded_at = NOW() WHERE id = 2',
  ],

  ['confirmed branch status', "UPDATE wallet_top_up_orders SET status = 'credited' WHERE id = 5"],
  [
    'confirmed payment channel present',
    'UPDATE wallet_top_up_orders SET payment_channel = NULL WHERE id = 5',
  ],
  [
    'confirmed payment expiry present',
    'UPDATE wallet_top_up_orders SET payment_expires_at = NULL WHERE id = 5',
  ],
  [
    'confirmed transaction present',
    'UPDATE wallet_top_up_orders SET wechat_transaction_id = NULL WHERE id = 5',
  ],
  [
    'confirmed provider paid present',
    'UPDATE wallet_top_up_orders SET provider_paid_at = NULL WHERE id = 5',
  ],
  [
    'confirmed provider confirmation present',
    'UPDATE wallet_top_up_orders SET provider_confirmed_at = NULL WHERE id = 5',
  ],
  ['confirmed credit absent', 'UPDATE wallet_top_up_orders SET credited_at = NOW() WHERE id = 5'],
  [
    'confirmed refund number absent',
    "UPDATE wallet_top_up_orders SET original_refund_number = 'confirmed-refund' WHERE id = 5",
  ],
  [
    'confirmed refund timestamp absent',
    'UPDATE wallet_top_up_orders SET refunded_at = NOW() WHERE id = 5',
  ],

  [
    'credited branch status',
    "UPDATE wallet_top_up_orders SET status = 'provider_confirmed' WHERE id = 6",
  ],
  [
    'credited payment channel present',
    'UPDATE wallet_top_up_orders SET payment_channel = NULL WHERE id = 6',
  ],
  [
    'credited payment expiry present',
    'UPDATE wallet_top_up_orders SET payment_expires_at = NULL WHERE id = 6',
  ],
  [
    'credited transaction present',
    'UPDATE wallet_top_up_orders SET wechat_transaction_id = NULL WHERE id = 6',
  ],
  [
    'credited provider paid present',
    'UPDATE wallet_top_up_orders SET provider_paid_at = NULL WHERE id = 6',
  ],
  [
    'credited provider confirmation present',
    'UPDATE wallet_top_up_orders SET provider_confirmed_at = NULL WHERE id = 6',
  ],
  ['credited timestamp present', 'UPDATE wallet_top_up_orders SET credited_at = NULL WHERE id = 6'],
  [
    'credited refund number absent',
    "UPDATE wallet_top_up_orders SET original_refund_number = 'credited-refund' WHERE id = 6",
  ],
  [
    'credited refund timestamp absent',
    'UPDATE wallet_top_up_orders SET refunded_at = NOW() WHERE id = 6',
  ],

  [
    'refund-pending branch status',
    "UPDATE wallet_top_up_orders SET status = 'refunded' WHERE id = 7",
  ],
  [
    'refund-pending payment channel present',
    'UPDATE wallet_top_up_orders SET payment_channel = NULL WHERE id = 7',
  ],
  [
    'refund-pending payment expiry present',
    'UPDATE wallet_top_up_orders SET payment_expires_at = NULL WHERE id = 7',
  ],
  [
    'refund-pending refund number present',
    'UPDATE wallet_top_up_orders SET original_refund_number = NULL WHERE id = 7',
  ],
  [
    'refund-pending refund timestamp absent',
    'UPDATE wallet_top_up_orders SET refunded_at = NOW() WHERE id = 7',
  ],

  [
    'refunded branch status',
    "UPDATE wallet_top_up_orders SET status = 'refund_pending' WHERE id = 8",
  ],
  [
    'refunded payment channel present',
    'UPDATE wallet_top_up_orders SET payment_channel = NULL WHERE id = 8',
  ],
  [
    'refunded payment expiry present',
    'UPDATE wallet_top_up_orders SET payment_expires_at = NULL WHERE id = 8',
  ],
  [
    'refunded refund number present',
    'UPDATE wallet_top_up_orders SET original_refund_number = NULL WHERE id = 8',
  ],
  [
    'refunded refund timestamp present',
    'UPDATE wallet_top_up_orders SET refunded_at = NULL WHERE id = 8',
  ],
]

const quoteLiteral = (value) => `'${value.replaceAll("'", "''")}'`
const behaviorChecks = `
CREATE OR REPLACE FUNCTION pg_temp.expect_sqlstate(
  statement text,
  expected_state text,
  label text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected_state THEN RETURN; END IF;
    RAISE EXCEPTION '% raised %, expected %', label, SQLSTATE, expected_state;
  END;
  RAISE EXCEPTION '% accepted an invalid write', label;
END $$;

INSERT INTO customers DEFAULT VALUES;
INSERT INTO wallet_accounts (customer_id) VALUES (1);
INSERT INTO wallet_top_up_orders (
  top_up_order_number, customer_id, account_id, amount_fen, currency, funding_source,
  payment_channel, status, wechat_transaction_id, ledger_transaction_key,
  original_refund_number, payment_expires_at, provider_paid_at, provider_confirmed_at,
  credited_at, refunded_at, updated_at, created_at
) VALUES
('WT000000000000000000000000000001', 1, 1, 100, 'CNY', 'wechat', NULL, 'created', NULL, 'ledger-1', NULL, NULL, NULL, NULL, NULL, NULL, NOW(), NOW()),
('WT000000000000000000000000000002', 1, 1, 100, 'CNY', 'wechat', 'native', 'payment_pending', NULL, 'ledger-2', NULL, NOW(), NULL, NULL, NULL, NULL, NOW(), NOW()),
('WT000000000000000000000000000003', 1, 1, 100, 'CNY', 'wechat', 'native', 'closed', NULL, 'ledger-3', NULL, NOW(), NULL, NULL, NULL, NULL, NOW(), NOW()),
('WT000000000000000000000000000004', 1, 1, 100, 'CNY', 'wechat', 'native', 'unknown', NULL, 'ledger-4', NULL, NOW(), NULL, NULL, NULL, NULL, NOW(), NOW()),
('WT000000000000000000000000000005', 1, 1, 100, 'CNY', 'wechat', 'native', 'provider_confirmed', 'wechat-5', 'ledger-5', NULL, NOW(), NOW(), NOW(), NULL, NULL, NOW(), NOW()),
('WT000000000000000000000000000006', 1, 1, 100, 'CNY', 'wechat', 'native', 'credited', 'wechat-6', 'ledger-6', NULL, NOW(), NOW(), NOW(), NOW(), NULL, NOW(), NOW()),
('WT000000000000000000000000000007', 1, 1, 100, 'CNY', 'wechat', 'native', 'refund_pending', NULL, 'ledger-7', 'refund-7', NOW(), NULL, NULL, NULL, NULL, NOW(), NOW()),
('WT000000000000000000000000000008', 1, 1, 100, 'CNY', 'wechat', 'native', 'refunded', 'wechat-8', 'ledger-8', 'refund-8', NOW(), NOW(), NOW(), NOW(), NOW(), NOW(), NOW());

${invalidUpdates
  .map(
    ([label, statement]) =>
      `SELECT pg_temp.expect_sqlstate(${quoteLiteral(statement)}, '23514', ${quoteLiteral(label)});`,
  )
  .join('\n')}

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_top_up_orders (
    top_up_order_number, customer_id, account_id, amount_fen, currency, funding_source,
    status, ledger_transaction_key, updated_at, created_at
  ) VALUES ('WT000000000000000000000000000001', 1, 1, 100, 'CNY', 'wechat', 'created', 'ledger-order-copy', NOW(), NOW())$$,
  '23505', 'global platform top-up order number'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_top_up_orders (
    top_up_order_number, customer_id, account_id, amount_fen, currency, funding_source,
    payment_channel, status, wechat_transaction_id, ledger_transaction_key,
    payment_expires_at, provider_paid_at, provider_confirmed_at, updated_at, created_at
  ) VALUES ('WT000000000000000000000000000011', 1, 1, 100, 'CNY', 'wechat', 'native',
    'provider_confirmed', 'wechat-5', 'ledger-tx-copy', NOW(), NOW(), NOW(), NOW(), NOW())$$,
  '23505', 'global WeChat transaction id'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_top_up_orders (
    top_up_order_number, customer_id, account_id, amount_fen, currency, funding_source,
    status, ledger_transaction_key, updated_at, created_at
  ) VALUES ('WT000000000000000000000000000012', 1, 1, 100, 'CNY', 'wechat', 'created', 'ledger-1', NOW(), NOW())$$,
  '23505', 'global ledger idempotency key'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_top_up_orders (
    top_up_order_number, customer_id, account_id, amount_fen, currency, funding_source,
    payment_channel, status, ledger_transaction_key, original_refund_number,
    payment_expires_at, updated_at, created_at
  ) VALUES ('WT000000000000000000000000000013', 1, 1, 100, 'CNY', 'wechat', 'native',
    'refund_pending', 'ledger-refund-copy', 'refund-7', NOW(), NOW(), NOW())$$,
  '23505', 'global original refund number'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_top_up_orders (
    top_up_order_number, customer_id, account_id, amount_fen, currency, funding_source,
    status, ledger_transaction_key, updated_at, created_at
  ) VALUES ('WT000000000000000000000000000021', 999, 1, 100, 'CNY', 'wechat', 'created', 'ledger-fk-customer', NOW(), NOW())$$,
  '23503', 'top-up customer foreign key'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_top_up_orders (
    top_up_order_number, customer_id, account_id, amount_fen, currency, funding_source,
    status, ledger_transaction_key, updated_at, created_at
  ) VALUES ('WT000000000000000000000000000022', 1, 999, 100, 'CNY', 'wechat', 'created', 'ledger-fk-account', NOW(), NOW())$$,
  '23503', 'top-up wallet account foreign key'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE payment_notification_archives SET wallet_top_up_order_id = 999 WHERE id = 1',
  '23503', 'notification archive top-up foreign key'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE manual_reviews SET wallet_top_up_order_id = 999 WHERE id = 1',
  '23503', 'manual review top-up foreign key'
);
`

let created = false
try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  created = true
  psql(`
    CREATE TABLE customers (id serial PRIMARY KEY);
    CREATE TABLE wallet_accounts (id serial PRIMARY KEY, customer_id integer NOT NULL);
    CREATE TABLE payment_notification_archives (id serial PRIMARY KEY);
    CREATE TABLE manual_reviews (id serial PRIMARY KEY);
    INSERT INTO payment_notification_archives DEFAULT VALUES;
    INSERT INTO manual_reviews DEFAULT VALUES;
  `)
  psql(upSql)
  psql(behaviorChecks)

  const schema = psql(
    `SELECT
       (to_regclass('public.wallet_top_up_orders') IS NOT NULL)::text || ':' ||
       (to_regclass('public.wallet_top_up_orders_top_up_order_number_idx') IS NOT NULL AND
        to_regclass('public.wallet_top_up_orders_wechat_transaction_id_idx') IS NOT NULL AND
        to_regclass('public.wallet_top_up_orders_ledger_transaction_key_idx') IS NOT NULL AND
        to_regclass('public.wallet_top_up_orders_original_refund_number_idx') IS NOT NULL)::text || ':' ||
       ((SELECT count(*) FROM information_schema.table_constraints
         WHERE table_schema = 'public' AND constraint_type = 'FOREIGN KEY'
           AND constraint_name LIKE '%wallet_top_up_order%') = 4)::text`,
    true,
  ).trim()
  if (schema !== 'true:true:true') {
    throw new Error(`D9-B-2 migration up schema mismatch: ${schema}`)
  }

  psql(downSql)
  const down = psql(
    `SELECT
       (to_regclass('public.wallet_top_up_orders') IS NULL)::text || ':' ||
       (NOT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_name = 'payment_notification_archives'
           AND column_name = 'wallet_top_up_order_id'))::text || ':' ||
       (NOT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_name = 'manual_reviews'
           AND column_name = 'wallet_top_up_order_id'))::text || ':' ||
       (to_regtype('public.enum_wallet_top_up_orders_currency') IS NULL)::text || ':' ||
       (to_regtype('public.enum_wallet_top_up_orders_funding_source') IS NULL)::text || ':' ||
       (to_regtype('public.enum_wallet_top_up_orders_payment_channel') IS NULL)::text || ':' ||
       (to_regtype('public.enum_wallet_top_up_orders_status') IS NULL)::text`,
    true,
  ).trim()
  if (down !== 'true:true:true:true:true:true:true') {
    throw new Error(`D9-B-2 migration down schema mismatch: ${down}`)
  }

  process.stdout.write(
    `D9-B-2 wallet top-up migration behavior verified: ${invalidUpdates.length} CHECK predicates, 4 unique indexes, 4 foreign keys, and down cleanup.\n`,
  )
} finally {
  if (created) postgres(['dropdb', '--force', '--username', 'wanmi', databaseName])
}
