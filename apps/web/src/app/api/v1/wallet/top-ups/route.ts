import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'

import { AppError, getTraceId, successResponse, toProblemDetails } from '@/lib/errors'
import { walletTopUpCreateRequestSchema, walletTopUpOrderResultSchema } from '@/schemas/wallet'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { createWalletTopUpOrder } from '@/services/wallet/top-ups'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 4_096

type Context = {
  customer: { collection: 'customers'; id: number; status?: string }
  req: PayloadRequest
}

type Dependencies = {
  createTopUp?: typeof createWalletTopUpOrder
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
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 充值请求', 415)
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    throw new AppError('WALLET_TOP_UP_REQUEST_TOO_LARGE', '充值请求过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('WALLET_TOP_UP_REQUEST_TOO_LARGE', '充值请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

export function createWalletTopUpPostHandler(dependencies: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const input = walletTopUpCreateRequestSchema.parse(await readBody(request))
      const result = await (dependencies.createTopUp ?? createWalletTopUpOrder)(
        authenticated.req,
        input,
        { customer: authenticated.customer },
      )
      return successResponse(walletTopUpOrderResultSchema.parse(result), traceId, { status: 201 })
    } catch (error) {
      const problem = toProblemDetails(error, traceId)
      const result = walletTopUpOrderResultSchema.parse({
        problem,
        state: problem.status === 429 ? 'rate_limited' : 'error',
      })
      return successResponse(result, traceId, { status: problem.status })
    }
  }
}

export const POST = createWalletTopUpPostHandler({ resolveContext: defaultContext })
