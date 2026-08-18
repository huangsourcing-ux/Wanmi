import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(`${repositoryRoot}/package.json`, 'utf8'))

assert.match(
  packageJson.scripts['verify:migrations'],
  /node scripts\/verify-d9c2-automatic-renewal-migration\.mjs/u,
  'the unified migration gate must execute the D9-C-2 behavior verifier',
)
assert.match(
  packageJson.scripts['verify:release'],
  /node scripts\/verify-d9c2-release-metadata\.mjs/u,
  'the unified release gate must execute the D9-C-2 metadata verifier',
)

const result = spawnSync(process.execPath, ['scripts/verify-release-contract.mjs'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: process.env,
})

assert.equal(
  result.status,
  0,
  `D9-C-2 release metadata must satisfy the release contract:\n${result.stdout}${result.stderr}`,
)

process.stdout.write('Verified D9-C-2 gate wiring, release policy, and manifest metadata.\n')
