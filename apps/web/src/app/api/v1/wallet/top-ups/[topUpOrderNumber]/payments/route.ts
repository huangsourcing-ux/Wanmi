import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'

import { AppError, getTraceId, successResponse, toProblemDetails } from '@/lib/errors'
import type { PaymentProvider } from '@/providers/types'
import { getRuntimeWechatPayProvider } from '@/providers/wechatpay'
import { paymentCreateRequestSchema, paymentSessionResultSchema } from '@/schemas/payments'
import { walletTopUpOrderResultSchema } from '@/schemas/wallet'
import { clientIp } from '@/services/auth/client-facts'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import {
  createWalletTopUpPayment,
  queryAndConfirmWalletTopUpPayment,
} from '@/services/wallet/top-ups'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 4_096

type Context = {
  customer: { collection: 'customers'; id: number; status?: string }
  req: PayloadRequest
}

type Dependencies = {
  createPayment?: typeof createWalletTopUpPayment
  provider: PaymentProvider
  queryPayment?: typeof queryAndConfirmWalletTopUpPayment
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

export function createWalletTopUpPaymentRouteHandlers(dependencies: Dependencies) {
  return {
    GET: async (
      request: Request,
      context: { params: Promise<{ topUpOrderNumber: string }> },
    ): Promise<Response> => {
      const traceId = getTraceId(request.headers)
      try {
        const { topUpOrderNumber } = await context.params
        const authenticated = await dependencies.resolveContext(request)
        const result = await (dependencies.queryPayment ?? queryAndConfirmWalletTopUpPayment)(
          authenticated.req,
          topUpOrderNumber,
          {
            customer: authenticated.customer,
            provider: dependencies.provider,
            traceId,
          },
        )
        return successResponse(walletTopUpOrderResultSchema.parse(result), traceId)
      } catch (error) {
        const problem = toProblemDetails(error, traceId)
        const result = walletTopUpOrderResultSchema.parse({
          problem,
          state: problem.status === 429 ? 'rate_limited' : 'error',
        })
        return successResponse(result, traceId, { status: problem.status })
      }
    },
    POST: async (
      request: Request,
      context: { params: Promise<{ topUpOrderNumber: string }> },
    ): Promise<Response> => {
      const traceId = getTraceId(request.headers)
      try {
        const { topUpOrderNumber } = await context.params
        const authenticated = await dependencies.resolveContext(request)
        const input = paymentCreateRequestSchema.parse(await readBody(request))
        const result = await (dependencies.createPayment ?? createWalletTopUpPayment)(
          authenticated.req,
          topUpOrderNumber,
          input,
          {
            clientIp: input.channel === 'h5' ? clientIp(request.headers) : undefined,
            customer: authenticated.customer,
            provider: dependencies.provider,
            traceId,
          },
        )
        return successResponse(paymentSessionResultSchema.parse(result), traceId, { status: 201 })
      } catch (error) {
        const problem = toProblemDetails(error, traceId)
        const result = paymentSessionResultSchema.parse({
          problem,
          state: problem.status === 429 ? 'rate_limited' : 'error',
        })
        return successResponse(result, traceId, { status: problem.status })
      }
    },
  }
}

const handlers = createWalletTopUpPaymentRouteHandlers({
  provider: getRuntimeWechatPayProvider(),
  resolveContext: defaultContext,
})

export const GET = handlers.GET
export const POST = handlers.POST
