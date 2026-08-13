import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { executeRebuildPlan } from './rebuild-plan.mjs'
import {
  loadRuntimeEnvironmentFiles,
  PRODUCTION_PROVIDER_KEYS,
  REAL_PROVIDER_GATE_KEYS,
  RUNTIME_MODE_KEYS,
  TRANSIENT_OVERRIDE_KEYS,
} from '../apps/web/scripts/runtime-environment-contract.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultNginxImage =
  'nginx:1.30.4-alpine-slim@sha256:ddde39c6e51f02fde7410c2e9c234cf2d0a4c7bdbbe176aeb37d8ad7ab4eb58c'
const defaultWhoDatImage =
  'lissy93/who-dat:v2.0.0@sha256:7bbfe95c6bc5aa6d7aeac033812621a30cc54d1208ab8e7bf9ce9318029e133a'

const exitCodes = {
  environment: 11,
  release: 12,
  network: 13,
  pull: 14,
  migrations: 16,
  web: 17,
  readyz: 18,
  worker: 19,
  recovery: 20,
  nginx: 21,
}

const runtimeEnvironmentKeys = [
  'ALIBABA_CLOUD_ACCESS_KEY_ID',
  'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  'ALIBABA_CLOUD_REGION_ID',
  'ALIBABA_CLOUD_SMS_DOMAIN_EXPIRY_TEMPLATE_CODE',
  'ALIBABA_CLOUD_SMS_OTP_TEMPLATE_CODE',
  'ALIBABA_CLOUD_SMS_SIGN_NAME',
  'ALIYUN_OSS_REALNAME_MODE',
  'ALIYUN_SMS_MODE',
  'ALLOW_REAL_ALIYUN_OSS_REALNAME',
  'ALLOW_REAL_ALIYUN_SMS_SENDS',
  'ALLOW_REAL_PROVIDER_WRITES',
  'ALLOW_REAL_WECHATPAY',
  'ALLOW_REAL_WECHATPAY_PAYMENTS',
  'ALLOW_REAL_WECHATPAY_REFUNDS',
  'ALLOW_REAL_WESTDIGITAL',
  'ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES',
  'ALLOW_REAL_WESTDIGITAL_READS',
  'ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES',
  'ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES',
  'ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES',
  'DATABASE_URL',
  'NEXT_PUBLIC_SERVER_URL',
  'OSS_REALNAME_BUCKET',
  'OSS_REALNAME_ENDPOINT',
  'OSS_REALNAME_PREFIX',
  'PAYLOAD_SECRET',
  'PUBLIC_STORAGE_MODE',
  'REALNAME_DOCUMENT_MASTER_KEYS',
  'REALNAME_DOCUMENT_MASTER_KEY_VERSION',
  'S3_ACCESS_KEY_ID',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_FORCE_PATH_STYLE',
  'S3_REGION',
  'S3_SECRET_ACCESS_KEY',
  'SESSION_PEPPER',
  'TOTP_ENCRYPTION_KEY',
  'WECHATPAY_API_V3_KEY',
  'WECHATPAY_APP_ID',
  'WECHATPAY_MERCHANT_CERTIFICATE_SERIAL',
  'WECHATPAY_MERCHANT_ID',
  'WECHATPAY_MERCHANT_PRIVATE_KEY_PATH',
  'WECHATPAY_MODE',
  'WECHATPAY_NOTIFY_URL',
  'WECHATPAY_PLATFORM_CERTIFICATE_SERIAL',
  'WECHATPAY_PLATFORM_PUBLIC_KEY_PATH',
  'WESTDIGITAL_API_PASSWORD',
  'WESTDIGITAL_MODE',
  'WESTDIGITAL_READ_TIMEOUT_MS',
  'WESTDIGITAL_USERNAME',
  'WESTDIGITAL_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN',
  'WESTDIGITAL_WRITE_DOMAIN_ALLOWLIST',
  'WESTDIGITAL_WRITE_MAX_REGISTER_RENEW_OPERATIONS',
  'WESTDIGITAL_WRITE_SINGLE_AMOUNT_LIMIT_FEN',
  'WHO_DAT_AUTH_KEY',
  'WHO_DAT_URL',
  'WANMI_D7_FIXTURE_DELAY_MS',
  'WANMI_D7_REBUILD_VALIDATION',
  'WANMI_RUNTIME_PROFILE',
]

for (const key of [
  ...PRODUCTION_PROVIDER_KEYS,
  ...REAL_PROVIDER_GATE_KEYS,
  ...RUNTIME_MODE_KEYS,
  ...TRANSIENT_OVERRIDE_KEYS,
]) {
  if (!runtimeEnvironmentKeys.includes(key)) runtimeEnvironmentKeys.push(key)
}

