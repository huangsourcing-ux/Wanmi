import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createTcpServer, connect, Socket, type NetConnectOpts } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { NodeTlsProvider, type NodeTlsConfig } from '@/providers/node-tls'

type CapturedConnectOptions = NetConnectOpts & { host: string; port: number }

const publicIpv4 = '93.184.216.34'
const publicIpv6 = '2606:2800:220:1:248:1893:25c8:1946'
const traceId = 'trace-node-tls-provider'
const baseConfig: NodeTlsConfig = {
  burst: 20,
  maxConcurrency: 4,
  maxHandshakeBytes: 262_144,
  queueCapacity: 32,
  queueWaitMs: 2_000,
  ratePerSecond: 10,
  timeoutMs: 1_000,
}

let temporaryDirectory = ''
let certificate = Buffer.alloc(0)
let privateKey = Buffer.alloc(0)
let incompleteChainCertificate = Buffer.alloc(0)
let incompleteChainPrivateKey = Buffer.alloc(0)
let rootCertificate = Buffer.alloc(0)

beforeAll(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'wanmi-tls-provider-'))
  const certificatePath = join(temporaryDirectory, 'certificate.pem')
  const privateKeyPath = join(temporaryDirectory, 'private-key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      privateKeyPath,
      '-out',
      certificatePath,
      '-days',
      '2',
      '-subj',
      '/CN=example.test/O=Wanmi Tests',
      '-addext',
      'subjectAltName=DNS:example.test,DNS:www.example.test',
    ],
    { stdio: 'ignore' },
  )
  certificate = readFileSync(certificatePath)
  privateKey = readFileSync(privateKeyPath)

  const rootCertificatePath = join(temporaryDirectory, 'root-certificate.pem')
  const rootPrivateKeyPath = join(temporaryDirectory, 'root-private-key.pem')
  const leafRequestPath = join(temporaryDirectory, 'leaf.csr')
  const leafCertificatePath = join(temporaryDirectory, 'leaf-certificate.pem')
  const leafPrivateKeyPath = join(temporaryDirectory, 'leaf-private-key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      rootPrivateKeyPath,
      '-out',
      rootCertificatePath,
      '-days',
      '2',
      '-subj',
      '/CN=Wanmi Test Root',
    ],
    { stdio: 'ignore' },
  )
  execFileSync(
    'openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      leafPrivateKeyPath,
      '-out',
      leafRequestPath,
      '-subj',
      '/CN=example.test/O=Wanmi Tests',
      '-addext',
      'subjectAltName=DNS:example.test',
    ],
    { stdio: 'ignore' },
  )
  execFileSync(
    'openssl',
    [
      'x509',
      '-req',
      '-in',
      leafRequestPath,
      '-CA',
      rootCertificatePath,
      '-CAkey',
      rootPrivateKeyPath,
      '-CAcreateserial',
      '-out',
      leafCertificatePath,
      '-days',
      '2',
      '-copy_extensions',
      'copy',
    ],
    { stdio: 'ignore' },
  )
  incompleteChainCertificate = readFileSync(leafCertificatePath)
  incompleteChainPrivateKey = readFileSync(leafPrivateKeyPath)
  rootCertificate = readFileSync(rootCertificatePath)
})

afterAll(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { force: true, recursive: true })
})

async function listen(server: ReturnType<typeof createTcpServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP listener address')
  return address.port
}

