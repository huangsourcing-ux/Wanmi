import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'

import iconv from 'iconv-lite'
import ipaddr from 'ipaddr.js'

import { readBoundedBody } from '@/providers/read-control'
import { isPublicDnsAddress } from '@/services/dns/query-dns-records'

const WESTDIGITAL_HOSTNAME = 'api.west.cn'
const WESTDIGITAL_ORIGIN = `https://${WESTDIGITAL_HOSTNAME}`
const MAX_RESOLVED_ADDRESSES = 16
const ALLOWED_PATHS = new Set([
  '/api/v2/audit/',
  '/api/v2/domain/',
  '/api/v2/domain/query/',
  '/api/v2/info/',
])

type ResolvedAddress = { address: string; family: 4 | 6 }

export type WestDigitalHttpRequest = {
  body: Readonly<Record<string, string>>
  path: '/v2/audit/' | '/v2/domain/' | '/v2/domain/query/' | '/v2/info/'
  requestId: string
  signal: AbortSignal
}

export type WestDigitalHttpResponse = {
  body: unknown
  headers: Readonly<Record<string, string | undefined>>
  status: number
}

export class WestDigitalHttpRequestError extends Error {
  constructor(
    readonly code: 'RESTRICTED_ADDRESS' | 'TIMEOUT' | 'UNAVAILABLE',
    readonly submission: 'not_submitted' | 'unknown',
  ) {
    super(code)
    this.name = 'WestDigitalHttpRequestError'
  }
}

export type WestDigitalHttpOptions = {
  apiPassword: string
  fetchImpl?: typeof fetch
  maxResponseBytes: number
  now?: () => number
  resolveAddresses?: (hostname: string) => Promise<ResolvedAddress[]>
  username: string
}

function percentEncodedGb18030(value: string): string {
  let result = ''
  for (const byte of iconv.encode(value, 'gb18030')) {
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2a ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f
    ) {
      result += String.fromCharCode(byte)
    } else if (byte === 0x20) {
      result += '+'
    } else {
      result += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return result
}

export function encodeWestDigitalForm(fields: Readonly<Record<string, string>>): Buffer {
  return Buffer.from(
    Object.entries(fields)
      .map(([key, value]) => `${percentEncodedGb18030(key)}=${percentEncodedGb18030(value)}`)
      .join('&'),
    'ascii',
  )
}

function normalizedAddress(value: string): string {
  return ipaddr.parse(value).toNormalizedString()
}

async function defaultResolveAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.flatMap((entry) =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family }]
      : [],
  )
}

function parseBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('gb18030', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return undefined
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new WestDigitalHttpRequestError('TIMEOUT', 'not_submitted'))
      return
    }
    signal.addEventListener(
      'abort',
      () => reject(new WestDigitalHttpRequestError('TIMEOUT', 'not_submitted')),
      { once: true },
    )
  })
}

async function resolvePublicAddress(
  signal: AbortSignal,
  resolver: (hostname: string) => Promise<ResolvedAddress[]>,
): Promise<ResolvedAddress> {
  let addresses: ResolvedAddress[]
  try {
    addresses = await Promise.race([resolver(WESTDIGITAL_HOSTNAME), abortPromise(signal)])
  } catch (error) {
    if (error instanceof WestDigitalHttpRequestError) throw error
    throw new WestDigitalHttpRequestError('UNAVAILABLE', 'not_submitted')
  }
  if (
    addresses.length === 0 ||
    addresses.length > MAX_RESOLVED_ADDRESSES ||
    addresses.some(({ address }) => !isPublicDnsAddress(address))
  ) {
    throw new WestDigitalHttpRequestError('RESTRICTED_ADDRESS', 'not_submitted')
  }
  return addresses[0]!
}

