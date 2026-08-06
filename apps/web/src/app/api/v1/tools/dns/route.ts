import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { AliDnsProvider } from '@/providers/alidns'
import type { DnsReadProvider } from '@/providers/types'
import { dnsLookupRequestSchema, dnsLookupResultSchema } from '@/schemas/dns'
import { DnsResultCache, queryDnsRecords } from '@/services/dns/query-dns-records'

const MAX_REQUEST_BODY_BYTES = 4_096

export const runtime = 'nodejs'

type DnsHandlerDependencies = {
  cache?: DnsResultCache
  provider: DnsReadProvider
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 查询请求', 415)
  }
  const declaredLength = request.headers.get('content-length')
  if (declaredLength) {
    const bytes = Number(declaredLength)
    if (!Number.isFinite(bytes) || bytes < 0) throw new AppError('INVALID_REQUEST', '请求格式无效')
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      throw new AppError('DNS_REQUEST_TOO_LARGE', 'DNS 查询请求过大', 413)
    }
  }
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_REQUEST_BODY_BYTES) {
          await reader.cancel()
          throw new AppError('DNS_REQUEST_TOO_LARGE', 'DNS 查询请求过大', 413)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

export function createDnsPostHandler(dependencies: DnsHandlerDependencies) {
  return async function post(request: Request) {
    const traceId = getTraceId(request.headers)
    try {
      const input = dnsLookupRequestSchema.parse(await readJsonBody(request))
      const result = await queryDnsRecords(input, {
        ...(dependencies.cache ? { cache: dependencies.cache } : {}),
        provider: dependencies.provider,
        traceId,
      })
      return successResponse(dnsLookupResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createDnsPostHandler({ provider: new AliDnsProvider() })
