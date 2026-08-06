import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { AliDnsProvider } from '@/providers/alidns'
import { NodeTlsProvider } from '@/providers/node-tls'
import type { DnsReadProvider, TlsHandshakeProvider } from '@/providers/types'
import { sslCheckRequestSchema, sslCheckResultSchema } from '@/schemas/tls'
import { DnsResultCache } from '@/services/dns/query-dns-records'
import { TlsResultCache, queryTlsCertificate } from '@/services/tls/query-tls-certificate'
import { runtimeProviderObservability } from '@/services/observability/runtime'

const MAX_REQUEST_BODY_BYTES = 4_096

export const runtime = 'nodejs'

type SslCheckHandlerDependencies = {
  dnsCache?: DnsResultCache
  dnsProvider: DnsReadProvider
  resultCache?: TlsResultCache
  tlsProvider: TlsHandshakeProvider
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
      throw new AppError('TLS_REQUEST_TOO_LARGE', 'SSL 检查请求过大', 413)
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
          throw new AppError('TLS_REQUEST_TOO_LARGE', 'SSL 检查请求过大', 413)
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

export function createSslCheckPostHandler(dependencies: SslCheckHandlerDependencies) {
  return async function post(request: Request) {
    const traceId = getTraceId(request.headers)
    try {
      const input = sslCheckRequestSchema.parse(await readJsonBody(request))
      const result = await queryTlsCertificate(input, {
        ...(dependencies.dnsCache ? { dnsCache: dependencies.dnsCache } : {}),
        ...(dependencies.resultCache ? { cache: dependencies.resultCache } : {}),
        dnsProvider: dependencies.dnsProvider,
        tlsProvider: dependencies.tlsProvider,
        traceId,
      })
      return successResponse(sslCheckResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createSslCheckPostHandler({
  dnsProvider: new AliDnsProvider({ logger: runtimeProviderObservability.logger }),
  tlsProvider: new NodeTlsProvider({ logger: runtimeProviderObservability.logger }),
})
