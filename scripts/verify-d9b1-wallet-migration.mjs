import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL('../apps/web/migrations/20260817_040409_d9b1_wallet_ledger.ts', import.meta.url),
)
const databaseName = `wanmi_d9b1_wallet_migration_${process.pid}_${Date.now()}`
if (!/^wanmi_d9b1_wallet_migration_[0-9]+_[0-9]+$/u.test(databaseName)) {
  throw new Error(`Unexpected D9-B-1 migration database name: ${databaseName}`)
}

const source = readFileSync(migrationPath, 'utf8')
const upSql = source.match(
  /export async function up[\s\S]*?await db\.execute\(sql`([\s\S]*?)`\)\n\}/u,
)?.[1]
const downBody = source.match(/export async function down[\s\S]*?\{([\s\S]*?)\n\}/u)?.[1]
const downSqlBlocks = downBody
  ? [...downBody.matchAll(/await db\.execute\(sql`([\s\S]*?)`\)/gu)].map((match) => match[1])
  : []
if (
  !upSql ||
  downSqlBlocks.length !== 2 ||
  upSql.includes('${') ||
  downSqlBlocks.some((statement) => statement.includes('${'))
) {
  throw new Error('D9-B-1 migration SQL could not be extracted safely')
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

const workflowSlugs = [
  'publishingProbe',
  'contentScheduledPublish',
  'backgroundProbe',
  'advertisingMaintenance',
  'smsReceiptReconciliation',
  'realnameCleanup',
  'westdigitalBalanceMonitoring',
  'domainExpiryReminders',
  'commerceFulfillment',
  'commerceWorkerHeartbeat',
  'nameserverChange',
  'wechatRefund',
  'paymentTimeoutClose',
]
  .map((value) => `'${value}'`)
  .join(', ')

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
    IF SQLSTATE = expected_state THEN
      RETURN;
    END IF;
    RAISE EXCEPTION '% raised %, expected %', label, SQLSTATE, expected_state;
  END;
  RAISE EXCEPTION '% accepted an invalid write', label;
END $$;

INSERT INTO customers DEFAULT VALUES;
INSERT INTO wallet_accounts (customer_id, currency, ledger_version, updated_at, created_at)
VALUES (1, 'CNY', 0, NOW(), NOW());
INSERT INTO wallet_transactions (
  transaction_key, customer_id, account_id, type, status, amount_fen,
  updated_at, created_at
) VALUES ('valid-credit', 1, 1, 'credit', 'posted', 10, NOW(), NOW());
INSERT INTO wallet_entries (
  entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
  ledger_sequence, posted_balance_after_fen, held_balance_after_fen, updated_at, created_at
) VALUES ('valid-credit:credit', 1, 1, 1, 'credit', 10, 1, 10, 0, NOW(), NOW());

SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_accounts SET ledger_version = 0.5 WHERE id = 1', '23514',
  'wallet account integer ledger version'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_accounts SET ledger_version = -1 WHERE id = 1', '23514',
  'wallet account nonnegative ledger version'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_accounts SET ledger_version = 9007199254740992 WHERE id = 1', '23514',
  'wallet account safe ledger version maximum'
);

SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_transactions SET amount_fen = 1.5 WHERE id = 1', '23514',
  'wallet transaction integer amount'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_transactions SET amount_fen = 0 WHERE id = 1', '23514',
  'wallet transaction positive amount'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_transactions SET amount_fen = 9007199254740992 WHERE id = 1', '23514',
  'wallet transaction safe amount maximum'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE wallet_transactions SET type = 'hold', status = 'posted', resolved_at = NULL WHERE id = 1$$,
  '23514', 'credit branch requires credit type'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE wallet_transactions SET type = 'credit', status = 'held', resolved_at = NULL WHERE id = 1$$,
  '23514', 'credit branch requires posted status'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE wallet_transactions SET type = 'credit', status = 'posted', resolved_at = NOW() WHERE id = 1$$,
  '23514', 'credit branch requires unresolved timestamp'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE wallet_transactions SET type = 'credit', status = 'held', resolved_at = NULL WHERE id = 1$$,
  '23514', 'held branch requires hold type'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE wallet_transactions SET type = 'hold', status = 'released', resolved_at = NULL WHERE id = 1$$,
  '23514', 'held branch requires held status'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE wallet_transactions SET type = 'hold', status = 'held', resolved_at = NOW() WHERE id = 1$$,
  '23514', 'held branch requires unresolved timestamp'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE wallet_transactions SET type = 'credit', status = 'captured', resolved_at = NOW() WHERE id = 1$$,
  '23514', 'terminal branch requires hold type'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE wallet_transactions SET type = 'hold', status = 'posted', resolved_at = NOW() WHERE id = 1$$,
  '23514', 'terminal branch requires a terminal status'
);
SELECT pg_temp.expect_sqlstate(
  $$UPDATE wallet_transactions SET type = 'hold', status = 'captured', resolved_at = NULL WHERE id = 1$$,
  '23514', 'terminal branch requires a resolution timestamp'
);

SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET amount_fen = 1.5 WHERE id = 1', '23514',
  'wallet entry integer amount'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET amount_fen = 0 WHERE id = 1', '23514',
  'wallet entry positive amount'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET amount_fen = 9007199254740992 WHERE id = 1', '23514',
  'wallet entry safe amount maximum'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET ledger_sequence = 1.5 WHERE id = 1', '23514',
  'wallet entry integer sequence'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET ledger_sequence = 0 WHERE id = 1', '23514',
  'wallet entry positive sequence'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET ledger_sequence = 9007199254740992 WHERE id = 1', '23514',
  'wallet entry safe sequence maximum'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET posted_balance_after_fen = 0.5 WHERE id = 1', '23514',
  'wallet entry integer posted snapshot'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET posted_balance_after_fen = 9007199254740992 WHERE id = 1', '23514',
  'wallet entry safe posted snapshot maximum'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET held_balance_after_fen = 0.5 WHERE id = 1', '23514',
  'wallet entry integer held snapshot'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET held_balance_after_fen = -1 WHERE id = 1', '23514',
  'wallet entry nonnegative held snapshot'
);
SELECT pg_temp.expect_sqlstate(
  'UPDATE wallet_entries SET held_balance_after_fen = 11 WHERE id = 1', '23514',
  'wallet held snapshot cannot exceed posted snapshot'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_accounts (customer_id, currency, ledger_version, updated_at, created_at)
    VALUES (1, 'CNY', 0, NOW(), NOW())$$,
  '23505', 'one CNY account per customer'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_transactions (
      transaction_key, customer_id, account_id, type, status, amount_fen, updated_at, created_at
    ) VALUES ('valid-credit', 1, 1, 'credit', 'posted', 10, NOW(), NOW())$$,
  '23505', 'global transaction idempotency key'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_entries (
      entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
      ledger_sequence, posted_balance_after_fen, held_balance_after_fen, updated_at, created_at
    ) VALUES ('valid-credit:credit', 1, 1, 1, 'credit', 10, 2, 20, 0, NOW(), NOW())$$,
  '23505', 'global wallet entry key'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_entries (
      entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
      ledger_sequence, posted_balance_after_fen, held_balance_after_fen, updated_at, created_at
    ) VALUES ('duplicate-sequence', 1, 1, 1, 'credit', 10, 1, 20, 0, NOW(), NOW())$$,
  '23505', 'account ledger sequence uniqueness'
);

SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_accounts (customer_id, currency, ledger_version, updated_at, created_at)
    VALUES (999, 'CNY', 0, NOW(), NOW())$$,
  '23503', 'wallet account customer foreign key'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_transactions (
      transaction_key, customer_id, account_id, type, status, amount_fen, updated_at, created_at
    ) VALUES ('bad-transaction-customer', 999, 1, 'credit', 'posted', 10, NOW(), NOW())$$,
  '23503', 'wallet transaction customer foreign key'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_transactions (
      transaction_key, customer_id, account_id, type, status, amount_fen, updated_at, created_at
    ) VALUES ('bad-transaction-account', 1, 999, 'credit', 'posted', 10, NOW(), NOW())$$,
  '23503', 'wallet transaction account foreign key'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_entries (
      entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
      ledger_sequence, posted_balance_after_fen, held_balance_after_fen, updated_at, created_at
    ) VALUES ('bad-entry-customer', 999, 1, 1, 'credit', 10, 2, 20, 0, NOW(), NOW())$$,
  '23503', 'wallet entry customer foreign key'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_entries (
      entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
      ledger_sequence, posted_balance_after_fen, held_balance_after_fen, updated_at, created_at
    ) VALUES ('bad-entry-account', 1, 999, 1, 'credit', 10, 2, 20, 0, NOW(), NOW())$$,
  '23503', 'wallet entry account foreign key'
);
SELECT pg_temp.expect_sqlstate(
  $$INSERT INTO wallet_entries (
      entry_key, customer_id, account_id, transaction_id, entry_type, amount_fen,
      ledger_sequence, posted_balance_after_fen, held_balance_after_fen, updated_at, created_at
    ) VALUES ('bad-entry-transaction', 1, 1, 999, 'credit', 10, 2, 20, 0, NOW(), NOW())$$,
  '23503', 'wallet entry transaction foreign key'
);
`

let created = false
try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  created = true
  psql(`
    CREATE TYPE public.enum_payload_jobs_workflow_slug AS ENUM(${workflowSlugs});
    CREATE TABLE public.payload_jobs (
      id serial PRIMARY KEY,
      workflow_slug public.enum_payload_jobs_workflow_slug NOT NULL
    );
    CREATE TABLE public.customers (id serial PRIMARY KEY);
  `)
  psql(upSql)
  psql(behaviorChecks)

  const schema = psql(
    `SELECT
       (to_regclass('public.wallet_accounts') IS NOT NULL)::text || ':' ||
       (to_regclass('public.wallet_transactions') IS NOT NULL)::text || ':' ||
       (to_regclass('public.wallet_entries') IS NOT NULL)::text || ':' ||
       ('walletLedgerConsistencyCheck' = ANY(
         enum_range(NULL::enum_payload_jobs_workflow_slug)::text[]
       ))::text`,
    true,
  ).trim()
  if (schema !== 'true:true:true:true') {
    throw new Error(`D9-B-1 migration up schema mismatch: ${schema}`)
  }

  psql(`INSERT INTO payload_jobs (workflow_slug) VALUES ('walletLedgerConsistencyCheck')`)
  psql(downSqlBlocks[0])
  const queuedWalletJobsAfterCleanup = psql(
    `SELECT count(*)::text FROM payload_jobs
     WHERE workflow_slug::text = 'walletLedgerConsistencyCheck'`,
    true,
  ).trim()
  if (queuedWalletJobsAfterCleanup !== '0') {
    throw new Error(
      `D9-B-1 migration down left ${queuedWalletJobsAfterCleanup} scheduled wallet jobs behind`,
    )
  }
  psql(`
    ALTER TABLE payload_jobs ALTER COLUMN workflow_slug SET DATA TYPE text;
    DROP TYPE public.enum_payload_jobs_workflow_slug;
    CREATE TYPE public.enum_payload_jobs_workflow_slug AS ENUM(${workflowSlugs});
    ALTER TABLE payload_jobs ALTER COLUMN workflow_slug
      SET DATA TYPE public.enum_payload_jobs_workflow_slug
      USING workflow_slug::public.enum_payload_jobs_workflow_slug;
  `)
  psql(downSqlBlocks[0])
  psql(downSqlBlocks[1])
  const down = psql(
    `SELECT
       (to_regclass('public.wallet_accounts') IS NULL)::text || ':' ||
       (to_regclass('public.wallet_transactions') IS NULL)::text || ':' ||
       (to_regclass('public.wallet_entries') IS NULL)::text || ':' ||
       (NOT ('walletLedgerConsistencyCheck' = ANY(
         enum_range(NULL::enum_payload_jobs_workflow_slug)::text[]
       )))::text`,
    true,
  ).trim()
  if (down !== 'true:true:true:true') {
    throw new Error(`D9-B-1 migration down schema mismatch: ${down}`)
  }

  process.stdout.write(
    'D9-B-1 wallet migration behavior verified: 26 CHECK predicates, 4 unique indexes, 6 foreign keys, and down cleanup.\n',
  )
} finally {
  if (created) postgres(['dropdb', '--force', '--username', 'wanmi', databaseName])
}
