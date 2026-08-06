import { randomUUID } from 'node:crypto'
import { Duplex } from 'node:stream'
import { connect as connectTcp, isIP, type NetConnectOpts, type Socket } from 'node:net'
import {
  checkServerIdentity,
  connect as connectTls,
  type ConnectionOptions,
  type DetailedPeerCertificate,
  type PeerCertificate,
  type TLSSocket,
} from 'node:tls'

import ipaddr from 'ipaddr.js'

import type { ProviderError, ProviderResult } from '@/lib/domain'
import { getEnv } from '@/lib/env'
import { logger as defaultLogger } from '@/lib/logging'
import {
  BoundedReadConcurrency,
  ReadConcurrencyFullError,
  ReadConcurrencyTimeoutError,
  ReadQueueFullError,
  ReadQueueTimeoutError,
  TokenBucketReadLimiter,
} from '@/providers/read-control'
import type { TlsHandshakeProvider, TlsHandshakeReport } from '@/providers/types'
import { isPublicDnsAddress } from '@/services/dns/query-dns-records'
import {
  TLS_MAX_ADDRESSES,
  TLS_MAX_ATTEMPTS,
  TLS_MAX_CHAIN_DEPTH,
  TLS_MAX_SAN_ENTRIES,
  TLS_PORT,
  tlsCertificateSchema,
  tlsFindingSchema,
  type TlsCertificate,
  type TlsFinding,
} from '@/schemas/tls'

export type NodeTlsConfig = {
  burst: number
  maxConcurrency: number
  maxHandshakeBytes: number
  queueCapacity: number
  queueWaitMs: number
  ratePerSecond: number
  timeoutMs: number
}

type TlsLogger = {
  info(fields: Record<string, unknown>): void
  warn(fields: Record<string, unknown>): void
}

type NodeTlsProviderOptions = {
  ca?: ConnectionOptions['ca']
  config?: NodeTlsConfig
  connectTcp?: (options: NetConnectOpts) => Socket
  logger?: TlsLogger
  now?: () => number
  requestIdFactory?: () => string
}

class TlsConnectionError extends Error {}
class TlsHandshakeError extends Error {}
class TlsHandshakeTooLargeError extends Error {}
class TlsRemoteMismatchError extends Error {}
class TlsTimeoutError extends Error {}

function configFromEnv(): NodeTlsConfig {
  const env = getEnv()
  return {
    burst: env.TLS_READ_BURST,
    maxConcurrency: env.TLS_READ_MAX_CONCURRENCY,
    maxHandshakeBytes: env.TLS_HANDSHAKE_MAX_BYTES,
    queueCapacity: env.TLS_READ_QUEUE_CAPACITY,
    queueWaitMs: env.TLS_READ_QUEUE_WAIT_MS,
    ratePerSecond: env.TLS_READ_RATE_PER_SECOND,
    timeoutMs: env.TLS_TIMEOUT_MS,
  }
}

function failure<T>(
  code: string,
  message: string,
  observedAt: string,
  requestId: string,
  options: Pick<ProviderError, 'retryable' | 'statusKnown'> & { retryAfterSeconds?: number },
): Extract<ProviderResult<T>, { ok: false }> {
  return {
    cache: { status: 'miss' },
    error: {
      code,
      message,
      ...(options.retryAfterSeconds ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
      retryable: options.retryable,
      statusKnown: options.statusKnown,
    },
    observedAt,
    ok: false,
    requestId,
  }
}

function uniqueInterleavedAddresses(addresses: string[]): string[] {
  const unique = [...new Set(addresses)]
  const ipv6 = unique.filter((address) => isIP(address) === 6)
  const ipv4 = unique.filter((address) => isIP(address) === 4)
  const ordered: string[] = []
  for (let index = 0; index < Math.max(ipv6.length, ipv4.length); index += 1) {
    if (ipv6[index]) ordered.push(ipv6[index])
    if (ipv4[index]) ordered.push(ipv4[index])
  }
  return ordered
}

function normalizedAddress(value: string): string {
  try {
    const parsed = ipaddr.parse(value)
    if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) return ''
    return parsed.toNormalizedString()
  } catch {
    return ''
  }
}

