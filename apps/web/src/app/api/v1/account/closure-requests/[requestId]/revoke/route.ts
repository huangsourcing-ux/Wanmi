import config from '@payload-config'
import { getPayload } from 'payload'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  accountClosureRequestIdSchema,
  accountClosureRevokeResponseSchema,
  accountClosureRevokeSchema,
} from '@/schemas/auth'
import { revokeAccountClosure } from '@/services/auth/account-closure'
import { authenticatedCustomerRequest } from '@/services/auth/otp'

const MAX_BODY_BYTES = 4_096

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 账户关闭撤销请求', 415)
  }
  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES) {
    throw new AppError('ACCOUNT_CLOSURE_REQUEST_TOO_LARGE', '账户关闭请求过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('ACCOUNT_CLOSURE_REQUEST_TOO_LARGE', '账户关闭请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    const requestId = accountClosureRequestIdSchema.parse((await context.params).requestId)
    const input = accountClosureRevokeSchema.parse(await readBody(request))
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    const result = await revokeAccountClosure(req, user, { reason: input.reason, requestId })
    return successResponse(accountClosureRevokeResponseSchema.parse(result), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
