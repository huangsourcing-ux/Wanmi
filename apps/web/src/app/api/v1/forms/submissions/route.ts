import config from '@payload-config'
import { getPayload } from 'payload'

import { AppError, getTraceId, successResponse, toProblemDetails } from '@/lib/errors'
import { publicFormSubmissionResultSchema } from '@/schemas/forms'
import { submitPublicForm } from '@/services/forms/form-submissions'

const MAX_FORM_BODY_BYTES = 16_384

async function readFormBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '表单只接受 JSON 请求', 415)
  }
  const contentLength = request.headers.get('content-length')
  if (contentLength) {
    const declaredBytes = Number(contentLength)
    if (!Number.isFinite(declaredBytes) || declaredBytes < 0) {
      throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
    }
    if (declaredBytes > MAX_FORM_BODY_BYTES) {
      throw new AppError('FORM_REQUEST_TOO_LARGE', '表单请求过大', 413)
    }
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_FORM_BODY_BYTES) {
    throw new AppError('FORM_REQUEST_TOO_LARGE', '表单请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

function formProblemResponse(error: unknown, traceId: string): Response {
  const problem = toProblemDetails(error, traceId)
  const result = publicFormSubmissionResultSchema.parse({
    problem,
    state: problem.status === 429 ? 'rate_limited' : 'error',
  })
  return successResponse(result, problem.traceId, {
    headers: {
      'content-type': 'application/json',
      ...(problem.retryAfterSeconds ? { 'retry-after': String(problem.retryAfterSeconds) } : {}),
    },
    status: problem.status,
  })
}

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const result = await submitPublicForm(
      payload,
      await readFormBody(request),
      request.headers,
      traceId,
    )
    return successResponse(publicFormSubmissionResultSchema.parse(result), traceId, { status: 202 })
  } catch (error) {
    return formProblemResponse(error, traceId)
  }
}
