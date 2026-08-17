import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const repositoryRoot = process.cwd()
const acknowledgement = 'D7-07-LOCAL-ONLY'
const dindImage =
  'docker:29.1.5-dind@sha256:3a33fc81fa4d38360f490f5b900e9846f725db45bb1d9b1fe02d849bd42a5cf2'
const registryImage =
  'registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e'
const postgresImage =
  'postgres:16.14-bookworm@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55'
const gitleaksImage =
  'ghcr.io/gitleaks/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9'
const runId = `d707-${Date.now()}-${process.pid}`
if (!/^d707-[0-9]+-[0-9]+$/u.test(runId)) throw new Error('Unsafe local validation id')

const names = {
  backgroundWorker: `${runId}-background-worker`,
  dindSource: `${runId}-dind-source`,
  dindTarget: `${runId}-dind-target`,
  imageExport: `${runId}-image-export`,
  logProbe: `${runId}-log-probe`,
  nginx: `${runId}-nginx`,
  postgres: `${runId}-postgres`,
  registry: `${runId}-registry`,
  web: `${runId}-web`,
  whodat: `${runId}-whodat`,
  worker: `${runId}-commerce-worker`,
}
const network = `wanmi-${runId}`
const temporaryPrefix = join(realpathSync(tmpdir()), 'wanmi-d7-07-')
const temporaryRoot = mkdtempSync(temporaryPrefix)
const cleanupContainers = new Set(Object.values(names))
const cleanupNetworks = new Set([network])
const cleanupImages = new Set()
let dockerClientEnvironment = process.env
let finalReport

function redact(value, secrets = []) {
  let output = String(value ?? '')
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length >= 6) output = output.replaceAll(secret, '[REDACTED]')
  }
  return output
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? 'utf8',
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? 100 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe',
  })
  if (result.error || result.status !== 0) {
    const output = options.inherit
      ? ''
      : redact(`${result.stdout ?? ''}${result.stderr ?? ''}`, options.secrets)
    throw new Error(
      `${options.label ?? command} failed (${result.status ?? 'unknown'}): ${output.slice(-4_000)}`,
    )
  }
  return options.inherit ? '' : String(result.stdout ?? '').trim()
}

function runAsync(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (code !== 0) {
        rejectPromise(
          new Error(
            `${options.label ?? command} failed (${code}): ${redact(`${out}${err}`, options.secrets).slice(-4_000)}`,
          ),
        )
        return
      }
      resolvePromise(out.trim())
    })
  })
}

function docker(args, options = {}) {
  return run('docker', args, {
    ...options,
    env: options.env ?? dockerClientEnvironment,
  })
}

function dockerAsync(args, options = {}) {
  return runAsync('docker', args, {
    ...options,
    env: options.env ?? dockerClientEnvironment,
  })
}

function hostDocker(args, options = {}) {
  return run('docker', args, { ...options, env: process.env })
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function hostMappedPort(container, port) {
  const value = hostDocker(['port', container, `${port}/tcp`], {
    label: `${container} port`,
  })
  const matches = [...value.matchAll(/:(\d+)$/gmu)]
  const ports = [...new Set(matches.map((match) => Number(match[1])))]
  if (ports.length !== 1) throw new Error(`Missing unique mapped port for ${container}:${port}`)
  return ports[0]
}

function waitForRegistry(port) {
  let lastState = ''
  for (let attempt = 0; attempt < 60; attempt += 1) {
    lastState = hostDocker(
      [
        'inspect',
        '--format',
        '{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}',
        names.registry,
      ],
      { label: 'Local registry state' },
    )
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const r=await fetch('http://127.0.0.1:${port}/v2/');if(!r.ok)process.exit(2)`,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
    if (lastState.startsWith('running|0|') && result.status === 0) return
    sleep(1_000)
  }
  throw new Error(`Local registry did not become ready; last state: ${lastState}`)
}

function startDind(name) {
  hostDocker(
    [
      'run',
      '--detach',
      '--privileged',
      '--name',
      name,
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--add-host',
      'host.docker.internal:host-gateway',
      '--publish',
      '127.0.0.1::2375',
      '--volume',
      `${repositoryRoot}:${repositoryRoot}:ro`,
      '--volume',
      `${temporaryRoot}:${temporaryRoot}`,
      '--env',
      'DOCKER_TLS_CERTDIR=',
      dindImage,
      '--insecure-registry=0.0.0.0/0',
    ],
    { label: `${name} start` },
  )
  const port = hostMappedPort(name, 2375)
  const environment = { ...process.env, DOCKER_HOST: `tcp://127.0.0.1:${port}` }
  let lastState = ''
  for (let attempt = 0; attempt < 120; attempt += 1) {
    lastState = hostDocker(['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', name], {
      label: `${name} state`,
    })
    const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: environment,
    })
    if (lastState === 'running|0' && result.status === 0 && result.stdout.trim()) {
      return environment
    }
    sleep(1_000)
  }
  throw new Error(`${name} did not become ready; last state: ${lastState}`)
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = spawnSync(
      'docker',
      ['exec', names.postgres, 'pg_isready', '-U', 'wanmi', '-d', 'wanmi'],
      { env: dockerClientEnvironment },
    )
    if (result.status === 0) return
    sleep(1_000)
  }
  throw new Error('Local PostgreSQL did not become ready')
}

