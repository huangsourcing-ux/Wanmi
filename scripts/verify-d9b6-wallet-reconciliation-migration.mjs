import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL('../apps/web/migrations/20260819_104757_d9b6_wallet_reconciliation.ts', import.meta.url),
)
const databaseName = `wanmi_d9b6_wallet_reconciliation_${process.pid}_${Date.now()}`
assert.match(databaseName, /^wanmi_d9b6_wallet_reconciliation_[0-9]+_[0-9]+$/u)

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
assert.ok(upSql, 'D9-B-6 migration UP SQL must be extractable')
assert.ok(downSql, 'D9-B-6 migration DOWN SQL must be extractable')
assert.ok(!upSql.includes('${'), 'D9-B-6 migration UP SQL must not interpolate values')
assert.ok(!downSql.includes('${'), 'D9-B-6 migration DOWN SQL must not interpolate values')

const postgres = (args) =>
  execFileSync('docker', ['compose', 'exec', '-T', 'postgres', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
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
CREATE TYPE enum_reconciliations_kind AS ENUM('wechat', 'westdigital', 'three_way');
CREATE TYPE enum_reconciliations_ledger AS ENUM(
  'wechat_funds', 'westdigital_prepaid', 'internal_orders'
);
CREATE TABLE wallet_accounts (id serial PRIMARY KEY);
CREATE TABLE wallet_entries (
  id serial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES wallet_accounts(id),
  entry_type varchar NOT NULL,
  amount_fen numeric NOT NULL
);
CREATE TABLE reconciliations (
  id serial PRIMARY KEY,
  kind enum_reconciliations_kind NOT NULL,
  ledger enum_reconciliations_ledger NOT NULL
);
CREATE TABLE manual_reviews (id serial PRIMARY KEY);

INSERT INTO wallet_accounts (id) VALUES (1), (2), (3), (4), (5);
INSERT INTO wallet_entries (account_id, entry_type, amount_fen) VALUES
  (1, 'credit', 100),
  (2, 'hold', 30),
  (2, 'capture', 20),
  (3, 'recovery', 25),
  (4, 'hold', 40),
  (4, 'release', 15);
`

try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  psql(baseSchema)
  psql(upSql)

  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_reconciliations_kind), ',');`),
    'wechat,westdigital,three_way,wallet',
    'wallet must be the fourth reconciliation kind',
  )
  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_reconciliations_ledger), ',');`),
    'wechat_funds,westdigital_prepaid,internal_orders,wallet_balance',
    'wallet_balance must be the fourth ledger',
  )
  assert.equal(
    scalar(`SELECT id || ':' || posted_balance_cache_fen || ':' || held_balance_cache_fen
      FROM wallet_accounts ORDER BY id;`),
    '1:100:0\n2:-20:10\n3:-25:0\n4:0:25\n5:0:0',
    'cache snapshots must be backfilled only from append-only wallet entries',
  )
  psql(`INSERT INTO wallet_accounts (id) VALUES (6);`)
  assert.equal(
    scalar(`SELECT posted_balance_cache_fen || ':' || held_balance_cache_fen
      FROM wallet_accounts WHERE id = 6;`),
    '0:0',
    'new cache snapshots must start at zero',
  )

  rejectsWrite(
    `UPDATE wallet_accounts SET posted_balance_cache_fen = 1.5 WHERE id = 1;`,
    'posted cache integer fen',
  )
  rejectsWrite(
    `UPDATE wallet_accounts SET posted_balance_cache_fen = 9007199254740992 WHERE id = 1;`,
    'posted cache safe upper bound',
  )
  rejectsWrite(
    `UPDATE wallet_accounts SET posted_balance_cache_fen = -9007199254740992 WHERE id = 1;`,
    'posted cache safe lower bound',
  )
  rejectsWrite(
    `UPDATE wallet_accounts SET held_balance_cache_fen = 1.5 WHERE id = 1;`,
    'held cache integer fen',
  )
  rejectsWrite(
    `UPDATE wallet_accounts SET held_balance_cache_fen = -1 WHERE id = 1;`,
    'held cache nonnegative',
  )
  rejectsWrite(
    `UPDATE wallet_accounts SET held_balance_cache_fen = 9007199254740992 WHERE id = 1;`,
    'held cache safe upper bound',
  )

  const reconciliationId = scalar(`INSERT INTO reconciliations (kind, ledger)
    VALUES ('wallet', 'wallet_balance') RETURNING id;`).split('\n')[0]
  psql(`INSERT INTO manual_reviews (wallet_account_id, reconciliation_id)
    VALUES (1, ${reconciliationId});`)
  rejectsWrite(
    `INSERT INTO manual_reviews (reconciliation_id) VALUES (${reconciliationId});`,
    'one manual review per reconciliation difference',
  )
  rejectsWrite(
    `INSERT INTO manual_reviews (wallet_account_id) VALUES (999999);`,
    'manual review wallet account foreign key',
  )
  rejectsWrite(
    `INSERT INTO manual_reviews (reconciliation_id) VALUES (999999);`,
    'manual review reconciliation foreign key',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM pg_indexes
      WHERE indexname = 'manual_reviews_wallet_account_idx';`),
    '1',
    'wallet-linked reviews must remain indexed',
  )

  const unsafeDown = psqlFailure(downSql)
  assert.notEqual(unsafeDown.status, 0, 'down migration must refuse wallet reconciliation facts')
  assert.match(
    `${unsafeDown.stderr}${unsafeDown.stdout}`,
    /invalid input value for enum/u,
    'down migration must fail while fourth-ledger facts exist',
  )
  psql(`DELETE FROM manual_reviews; DELETE FROM reconciliations;`)
  psql(downSql)
  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_reconciliations_kind), ',');`),
    'wechat,westdigital,three_way',
    'clean down must restore the prior reconciliation kinds',
  )
  assert.equal(
    scalar(`SELECT array_to_string(enum_range(NULL::enum_reconciliations_ledger), ',');`),
    'wechat_funds,westdigital_prepaid,internal_orders',
    'clean down must restore the prior ledgers',
  )
  assert.equal(
    scalar(`SELECT COUNT(*) FROM information_schema.columns
      WHERE table_name IN ('wallet_accounts', 'manual_reviews')
      AND column_name IN (
        'posted_balance_cache_fen', 'held_balance_cache_fen',
        'wallet_account_id', 'reconciliation_id'
      );`),
    '0',
    'clean down must remove only the D9-B-6 columns',
  )

  process.stdout.write('D9-B-6 wallet reconciliation migration verification passed\n')
} finally {
  postgres(['dropdb', '--if-exists', '--username', 'wanmi', databaseName])
}
