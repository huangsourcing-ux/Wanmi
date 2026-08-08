import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'

import { clientIp } from '@/services/auth/client-facts'
import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import type { PaymentProvider } from '@/providers/types'
import { getRuntimeWechatPayProvider } from '@/providers/wechatpay'
import { paymentCreateRequestSchema, paymentStatusResultSchema } from '@/schemas/payments'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { createWechatPayment, queryAndConfirmWechatPayment } from '@/services/commerce/payments'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 4_096

type Context = {
  customer: { collection: 'customers'; id: number; status?: string }
  req: PayloadRequest
}

type Dependencies = {
  provider: PaymentProvider
  resolveContext: (request: Request) => Promise<Context>
}

async function defaultContext(request: Request): Promise<Context> {
  const payload = await getPayload({ config })
  const { req, user } = await authenticatedCustomerRequest(payload, request)
  return {
    customer: { collection: 'customers', id: user.id, status: user.status },
    req,
  }
}

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 支付请求', 415)
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES)
    throw new AppError('PAYMENT_REQUEST_TOO_LARGE', '支付请求过大', 413)
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('PAYMENT_REQUEST_TOO_LARGE', '支付请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

export function createPaymentRouteHandlers(dependencies: Dependencies) {
  return {
    GET: async (
      request: Request,
      context: { params: Promise<{ orderNumber: string }> },
    ): Promise<Response> => {
      const traceId = getTraceId(request.headers)
      try {
        const { orderNumber } = await context.params
        const authenticated = await dependencies.resolveContext(request)
        const result = await queryAndConfirmWechatPayment(authenticated.req, orderNumber, {
          customer: authenticated.customer,
          provider: dependencies.provider,
          traceId,
        })
        return successResponse(paymentStatusResultSchema.parse(result), traceId)
      } catch (error) {
        return problemResponse(error, traceId)
      }
    },
    POST: async (
      request: Request,
      context: { params: Promise<{ orderNumber: string }> },
    ): Promise<Response> => {
      const traceId = getTraceId(request.headers)
      try {
        const { orderNumber } = await context.params
        const authenticated = await dependencies.resolveContext(request)
        const input = paymentCreateRequestSchema.parse(await readBody(request))
        const result = await createWechatPayment(authenticated.req, orderNumber, input, {
          clientIp: input.channel === 'h5' ? clientIp(request.headers) : undefined,
          customer: authenticated.customer,
          provider: dependencies.provider,
          traceId,
        })
        return successResponse(result, traceId, { status: 201 })
      } catch (error) {
        return problemResponse(error, traceId)
      }
    },
  }
}

const handlers = createPaymentRouteHandlers({
  provider: getRuntimeWechatPayProvider(),
  resolveContext: defaultContext,
})

export const GET = handlers.GET
export const POST = handlers.POST
