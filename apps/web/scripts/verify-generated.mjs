import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

const cwd = new URL('..', import.meta.url)
const generated = [
  new URL('../src/payload-types.ts', import.meta.url),
  new URL('../src/app/(payload)/admin/importMap.js', import.meta.url),
]
const before = generated.map((file) => readFileSync(file, 'utf8'))
const migrationDir = new URL('../migrations/', import.meta.url)
const migrationsBefore = readdirSync(migrationDir).sort()
const d604Snapshot = JSON.parse(
  readFileSync(
    new URL('../migrations/20260809_013335_d6_domain_assets_nameservers_reminders.json', import.meta.url),
    'utf8',
  ),
)
const d605SnapshotUrl = new URL(
  '../migrations/20260809_053302_d6_active_renewals.json',
  import.meta.url,
)
const d605SnapshotText = readFileSync(d605SnapshotUrl, 'utf8')
const d605Snapshot = JSON.parse(d605SnapshotText)
const missingD604Tables = Object.keys(d604Snapshot.tables).filter(
  (tableName) => d605Snapshot.tables[tableName] === undefined,
)
if (missingD604Tables.length) {
  console.error(
    `D6-05 migration snapshot dropped D6-04 tables: ${missingD604Tables.join(', ')}`,
  )
  process.exit(1)
}
const requiredSnapshotTables = [
  'domain_expiry_reminders',
  'provider_operations',
  'renewals',
  'domain_assets',
]
const snapshotTableMentionCounts = Object.fromEntries(
  requiredSnapshotTables.map((tableName) => [
    tableName,
    d605SnapshotText.split(`"${tableName}"`).length - 1,
  ]),
)
const missingRequiredTables = requiredSnapshotTables.filter(
  (tableName) => d605Snapshot.tables[`public.${tableName}`] === undefined,
)
if (missingRequiredTables.length) {
  console.error(
    `D6-05 migration snapshot is missing required tables: ${missingRequiredTables.join(', ')}`,
  )
  process.exit(1)
}
console.log(
  `Verified D6-05 cumulative migration snapshot table mentions: ${requiredSnapshotTables
    .map((tableName) => `${tableName}=${snapshotTableMentionCounts[tableName]}`)
    .join(', ')}`,
)

for (const command of [
  ['pnpm', ['generate:types']],
  ['pnpm', ['generate:importmap']],
  ['pnpm', ['migrate:create', 'verify_schema_drift', '--skip-empty']],
]) {
  const result = spawnSync(command[0], command[1], { cwd, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const changed = generated.filter((file, index) => readFileSync(file, 'utf8') !== before[index])
const migrationsAfter = readdirSync(migrationDir).sort()
const migrationDrift = migrationsAfter.filter((file) => !migrationsBefore.includes(file))

if (changed.length || migrationDrift.length) {
  const stale = [
    ...changed.map((file) => file.pathname),
    ...migrationDrift.map((file) => new URL(file, migrationDir).pathname),
  ]
  console.error(`Generated files or migrations were stale: ${stale.join(', ')}`)
  process.exit(1)
}
