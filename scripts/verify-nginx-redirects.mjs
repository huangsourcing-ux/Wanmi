import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const image =
  'nginx:1.30.4-alpine-slim@sha256:ddde39c6e51f02fde7410c2e9c234cf2d0a4c7bdbbe176aeb37d8ad7ab4eb58c'
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..')
const configurationPath = join(repositoryRoot, 'deploy/nginx/wanmi-host-redirects.conf')
const temporaryRoot = mkdtempSync(join(realpathSync(tmpdir()), 'wanmi-nginx-redirects-'))
const certificateDirectory = join(temporaryRoot, 'tls')
const containerName = `wanmi-nginx-redirects-${process.pid}-${Date.now()}`
let started = false

const docker = (args, options = {}) => {
  const output = execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  })
  return typeof output === 'string' ? output.trim() : ''
}

const mappedPort = (containerPort) => {
  const mapping = docker(['port', containerName, `${containerPort}/tcp`])
    .split('\n')
    .find((line) => line.startsWith('127.0.0.1:'))
  const port = Number(mapping?.slice(mapping.lastIndexOf(':') + 1))
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`Unable to resolve mapped port for ${containerPort}/tcp: ${mapping}`)
  }
  return port
}

const verifyRedirect = ({ host, port, secure }) =>
  new Promise((resolveRequest, rejectRequest) => {
    const request = (secure ? httpsRequest : httpRequest)(
      {
        headers: { host },
        host: '127.0.0.1',
        method: 'GET',
        path: '/articles/legacy?q=wanmi.net&utm_source=alias',
        port,
        rejectUnauthorized: false,
        servername: secure ? host : undefined,
      },
      (response) => {
        response.resume()
        const expected = 'https://wanmi.net/articles/legacy?q=wanmi.net&utm_source=alias'
        if (response.statusCode !== 301 || response.headers.location !== expected) {
          rejectRequest(
            new Error(
              `${secure ? 'HTTPS' : 'HTTP'} ${host} returned ${response.statusCode} ${response.headers.location ?? ''}`,
            ),
          )
          return
        }
        resolveRequest()
      },
    )
    request.on('error', rejectRequest)
    request.end()
  })

const wait = (milliseconds) =>
  new Promise((resolveWait) => {
    setTimeout(resolveWait, milliseconds)
  })

const verifyRedirectWhenReady = async (options) => {
  let lastError
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    try {
      await verifyRedirect(options)
      return
    } catch (error) {
      lastError = error
      if (attempt < 50) await wait(100)
    }
  }
  throw lastError
}

try {
  mkdirSync(certificateDirectory)
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=wanmi.ai',
      '-addext',
      'subjectAltName=DNS:wanmi.ai,DNS:www.wanmi.ai,DNS:www.wanmi.net',
      '-keyout',
      join(certificateDirectory, 'privkey.pem'),
      '-out',
      join(certificateDirectory, 'fullchain.pem'),
    ],
    { stdio: 'ignore' },
  )

  const mounts = [
    '--volume',
    `${configurationPath}:/etc/nginx/conf.d/default.conf:ro`,
    '--volume',
    `${certificateDirectory}:/etc/nginx/tls/wanmi:ro`,
  ]
  docker(['run', '--rm', ...mounts, image, 'nginx', '-t'], { stdio: 'inherit' })
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--publish',
    '127.0.0.1::80',
    '--publish',
    '127.0.0.1::443',
    ...mounts,
    image,
  ])
  started = true

  const httpPort = mappedPort(80)
  const httpsPort = mappedPort(443)
  for (const host of ['wanmi.net', 'wanmi.ai', 'www.wanmi.ai', 'www.wanmi.net']) {
    await verifyRedirectWhenReady({ host, port: httpPort, secure: false })
  }
  for (const host of ['wanmi.ai', 'www.wanmi.ai', 'www.wanmi.net']) {
    await verifyRedirectWhenReady({ host, port: httpsPort, secure: true })
  }
  process.stdout.write('Verified Nginx syntax and 7 canonical host redirect cases.\n')
} finally {
  if (started) {
    docker(['rm', '--force', '--volumes', containerName], { stdio: 'ignore' })
  }
  const resolvedTemporaryRoot = realpathSync(temporaryRoot)
  const expectedPrefix = `${realpathSync(tmpdir())}${sep}wanmi-nginx-redirects-`
  if (!resolvedTemporaryRoot.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to remove unexpected temporary directory: ${resolvedTemporaryRoot}`)
  }
  rmSync(resolvedTemporaryRoot, { recursive: true })
}