async function close(server: ReturnType<typeof createTcpServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function redirectedConnector(localPort: number, calls: CapturedConnectOptions[]) {
  return (options: NetConnectOpts) => {
    const captured = options as CapturedConnectOptions
    calls.push(captured)
    const socket = connect({ host: '127.0.0.1', port: localPort })
    socket.once('connect', () => {
      Object.defineProperty(socket, 'remoteAddress', {
        configurable: true,
        value: captured.host,
      })
      Object.defineProperty(socket, 'remotePort', { configurable: true, value: 443 })
    })
    return socket
  }
}

function provider(options: {
  ca?: Buffer
  config?: Partial<NodeTlsConfig>
  connectTcp: (options: NetConnectOpts) => Socket
  logger?: {
    info(fields: Record<string, unknown>): void
    warn(fields: Record<string, unknown>): void
  }
  now?: () => number
}) {
  return new NodeTlsProvider({
    ...(options.ca ? { ca: options.ca } : {}),
    config: { ...baseConfig, ...options.config },
    connectTcp: options.connectTcp,
    logger: options.logger ?? { info: vi.fn(), warn: vi.fn() },
    ...(options.now ? { now: options.now } : {}),
    requestIdFactory: () => 'tls-provider-request',
  })
}

describe('Node TLS provider fixed-target transport', () => {
  it('connects only to the prevalidated IP on port 443, completes diagnostics and sends no app data', async () => {
    let applicationBytes = 0
    const server = createTlsServer({ cert: certificate, key: privateKey }, (socket) => {
      socket.on('data', (chunk) => {
        applicationBytes += chunk.byteLength
      })
    })
    const port = await listen(server)
    const calls: CapturedConnectOptions[] = []
    const logger = { info: vi.fn(), warn: vi.fn() }
    try {
      const result = await provider({
        connectTcp: redirectedConnector(port, calls),
        logger,
      }).inspectCertificate({
        addresses: [publicIpv4],
        domainAscii: 'example.test',
        traceId,
      })
      expect(result).toMatchObject({
        data: {
          certificate: {
            chain: { status: 'self_signed' },
            hostnameMatch: true,
            validityStatus: 'valid',
          },
          findings: [{ code: 'TLS_CERT_SELF_SIGNED' }],
        },
        ok: true,
      })
      expect(calls).toEqual([
        expect.objectContaining({
          autoSelectFamily: false,
          family: 4,
          host: publicIpv4,
          port: 443,
        }),
      ])
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(applicationBytes).toBe(0)
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain('example.test')
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain(publicIpv4)
    } finally {
      await close(server)
    }
  })

  it('uses native hostname matching and reports expired or not-yet-valid periods', async () => {
    const server = createTlsServer({ cert: certificate, key: privateKey })
    const port = await listen(server)
    try {
      const mismatch = await provider({
        connectTcp: redirectedConnector(port, []),
      }).inspectCertificate({
        addresses: [publicIpv4],
        domainAscii: 'mismatch.example.test',
        traceId,
      })
      expect(mismatch).toMatchObject({
        data: {
          certificate: { hostnameMatch: false },
          findings: expect.arrayContaining([
            expect.objectContaining({ code: 'TLS_HOSTNAME_MISMATCH' }),
          ]),
        },
        ok: true,
      })

      const expired = await provider({
        connectTcp: redirectedConnector(port, []),
        now: () => Date.now() + 10 * 86_400_000,
      }).inspectCertificate({ addresses: [publicIpv4], domainAscii: 'example.test', traceId })
      expect(expired).toMatchObject({
        data: {
          findings: expect.arrayContaining([expect.objectContaining({ code: 'TLS_CERT_EXPIRED' })]),
        },
        ok: true,
      })

      const future = await provider({
        connectTcp: redirectedConnector(port, []),
        now: () => Date.now() - 2 * 86_400_000,
      }).inspectCertificate({ addresses: [publicIpv4], domainAscii: 'example.test', traceId })
      expect(future).toMatchObject({
        data: {
          findings: expect.arrayContaining([
            expect.objectContaining({ code: 'TLS_CERT_NOT_YET_VALID' }),
          ]),
        },
        ok: true,
      })
    } finally {
      await close(server)
    }
  })

  it('hard-stops a handshake above the configured inbound byte limit', async () => {
    const server = createTlsServer({ cert: certificate, key: privateKey })
    const port = await listen(server)
    try {
      const result = await provider({
        config: { maxHandshakeBytes: 64 },
        connectTcp: redirectedConnector(port, []),
      }).inspectCertificate({ addresses: [publicIpv4], domainAscii: 'example.test', traceId })
      expect(result).toMatchObject({ error: { code: 'TLS_HANDSHAKE_TOO_LARGE' }, ok: false })
    } finally {
      await close(server)
    }
  })

  it('reads an incomplete peer chain and reports native trust validation failure', async () => {
    const server = createTlsServer({
      cert: incompleteChainCertificate,
      key: incompleteChainPrivateKey,
    })
    const port = await listen(server)
    try {
      const result = await provider({
        connectTcp: redirectedConnector(port, []),
      }).inspectCertificate({ addresses: [publicIpv4], domainAscii: 'example.test', traceId })
      expect(result).toMatchObject({
        data: {
          certificate: { chain: { status: 'invalid' } },
          findings: expect.arrayContaining([
            expect.objectContaining({ code: 'TLS_CERT_CHAIN_INVALID' }),
          ]),
        },
        ok: true,
      })
    } finally {
      await close(server)
    }
  })

  it('accepts a valid CA-signed certificate when the injected test trust source authorizes it', async () => {
    const server = createTlsServer({
      cert: incompleteChainCertificate,
      key: incompleteChainPrivateKey,
    })
    const port = await listen(server)
    try {
      const result = await provider({
        ca: rootCertificate,
        connectTcp: redirectedConnector(port, []),
      }).inspectCertificate({ addresses: [publicIpv4], domainAscii: 'example.test', traceId })
      expect(result).toMatchObject({
        data: {
          certificate: {
            chain: { status: 'trusted' },
            hostnameMatch: true,
            validityStatus: 'valid',
          },
          findings: [],
        },
        ok: true,
      })
    } finally {
      await close(server)
    }
  })

  it('detects remote endpoint changes and never retries a security mismatch', async () => {
    const server = createTlsServer({ cert: certificate, key: privateKey })
    const port = await listen(server)
    const calls: CapturedConnectOptions[] = []
    try {
      const result = await provider({
        connectTcp: (options) => {
          calls.push(options as CapturedConnectOptions)
          return connect({ host: '127.0.0.1', port })
        },
      }).inspectCertificate({
        addresses: [publicIpv4, '93.184.216.35'],
        domainAscii: 'example.test',
        traceId,
      })
      expect(result).toMatchObject({ error: { code: 'TLS_TARGET_CHANGED' }, ok: false })
      expect(calls).toHaveLength(1)
    } finally {
      await close(server)
    }
  })

  it('interleaves IPv6/IPv4 attempts and rotates after a connection failure', async () => {
    const closedServer = createTcpServer()
    const closedPort = await listen(closedServer)
    await close(closedServer)
    const tlsServer = createTlsServer({ cert: certificate, key: privateKey })
    const tlsPort = await listen(tlsServer)
    const calls: CapturedConnectOptions[] = []
    const redirect = redirectedConnector(tlsPort, [])
    try {
      const result = await provider({
        connectTcp: (options) => {
          calls.push(options as CapturedConnectOptions)
          if (calls.length === 1) return connect({ host: '127.0.0.1', port: closedPort })
          return redirect(options)
        },
      }).inspectCertificate({
        addresses: [publicIpv4, publicIpv6, '93.184.216.35'],
        domainAscii: 'example.test',
        traceId,
      })
      expect(result).toMatchObject({ ok: true })
      expect(calls.map((options) => options.host)).toEqual([publicIpv6, publicIpv4])
      expect(calls.every((options) => options.port === 443)).toBe(true)
    } finally {
      await close(tlsServer)
    }
  })

  it('maps refused connections, total timeout, and bounded queue saturation separately', async () => {
    const closedServer = createTcpServer()
    const closedPort = await listen(closedServer)
    await close(closedServer)
    const refused = await provider({
      connectTcp: () => connect({ host: '127.0.0.1', port: closedPort }),
    }).inspectCertificate({ addresses: [publicIpv4], domainAscii: 'refused.example.test', traceId })
    expect(refused).toMatchObject({ error: { code: 'TLS_CONNECTION_FAILED' }, ok: false })

    const attempts: CapturedConnectOptions[] = []
    const limitedAttempts = await provider({
      connectTcp: (options) => {
        attempts.push(options as CapturedConnectOptions)
        return connect({ host: '127.0.0.1', port: closedPort })
      },
    }).inspectCertificate({
      addresses: Array.from({ length: 8 }, (_, index) => `93.184.216.${index + 1}`),
      domainAscii: 'attempt-limit.example.test',
      traceId,
    })
    expect(limitedAttempts).toMatchObject({
      error: { code: 'TLS_CONNECTION_FAILED' },
      ok: false,
    })
    expect(attempts).toHaveLength(4)

    const timeout = await provider({
      config: { timeoutMs: 20 },
      connectTcp: () => new Socket(),
    }).inspectCertificate({ addresses: [publicIpv4], domainAscii: 'timeout.example.test', traceId })
    expect(timeout).toMatchObject({ error: { code: 'TLS_TIMEOUT' }, ok: false })

    const queued = provider({
      config: {
        burst: 20,
        maxConcurrency: 1,
        queueCapacity: 1,
        queueWaitMs: 200,
        ratePerSecond: 20,
        timeoutMs: 50,
      },
      connectTcp: () => new Socket(),
    })
    const first = queued.inspectCertificate({
      addresses: [publicIpv4],
      domainAscii: 'one.example.test',
      traceId,
    })
    const second = queued.inspectCertificate({
      addresses: [publicIpv4],
      domainAscii: 'two.example.test',
      traceId,
    })
    const third = queued.inspectCertificate({
      addresses: [publicIpv4],
      domainAscii: 'three.example.test',
      traceId,
    })
    await expect(third).resolves.toMatchObject({ error: { code: 'TLS_QUEUE_FULL' }, ok: false })
    await expect(first).resolves.toMatchObject({ error: { code: 'TLS_TIMEOUT' }, ok: false })
    await expect(second).resolves.toMatchObject({ error: { code: 'TLS_TIMEOUT' }, ok: false })
  })

  it('rejects private, mapped, empty, or oversized address lists without connector access', async () => {
    const connectTcp = vi.fn(() => new Socket())
    const tls = provider({ connectTcp })
    for (const addresses of [
      [],
      ['127.0.0.1'],
      ['::ffff:93.184.216.34'],
      Array.from({ length: 9 }, (_, index) => `93.184.216.${index + 1}`),
    ]) {
      await expect(
        tls.inspectCertificate({ addresses, domainAscii: 'example.test', traceId }),
      ).resolves.toMatchObject({ error: { code: 'TLS_TARGET_BLOCKED' }, ok: false })
    }
    expect(connectTcp).not.toHaveBeenCalled()
  })
})