function sql(statement) {
  return docker(
    ['exec', names.postgres, 'psql', '-U', 'wanmi', '-d', 'wanmi', '-At', '-c', statement],
    { label: 'PostgreSQL probe' },
  )
}

function waitForSql(statement, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let value = ''
  while (Date.now() < deadline) {
    value = sql(statement)
    if (predicate(value)) return value
    sleep(500)
  }
  throw new Error(`${label} timed out; last value: ${value}`)
}

function waitReady(container, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = spawnSync(
      'docker',
      [
        'exec',
        container,
        'node',
        '--input-type=module',
        '-e',
        "const r=await fetch('http://127.0.0.1:3000/readyz');const b=await r.json();if(!r.ok||b?.status!=='ready')process.exit(2)",
      ],
      { env: dockerClientEnvironment },
    )
    if (result.status === 0) return
    sleep(1_000)
  }
  throw new Error(`${container} readyz timed out`)
}

function parseMarker(output, marker) {
  const line = output
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(`${marker} `))
  if (!line) throw new Error(`Missing ${marker} output`)
  return JSON.parse(line.slice(marker.length + 1))
}

function environmentArguments(environment) {
  return Object.keys(environment).flatMap((key) => ['--env', key])
}

function parseMebibytes(value) {
  const match = value.trim().match(/^([0-9.]+)([KMG]iB)$/u)
  if (!match) throw new Error(`Unknown Docker memory unit: ${value}`)
  const amount = Number(match[1])
  return match[2] === 'GiB' ? amount * 1_024 : match[2] === 'KiB' ? amount / 1_024 : amount
}

function sampleMemory(containers, sampleCount = 8) {
  const samples = []
  for (let index = 0; index < sampleCount; index += 1) {
    const output = docker(
      ['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}', ...Object.values(containers)],
      { label: 'Docker memory sample' },
    )
    const sample = {}
    for (const line of output.split('\n')) {
      const [container, usage] = line.split('|')
      const current = usage?.split('/')[0]
      const label = Object.entries(containers).find(([, name]) => name === container)?.[0]
      if (label && current) sample[label] = parseMebibytes(current)
    }
    if (Object.keys(sample).length !== Object.keys(containers).length) {
      throw new Error(`Incomplete Docker memory sample: ${JSON.stringify(sample)}`)
    }
    samples.push(sample)
    sleep(1_000)
  }
  const result = {}
  for (const label of Object.keys(containers)) {
    const values = samples.map((sample) => sample[label])
    const steadyValues = values.slice(-3)
    result[label] = {
      peakMiB: Math.round(Math.max(...values) * 10) / 10,
      steadyMiB:
        Math.round(
          (steadyValues.reduce((sum, value) => sum + value, 0) / steadyValues.length) * 10,
        ) / 10,
    }
  }
  return result
}

function validateResourceLimits(containers) {
  for (const [label, name] of Object.entries(containers)) {
    const value = docker(
      ['inspect', '--format', '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}', name],
      { label: `${label} resource inspection` },
    )
    if (value !== '2000000000|4294967296') {
      throw new Error(`${label} limits differ from --cpus=2 --memory=4g: ${value}`)
    }
  }
}

