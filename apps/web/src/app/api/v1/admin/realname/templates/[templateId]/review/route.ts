import config from '@payload-config'
import { getPayload } from 'payload'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { realnameTemplateIdSchema } from '@/schemas/realname-documents'
import { systemAdminRequest } from '@/services/auth/admin-session'
import {
  manualReviewResolutionSchema,
  resolveRealnameManualReview,
} from '@/services/realname/templates'

const MAX_BODY_BYTES = 4_096

export async function POST(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 人工复核请求', 415)
    }
    const body = await request.text()
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      throw new AppError('REALNAME_REVIEW_BODY_TOO_LARGE', '人工复核请求过大', 413)
    }
    let candidate: unknown
    try {
      candidate = JSON.parse(body) as unknown
    } catch {
      throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
    }
    const { templateId } = await context.params
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    const result = await resolveRealnameManualReview(
      req,
      realnameTemplateIdSchema.parse(templateId),
      manualReviewResolutionSchema.parse(candidate),
    )
    return successResponse(
      {
        id: result.id,
        providerReviewState: result.providerReviewState,
        status: result.status,
      },
      getTraceId(req.headers),
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
