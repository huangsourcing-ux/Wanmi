import config from '@payload-config'
import { getPayload } from 'payload'

import { AppError, problemResponse, successResponse } from '@/lib/errors'
import { createTraceId, getTraceId } from '@/lib/request-id'
import { contentWorkflowInputSchema } from '@/schemas/content'
import { authenticatedAdminRequest } from '@/services/auth/admin-session'
import { executeContentWorkflow } from '@/services/content/workflow'
import { isContentCollection } from '@/services/content/types'

const MAX_BODY_BYTES = 2_048

export async function POST(
  request: Request,
  { params }: { params: Promise<{ collection: string; id: string }> },
) {
  const errorTraceId = createTraceId()
  try {
    const { collection, id } = await params
    if (!isContentCollection(collection)) {
      throw new AppError('CONTENT_COLLECTION_NOT_FOUND', '未找到内容类型', 404)
    }
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 工作流请求', 415)
    }
    const contentLength = request.headers.get('content-length')
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      throw new AppError('CONTENT_WORKFLOW_BODY_TOO_LARGE', '工作流请求过大', 413)
    }
    const body = await request.text()
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      throw new AppError('CONTENT_WORKFLOW_BODY_TOO_LARGE', '工作流请求过大', 413)
    }
    let candidate: unknown
    try {
      candidate = JSON.parse(body) as unknown
    } catch {
      throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
    }

    const payload = await getPayload({ config })
    const { req } = await authenticatedAdminRequest(payload, request)
    const result = await executeContentWorkflow(
      req,
      collection,
      id,
      contentWorkflowInputSchema.parse(candidate),
    )
    return successResponse(result, getTraceId(req.headers))
  } catch (error) {
    return problemResponse(error, errorTraceId)
  }
}
