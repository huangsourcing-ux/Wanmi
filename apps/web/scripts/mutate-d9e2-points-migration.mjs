import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const files = {
  manifest: `${repositoryRoot}/deploy/release-manifest.example.json`,
  migration: `${repositoryRoot}/apps/web/migrations/20260820_000011_d9e2_points_ledger.ts`,
  policy: `${repositoryRoot}/deploy/release-policy.json`,
}
const originals = Object.fromEntries(
  Object.entries(files).map(([target, path]) => [target, readFileSync(path, 'utf8')]),
)
const mutations = []
const add = (mutation) => mutations.push(mutation)

const replaceExact = (source, search, replacement, label) => {
  const occurrences = source.split(search).length - 1
  if (occurrences !== 1) {
    throw new Error(`${label}: expected one occurrence, found ${occurrences}`)
  }
  return source.replace(search, replacement)
}

const replaceInTable = (source, table, search, replacement, label) => {
  const start = source.indexOf(`CREATE TABLE "${table}" (`)
  if (start < 0) throw new Error(`${label}: table ${table} not found`)
  const end = source.indexOf('\n  );', start)
  if (end < 0) throw new Error(`${label}: table ${table} end not found`)
  const block = source.slice(start, end)
  const changed = replaceExact(block, search, replacement, label)
  return `${source.slice(0, start)}${changed}${source.slice(end)}`
}

const addMigrationReplacement = ({ group, id, predicate, replacement, search }) =>
  add({
    group,
    id,
    predicate,
    target: 'migration',
    transform: (source) => replaceExact(source, search, replacement, id),
  })

const addTableReplacement = ({ group = 'check', id, predicate, replacement, search, table }) =>
  add({
    group,
    id,
    predicate,
    target: 'migration',
    transform: (source) => replaceInTable(source, table, search, replacement, id),
  })

for (const [field, replacement] of [
  ['phase', 'contract'],
  ['newCodeCompatibleBeforeUp', false],
  ['oldCodeCompatible', false],
  ['rollback', 'drop'],
]) {
  add({
    group: 'release',
    id: `release-policy-${field}`,
    predicate: `release policy fixes ${field}`,
    target: 'policy',
    transform: (source) => {
      const policy = JSON.parse(source)
      policy.migrations['20260820_000011_d9e2_points_ledger'][field] = replacement
      return JSON.stringify(policy, null, 2)
    },
  })
}
add({
  group: 'release',
  id: 'release-manifest-migration',
  predicate: 'release manifest contains the D9-E-2 migration exactly once',
  target: 'manifest',
  transform: (source) => {
    const manifest = JSON.parse(source)
    manifest.migrations = manifest.migrations.filter(
      (name) => name !== '20260820_000011_d9e2_points_ledger',
    )
    return JSON.stringify(manifest, null, 2)
  },
})

const enumValues = {
  enum_points_batches_source_type: ['order_reward'],
  enum_points_ledger_entry_type: [
    'pending',
    'available',
    'held',
    'consumed',
    'expired',
    'reversed',
  ],
  enum_points_redemptions_target: ['advanced_whois', 'bulk_query', 'ai_domain_analysis'],
  enum_tool_quota_ledger_entry_type: ['grant', 'consume'],
  enum_tool_quota_ledger_target: ['advanced_whois', 'bulk_query', 'ai_domain_analysis'],
}
for (const [type, values] of Object.entries(enumValues)) {
  for (const value of values) {
    const declaration = originals.migration
      .split('\n')
      .find((line) => line.includes(`CREATE TYPE "public"."${type}" AS ENUM`))
    if (!declaration) throw new Error(`enum declaration missing: ${type}`)
    addMigrationReplacement({
      group: 'enum',
      id: `${type.replace(/^enum_/u, '')}-${value.replaceAll('_', '-')}`,
      predicate: `${type} contains ${value}`,
      search: declaration,
      replacement: declaration.replace(`'${value}'`, `'mutated_${value}'`),
    })
  }
}
addMigrationReplacement({
  group: 'enum',
  id: 'workflow-points-expiration-up',
  predicate: 'up migration registers the pointsExpiration workflow',
  search:
    '  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE \'pointsExpiration\' BEFORE \'notificationDelivery\';',
  replacement:
    '  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE \'mutatedPointsExpiration\' BEFORE \'notificationDelivery\';',
})

