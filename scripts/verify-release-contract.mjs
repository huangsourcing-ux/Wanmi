import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const migrationDirectory = join(repositoryRoot, 'apps/web/migrations')

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const manifestPath = resolve(
  repositoryRoot,
  argument('--manifest', 'deploy/release-manifest.example.json'),
)
const policyPath = resolve(repositoryRoot, argument('--policy', 'deploy/release-policy.json'))

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const exactKeys = (value, keys, label) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} keys must be ${expected.join(', ')}`,
  )
}

const assertDigestReference = (value, label) => {
  assert(
    typeof value === 'string' && /^\S+@sha256:[0-9a-f]{64}$/u.test(value),
    `${label} must use an immutable repository@sha256:<64 hex> reference; mutable tags are forbidden`,
  )
}

const assertSha256 = (value, label) => {
  assert(
    typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value),
    `${label} must be a lowercase SHA-256 digest`,
  )
}

const timestamp = (value, label) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  assert(
    Number.isFinite(parsed) && new Date(parsed).toISOString() === value,
    `${label} must be ISO UTC`,
  )
  return parsed
}

const migrationNames = readdirSync(migrationDirectory)
  .filter((name) => /^\d{8}_\d{6}_[a-z0-9_]+\.ts$/u.test(name))
  .map((name) => name.slice(0, -3))
  .sort()

const policy = readJson(policyPath)
exactKeys(policy, ['migrationBaseline', 'migrations', 'rules', 'schemaVersion'], 'release policy')
assert(policy.schemaVersion === 1, 'release policy schemaVersion must be 1')
exactKeys(
  policy.rules,
  [
    'allowExpandAndContractInSameRelease',
    'allowRenameColumn',
    'contractRollback',
    'expandRollback',
  ],
  'release policy rules',
)
assert(
  policy.rules.allowExpandAndContractInSameRelease === false,
  'expand and contract must stay in separate releases',
)
assert(
  policy.rules.allowRenameColumn === false,
  'column rename must use add/backfill/contract releases',
)
assert(
  policy.rules.expandRollback === 'retain',
  'expand migrations must remain applied during code rollback',
)
assert(
  policy.rules.contractRollback === 'down',
  'contract migrations must be reversed before code rollback',
)

const baselineIndex = migrationNames.indexOf(policy.migrationBaseline)
assert(baselineIndex !== -1, `migration baseline not found: ${policy.migrationBaseline}`)
const releaseMigrations = migrationNames.slice(baselineIndex + 1)
const policyMigrationNames = Object.keys(policy.migrations).sort()
assert(
  JSON.stringify(policyMigrationNames) === JSON.stringify(releaseMigrations),
  `migration policy entries must exactly match migrations after baseline: ${releaseMigrations.join(', ') || '(none)'}`,
)

const phases = new Set()
for (const migrationName of releaseMigrations) {
  const entry = policy.migrations[migrationName]
  exactKeys(
    entry,
    ['newCodeCompatibleBeforeUp', 'oldCodeCompatible', 'phase', 'reason', 'rollback'],
    `migration policy ${migrationName}`,
  )
  assert(['contract', 'data', 'expand'].includes(entry.phase), `${migrationName} has invalid phase`)
  assert(
    typeof entry.reason === 'string' && entry.reason.trim().length >= 20,
    `${migrationName} needs a specific compatibility reason`,
  )
  phases.add(entry.phase)

  const source = readFileSync(join(migrationDirectory, `${migrationName}.ts`), 'utf8')
  const up = source.split(/export\s+async\s+function\s+down/u)[0]
  const addsSchema = /\b(?:ADD\s+COLUMN|CREATE\s+TABLE|CREATE\s+TYPE)\b/iu.test(up)
  const dropsSchema =
    /\b(?:DROP\s+COLUMN|DROP\s+TABLE|DROP\s+TYPE|ALTER\s+COLUMN[\s\S]{0,120}?SET\s+NOT\s+NULL|ALTER\s+COLUMN[\s\S]{0,120}?TYPE)\b/iu.test(
      up,
    )
  const renamesColumn = /\bRENAME\s+COLUMN\b/iu.test(up)
  assert(!renamesColumn, `${migrationName} renames a column; use add, backfill/use, then contract`)
  assert(
    !(addsSchema && dropsSchema),
    `${migrationName} both adds and removes schema in one release`,
  )

  if (entry.phase === 'expand') {
    assert(!dropsSchema, `${migrationName} is expand but removes schema`)
    assert(
      entry.rollback === 'retain',
      `${migrationName} expand rollback must retain the migration`,
    )
    assert(entry.oldCodeCompatible === true, `${migrationName} expand must keep old code runnable`)
    assert(
      entry.newCodeCompatibleBeforeUp === true,
      `${migrationName} expand must be deployed before code starts depending on it`,
    )
  } else if (entry.phase === 'contract') {
    assert(!addsSchema, `${migrationName} is contract but adds schema`)
    assert(entry.rollback === 'down', `${migrationName} contract rollback must run down first`)
    assert(
      entry.oldCodeCompatible === false,
      `${migrationName} contract must declare old code incompatible`,
    )
    assert(
      entry.newCodeCompatibleBeforeUp === true,
      `${migrationName} contract requires code that already stopped using removed schema`,
    )
  } else {
    assert(!addsSchema && !dropsSchema, `${migrationName} is data-only but changes schema`)
    assert(['down', 'retain'].includes(entry.rollback), `${migrationName} data rollback is invalid`)
    assert(
      entry.oldCodeCompatible === true,
      `${migrationName} data migration must keep old code runnable`,
    )
  }
}
assert(
  !(phases.has('expand') && phases.has('contract')),
  'the same release cannot add new schema and remove old schema; use add, use, then cleanup releases',
)

const manifest = readJson(manifestPath)
exactKeys(
  manifest,
  [
    'applicationPromotionNotBefore',
    'image',
    'migrations',
    'releaseId',
    'rollback',
    'schemaVersion',
    'staticAssets',
  ],
  'release manifest',
)
assert(manifest.schemaVersion === 1, 'release manifest schemaVersion must be 1')
assert(
  typeof manifest.releaseId === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/u.test(manifest.releaseId),
  'releaseId must be a stable lowercase identifier',
)
assertDigestReference(manifest.image, 'release image')
exactKeys(
  manifest.staticAssets,
  ['immutablePrefix', 'manifestSha256', 'uploadedAt', 'verifiedAt'],
  'staticAssets',
)
assert(
  manifest.staticAssets.immutablePrefix === `_next/static/${manifest.releaseId}/`,
  'static assets must use a release-scoped immutable _next/static prefix',
)
assertSha256(manifest.staticAssets.manifestSha256, 'static asset manifest')
const uploadedAt = timestamp(manifest.staticAssets.uploadedAt, 'staticAssets.uploadedAt')
const verifiedAt = timestamp(manifest.staticAssets.verifiedAt, 'staticAssets.verifiedAt')
const promotionAt = timestamp(
  manifest.applicationPromotionNotBefore,
  'applicationPromotionNotBefore',
)
assert(uploadedAt <= verifiedAt, 'static asset verification cannot precede upload')
assert(
  verifiedAt < promotionAt,
  'static assets must be uploaded and verified before application promotion',
)
assert(
  JSON.stringify(manifest.migrations) === JSON.stringify(releaseMigrations),
  'release manifest migrations must exactly match the compatibility policy',
)

exactKeys(manifest.rollback, ['database', 'image', 'staticAssets'], 'rollback')
assertDigestReference(manifest.rollback.image, 'rollback image')
exactKeys(
  manifest.rollback.staticAssets,
  ['immutablePrefix', 'manifestSha256'],
  'rollback staticAssets',
)
assert(
  /^_next\/static\/[a-z0-9][a-z0-9-]{2,63}\/$/u.test(
    manifest.rollback.staticAssets.immutablePrefix,
  ),
  'rollback static assets must retain a previous immutable release prefix',
)
assertSha256(manifest.rollback.staticAssets.manifestSha256, 'rollback static asset manifest')
const requiresDown = releaseMigrations.some(
  (migrationName) => policy.migrations[migrationName].rollback === 'down',
)
assert(
  manifest.rollback.database === (requiresDown ? 'down' : 'retain'),
  `rollback.database must be ${requiresDown ? 'down' : 'retain'} for this migration set`,
)

process.stdout.write(
  `Verified release contract: assets before promotion, digest-pinned current/rollback images, and ${releaseMigrations.length} migration policies.\n`,
)
