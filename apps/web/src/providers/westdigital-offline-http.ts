import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'

import ipaddr from 'ipaddr.js'

import {
  WestDigitalHttpRequestError,
  type WestDigitalHttpResponse,
} from '@/providers/westdigital-http'
import { readBoundedBody } from '@/providers/read-control'
import { isPublicDnsAddress } from '@/services/dns/query-dns-records'

const HOSTNAME = 'newapi.west.cn'
const ORIGIN = `https://${HOSTNAME}`
const MAX_RESOLVED_ADDRESSES = 16
const ALLOWED_PATHS = new Set([
  '/v2/offline-task/add-dns-record-task',
  '/v2/offline-task/task-list',
  '/v2/offline-task/task-record-list',
])

type ResolvedAddress = { address: string; family: 4 | 6 }

export type WestDigitalOfflineHttpRequest = {
  body: Readonly<Record<string, string>>
  path:
    | '/v2/offline-task/add-dns-record-task'
    | '/v2/offline-task/task-list'
    | '/v2/offline-task/task-record-list'
  requestId: string
  signal: AbortSignal
}

export type WestDigitalOfflineHttpOptions = {
  apiPassword: string
  fetchImpl?: typeof fetch
  maxResponseBytes: number
  now?: () => number
  resolveAddresses?: (hostname: string) => Promise<ResolvedAddress[]>
  username: string
}

function parseBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return undefined
  }
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

async function publicAddress(
  resolver: (hostname: string) => Promise<ResolvedAddress[]>,
): Promise<ResolvedAddress> {
  let addresses: ResolvedAddress[]
  try {
    addresses = await resolver(HOSTNAME)
  } catch {
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
  body?: Buffer
  maxResponseBytes: number
  method: 'GET' | 'POST'
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
          ...(input.body
            ? {
                'content-length': String(input.body.byteLength),
                'content-type': 'application/x-www-form-urlencoded',
              }
            : {}),
          'x-request-id': input.requestId,
        },
        hostname: HOSTNAME,
        lookup: (_hostname, _options, callback) =>
          callback(null, input.address.address, input.address.family),
        maxHeaderSize: 16_384,
        method: input.method,
        path: input.path,
        port: 443,
        protocol: 'https:',
        servername: HOSTNAME,
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

export async function executeWestDigitalOfflineHttpRequest(
  request: WestDigitalOfflineHttpRequest,
  options: WestDigitalOfflineHttpOptions,
): Promise<WestDigitalHttpResponse> {
  if (!options.username || !options.apiPassword || !ALLOWED_PATHS.has(request.path)) {
    throw new WestDigitalHttpRequestError('RESTRICTED_ADDRESS', 'not_submitted')
  }
  if ('username' in request.body || 'time' in request.body || 'token' in request.body) {
    throw new WestDigitalHttpRequestError('UNAVAILABLE', 'not_submitted')
  }
  const time = String((options.now ?? Date.now)())
  const fields = new URLSearchParams({
    ...request.body,
    time,
    token: createHash('md5')
      .update(`${options.username}${options.apiPassword}${time}`)
      .digest('hex'),
    username: options.username,
  })
  const method = request.path === '/v2/offline-task/add-dns-record-task' ? 'POST' : 'GET'
  const body = method === 'POST' ? Buffer.from(fields.toString(), 'utf8') : undefined
  const path = method === 'GET' ? `${request.path}?${fields.toString()}` : request.path

  if (options.fetchImpl) {
    const response = await options.fetchImpl(`${ORIGIN}${path}`, {
      ...(body ? { body } : {}),
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        'x-request-id': request.requestId,
      },
      method,
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

  return pinnedRequest({
    address: await publicAddress(options.resolveAddresses ?? defaultResolveAddresses),
    body,
    maxResponseBytes: options.maxResponseBytes,
    method,
    path,
    requestId: request.requestId,
    signal: request.signal,
  })
}