for (const table of [
  'points_accounts',
  'points_batches',
  'points_redemptions',
  'points_ledger',
  'points_consumption_allocations',
  'tool_quota_ledger',
]) {
  add({
    group: 'required',
    id: `${table.replaceAll('_', '-')}-required-columns`,
    predicate: `${table} fact dimensions are required`,
    target: 'migration',
    transform: (source) => {
      const start = source.indexOf(`CREATE TABLE "${table}" (`)
      const end = source.indexOf('\n  );', start)
      if (start < 0 || end < 0) throw new Error(`required columns: table ${table} missing`)
      const block = source.slice(start, end)
      const changed = block.replaceAll(' NOT NULL', '')
      if (changed === block) throw new Error(`required columns: ${table} has no NOT NULL`)
      return `${source.slice(0, start)}${changed}${source.slice(end)}`
    },
  })
}

const numericChecks = [
  ['points_accounts', 'ledger_version', 0],
  ['points_accounts', 'quota_ledger_version', 0],
  ['points_batches', 'points', 1],
  ['points_redemptions', 'points_cost', 1],
  ['points_redemptions', 'quota_units', 1],
  ['points_ledger', 'points', 1],
  ['points_ledger', 'ledger_sequence', 1],
  ['points_consumption_allocations', 'points', 1],
  ['tool_quota_ledger', 'quota_units', 1],
  ['tool_quota_ledger', 'ledger_sequence', 1],
]
for (const [table, field, lower] of numericChecks) {
  const prefix = `${table.replaceAll('_', '-')}-${field.replaceAll('_', '-')}`
  addTableReplacement({
    id: `${prefix}-integer`,
    predicate: `${table}.${field} is integral`,
    table,
    search: `"${field}" = trunc("${field}")`,
    replacement: 'TRUE',
  })
  addTableReplacement({
    id: `${prefix}-lower-bound`,
    predicate: `${table}.${field} is at least ${lower}`,
    table,
    search: `"${field}" BETWEEN ${lower} AND 9007199254740991`,
    replacement: `"${field}" <= 9007199254740991`,
  })
  addTableReplacement({
    id: `${prefix}-upper-bound`,
    predicate: `${table}.${field} is at most Number.MAX_SAFE_INTEGER`,
    table,
    search: `"${field}" BETWEEN ${lower} AND 9007199254740991`,
    replacement: `"${field}" >= ${lower}`,
  })
}
addTableReplacement({
  id: 'points-batches-expiry-after-creation',
  predicate: 'a points batch expires after it is created',
  table: 'points_batches',
  search: 'CHECK ("expires_at" > "created_at")',
  replacement: 'CHECK (TRUE)',
})
addTableReplacement({
  id: 'points-ledger-nonredemption-state-link',
  predicate: 'pending, available, expired, and reversed facts have no redemption link',
  table: 'points_ledger',
  search:
    "(\"entry_type\" IN ('pending', 'available', 'expired', 'reversed') AND \"redemption_id\" IS NULL)",
  replacement: "(\"entry_type\" IN ('pending', 'available', 'expired', 'reversed'))",
})
addTableReplacement({
  id: 'points-ledger-redemption-state-link',
  predicate: 'held and consumed facts require a redemption link',
  table: 'points_ledger',
  search: '("entry_type" IN (\'held\', \'consumed\') AND "redemption_id" IS NOT NULL)',
  replacement: "(\"entry_type\" IN ('held', 'consumed'))",
})
addTableReplacement({
  id: 'tool-quota-grant-redemption-link',
  predicate: 'quota grants require their redemption link',
  table: 'tool_quota_ledger',
  search: '("entry_type" = \'grant\' AND "redemption_id" IS NOT NULL)',
  replacement: '("entry_type" = \'grant\')',
})
addTableReplacement({
  id: 'tool-quota-consume-redemption-link',
  predicate: 'quota consumption has no redemption link',
  table: 'tool_quota_ledger',
  search: '("entry_type" = \'consume\' AND "redemption_id" IS NULL)',
  replacement: '("entry_type" = \'consume\')',
})

for (const index of [
  'customer_idx',
  'points_batches_earning_key_idx',
  'points_redemptions_redemption_key_idx',
  'points_ledger_entry_key_idx',
  'account_ledgerSequence_1_idx',
  'points_consumption_allocations_allocation_key_idx',
  'redemption_batch_idx',
  'tool_quota_ledger_entry_key_idx',
  'account_ledgerSequence_2_idx',
]) {
  addMigrationReplacement({
    group: 'unique',
    id: `unique-${index.replaceAll('_', '-')}`,
    predicate: `${index} rejects duplicate facts`,
    search: `  CREATE UNIQUE INDEX "${index}"`,
    replacement: `  CREATE INDEX "${index}"`,
  })
}

const foreignKeys = originals.migration
  .split('\n')
  .filter((line) => line.includes(' ADD CONSTRAINT ') && line.includes(' FOREIGN KEY '))
if (foreignKeys.length !== 17)
  throw new Error(`expected 17 foreign keys, found ${foreignKeys.length}`)
