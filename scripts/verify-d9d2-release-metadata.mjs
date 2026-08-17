import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const result = spawnSync(process.execPath, ['scripts/verify-release-contract.mjs'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: process.env,
})

assert.equal(
  result.status,
  0,
  `D9-D-2 release metadata must satisfy the release contract:\n${result.stdout}${result.stderr}`,
)

process.stdout.write('Verified D9-D-2 release policy and manifest metadata.\n')
