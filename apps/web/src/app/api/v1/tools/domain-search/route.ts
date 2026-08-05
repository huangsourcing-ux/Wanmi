import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import {
  DOMAIN_SEARCH_MAX_TLDS,
  domainSearchRequestSchema,
  domainSearchResultSchema,
} from '@/schemas/domain-search'
import { queryDomainAvailability } from '@/services/domain-search/query-availability'

const MAX_REQUEST_BODY_BYTES = 4_096
const provider = new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() })

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
      throw new AppError('DOMAIN_SEARCH_REQUEST_TOO_LARGE', '域名查询请求过大', 413)
    }
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new AppError('DOMAIN_SEARCH_REQUEST_TOO_LARGE', '域名查询请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

function rejectTooManyTlds(candidate: unknown): void {
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'tlds' in candidate &&
    Array.isArray(candidate.tlds) &&
    candidate.tlds.length > DOMAIN_SEARCH_MAX_TLDS
  ) {
    throw new AppError(
      'DOMAIN_SEARCH_TLD_LIMIT_EXCEEDED',
      `单次最多查询 ${DOMAIN_SEARCH_MAX_TLDS} 个域名后缀，当前提交了 ${candidate.tlds.length} 个`,
      400,
      {
        action: `请删除多余后缀后重试，最多保留 ${DOMAIN_SEARCH_MAX_TLDS} 个`,
        retryable: false,
        title: '域名后缀数量超过上限',
      },
    )
  }
}

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const candidate = await readJsonBody(request)
    rejectTooManyTlds(candidate)
    const input = domainSearchRequestSchema.parse(candidate)
    const result = await queryDomainAvailability(input, { provider, traceId })
    return successResponse(domainSearchResultSchema.parse(result), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