class RebuildError extends Error {
  constructor(code, message) {
    super(message)
    this.exitCode = code
  }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new RebuildError(exitCodes.environment, `Missing runtime setting: ${name}`)
  return value
}

function digestImageEnvironment(name, fallback) {
  const value = process.env[name]?.trim() || fallback
  if (!/^\S+@sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new RebuildError(exitCodes.environment, `${name} must use repository@sha256:<64 hex>`)
  }
  return value
}

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RebuildError(exitCodes.environment, `${name} must be ${minimum}..${maximum}`)
  }
  return value
}

function redactionValues(extra = []) {
  const values = runtimeEnvironmentKeys
    .filter((key) => /(SECRET|PASSWORD|KEY|PRIVATE|PEPPER|TOKEN)/u.test(key))
    .map((key) => process.env[key])
    .filter((value) => typeof value === 'string' && value.length >= 6)
  return [...new Set([...values, ...extra])].sort((left, right) => right.length - left.length)
}

function redact(value, extra = []) {
  let output = String(value ?? '')
  for (const secret of redactionValues(extra)) output = output.replaceAll(secret, '[REDACTED]')
  return output
}

process.on('uncaughtException', (error) => {
  const code = error instanceof RebuildError ? error.exitCode : 1
  process.stderr.write(`${redact(error instanceof Error ? error.message : 'Rebuild failed')}\n`)
  process.exit(code)
})

const nginxImage = digestImageEnvironment('WANMI_NGINX_IMAGE', defaultNginxImage)
const whoDatImage = digestImageEnvironment('WANMI_WHODAT_IMAGE', defaultWhoDatImage)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 50 * 1024 * 1024,
  })
  if (options.print !== false) {
    if (result.stdout) process.stdout.write(redact(result.stdout, options.extraSecrets))
    if (result.stderr) process.stderr.write(redact(result.stderr, options.extraSecrets))
  }
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status ?? 'unknown'}`
    throw new RebuildError(options.exitCode ?? 1, `${options.label ?? command} failed: ${detail}`)
  }
  return result.stdout.trim()
}

function docker(args, options = {}) {
  return run('docker', args, options)
}

function dockerExists(kind, name) {
  const result = spawnSync('docker', [kind, 'inspect', name], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  return result.status === 0
}

function runtimeEnvironmentArguments(additional = {}) {
  const args = []
  for (const key of runtimeEnvironmentKeys) {
    if (process.env[key] !== undefined) args.push('--env', key)
  }
  for (const key of Object.keys(additional)) args.push('--env', key)
  return args
}

function containerEnvironment(additional = {}) {
  return { ...process.env, ...additional }
}

function resourceArguments() {
  const cpus = process.env.WANMI_CONTAINER_CPUS ?? '2'
  const memory = process.env.WANMI_CONTAINER_MEMORY ?? '4g'
  if (!/^\d+(?:\.\d+)?$/u.test(cpus) || !/^\d+(?:\.\d+)?[kmg]$/iu.test(memory)) {
    throw new RebuildError(exitCodes.environment, 'Invalid container CPU or memory limit')
  }
  return ['--cpus', cpus, '--memory', memory]
}

function logArguments() {
  return ['--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=3']
}

function waitForContainer(name, code, label) {
  const state = docker(['inspect', '--format', '{{.State.Running}}|{{.State.ExitCode}}', name], {
    exitCode: code,
    label,
    print: false,
  })
  if (state !== 'true|0') throw new RebuildError(code, `${label} is not running: ${state}`)
}

function waitForStableContainer(name, code, label, seconds = 5) {
  const deadline = Date.now() + seconds * 1_000
  while (Date.now() < deadline) {
    const state = docker(
      [
        'inspect',
        '--format',
        '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}|{{.RestartCount}}',
        name,
      ],
      { exitCode: code, label, print: false },
    )
    if (state !== 'running|true|0|0') {
      throw new RebuildError(code, `${label} failed startup stability: ${state}`)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
}

function runtimeCommand(role, command, ...args) {
  return ['node', 'scripts/runtime-entry.mjs', role, command, ...args]
}

function waitForHttpInContainer(container, url, code, label, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1_000
  let lastFailure = 'not attempted'
  while (Date.now() < deadline) {
    const result = spawnSync(
      'docker',
      [
        'exec',
        container,
        'node',
        '--input-type=module',
        '-e',
        `const r=await fetch(${JSON.stringify(url)});const b=await r.json();if(!r.ok||b?.status!=='ready')process.exit(2)`,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
    if (result.status === 0) return
    lastFailure = redact(result.stderr || result.stdout || `exit ${result.status ?? 'unknown'}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
  }
  throw new RebuildError(code, `${label} did not become ready: ${lastFailure.trim()}`)
}