function scalarNameField(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 1_024)
  if (Array.isArray(value)) {
    const first = value.find((item): item is string => typeof item === 'string')
    return first?.slice(0, 1_024) ?? null
  }
  return null
}

function certificateName(value: PeerCertificate['subject']) {
  return {
    commonName: scalarNameField(value?.CN),
    organization: scalarNameField(value?.O),
  }
}

function isoDate(value: string): string {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new TlsHandshakeError()
  return new Date(milliseconds).toISOString()
}

function optionalIsoDate(value: string | undefined): string | null {
  if (!value) return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}

function parseSubjectAlternativeNames(value: string | undefined): string[] {
  if (!value) return []
  const entries: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index]
    if (index < value.length) {
      if (escaped) escaped = false
      else if (character === '\\' && quoted) escaped = true
      else if (character === '"') quoted = !quoted
    }
    if (index !== value.length && (character !== ',' || quoted)) continue
    const item = value.slice(start, index).trim()
    start = index + 1
    if (!item) continue
    const separator = item.indexOf(':')
    if (separator <= 0) continue
    const kind = item.slice(0, separator).trim()
    const raw = item.slice(separator + 1).trim()
    let decoded = raw
    if (raw.startsWith('"')) {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed !== 'string') continue
        decoded = parsed
      } catch {
        continue
      }
    }
    if (!decoded) continue
    entries.push((kind === 'DNS' ? decoded : `${kind}: ${decoded}`).slice(0, 1_024))
  }
  return entries
}

function chainSummary(
  leaf: DetailedPeerCertificate,
): Pick<TlsCertificate['chain'], 'certificates' | 'depth' | 'truncated'> {
  const certificates: TlsCertificate['chain']['certificates'] = []
  const seen = new Set<string>()
  let current: DetailedPeerCertificate | undefined = leaf
  let depth = 0
  let truncated = false

  while (current && depth < 64) {
    const fingerprint = current.fingerprint256 || current.fingerprint || `depth-${depth}`
    if (seen.has(fingerprint)) break
    seen.add(fingerprint)
    depth += 1
    if (certificates.length < TLS_MAX_CHAIN_DEPTH) {
      certificates.push({
        fingerprint256: current.fingerprint256 || null,
        issuer: certificateName(current.issuer),
        subject: certificateName(current.subject),
        validFrom: optionalIsoDate(current.valid_from),
        validTo: optionalIsoDate(current.valid_to),
      })
    } else truncated = true
    const issuer: DetailedPeerCertificate | undefined = current.issuerCertificate
    if (!issuer || issuer === current) break
    current = issuer
  }
  if (depth >= 64) truncated = true
  return { certificates, depth, truncated }
}

function isSelfSignedError(error: Error | string | null): boolean {
  const code = typeof error === 'string' ? error : (error as NodeJS.ErrnoException | null)?.code
  return code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN'
}

function certificateDetails(
  socket: TLSSocket,
  domainAscii: string,
  now: number,
): { certificate: TlsCertificate; findings: TlsFinding[] } {
  const peer = socket.getPeerCertificate(true)
  if (!peer?.raw) throw new TlsHandshakeError()
  const validFrom = isoDate(peer.valid_from)
  const validTo = isoDate(peer.valid_to)
  const validFromMs = Date.parse(validFrom)
  const validToMs = Date.parse(validTo)
  const hostnameError = checkServerIdentity(domainAscii, peer)
  const hostnameMatch = hostnameError === undefined
  const selfSigned = isSelfSignedError(socket.authorizationError)
  const chainStatus = socket.authorized ? 'trusted' : selfSigned ? 'self_signed' : 'invalid'
  const validityStatus = now < validFromMs ? 'not_yet_valid' : now > validToMs ? 'expired' : 'valid'
  const findings: TlsFinding[] = []
  if (validityStatus === 'expired') {
    findings.push({ code: 'TLS_CERT_EXPIRED', message: '证书已过期', severity: 'error' })
  } else if (validityStatus === 'not_yet_valid') {
    findings.push({
      code: 'TLS_CERT_NOT_YET_VALID',
      message: '证书尚未进入有效期',
      severity: 'error',
    })
  }
  if (!hostnameMatch) {
    findings.push({
      code: 'TLS_HOSTNAME_MISMATCH',
      message: '证书名称与查询域名不匹配',
      severity: 'error',
    })
  }
  if (selfSigned) {
    findings.push({
      code: 'TLS_CERT_SELF_SIGNED',
      message: '证书链包含自签名证书且不受系统信任库信任',
      severity: 'error',
    })
  } else if (!socket.authorized) {
    findings.push({
      code: 'TLS_CERT_CHAIN_INVALID',
      message: '证书链未通过 Node.js 系统信任库验证',
      severity: 'error',
    })
  }

  const sans = parseSubjectAlternativeNames(peer.subjectaltname)
  return {
    certificate: tlsCertificateSchema.parse({
      chain: { ...chainSummary(peer), status: chainStatus },
      daysRemaining: Math.ceil((validToMs - now) / 86_400_000),
      hostnameMatch,
      issuer: certificateName(peer.issuer),
      sanCount: sans.length,
      sanTruncated: sans.length > TLS_MAX_SAN_ENTRIES,
      subject: certificateName(peer.subject),
      subjectAlternativeNames: sans.slice(0, TLS_MAX_SAN_ENTRIES),
      validFrom,
      validityStatus,
      validTo,
    }),
    findings: findings.map((finding) => tlsFindingSchema.parse(finding)),
  }
}

