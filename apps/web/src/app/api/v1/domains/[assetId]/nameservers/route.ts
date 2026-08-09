import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'
import { z } from 'zod'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { nameserverChangeRequestSchema, nameserverChangeResultSchema } from '@/schemas/domains'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { requestCustomerNameserverChange } from '@/services/domains/nameserver-changes'

export const runtime = 'nodejs'

const assetIdSchema = z.coerce.number().int().positive()
const MAX_BODY_BYTES = 4_096

type Context = {
  customer: { collection: 'customers'; id: number; status?: string }
  req: PayloadRequest
}

type Dependencies = {
  requestChange?: typeof requestCustomerNameserverChange
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
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON Name Server 请求', 415)
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    throw new AppError('NAMESERVER_REQUEST_TOO_LARGE', 'Name Server 请求过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('NAMESERVER_REQUEST_TOO_LARGE', 'Name Server 请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

export function createNameserverChangeHandler(dependencies: Dependencies) {
  return async function nameserverChange(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const input = nameserverChangeRequestSchema.parse(await readBody(request))
      const result = await (dependencies.requestChange ?? requestCustomerNameserverChange)(
        authenticated.req,
        assetIdSchema.parse(assetId),
        input,
        { customer: authenticated.customer, traceId },
      )
      return successResponse(nameserverChangeResultSchema.parse(result), traceId, { status: 202 })
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createNameserverChangeHandler({ resolveContext: defaultContext })
