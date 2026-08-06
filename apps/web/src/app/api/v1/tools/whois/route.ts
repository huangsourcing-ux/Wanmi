import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { createConfiguredWestDigitalWhoisProvider } from '@/providers/westdigital-whois'
import { WhoDatProvider } from '@/providers/whodat'
import type { PublicRegistrationProvider } from '@/providers/types'
import { whoisLookupRequestSchema, whoisLookupResultSchema } from '@/schemas/whois'
import { queryPublicRegistration } from '@/services/whois/query-public-registration'
import { runtimeProviderObservability } from '@/services/observability/runtime'

const MAX_REQUEST_BODY_BYTES = 4_096

type WhoisHandlerDependencies = {
  fallback?: PublicRegistrationProvider
  primary: PublicRegistrationProvider
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
      throw new AppError('WHOIS_REQUEST_TOO_LARGE', 'WHOIS 查询请求过大', 413)
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
          throw new AppError('WHOIS_REQUEST_TOO_LARGE', 'WHOIS 查询请求过大', 413)
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
  let body: string
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

export function createWhoisPostHandler(dependencies: WhoisHandlerDependencies) {
  return async function post(request: Request) {
    const traceId = getTraceId(request.headers)
    try {
      const input = whoisLookupRequestSchema.parse(await readJsonBody(request))
      const result = await queryPublicRegistration(input, {
        ...(dependencies.fallback ? { fallback: dependencies.fallback } : {}),
        primary: dependencies.primary,
        traceId,
      })
      return successResponse(whoisLookupResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

const configuredFallback = createConfiguredWestDigitalWhoisProvider({
  logger: runtimeProviderObservability.logger,
})
const POST_HANDLER = createWhoisPostHandler({
  ...(configuredFallback ? { fallback: configuredFallback } : {}),
  primary: new WhoDatProvider({ logger: runtimeProviderObservability.logger }),
})

export const POST = POST_HANDLER
