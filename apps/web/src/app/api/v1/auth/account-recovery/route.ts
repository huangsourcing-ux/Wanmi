import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { accountRecoveryRequestResponseSchema, accountRecoveryRequestSchema } from '@/schemas/auth'
import { submitAccountRecoveryRequest } from '@/services/auth/account-recovery'

const MAX_BODY_BYTES = 4_096

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 账户找回请求', 415)
  }
  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES) {
    throw new AppError('ACCOUNT_RECOVERY_REQUEST_TOO_LARGE', '账户找回请求过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('ACCOUNT_RECOVERY_REQUEST_TOO_LARGE', '账户找回请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = accountRecoveryRequestSchema.parse(await readBody(request))
    const payload = await getPayload({ config })
    const req = await createLocalReq({ req: { headers: request.headers } }, payload)
    const result = await submitAccountRecoveryRequest(req, input)
    return successResponse(accountRecoveryRequestResponseSchema.parse(result), traceId, {
      status: 202,
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