class BoundedTlsTransport extends Duplex {
  private inboundBytes = 0

  constructor(
    private readonly socket: Socket,
    private readonly maxInboundBytes: number,
  ) {
    super()
    socket.on('data', (chunk: Buffer) => {
      this.inboundBytes += chunk.byteLength
      if (this.inboundBytes > this.maxInboundBytes) {
        this.destroy(new TlsHandshakeTooLargeError())
        return
      }
      if (!this.push(chunk)) socket.pause()
    })
    socket.on('end', () => this.push(null))
    socket.on('error', (error) => this.destroy(error))
    socket.on('close', () => {
      if (!this.destroyed) this.destroy()
    })
  }

  override _read(): void {
    this.socket.resume()
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.socket.write(chunk, encoding)) callback()
    else this.socket.once('drain', callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.end(callback)
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.destroy()
    callback(error)
  }
}

export class NodeTlsProvider implements TlsHandshakeProvider {
  private readonly ca: ConnectionOptions['ca'] | undefined
  private readonly concurrency: BoundedReadConcurrency
  private readonly config: NodeTlsConfig
  private readonly connectTcpImpl: (options: NetConnectOpts) => Socket
  private readonly inFlight = new Map<string, Promise<ProviderResult<TlsHandshakeReport>>>()
  private readonly limiter: TokenBucketReadLimiter
  private readonly logger: TlsLogger
  private readonly now: () => number
  private readonly requestIdFactory: () => string

  constructor(options: NodeTlsProviderOptions = {}) {
    this.ca = options.ca
    this.config = options.config ?? configFromEnv()
    this.connectTcpImpl = options.connectTcp ?? connectTcp
    this.logger = options.logger ?? defaultLogger
    this.now = options.now ?? Date.now
    this.requestIdFactory = options.requestIdFactory ?? (() => `tls-${randomUUID()}`)
    this.limiter = new TokenBucketReadLimiter(
      this.config.ratePerSecond,
      this.config.burst,
      this.config.queueCapacity,
      this.config.queueWaitMs,
      this.now,
    )
    this.concurrency = new BoundedReadConcurrency(
      this.config.maxConcurrency,
      this.config.queueCapacity,
      this.config.queueWaitMs,
    )
  }

  async health(): Promise<ProviderResult<{ healthy: boolean }>> {
    return {
      cache: { status: 'miss' },
      data: { healthy: true },
      observedAt: this.observedAt(),
      ok: true,
      requestId: this.requestIdFactory(),
    }
  }

