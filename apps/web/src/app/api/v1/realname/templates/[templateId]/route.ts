import config from '@payload-config'
import { getPayload } from 'payload'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { realnameTemplateIdSchema } from '@/schemas/realname-documents'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import {
  createRealnameTemplateSchema,
  disableRealnameTemplate,
  updateRejectedRealnameTemplate,
} from '@/services/realname/templates'

const MAX_BODY_BYTES = 16_384

function summary(template: Record<string, unknown> & { id: number | string }) {
  return {
    cleanupDueAt: template.cleanupDueAt,
    disabledAt: template.disabledAt,
    id: template.id,
    providerReviewState: template.providerReviewState,
    status: template.status,
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
) {
  const traceId = getTraceId(request.headers)
  try {
    const { templateId } = await context.params
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    const result = await disableRealnameTemplate(req, realnameTemplateIdSchema.parse(templateId))
    return successResponse(summary(result), getTraceId(req.headers))
  } catch (error) {
    return problemResponse(error, traceId)
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
) {
  const traceId = getTraceId(request.headers)
  try {
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 模板修改请求', 415)
    }
    const body = await request.text()
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      throw new AppError('REALNAME_TEMPLATE_BODY_TOO_LARGE', '实名模板修改请求过大', 413)
    }
    let candidate: unknown
    try {
      candidate = JSON.parse(body) as unknown
    } catch {
      throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
    }
    const { templateId } = await context.params
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    const result = await updateRejectedRealnameTemplate(
      req,
      realnameTemplateIdSchema.parse(templateId),
      createRealnameTemplateSchema.parse(candidate),
    )
    return successResponse(summary(result), getTraceId(req.headers))
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
