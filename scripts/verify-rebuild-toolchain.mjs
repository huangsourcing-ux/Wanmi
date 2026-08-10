import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { executeRebuildPlan, REBUILD_STEP_NAMES } from './rebuild-plan.mjs'

const calls = []
await executeRebuildPlan(
  Object.fromEntries(REBUILD_STEP_NAMES.map((name) => [name, async () => calls.push(name)])),
)
assert.deepEqual(calls, REBUILD_STEP_NAMES, 'rebuild order changed')

const failedReadyCalls = []
const readyFailure = new Error('mutant readyz failure')
await assert.rejects(
  executeRebuildPlan(
    Object.fromEntries(
      REBUILD_STEP_NAMES.map((name) => [
        name,
        async () => {
          failedReadyCalls.push(name)
          if (name === 'verify-readyz') throw readyFailure
        },
      ]),
    ),
  ),
  readyFailure,
)
assert.deepEqual(failedReadyCalls, REBUILD_STEP_NAMES.slice(0, 5))
assert(!failedReadyCalls.includes('start-commerce-worker'), 'Worker started after readyz failed')

const source = readFileSync(new URL('./rebuild.mjs', import.meta.url), 'utf8')
assert(source.includes('scripts/verify-release-contract.mjs'))
assert(source.includes("resolve(repositoryRoot, 'deploy/release-policy.json')"))
assert(source.includes("'{{.Config.Image}}'"))
assert(source.includes("'--queue',\n          'commerce',\n          '--limit',\n          '1'"))
assert(!source.includes('docker compose down'))

process.stdout.write(
  'Verified fixed rebuild order, readyz fail-closed behavior, release-policy reuse, and same-image commerce Worker configuration.\n',
)
