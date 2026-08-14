import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
assert(source.includes("digestImageEnvironment('WANMI_NGINX_IMAGE', defaultNginxImage)"))
assert(source.includes("digestImageEnvironment('WANMI_WHODAT_IMAGE', defaultWhoDatImage)"))
assert(
  source.indexOf('loadRuntimeEnvironmentFiles(process.env, repositoryRoot)') <
    source.indexOf("digestImageEnvironment('WANMI_NGINX_IMAGE', defaultNginxImage)"),
)
assert(
  source.indexOf('loadRuntimeEnvironmentFiles(process.env, repositoryRoot)') <
    source.indexOf("digestImageEnvironment('WANMI_WHODAT_IMAGE', defaultWhoDatImage)"),
)
assert(source.includes('/^\\S+@sha256:[0-9a-f]{64}$/u'))
assert(source.includes("'--queue',\n          'commerce',\n          '--limit',\n          '1'"))
assert(source.includes("'--queue',\n          'background',\n          '--limit',\n          '1'"))
assert(source.includes("'node_modules/payload/bin.js'"))
assert(!source.includes("'node_modules/.bin/payload'"))
assert(source.includes("'on-failure:3'"))
assert(source.includes('waitForStableContainer(names.worker'))
assert(source.includes('loadRuntimeEnvironmentFiles(process.env, repositoryRoot)'))
assert(source.includes('...TRANSIENT_OVERRIDE_KEYS'))
assert(!source.includes('docker compose down'))
assert(source.includes("key: 'WECHATPAY_MERCHANT_PRIVATE_KEY_PATH'"))
assert(source.includes("key: 'WECHATPAY_PLATFORM_PUBLIC_KEY_PATH'"))
assert(source.includes("target: '/tmp/wanmi-wechatpay-merchant-private.pem'"))
assert(source.includes("target: '/tmp/wanmi-wechatpay-platform-public.pem'"))
assert(source.includes('type=bind,source=${source},target=${target},readonly'))
assert.equal(
  source.match(/\.\.\.runtimeFileArguments\(\)/gu)?.length,
  5,
  'Wechat Pay PEM mounts must cover migrations, Web, both Workers, and recovery',
)
assert(source.includes('(statistics.mode & 0o777) !== 0o600'))
assert(source.includes('statistics.uid !== 1001'))

const rebuildScript = fileURLToPath(new URL('./rebuild.mjs', import.meta.url))
const validationEnvironment = {
  DATABASE_URL: 'postgres://runtime-check.invalid/wanmi',
  NEXT_PUBLIC_SERVER_URL: 'https://runtime-check.invalid',
  PAYLOAD_SECRET: 'runtime-check',
  REALNAME_DOCUMENT_MASTER_KEYS: 'runtime-check',
  REALNAME_DOCUMENT_MASTER_KEY_VERSION: 'runtime-check',
  SESSION_PEPPER: 'runtime-check',
  TOTP_ENCRYPTION_KEY: 'runtime-check',
  WANMI_RUNTIME_PROFILE: 'validation',
  WHO_DAT_AUTH_KEY: 'runtime-check',
  WHO_DAT_URL: 'http://runtime-check.invalid',
}
for (const [name, value] of [
  ['WANMI_NGINX_IMAGE', 'nginx:latest'],
  ['WANMI_WHODAT_IMAGE', 'lissy93/who-dat:v2.0.0'],
]) {
  const result = spawnSync(process.execPath, [rebuildScript], {
    encoding: 'utf8',
    env: { ...process.env, ...validationEnvironment, [name]: value },
  })
  assert.equal(result.status, 11, `${name} mutable tag did not fail with environment exit code`)
  assert.match(result.stderr, new RegExp(`${name} must use repository@sha256`))
  assert(!result.stderr.includes(value), `${name} invalid value leaked to stderr`)
}

for (const name of ['WECHATPAY_MERCHANT_PRIVATE_KEY_PATH', 'WECHATPAY_PLATFORM_PUBLIC_KEY_PATH']) {
  const invalidPath = '/dev/null'
  const result = spawnSync(process.execPath, [rebuildScript], {
    encoding: 'utf8',
    env: { ...process.env, ...validationEnvironment, [name]: invalidPath },
  })
  assert.equal(result.status, 11, `${name} invalid file did not fail with environment exit code`)
  assert.match(result.stderr, new RegExp(`Runtime file missing or invalid: ${name}`))
  assert(!result.stderr.includes(invalidPath), `${name} invalid path leaked to stderr`)
}

process.stdout.write(
  'Verified fixed rebuild order, startup configuration fail-closed behavior, secure Wechat Pay PEM mounts, bounded same-image Workers, readyz fail-closed behavior, and release-policy reuse.\n',
)
