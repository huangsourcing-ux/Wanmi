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