for (const line of foreignKeys) {
  const constraint = line.match(/ADD CONSTRAINT "([^"]+)"/u)?.[1]
  if (!constraint) throw new Error(`foreign key name missing: ${line}`)
  addMigrationReplacement({
    group: 'foreign-key',
    id: `foreign-key-${constraint.replaceAll('_', '-')}`,
    predicate: `${constraint} rejects a dangling fact link`,
    search: `${line}\n`,
    replacement: '',
  })
}

addMigrationReplacement({
  group: 'down',
  id: 'down-queued-job-cleanup',
  predicate: 'down removes queued pointsExpiration jobs before shrinking the workflow enum',
  search: '   DELETE FROM "payload_jobs" WHERE "workflow_slug"::text = \'pointsExpiration\';',
  replacement: '   SELECT 1;',
})
for (const table of [
  'points_accounts',
  'points_batches',
  'points_redemptions',
  'points_ledger',
  'points_consumption_allocations',
  'tool_quota_ledger',
]) {
  const dropLine = originals.migration
    .split('\n')
    .find((line) => line.includes(`DROP TABLE "${table}" CASCADE;`))
  if (!dropLine) throw new Error(`down drop line missing: ${table}`)
  addMigrationReplacement({
    group: 'down',
    id: `down-drop-${table.replaceAll('_', '-')}`,
    predicate: `down removes ${table}`,
    search: dropLine,
    replacement: `${dropLine.match(/^\s*/u)?.[0] ?? ''}SELECT 1;`,
  })
}
for (const type of Object.keys(enumValues)) {
  addMigrationReplacement({
    group: 'down',
    id: `down-drop-${type.replaceAll('_', '-')}`,
    predicate: `down removes ${type}`,
    search: `  DROP TYPE "public"."${type}";`,
    replacement: '  SELECT 1;',
  })
}
addMigrationReplacement({
  group: 'down',
  id: 'down-exact-workflow-enum',
  predicate: 'down restores the exact workflow enum that preceded D9-E-2',
  search: "'walletLedgerConsistencyCheck', 'notificationDelivery', 'commerceFulfillment'",
  replacement:
    "'walletLedgerConsistencyCheck', 'mutatedNotificationDelivery', 'commerceFulfillment'",
})

const applyMutation = (mutation) => {
  const original = originals[mutation.target]
  const changed = mutation.transform(original)
  if (changed === original) throw new Error(`${mutation.id}: mutation made no change`)
  return changed
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(
      `${mutation.group}\t${mutation.id}\t${mutation.predicate}\t${mutation.target}\n`,
    )
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of mutations) {
    try {
      applyMutation(mutation)
    } catch (error) {
      invalid += 1
      process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    }
  }
  process.stdout.write(`VALIDATED\t${mutations.length - invalid}/${mutations.length}\n`)
  process.exit(invalid ? 1 : 0)
}

const selected = selectors.length
  ? mutations.filter(
      (mutation) => selectors.includes(mutation.group) || selectors.includes(mutation.id),
    )
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-E-2 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

const stripAnsi = (value) => value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
const runMutation = (mutation) =>
  new Promise((resolve) => {
    const env = { ...process.env }
    const changed = applyMutation(mutation)
    const envKey = {
      manifest: 'D9E2_RELEASE_MANIFEST_BASE64',
      migration: 'D9E2_MIGRATION_SOURCE_BASE64',
      policy: 'D9E2_RELEASE_POLICY_BASE64',
    }[mutation.target]
    env[envKey] = Buffer.from(changed).toString('base64')
    const child = spawn(process.execPath, ['scripts/verify-d9e2-points-migration.mjs'], {
      cwd: repositoryRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('close', (status) => {
      const clean = stripAnsi(output)
      const assertion = clean.split('\n').find((line) => line.includes('AssertionError')) ?? ''
      resolve({ assertion, clean, mutation, status })
    })
  })

let cursor = 0
let killed = 0
let failed = false
const worker = async () => {
  while (cursor < selected.length) {
    const index = cursor
    cursor += 1
    const result = await runMutation(selected[index])
    process.stdout.write(`\nMUTATION ${result.mutation.group}/${result.mutation.id}\n`)
    process.stdout.write(
      `PREDICATE ${result.mutation.predicate}\nRAW_FAILURE ${result.assertion}\n`,
    )
    if (result.status !== 0 && result.assertion) {
      killed += 1
      process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
    } else {
      failed = true
      const tail = result.clean.split('\n').slice(-12).join('\n')
      process.stderr.write(
        `${result.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${result.mutation.id}\n${tail}\n`,
      )
    }
  }
}

await Promise.all(Array.from({ length: Math.min(4, selected.length) }, () => worker()))
process.stdout.write(`\nD9E2_MIGRATION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