  async inspectCertificate(input: {
    addresses: string[]
    domainAscii: string
    traceId: string
  }): Promise<ProviderResult<TlsHandshakeReport>> {
    const requestId = this.requestIdFactory()
    const addresses = uniqueInterleavedAddresses(input.addresses)
    if (
      addresses.length === 0 ||
      addresses.length > TLS_MAX_ADDRESSES ||
      addresses.some((address) => !isPublicDnsAddress(address))
    ) {
      return failure(
        'TLS_TARGET_BLOCKED',
        'TLS 目标地址未通过公网安全校验',
        this.observedAt(),
        requestId,
        { retryable: false, statusKnown: true },
      )
    }

    const key = `${input.domainAscii}:${addresses.join(',')}`
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const promise = this.schedule(addresses, input.domainAscii, input.traceId, requestId).finally(
      () => this.inFlight.delete(key),
    )
    this.inFlight.set(key, promise)
    return promise
  }

  private async schedule(
    addresses: string[],
    domainAscii: string,
    traceId: string,
    requestId: string,
  ): Promise<ProviderResult<TlsHandshakeReport>> {
    const startedAt = this.now()
    try {
      return await this.limiter.schedule(() =>
        this.concurrency.schedule(() => this.execute(addresses, domainAscii, traceId, requestId)),
      )
    } catch (error) {
      const queueFull =
        error instanceof ReadQueueFullError || error instanceof ReadConcurrencyFullError
      if (
        queueFull ||
        error instanceof ReadQueueTimeoutError ||
        error instanceof ReadConcurrencyTimeoutError
      ) {
        const result = failure<TlsHandshakeReport>(
          queueFull ? 'TLS_QUEUE_FULL' : 'TLS_QUEUE_TIMEOUT',
          queueFull ? 'TLS 检查队列已满' : 'TLS 检查排队超时',
          this.observedAt(),
          requestId,
          { retryAfterSeconds: 1, retryable: true, statusKnown: false },
        )
        this.logScheduleFailure(result.error.code, traceId, requestId, startedAt)
        return result
      }
      const result = failure<TlsHandshakeReport>(
        'TLS_UNAVAILABLE',
        'TLS 检查暂时不可用',
        this.observedAt(),
        requestId,
        {
          retryable: true,
          statusKnown: false,
        },
      )
      this.logScheduleFailure(result.error.code, traceId, requestId, startedAt)
      return result
    }
  }

  private logScheduleFailure(
    errorCode: string,
    traceId: string,
    requestId: string,
    startedAt: number,
  ): void {
    this.logger.warn({
      durationMs: Math.max(0, this.now() - startedAt),
      errorCode,
      event: 'tls.request_failed',
      provider: 'node_tls',
      queueDepth: this.limiter.queueSize + this.concurrency.queueSize,
      requestId,
      retryable: true,
      traceId,
    })
  }

  private async execute(
    addresses: string[],
    domainAscii: string,
    traceId: string,
    requestId: string,
  ): Promise<ProviderResult<TlsHandshakeReport>> {
    const startedAt = this.now()
    const deadline = startedAt + this.config.timeoutMs
    const errors: unknown[] = []
    this.logger.info({
      addressCount: addresses.length,
      event: 'tls.request_started',
      port: TLS_PORT,
      provider: 'node_tls',
      queueDepth: this.limiter.queueSize + this.concurrency.queueSize,
      requestId,
      traceId,
    })

    for (const address of addresses.slice(0, TLS_MAX_ATTEMPTS)) {
      try {
        const report = await this.inspectAddress(address, domainAscii, deadline)
        const result: Extract<ProviderResult<TlsHandshakeReport>, { ok: true }> = {
          cache: { status: 'miss' },
          data: report,
          observedAt: this.observedAt(),
          ok: true,
          requestId,
        }
        this.logger.info({
          addressAttempts: errors.length + 1,
          durationMs: Math.max(0, this.now() - startedAt),
          event: 'tls.request_succeeded',
          findingCount: report.findings.length,
          port: TLS_PORT,
          provider: 'node_tls',
          queueDepth: this.limiter.queueSize + this.concurrency.queueSize,
          requestId,
          traceId,
        })
        return result
      } catch (error) {
        errors.push(error)
        if (error instanceof TlsHandshakeTooLargeError || error instanceof TlsRemoteMismatchError) {
          break
        }
      }
    }

    const mapped = this.mapAttemptFailure(errors, requestId)
    this.logger.warn({
      addressAttempts: errors.length,
      durationMs: Math.max(0, this.now() - startedAt),
      errorCode: mapped.error.code,
      event: 'tls.request_failed',
      port: TLS_PORT,
      provider: 'node_tls',
      queueDepth: this.limiter.queueSize + this.concurrency.queueSize,
      requestId,
      retryable: mapped.error.retryable,
      traceId,
    })
    return mapped
  }

