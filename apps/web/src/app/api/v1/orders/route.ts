import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import type { WestDigitalReadProvider } from '@/providers/types'
import { createConfiguredWestDigitalReadProvider } from '@/providers/westdigital'
import { orderCreateRequestSchema, orderCreationResultSchema } from '@/schemas/orders'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { createCustomerOrder } from '@/services/commerce/order-creation'
import { runtimeProviderObservability } from '@/services/observability/runtime'

export const runtime = 'nodejs'

const MAX_REQUEST_BODY_BYTES = 4_096
const provider = createConfiguredWestDigitalReadProvider({
  logger: runtimeProviderObservability.logger,
})

type OrderPostDependencies = {
  createOrder?: typeof createCustomerOrder
  provider: WestDigitalReadProvider
  resolveContext: (request: Request) => Promise<{
    customer: { collection: 'customers'; id: number; status?: string }
    req: PayloadRequest
  }>
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 订单请求', 415)
  }
  const declaredLength = request.headers.get('content-length')
  if (declaredLength && Number(declaredLength) > MAX_REQUEST_BODY_BYTES) {
    throw new AppError('ORDER_REQUEST_TOO_LARGE', '订单请求过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new AppError('ORDER_REQUEST_TOO_LARGE', '订单请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

async function defaultContext(request: Request) {
  const payload = await getPayload({ config })
  const { req, user } = await authenticatedCustomerRequest(payload, request)
  return {
    customer: {
      collection: 'customers' as const,
      id: user.id,
      status: user.status,
    },
    req,
  }
}

export function createOrderPostHandler(dependencies: OrderPostDependencies) {
  return async function orderPost(request: Request): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const context = await dependencies.resolveContext(request)
      const input = orderCreateRequestSchema.parse(await readJsonBody(request))
      const result = await (dependencies.createOrder ?? createCustomerOrder)(context.req, input, {
        customer: context.customer,
        provider: dependencies.provider,
        traceId,
      })
      return successResponse(orderCreationResultSchema.parse(result), traceId, { status: 201 })
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createOrderPostHandler({ provider, resolveContext: defaultContext })