function verifySecrets(image, runtimeEnvironment, rebuildOutput) {
  const masterKeys = runtimeEnvironment.REALNAME_DOCUMENT_MASTER_KEYS.split(',')
    .map((entry) => entry.slice(entry.indexOf(':') + 1))
    .filter(Boolean)
  const secrets = [
    runtimeEnvironment.PAYLOAD_SECRET,
    runtimeEnvironment.SESSION_PEPPER,
    runtimeEnvironment.TOTP_ENCRYPTION_KEY,
    runtimeEnvironment.REALNAME_DOCUMENT_MASTER_KEYS,
    runtimeEnvironment.WHO_DAT_AUTH_KEY,
    ...masterKeys,
  ]
  const imageMetadata = `${docker(['image', 'inspect', image])}\n${docker([
    'history',
    '--no-trunc',
    image,
  ])}`
  const runtimeLogs = [names.web, names.worker, names.whodat, names.nginx]
    .map((name) => docker(['logs', name], { label: `${name} logs` }))
    .join('\n')
  for (const secret of secrets) {
    if (
      imageMetadata.includes(secret) ||
      runtimeLogs.includes(secret) ||
      rebuildOutput.includes(secret)
    ) {
      throw new Error('A runtime secret appeared in image metadata or logs')
    }
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|AKID[A-Z0-9]{12,}/u.test(runtimeLogs)) {
    throw new Error('A secret-shaped value appeared in runtime logs')
  }

  docker(['create', '--name', names.imageExport, image], { label: 'Image export container' })
  const archive = join(temporaryRoot, 'rootfs.tar')
  const rootfs = join(temporaryRoot, 'rootfs')
  mkdirSync(rootfs)
  docker(['export', '--output', archive, names.imageExport], { label: 'Image rootfs export' })
  run('tar', ['-xf', archive, '-C', rootfs], { label: 'Image rootfs extraction' })
  for (const secret of secrets) {
    const result = spawnSync('rg', ['-a', '-F', '--', secret, join(rootfs, 'app')], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    if (result.status === 0) throw new Error('A runtime secret appeared in the final image rootfs')
    if (result.status !== 1)
      throw new Error('Unable to scan final image rootfs for runtime secrets')
  }
  const imageArchive = join(temporaryRoot, 'image.tar')
  const imageLayers = join(temporaryRoot, 'image-layers')
  mkdirSync(imageLayers)
  docker(['save', '--output', imageArchive, image], { label: 'OCI image archive export' })
  run('tar', ['-xf', imageArchive, '-C', imageLayers], { label: 'OCI image archive extraction' })
  const savedManifest = JSON.parse(readFileSync(join(imageLayers, 'manifest.json'), 'utf8'))[0]
  if (!Array.isArray(savedManifest?.Layers) || savedManifest.Layers.length === 0) {
    throw new Error('OCI image archive did not expose any layers')
  }
  const applicationLayerRoots = []
  savedManifest.Layers.forEach((relativeLayer, index) => {
    const layerRoot = join(imageLayers, `unpacked-${index}`)
    mkdirSync(layerRoot)
    run('tar', ['-xf', join(imageLayers, relativeLayer), '-C', layerRoot], {
      label: `OCI image layer ${index} extraction`,
    })
    const applicationRoot = join(layerRoot, 'app')
    if (existsSync(applicationRoot)) applicationLayerRoots.push(applicationRoot)
  })
  for (const secret of secrets) {
    const result = spawnSync('rg', ['-a', '-F', '--', secret, imageLayers], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    if (result.status === 0) throw new Error('A runtime secret appeared in an OCI image layer')
    if (result.status !== 1) throw new Error('Unable to scan OCI image layers for runtime secrets')
  }
  if (applicationLayerRoots.length === 0) {
    throw new Error('OCI image layers did not contain the application root')
  }
  docker(
    [
      'run',
      '--rm',
      ...applicationLayerRoots.flatMap((applicationRoot, index) => [
        '--volume',
        `${applicationRoot}:/application-layers/layer-${index}:ro`,
      ]),
      '--volume',
      `${resolve(repositoryRoot, '.gitleaks.toml')}:/config/.gitleaks.toml:ro`,
      gitleaksImage,
      'detect',
      '--no-banner',
      '--no-git',
      '--redact',
      '--config=/config/.gitleaks.toml',
      '--source=/application-layers',
    ],
    { label: 'All image layers secret-shape scan' },
  )
}

function verifyLogRotation(image) {
  const lines = 50_000
  docker(
    [
      'run',
      '--detach',
      '--platform',
      'linux/amd64',
      '--name',
      names.logProbe,
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--log-driver',
      'local',
      '--log-opt',
      'max-size=1m',
      '--log-opt',
      'max-file=2',
      image,
      'node',
      '-e',
      `for(let i=0;i<${lines};i++)console.log('D707_LOG_'+String(i).padStart(6,'0')+'_'+'.'.repeat(180))`,
    ],
    { label: 'Log rotation write probe' },
  )
  docker(['wait', names.logProbe], { label: 'Log rotation probe completion' })
  const config = JSON.parse(docker(['inspect', names.logProbe]))[0].HostConfig.LogConfig
  if (
    config.Type !== 'local' ||
    config.Config['max-size'] !== '1m' ||
    config.Config['max-file'] !== '2'
  ) {
    throw new Error(`Unexpected log rotation config: ${JSON.stringify(config)}`)
  }
  const retained = docker(['logs', names.logProbe], {
    label: 'Rotated log readback',
    maxBuffer: 10 * 1024 * 1024,
  })
  const retainedBytes = Buffer.byteLength(retained)
  if (retained.includes('D707_LOG_000000_')) throw new Error('Oldest log segment was not removed')
  if (!retained.includes(`D707_LOG_${String(lines - 1).padStart(6, '0')}_`)) {
    throw new Error('Newest log segment was not retained')
  }
  if (retainedBytes > 2.5 * 1024 * 1024) {
    throw new Error(`Retained logs exceed bounded rotation size: ${retainedBytes}`)
  }
  return { retainedBytes, writtenBytesLowerBound: lines * 190 }
}

function cleanup() {
  for (const name of cleanupContainers) {
    if (!name.startsWith(runId)) throw new Error(`Refusing to remove unexpected container: ${name}`)
    spawnSync('docker', ['rm', '--force', '--volumes', name], { stdio: 'ignore' })
  }
  for (const name of cleanupNetworks) {
    if (name !== network) throw new Error(`Refusing to remove unexpected network: ${name}`)
    spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' })
  }
  for (const image of cleanupImages) {
    if (!image.startsWith(`wanmi-d707-build:${runId}`)) {
      throw new Error(`Refusing to remove unexpected image: ${image}`)
    }
    spawnSync('docker', ['image', 'rm', image], { stdio: 'ignore' })
  }
  const resolvedTemporaryRoot = realpathSync(temporaryRoot)
  if (!resolvedTemporaryRoot.startsWith(temporaryPrefix) || !resolvedTemporaryRoot.includes(sep)) {
    throw new Error(`Refusing to remove unexpected temporary directory: ${resolvedTemporaryRoot}`)
  }
  rmSync(resolvedTemporaryRoot, { recursive: true })
}

try {
  process.stdout.write(
    'Preparing local-only registry, isolated Docker daemons, PostgreSQL, and linux/amd64 image.\n',
  )
  hostDocker(['pull', registryImage], { label: 'Local registry image pull', inherit: true })
  hostDocker(['pull', dindImage], { label: 'Docker-in-Docker image pull', inherit: true })
  hostDocker(['pull', '--platform', 'linux/amd64', postgresImage], {
    label: 'PostgreSQL image pull',
    inherit: true,
  })
  const postgresRuntimeImage = hostDocker(
    ['image', 'inspect', '--platform', 'linux/amd64', '--format', '{{.Id}}', postgresImage],
    { label: 'PostgreSQL source image inspection' },
  )
  if (!/^sha256:[0-9a-f]{64}$/u.test(postgresRuntimeImage)) {
    throw new Error('PostgreSQL source image did not expose an image ID')
  }
  const mutableBuildReference = `wanmi-d707-build:${runId}`
  cleanupImages.add(mutableBuildReference)
  hostDocker(
    [
      'build',
      '--platform',
      'linux/amd64',
      '--file',
      'apps/web/Dockerfile',
      '--tag',
      mutableBuildReference,
      '.',
    ],
    { label: 'linux/amd64 application image build', inherit: true },
  )
  hostDocker(
    [
      'run',
      '--detach',
      '--name',
      names.registry,
      '--publish',
      '::5000',
      '--restart',
      'unless-stopped',
      '--env',
      'OTEL_TRACES_EXPORTER=none',
      registryImage,
    ],
    { label: 'Local registry start' },
  )
  const registryPort = hostMappedPort(names.registry, 5000)
  waitForRegistry(registryPort)

  dockerClientEnvironment = startDind(names.dindSource)
  const buildArchive = join(temporaryRoot, 'build-image.tar')
  hostDocker(['save', '--output', buildArchive, mutableBuildReference], {
    label: 'Application image transfer export',
  })
  docker(['load', '--input', buildArchive], { label: 'Application image source-daemon load' })
  const registryRepository = `host.docker.internal:${registryPort}/wanmi-web`
  const registryTag = `${registryRepository}:d7-07`
  docker(['tag', mutableBuildReference, registryTag], { label: 'Local registry image tag' })
  docker(['push', registryTag], { label: 'Local registry image push', inherit: true })
  const digestReference = JSON.parse(docker(['image', 'inspect', registryTag]))[0].RepoDigests.find(
    (value) => value.startsWith(`${registryRepository}@sha256:`),
  )
  if (!digestReference) throw new Error('Local registry did not return an immutable digest')
  const sourceState = hostDocker(
    ['inspect', '--format', '{{.Name}}|{{.State.Status}}', names.dindSource],
    { label: 'Source Docker daemon cleanup validation' },
  )
  if (sourceState !== `/${names.dindSource}|running`) {
    throw new Error(`Source Docker daemon has an unexpected state: ${sourceState}`)
  }
  hostDocker(['rm', '--force', '--volumes', names.dindSource], {
    label: 'Source Docker daemon cleanup',
  })

  dockerClientEnvironment = startDind(names.dindTarget)
  const targetNodeLimits = hostDocker(
    ['inspect', '--format', '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}', names.dindTarget],
    { label: 'Target node resource inspection' },
  )
  if (targetNodeLimits !== '2000000000|4294967296') {
    throw new Error(`Target node limits differ from --cpus=2 --memory=4g: ${targetNodeLimits}`)
  }
  const postgresArchive = join(temporaryRoot, 'postgres-image.tar')
  hostDocker(['save', '--platform', 'linux/amd64', '--output', postgresArchive, postgresImage], {
    label: 'PostgreSQL fixture transfer export',
  })
  docker(['load', '--input', postgresArchive], { label: 'PostgreSQL fixture target-node load' })
  const postgresPlatform = docker(
    ['image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', postgresRuntimeImage],
    { label: 'PostgreSQL fixture platform check' },
  )
  if (postgresPlatform !== 'linux/amd64') {
    throw new Error(`PostgreSQL fixture platform is ${postgresPlatform}`)
  }
  docker(['network', 'create', network], { label: 'Local validation network' })
  docker(
    [
      'run',
      '--detach',
      '--platform',
      'linux/amd64',
      '--name',
      names.postgres,
      '--network',
      network,
      '--network-alias',
      'd7-postgres',
      '--env',
      'POSTGRES_DB=wanmi',
      '--env',
      'POSTGRES_USER=wanmi',
      '--env',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      postgresRuntimeImage,
    ],
    { label: 'Local PostgreSQL start' },
  )
  waitForPostgres()

  const example = JSON.parse(readFileSync('deploy/release-manifest.example.json', 'utf8'))
  const staticHash = createHash('sha256').update(digestReference).digest('hex')
  const manifestPath = join(temporaryRoot, 'release-manifest.json')
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...example,
        applicationPromotionNotBefore: new Date(Date.now() - 1_000).toISOString(),
        image: digestReference,
        releaseId: `d707-${Date.now()}`,
        staticAssets: {
          immutablePrefix: `_next/static/d707-${Date.now()}/`,
          manifestSha256: staticHash,
          uploadedAt: new Date(Date.now() - 3_000).toISOString(),
          verifiedAt: new Date(Date.now() - 2_000).toISOString(),
        },
      },
      null,
      2,
    )}\n`,
  )
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.staticAssets.immutablePrefix = `_next/static/${manifest.releaseId}/`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const payloadSecret = `d707-payload-${randomBytes(24).toString('hex')}`
  const sessionPepper = `d707-session-${randomBytes(24).toString('hex')}`
  const totpKey = randomBytes(32).toString('base64')
  const masterKey = randomBytes(32).toString('base64')
  const whoDatAuth = `d707-whodat-${randomBytes(24).toString('hex')}`
  const runtimeVariables = {
    ALIYUN_OSS_REALNAME_MODE: 'mock',
    ALIYUN_SMS_MODE: 'mock',
    ALLOW_REAL_ALIYUN_OSS_REALNAME: 'false',
    ALLOW_REAL_ALIYUN_SMS_SENDS: 'false',
    ALLOW_REAL_PROVIDER_WRITES: 'false',
    ALLOW_REAL_WECHATPAY: 'false',
    ALLOW_REAL_WECHATPAY_PAYMENTS: 'false',
    ALLOW_REAL_WECHATPAY_REFUNDS: 'false',
    ALLOW_REAL_WESTDIGITAL: 'false',
    ALLOW_REAL_WESTDIGITAL_DNS_WRITES: 'false',
    ALLOW_REAL_WESTDIGITAL_DOMAIN_MANAGEMENT_WRITES: 'false',
    ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES: 'false',
    ALLOW_REAL_WESTDIGITAL_READS: 'false',
    ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES: 'false',
    ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES: 'false',
    ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES: 'false',
    DATABASE_URL: 'postgresql://wanmi@d7-postgres:5432/wanmi',
    NEXT_PUBLIC_SERVER_URL: 'http://127.0.0.1:3100',
    PAYLOAD_SECRET: payloadSecret,
    PUBLIC_STORAGE_MODE: 'local',
    REALNAME_DOCUMENT_MASTER_KEYS: `d707-v1:${masterKey}`,
    REALNAME_DOCUMENT_MASTER_KEY_VERSION: 'd707-v1',
    SESSION_PEPPER: sessionPepper,
    TOTP_ENCRYPTION_KEY: totpKey,
    WANMI_CONTAINER_CPUS: '2',
    WANMI_CONTAINER_MEMORY: '4g',
    WANMI_D7_FIXTURE_DELAY_MS: '60000',
    WANMI_D7_REBUILD_VALIDATION: acknowledgement,
    WANMI_DEPLOYMENT_ID: runId,
    WANMI_NGINX_CONFIG_PATH: resolve('deploy/nginx/wanmi-rebuild-local.conf'),
    WANMI_NGINX_PORT: String(20_000 + (process.pid % 10_000)),
    WANMI_READYZ_TIMEOUT_SECONDS: '180',
    WANMI_RUNTIME_PROFILE: 'validation',
    WANMI_WEB_PORT: String(30_000 + (process.pid % 10_000)),
    WANMI_WORKER_CRON: '*/2 * * * * *',
    WECHATPAY_MODE: 'fixture',
    WESTDIGITAL_MODE: 'fixture',
    WESTDIGITAL_READ_TIMEOUT_MS: '90000',
    WESTDIGITAL_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN: '0',
    WESTDIGITAL_WRITE_DOMAIN_ALLOWLIST: '',
    WESTDIGITAL_WRITE_MAX_REGISTER_RENEW_OPERATIONS: '0',
    WESTDIGITAL_WRITE_SINGLE_AMOUNT_LIMIT_FEN: '0',
    WHO_DAT_AUTH_KEY: whoDatAuth,
    WHO_DAT_URL: 'http://wanmi-whodat:8080',
  }
  const runtimeEnvironment = { ...dockerClientEnvironment, ...runtimeVariables }
  const secrets = [payloadSecret, sessionPepper, totpKey, masterKey, whoDatAuth]

  const rebuildStartedAt = performance.now()
  const rebuild = spawnSync(process.execPath, ['scripts/rebuild.mjs', '--manifest', manifestPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: runtimeEnvironment,
    maxBuffer: 100 * 1024 * 1024,
  })
  const rebuildOutput = `${rebuild.stdout ?? ''}${rebuild.stderr ?? ''}`
  if (rebuild.status !== 0) {
    throw new Error(`Rebuild failed (${rebuild.status}): ${redact(rebuildOutput, secrets)}`)
  }
  const rebuildSeconds = Math.round((performance.now() - rebuildStartedAt) / 100) / 10
  if (rebuildSeconds >= 7_200)
    throw new Error(`Local rebuild exceeded the 2 hour RTO: ${rebuildSeconds}s`)
  const rebuildResult = JSON.parse(
    rebuild.stdout
      .trim()
      .split('\n')
      .reverse()
      .find((line) => line.startsWith('{') && line.includes('"status":"ready"')),
  )
  if (rebuildResult.image !== digestReference) throw new Error('Rebuild used a different image')

  const measuredContainers = {
    backgroundWorker: names.backgroundWorker,
    web: names.web,
    whodat: names.whodat,
    worker: names.worker,
  }
  validateResourceLimits(measuredContainers)
  const webImage = docker(['inspect', '--format', '{{.Config.Image}}', names.web])
  const workerImage = docker(['inspect', '--format', '{{.Config.Image}}', names.worker])
  const backgroundWorkerImage = docker([
    'inspect',
    '--format',
    '{{.Config.Image}}',
    names.backgroundWorker,
  ])
  if (
    webImage !== digestReference ||
    workerImage !== digestReference ||
    backgroundWorkerImage !== digestReference ||
    webImage !== workerImage ||
    webImage !== backgroundWorkerImage
  ) {
    throw new Error('Web and Worker image references differ')
  }
  for (const name of [names.web, names.worker, names.backgroundWorker]) {
    const state = docker([
      'inspect',
      '--format',
      '{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}|{{.HostConfig.RestartPolicy.Name}}|{{.HostConfig.RestartPolicy.MaximumRetryCount}}',
      name,
    ])
    if (state !== 'running|0|0|on-failure|3') {
      throw new Error(`Runtime process did not remain stable with bounded restart: ${state}`)
    }
  }
  verifySecrets(digestReference, runtimeEnvironment, rebuildOutput)

  const probeVariables = {
    ...runtimeVariables,
    WANMI_D7_REBUILD_VALIDATION: acknowledgement,
  }
  const probeEnvironment = { ...dockerClientEnvironment, ...probeVariables }
  const probeOutput = docker(
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--network',
      network,
      '--cpus',
      '2',
      '--memory',
      '4g',
      ...environmentArguments(probeVariables),
      digestReference,
      'node',
      'scripts/runtime-entry.mjs',
      'maintenance',
      'node',
      'node_modules/payload/bin.js',
      'run',
      'scripts/d7-07-rebuild-probe.ts',
    ],
    { env: probeEnvironment, label: 'Interrupted commerce fixture seed', secrets },
  )
  const probe = parseMarker(probeOutput, 'D7_PROBE_RESULT')
  const orderId = Number(probe.orderId)
  const jobId = Number(probe.jobId)
  if (!Number.isSafeInteger(orderId) || !Number.isSafeInteger(jobId)) {
    throw new Error('Probe returned invalid identifiers')
  }
  waitForSql(
    `SELECT status || '|' || attempt_count FROM provider_operations WHERE order_id = ${orderId} AND operation = 'register'`,
    (value) => value === 'submitted|1',
    'Provider write submission window',
  )
  waitForSql(
    `SELECT processing::text FROM payload_jobs WHERE id = ${jobId}`,
    (value) => value === 'true',
    'Job processing state',
  )

  const workerIdBeforeWebRestart = docker(['inspect', '--format', '{{.Id}}', names.worker])
  docker(['restart', names.web], { label: 'Independent Web restart' })
  waitReady(names.web)
  const workerAfterWebRestart = docker(
    ['inspect', '--format', '{{.Id}}|{{.State.Running}}', names.worker],
    { label: 'Worker state after Web restart' },
  )
  if (workerAfterWebRestart !== `${workerIdBeforeWebRestart}|true`) {
    throw new Error('Web restart changed or stopped the Worker')
  }
  if (sql(`SELECT processing::text FROM payload_jobs WHERE id = ${jobId}`) !== 'true') {
    throw new Error('Web restart interrupted the Worker Job')
  }

  const memory = sampleMemory(measuredContainers)
  const aggregatePeakMiB = Object.values(memory).reduce((sum, item) => sum + item.peakMiB, 0)
  const aggregateSteadyMiB = Object.values(memory).reduce((sum, item) => sum + item.steadyMiB, 0)
  if (aggregatePeakMiB >= 4_096 || aggregateSteadyMiB >= 4_096) {
    throw new Error(`Measured service memory leaves no 4 GiB headroom: ${aggregatePeakMiB} MiB`)
  }

  docker(['update', '--restart=no', names.worker], { label: 'Disable local auto-restart' })
  docker(['kill', '--signal', 'KILL', names.worker], { label: 'Forced Worker interruption' })
  waitReady(names.web)
  const interrupted = sql(
    `SELECT processing::text || '|' || COALESCE(completed_at::text, '') FROM payload_jobs WHERE id = ${jobId}`,
  )
  if (interrupted !== 'true|')
    throw new Error(`Job was not interrupted in processing: ${interrupted}`)

  const recoveryBefore = new Date().toISOString()
  docker(['start', names.worker], { label: 'Independent Worker restart' })
  const recoveryVariables = {
    ...runtimeVariables,
    WANMI_COMMERCE_RECOVERY_ACK: 'D7-07-RECOVER-INTERRUPTED',
    WANMI_COMMERCE_RECOVERY_BEFORE: recoveryBefore,
  }
  const recoveryEnvironment = { ...dockerClientEnvironment, ...recoveryVariables }
  const recoveryCommand = [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--network',
    network,
    '--cpus',
    '2',
    '--memory',
    '4g',
    ...environmentArguments(recoveryVariables),
    digestReference,
    'node',
    'scripts/runtime-entry.mjs',
    'maintenance',
    'node',
    'node_modules/payload/bin.js',
    'run',
    'scripts/recover-commerce-jobs.ts',
  ]
  const recoveryOutputs = await Promise.all([
    dockerAsync(recoveryCommand, {
      env: recoveryEnvironment,
      label: 'Recovery contender A',
      secrets,
    }),
    dockerAsync(recoveryCommand, {
      env: recoveryEnvironment,
      label: 'Recovery contender B',
      secrets,
    }),
  ])
  const recoveries = recoveryOutputs.map((output) => parseMarker(output, 'D7_RECOVERY_RESULT'))
  if (recoveries.reduce((sum, item) => sum + item.recoveredCount, 0) !== 1) {
    throw new Error(`Interrupted Job was not recovered exactly once: ${JSON.stringify(recoveries)}`)
  }

  waitForSql(
    `SELECT COALESCE(completed_at::text, '') || '|' || processing::text FROM payload_jobs WHERE id = ${jobId}`,
    (value) => value.startsWith('202') && value.endsWith('|false'),
    'Recovered Job completion',
    90_000,
  )
  if (sql(`SELECT status FROM orders WHERE id = ${orderId}`) !== 'succeeded') {
    throw new Error('Recovered registration order did not succeed')
  }
  const operationEvidence = sql(
    `SELECT COUNT(*) || '|' || MIN(attempt_count) || '|' || MAX(attempt_count) || '|' || MIN(status) FROM provider_operations WHERE order_id = ${orderId} AND operation IN ('register', 'renew', 'refund')`,
  )
  if (operationEvidence !== '1|1|1|succeeded') {
    throw new Error(`Provider operation was duplicated: ${operationEvidence}`)
  }
  const claimAudits = sql(
    `SELECT COUNT(*) FROM audit_logs WHERE target_id IN (SELECT id::text FROM provider_operations WHERE order_id = ${orderId}) AND metadata->>'outcome' = 'write_claimed'`,
  )
  if (claimAudits !== '1') throw new Error(`Provider write was claimed ${claimAudits} times`)
  if (sql(`SELECT COUNT(*) FROM renewals WHERE order_id = ${orderId}`) !== '0') {
    throw new Error('Unexpected renewal was created during registration recovery')
  }
  if (sql(`SELECT COUNT(*) FROM refunds WHERE order_id = ${orderId}`) !== '0') {
    throw new Error('Unexpected refund was created during registration recovery')
  }

  const logRotation = verifyLogRotation(digestReference)
  const headroomPeakMiB = Math.round((4_096 - aggregatePeakMiB) * 10) / 10
  const headroomSteadyMiB = Math.round((4_096 - aggregateSteadyMiB) * 10) / 10
  finalReport = {
    architecture: 'linux/amd64',
    commerceInterruption: {
      providerClaimAudits: Number(claimAudits),
      providerOperationEvidence: operationEvidence,
      recoveryContenders: recoveries.map(({ recoveredCount }) => recoveredCount),
      result: 'recovered exactly once',
    },
    image: digestReference,
    independentRestarts: { webKeptWorkerJobRunning: true, workerKeptWebReady: true },
    limits: {
      cpusPerContainer: 2,
      memoryPerContainerGiB: 4,
      targetNodeCpus: 2,
      targetNodeMemoryGiB: 4,
    },
    logRotation,
    memory: {
      aggregatePeakMiB: Math.round(aggregatePeakMiB * 10) / 10,
      aggregateSteadyMiB: Math.round(aggregateSteadyMiB * 10) / 10,
      headroomPeakMiB,
      headroomSteadyMiB,
      services: memory,
    },
    rebuild: { rtoSeconds: 7_200, seconds: rebuildSeconds },
    secretChecks: {
      applicationLayerShapes: 'passed',
      finalImageRootfs: 'passed',
      imageLayerSentinels: 'passed',
      imageMetadata: 'passed',
      runtimeLogs: 'passed',
    },
    status: 'container-limited-equivalent-passed',
  }
  process.stdout.write(`D7_LOCAL_VALIDATION_RESULT ${JSON.stringify(finalReport, null, 2)}\n`)
} finally {
  cleanup()
}