  private inspectAddress(address: string, domainAscii: string, deadline: number) {
    return new Promise<TlsHandshakeReport>((resolve, reject) => {
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        reject(new TlsTimeoutError())
        return
      }
      const rawSocket = this.connectTcpImpl({
        autoSelectFamily: false,
        family: isIP(address),
        host: address,
        port: TLS_PORT,
      })
      let tlsSocket: TLSSocket | undefined
      let settled = false
      const timer = setTimeout(() => finish(new TlsTimeoutError()), remaining)
      const finish = (error?: Error, report?: TlsHandshakeReport) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        tlsSocket?.destroy()
        rawSocket.destroy()
        if (error) reject(error)
        else if (report) resolve(report)
        else reject(new TlsHandshakeError())
      }
      rawSocket.once('error', () => finish(new TlsConnectionError()))
      rawSocket.once('connect', () => {
        if (
          rawSocket.remotePort !== TLS_PORT ||
          !rawSocket.remoteAddress ||
          normalizedAddress(rawSocket.remoteAddress) !== normalizedAddress(address)
        ) {
          finish(new TlsRemoteMismatchError())
          return
        }
        const transport = new BoundedTlsTransport(rawSocket, this.config.maxHandshakeBytes)
        transport.once('error', (error) =>
          finish(error instanceof TlsHandshakeTooLargeError ? error : new TlsHandshakeError()),
        )
        tlsSocket = connectTls({
          ...(this.ca ? { ca: this.ca } : {}),
          checkServerIdentity: () => undefined,
          rejectUnauthorized: false,
          servername: domainAscii,
          socket: transport,
        })
        tlsSocket.once('error', () => finish(new TlsHandshakeError()))
        tlsSocket.once('secureConnect', () => {
          try {
            tlsSocket?.disableRenegotiation()
            const details = certificateDetails(tlsSocket as TLSSocket, domainAscii, this.now())
            const protocol = tlsSocket?.getProtocol()
            const cipher = tlsSocket?.getCipher()
            if (!protocol || !cipher?.name) throw new TlsHandshakeError()
            finish(undefined, {
              certificate: details.certificate,
              cipherSuite: cipher.name,
              findings: details.findings,
              protocol,
            })
          } catch (error) {
            finish(error instanceof Error ? error : new TlsHandshakeError())
          }
        })
      })
    })
  }

  private mapAttemptFailure(
    errors: unknown[],
    requestId: string,
  ): Extract<ProviderResult<TlsHandshakeReport>, { ok: false }> {
    const observedAt = this.observedAt()
    if (errors.some((error) => error instanceof TlsRemoteMismatchError)) {
      return failure(
        'TLS_TARGET_CHANGED',
        'TLS 实际连接目标与已校验地址不一致',
        observedAt,
        requestId,
        {
          retryable: false,
          statusKnown: true,
        },
      )
    }
    if (errors.some((error) => error instanceof TlsHandshakeTooLargeError)) {
      return failure('TLS_HANDSHAKE_TOO_LARGE', 'TLS 握手数据超过安全上限', observedAt, requestId, {
        retryable: false,
        statusKnown: false,
      })
    }
    if (errors.length > 0 && errors.every((error) => error instanceof TlsTimeoutError)) {
      return failure('TLS_TIMEOUT', 'TLS 连接或握手超时', observedAt, requestId, {
        retryable: true,
        statusKnown: false,
      })
    }
    if (errors.some((error) => error instanceof TlsHandshakeError)) {
      return failure('TLS_HANDSHAKE_FAILED', '目标未能完成 TLS 握手', observedAt, requestId, {
        retryable: true,
        statusKnown: false,
      })
    }
    return failure('TLS_CONNECTION_FAILED', '无法连接目标的 TLS 端口', observedAt, requestId, {
      retryable: true,
      statusKnown: false,
    })
  }

  private observedAt(): string {
    return new Date(this.now()).toISOString()
  }
}
