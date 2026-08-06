import config from '@payload-config'
import { getPayload } from 'payload'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import type { WestDigitalReadProvider } from '@/providers/types'
import { PRICING_MAX_TLDS, pricingRequestSchema, pricingResultSchema } from '@/schemas/pricing'
import { queryTldPricing } from '@/services/pricing/query-tld-pricing'
import { runtimeProviderObservability } from '@/services/observability/runtime'
import {
  PayloadPriceSnapshotStore,
  type PriceSnapshotStore,
} from '@/services/pricing/price-snapshots'

export const runtime = 'nodejs'

const MAX_REQUEST_BODY_BYTES = 4_096
const provider = new WestDigitalReadAdapter({
  logger: runtimeProviderObservability.logger,
  transport: new FixtureWestDigitalTransport(),
})

type PricingPostDependencies = {
  getSnapshotStore: () => Promise<PriceSnapshotStore>
  provider: WestDigitalReadProvider
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 价格查询请求', 415)
  }
  const declaredLength = request.headers.get('content-length')
  if (declaredLength) {
    const bytes = Number(declaredLength)
    if (!Number.isFinite(bytes) || bytes < 0) throw new AppError('INVALID_REQUEST', '请求格式无效')
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      throw new AppError('PRICING_REQUEST_TOO_LARGE', '价格查询请求过大', 413)
    }
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new AppError('PRICING_REQUEST_TOO_LARGE', '价格查询请求过大', 413)
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
    candidate.tlds.length > PRICING_MAX_TLDS
  ) {
    throw new AppError(
      'PRICING_TLD_LIMIT_EXCEEDED',
      `单次最多查询 ${PRICING_MAX_TLDS} 个域名后缀，当前提交了 ${candidate.tlds.length} 个`,
      400,
      {
        action: `请删除多余后缀后重试，最多保留 ${PRICING_MAX_TLDS} 个`,
        retryable: false,
        title: '域名后缀数量超过上限',
      },
    )
  }
}

async function defaultSnapshotStore(): Promise<PriceSnapshotStore> {
  const payload = await getPayload({ config })
  return new PayloadPriceSnapshotStore(payload)
}

export function createPricingPostHandler(dependencies: PricingPostDependencies) {
  return async function pricingPost(request: Request): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const candidate = await readJsonBody(request)
      rejectTooManyTlds(candidate)
      const input = pricingRequestSchema.parse(candidate)
      const snapshots = await dependencies.getSnapshotStore()
      const result = await queryTldPricing(input, {
        provider: dependencies.provider,
        snapshots,
        traceId,
      })
      return successResponse(pricingResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createPricingPostHandler({
  getSnapshotStore: defaultSnapshotStore,
  provider,
})
