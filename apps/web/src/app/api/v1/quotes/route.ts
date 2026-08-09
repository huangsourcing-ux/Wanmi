import config from '@payload-config'
import { getPayload } from 'payload'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import type { WestDigitalReadProvider } from '@/providers/types'
import { quoteCreateRequestSchema, quoteCreationResultSchema } from '@/schemas/quotes'
import { runtimeProviderObservability } from '@/services/observability/runtime'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import {
  createCustomerQuote,
  PayloadCustomerDomainAssetStore,
  PayloadCustomerQuoteStore,
} from '@/services/pricing/customer-quotes'
import {
  PayloadPriceSnapshotStore,
  type PriceSnapshotStore,
} from '@/services/pricing/price-snapshots'
import { loadEnabledPricingRules } from '@/services/pricing/price-rules'
import type { PricingRule } from '@/services/pricing/price-calculation'

export const runtime = 'nodejs'

const MAX_REQUEST_BODY_BYTES = 4_096
const provider = new WestDigitalReadAdapter({
  logger: runtimeProviderObservability.logger,
  transport: new FixtureWestDigitalTransport(),
})

type QuotePostDependencies = {
  createQuote?: typeof createCustomerQuote
  provider: WestDigitalReadProvider
  resolveContext: (request: Request) => Promise<{
    customer: { collection: 'customers'; id: number }
    assetStore?: import('@/services/pricing/customer-quotes').CustomerDomainAssetStore
    quoteStore: import('@/services/pricing/customer-quotes').CustomerQuoteStore
    rules: Readonly<Record<string, PricingRule>>
    snapshots: PriceSnapshotStore
  }>
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 报价请求', 415)
  }
  const declaredLength = request.headers.get('content-length')
  if (declaredLength && Number(declaredLength) > MAX_REQUEST_BODY_BYTES) {
    throw new AppError('QUOTE_REQUEST_TOO_LARGE', '报价请求过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new AppError('QUOTE_REQUEST_TOO_LARGE', '报价请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

async function defaultContext(request: Request): Promise<{
  customer: { collection: 'customers'; id: number }
  assetStore: PayloadCustomerDomainAssetStore
  quoteStore: PayloadCustomerQuoteStore
  rules: Readonly<Record<string, PricingRule>>
  snapshots: PriceSnapshotStore
}> {
  const payload = await getPayload({ config })
  const { req, user } = await authenticatedCustomerRequest(payload, request)
  const customer = { collection: 'customers' as const, id: user.id }
  return {
    assetStore: new PayloadCustomerDomainAssetStore(req, customer),
    customer,
    quoteStore: new PayloadCustomerQuoteStore(req, customer),
    rules: await loadEnabledPricingRules(payload, req),
    snapshots: new PayloadPriceSnapshotStore(payload),
  }
}

export function createQuotePostHandler(dependencies: QuotePostDependencies) {
  return async function quotePost(request: Request): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const context = await dependencies.resolveContext(request)
      const input = quoteCreateRequestSchema.parse(await readJsonBody(request))
      const result = await (dependencies.createQuote ?? createCustomerQuote)(input, {
        ...context,
        provider: dependencies.provider,
        traceId,
      })
      return successResponse(quoteCreationResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createQuotePostHandler({ provider, resolveContext: defaultContext })