function pinnedRequest(input: {
  address: ResolvedAddress
  body: Buffer
  maxResponseBytes: number
  path: string
  requestId: string
  signal: AbortSignal
}): Promise<WestDigitalHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false
    let submitted = false
    const fail = (error: WestDigitalHttpRequestError) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = httpsRequest(
      {
        headers: {
          accept: 'application/json',
          'content-length': String(input.body.byteLength),
          'content-type': 'application/x-www-form-urlencoded;charset=GB2312',
          'x-request-id': input.requestId,
        },
        hostname: WESTDIGITAL_HOSTNAME,
        lookup: (_hostname, _options, callback) =>
          callback(null, input.address.address, input.address.family),
        maxHeaderSize: 16_384,
        method: 'POST',
        path: input.path,
        port: 443,
        protocol: 'https:',
        servername: WESTDIGITAL_HOSTNAME,
      },
      (response) => {
        const remoteAddress = response.socket.remoteAddress
        if (
          !remoteAddress ||
          response.socket.remotePort !== 443 ||
          normalizedAddress(remoteAddress) !== normalizedAddress(input.address.address)
        ) {
          response.destroy()
          fail(new WestDigitalHttpRequestError('RESTRICTED_ADDRESS', 'unknown'))
          return
        }
        const declared = response.headers['content-length']
        if (declared && (!/^\d+$/u.test(declared) || Number(declared) > input.maxResponseBytes)) {
          response.destroy()
          fail(new WestDigitalHttpRequestError('UNAVAILABLE', 'unknown'))
          return
        }
        const chunks: Buffer[] = []
        let length = 0
        response.on('data', (chunk: Buffer) => {
          length += chunk.byteLength
          if (length > input.maxResponseBytes) {
            response.destroy()
            fail(new WestDigitalHttpRequestError('UNAVAILABLE', 'unknown'))
            return
          }
          chunks.push(chunk)
        })
        response.once('end', () => {
          if (settled) return
          settled = true
          resolve({
            body: parseBody(Buffer.concat(chunks)),
            headers: {
              'retry-after': Array.isArray(response.headers['retry-after'])
                ? response.headers['retry-after'][0]
                : response.headers['retry-after'],
            },
            status: response.statusCode ?? 0,
          })
        })
        response.once('error', () =>
          fail(
            new WestDigitalHttpRequestError('UNAVAILABLE', submitted ? 'unknown' : 'not_submitted'),
          ),
        )
      },
    )
    request.once('finish', () => {
      submitted = true
    })
    request.once('error', () =>
      fail(new WestDigitalHttpRequestError('UNAVAILABLE', submitted ? 'unknown' : 'not_submitted')),
    )
    const abort = () => {
      request.destroy()
      fail(new WestDigitalHttpRequestError('TIMEOUT', submitted ? 'unknown' : 'not_submitted'))
    }
    if (input.signal.aborted) {
      abort()
      return
    }
    input.signal.addEventListener('abort', abort, { once: true })
    request.once('close', () => input.signal.removeEventListener('abort', abort))
    request.end(input.body)
  })
}

export async function executeWestDigitalHttpRequest(
  request: WestDigitalHttpRequest,
  options: WestDigitalHttpOptions,
): Promise<WestDigitalHttpResponse> {
  if (!options.username || !options.apiPassword) {
    throw new WestDigitalHttpRequestError('UNAVAILABLE', 'not_submitted')
  }
  const path = `/api${request.path}`
  if (!ALLOWED_PATHS.has(path)) {
    throw new WestDigitalHttpRequestError('RESTRICTED_ADDRESS', 'not_submitted')
  }
  if ('username' in request.body || 'time' in request.body || 'token' in request.body) {
    throw new WestDigitalHttpRequestError('UNAVAILABLE', 'not_submitted')
  }
  const time = String((options.now ?? Date.now)())
  const body = encodeWestDigitalForm({
    ...request.body,
    time,
    token: createHash('md5')
      .update(`${options.username}${options.apiPassword}${time}`)
      .digest('hex'),
    username: options.username,
  })

  if (options.fetchImpl) {
    const response = await options.fetchImpl(`${WESTDIGITAL_ORIGIN}${path}`, {
      body,
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded;charset=GB2312',
        'x-request-id': request.requestId,
      },
      method: 'POST',
      redirect: 'error',
      signal: request.signal,
    })
    const bytes = await readBoundedBody(response, options.maxResponseBytes)
    return {
      body: parseBody(bytes),
      headers: { 'retry-after': response.headers.get('retry-after') ?? undefined },
      status: response.status,
    }
  }

  const address = await resolvePublicAddress(
    request.signal,
    options.resolveAddresses ?? defaultResolveAddresses,
  )
  return pinnedRequest({
    address,
    body,
    maxResponseBytes: options.maxResponseBytes,
    path,
    requestId: request.requestId,
    signal: request.signal,
  })
}