function waitForNginx(container, timeoutSeconds = 60) {
  const deadline = Date.now() + timeoutSeconds * 1_000
  let lastFailure = 'not attempted'
  while (Date.now() < deadline) {
    const result = spawnSync(
      'docker',
      ['exec', container, 'wget', '-q', '-O', '-', 'http://127.0.0.1/nginx-healthz'],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
    if (result.status === 0 && result.stdout.trim() === 'ready') return
    lastFailure = redact(result.stderr || result.stdout || `exit ${result.status ?? 'unknown'}`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  throw new RebuildError(exitCodes.nginx, `Nginx readiness check failed: ${lastFailure.trim()}`)
}

const startedAt = Date.now()
try {
  loadRuntimeEnvironmentFiles(process.env, repositoryRoot)
} catch (error) {
  process.stderr.write(
    `${redact(error instanceof Error ? error.message : 'Runtime configuration invalid')}\n`,
  )
  process.exit(exitCodes.environment)
}
const manifestPath = resolve(repositoryRoot, argument('--manifest', 'deploy/release-manifest.json'))
const policyPath = resolve(repositoryRoot, 'deploy/release-policy.json')
const deploymentId = requiredEnvironment('WANMI_DEPLOYMENT_ID')
if (!/^[a-z0-9][a-z0-9-]{2,40}$/u.test(deploymentId)) {
  throw new RebuildError(exitCodes.environment, 'WANMI_DEPLOYMENT_ID has an invalid format')
}
const network = `wanmi-${deploymentId}`
const names = {
  backgroundWorker: `${deploymentId}-background-worker`,
  migration: `${deploymentId}-migrate`,
  nginx: `${deploymentId}-nginx`,
  recovery: `${deploymentId}-recover-commerce`,
  web: `${deploymentId}-web`,
  whodat: `${deploymentId}-whodat`,
  worker: `${deploymentId}-commerce-worker`,
}
const webPort = integerEnvironment('WANMI_WEB_PORT', '3100', 1, 65_535)
const nginxPort = integerEnvironment('WANMI_NGINX_PORT', '8088', 1, 65_535)
const readyTimeout = integerEnvironment('WANMI_READYZ_TIMEOUT_SECONDS', '120', 5, 600)
const workerCron = process.env.WANMI_WORKER_CRON ?? '* * * * *'
if (!/^[\d*/?, -]{5,64}$/u.test(workerCron)) {
  throw new RebuildError(exitCodes.environment, 'WANMI_WORKER_CRON has an invalid format')
}
for (const key of [
  'DATABASE_URL',
  'NEXT_PUBLIC_SERVER_URL',
  'PAYLOAD_SECRET',
  'REALNAME_DOCUMENT_MASTER_KEYS',
  'REALNAME_DOCUMENT_MASTER_KEY_VERSION',
  'SESSION_PEPPER',
  'TOTP_ENCRYPTION_KEY',
  'WHO_DAT_AUTH_KEY',
]) {
  requiredEnvironment(key)
}
if (!existsSync(manifestPath)) {
  throw new RebuildError(exitCodes.release, `Release manifest does not exist: ${manifestPath}`)
}
const nginxConfiguration = resolve(requiredEnvironment('WANMI_NGINX_CONFIG_PATH'))
if (!existsSync(nginxConfiguration)) {
  throw new RebuildError(exitCodes.environment, 'WANMI_NGINX_CONFIG_PATH does not exist')
}
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  throw new RebuildError(exitCodes.release, 'Release manifest is not valid JSON')
}
const image = manifest.image
const recoveryBefore = new Date().toISOString()

function assertContainerNamesAvailable() {
  for (const name of Object.values(names)) {
    if (dockerExists('container', name)) {
      throw new RebuildError(exitCodes.environment, `Container already exists: ${name}`)
    }
  }
}

try {
  await executeRebuildPlan({
    'prepare-environment-and-network': async () => {
      process.stdout.write('[1/8] Preparing runtime environment and isolated network.\n')
      assertContainerNamesAvailable()
      if (!dockerExists('network', network)) {
        docker(['network', 'create', network], {
          exitCode: exitCodes.network,
          label: 'Docker network creation',
          print: false,
        })
      }
    },
    'pull-digest-image': async () => {
      process.stdout.write('[2/8] Verifying release policy and pulling digest-pinned images.\n')
      run(
        process.execPath,
        ['scripts/verify-release-contract.mjs', '--manifest', manifestPath, '--policy', policyPath],
        { exitCode: exitCodes.release, label: 'Release contract verification' },
      )
      if (Date.now() < Date.parse(manifest.applicationPromotionNotBefore)) {
        throw new RebuildError(exitCodes.release, 'Release promotion time has not been reached')
      }
      docker(['pull', '--platform', 'linux/amd64', image], {
        exitCode: exitCodes.pull,
        label: 'Application image pull',
      })
      const platform = docker(
        ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image],
        { exitCode: exitCodes.pull, label: 'Application image platform check', print: false },
      )
      if (platform !== 'linux/amd64') {
        throw new RebuildError(exitCodes.pull, `Application image platform is ${platform}`)
      }
      docker(['pull', '--platform', 'linux/amd64', whoDatImage], {
        exitCode: exitCodes.pull,
        label: 'Who-Dat image pull',
        print: false,
      })
      docker(['pull', '--platform', 'linux/amd64', nginxImage], {
        exitCode: exitCodes.pull,
        label: 'Nginx image pull',
        print: false,
      })
      docker(
        [
          'run',
          '--detach',
          '--platform',
          'linux/amd64',
          '--name',
          names.whodat,
          '--network',
          network,
          '--network-alias',
          'wanmi-whodat',
          '--restart',
          'unless-stopped',
          ...resourceArguments(),
          ...logArguments(),
          '--env',
          'AUTH_KEY',
          '--env',
          'CACHE_TTL_SECONDS=3600',
          '--env',
          'ENABLE_CACHE=true',
          whoDatImage,
        ],
        {
          env: containerEnvironment({ AUTH_KEY: process.env.WHO_DAT_AUTH_KEY }),
          exitCode: exitCodes.pull,
          label: 'Who-Dat start',
          print: false,
        },
      )
      waitForContainer(names.whodat, exitCodes.pull, 'Who-Dat')
    },
    'run-payload-migrations': async () => {
      process.stdout.write('[3/8] Running Payload migrations and migration status.\n')
      const base = [
        'run',
        '--rm',
        '--platform',
        'linux/amd64',
        '--name',
        names.migration,
        '--network',
        network,
        ...resourceArguments(),
        ...runtimeEnvironmentArguments(),
        image,
        ...runtimeCommand('maintenance', 'node', 'node_modules/payload/bin.js'),
      ]
      docker([...base, 'migrate'], {
        exitCode: exitCodes.migrations,
        label: 'Payload migrate',
      })
      docker([...base, 'migrate:status'], {
        exitCode: exitCodes.migrations,
        label: 'Payload migrate status',
      })
    },
    'start-web': async () => {
      process.stdout.write('[4/8] Starting Web from the verified digest.\n')
      docker(
        [
          'run',
          '--detach',
          '--platform',
          'linux/amd64',
          '--name',
          names.web,
          '--network',
          network,
          '--network-alias',
          'wanmi-web',
          '--publish',
          `127.0.0.1:${webPort}:3000`,
          '--restart',
          'on-failure:3',
          ...resourceArguments(),
          ...logArguments(),
          '--env',
          'HOSTNAME=0.0.0.0',
          ...runtimeEnvironmentArguments(),
          image,
          ...runtimeCommand('web', 'node', 'server.js'),
        ],
        { exitCode: exitCodes.web, label: 'Web start', print: false },
      )
      waitForContainer(names.web, exitCodes.web, 'Web')
      waitForStableContainer(names.web, exitCodes.web, 'Web')
    },
    'verify-readyz': async () => {
      process.stdout.write('[5/8] Waiting for database-backed readyz.\n')
      waitForHttpInContainer(
        names.web,
        'http://127.0.0.1:3000/readyz',
        exitCodes.readyz,
        'Web readyz',
        readyTimeout,
      )
    },
    'start-commerce-worker': async () => {
      process.stdout.write('[6/8] Starting isolated commerce and background Workers.\n')
      docker(
        [
          'run',
          '--detach',
          '--platform',
          'linux/amd64',
          '--name',
          names.worker,
          '--network',
          network,
          '--restart',
          'on-failure:3',
          ...resourceArguments(),
          ...logArguments(),
          ...runtimeEnvironmentArguments(),
          image,
          ...runtimeCommand('commerce-worker', 'node', 'node_modules/payload/bin.js', 'jobs:run'),
          '--cron',
          workerCron,
          '--queue',
          'commerce',
          '--limit',
          '1',
          '--handle-schedules',
        ],
        { exitCode: exitCodes.worker, label: 'Commerce Worker start', print: false },
      )
      waitForContainer(names.worker, exitCodes.worker, 'Commerce Worker')
      waitForStableContainer(names.worker, exitCodes.worker, 'Commerce Worker')
      docker(
        [
          'run',
          '--detach',
          '--platform',
          'linux/amd64',
          '--name',
          names.backgroundWorker,
          '--network',
          network,
          '--restart',
          'on-failure:3',
          ...resourceArguments(),
          ...logArguments(),
          ...runtimeEnvironmentArguments(),
          image,
          ...runtimeCommand('background-worker', 'node', 'node_modules/payload/bin.js', 'jobs:run'),
          '--cron',
          workerCron,
          '--queue',
          'background',
          '--limit',
          '1',
          '--handle-schedules',
        ],
        { exitCode: exitCodes.worker, label: 'Background Worker start', print: false },
      )
      waitForContainer(names.backgroundWorker, exitCodes.worker, 'Background Worker')
      waitForStableContainer(names.backgroundWorker, exitCodes.worker, 'Background Worker')
      const webImage = docker(['inspect', '--format', '{{.Config.Image}}', names.web], {
        exitCode: exitCodes.worker,
        label: 'Web image inspection',
        print: false,
      })
      const workerImage = docker(['inspect', '--format', '{{.Config.Image}}', names.worker], {
        exitCode: exitCodes.worker,
        label: 'Worker image inspection',
        print: false,
      })
      const backgroundWorkerImage = docker(
        ['inspect', '--format', '{{.Config.Image}}', names.backgroundWorker],
        { exitCode: exitCodes.worker, label: 'Background Worker image inspection', print: false },
      )
      if (
        webImage !== image ||
        workerImage !== image ||
        backgroundWorkerImage !== image ||
        webImage !== workerImage ||
        webImage !== backgroundWorkerImage
      ) {
        throw new RebuildError(exitCodes.worker, 'Web and Workers do not use the same digest')
      }
    },
    'recover-unfinished-commerce-jobs': async () => {
      process.stdout.write('[7/8] Querying and atomically releasing interrupted commerce Jobs.\n')
      const additional = {
        WANMI_COMMERCE_RECOVERY_ACK: 'D7-07-RECOVER-INTERRUPTED',
        WANMI_COMMERCE_RECOVERY_BEFORE: recoveryBefore,
      }
      docker(
        [
          'run',
          '--rm',
          '--platform',
          'linux/amd64',
          '--name',
          names.recovery,
          '--network',
          network,
          ...resourceArguments(),
          ...runtimeEnvironmentArguments(additional),
          image,
          ...runtimeCommand(
            'maintenance',
            'node',
            'node_modules/payload/bin.js',
            'run',
            'scripts/recover-commerce-jobs.ts',
          ),
        ],
        {
          env: containerEnvironment(additional),
          exitCode: exitCodes.recovery,
          label: 'Commerce Job recovery',
        },
      )
      waitForContainer(names.worker, exitCodes.recovery, 'Commerce Worker after recovery')
      waitForContainer(
        names.backgroundWorker,
        exitCodes.recovery,
        'Background Worker after recovery',
      )
    },
    'start-nginx': async () => {
      process.stdout.write('[8/8] Validating and starting Nginx.\n')
      const configuration = realpathSync(nginxConfiguration)
      const mount = `${configuration}:/etc/nginx/conf.d/default.conf:ro`
      docker(
        [
          'run',
          '--rm',
          '--platform',
          'linux/amd64',
          '--network',
          network,
          '--volume',
          mount,
          nginxImage,
          'nginx',
          '-t',
        ],
        {
          exitCode: exitCodes.nginx,
          label: 'Nginx configuration test',
        },
      )
      docker(
        [
          'run',
          '--detach',
          '--platform',
          'linux/amd64',
          '--name',
          names.nginx,
          '--network',
          network,
          '--publish',
          `127.0.0.1:${nginxPort}:80`,
          '--restart',
          'unless-stopped',
          ...resourceArguments(),
          ...logArguments(),
          '--volume',
          mount,
          nginxImage,
        ],
        { exitCode: exitCodes.nginx, label: 'Nginx start', print: false },
      )
      waitForContainer(names.nginx, exitCodes.nginx, 'Nginx')
      waitForNginx(names.nginx)
    },
  })
  process.stdout.write(
    `${JSON.stringify({
      containers: names,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
      image,
      network,
      status: 'ready',
    })}\n`,
  )
} catch (error) {
  const failure =
    error instanceof RebuildError
      ? error
      : new RebuildError(1, error instanceof Error ? error.message : 'Rebuild failed')
  process.stderr.write(`${redact(failure.message)}\n`)
  process.exitCode = failure.exitCode
}
