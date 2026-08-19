import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const result = spawnSync('node', ['scripts/verify-release-contract.mjs'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  env: process.env,
})
assert.equal(
  result.status,
  0,
  `D9-B-4 release metadata rejected by the release contract:\n${result.stdout}${result.stderr}`,
)
process.stdout.write(result.stdout)
