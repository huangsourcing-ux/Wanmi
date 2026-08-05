import config from '@payload-config'
import { getPayload } from 'payload'

import { AppError, problemResponse, successResponse } from '@/lib/errors'
import { createTraceId } from '@/lib/request-id'
import { firstPartyEventSchema } from '@/schemas/analytics'
import { recordFirstPartyEvent } from '@/services/analytics/record-first-party-event'

const MAX_EVENT_BODY_BYTES = 4_096

function optedOut(headers: Headers): boolean {
  return headers.get('dnt') === '1' || headers.get('sec-gpc') === '1'
}

function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store' },
  })
}

async function readEventBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 事件', 415)
  }
  const contentLength = request.headers.get('content-length')
  if (contentLength) {
    const declaredBytes = Number(contentLength)
    if (!Number.isFinite(declaredBytes) || declaredBytes < 0) {
      throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
    }
    if (declaredBytes > MAX_EVENT_BODY_BYTES) {
      throw new AppError('EVENT_TOO_LARGE', '事件请求过大', 413)
    }
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_EVENT_BODY_BYTES) {
    throw new AppError('EVENT_TOO_LARGE', '事件请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

export async function POST(request: Request) {
  if (optedOut(request.headers)) return noContent()
  const errorTraceId = createTraceId()
  try {
    const candidate = firstPartyEventSchema.parse(await readEventBody(request))
    const payload = await getPayload({ config })
    const result = await recordFirstPartyEvent(payload, candidate)
    return successResponse({ accepted: true }, result.traceId, { status: 202 })
  } catch (error) {
    return problemResponse(error, errorTraceId)
  }
}
