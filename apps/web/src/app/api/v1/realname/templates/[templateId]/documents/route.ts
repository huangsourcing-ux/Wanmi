import config from '@payload-config'
import { getPayload } from 'payload'

import { getEnv } from '@/lib/env'
import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  realnameDocumentSummarySchema,
  realnameTemplateIdSchema,
} from '@/schemas/realname-documents'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { uploadRealnameDocument } from '@/services/realname/documents'

export async function POST(request: Request, context: { params: Promise<{ templateId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
      throw new AppError('REALNAME_DOCUMENT_MULTIPART_REQUIRED', '请使用文件上传表单提交', 415)
    }
    const contentLength = Number(request.headers.get('content-length') ?? 0)
    if (
      Number.isFinite(contentLength) &&
      contentLength > getEnv().REALNAME_DOCUMENT_MAX_BYTES + 1024 * 1024
    ) {
      throw new AppError('REALNAME_DOCUMENT_TOO_LARGE', '证件文件超过大小限制', 413)
    }
    const { templateId } = await context.params
    const parsedTemplateId = realnameTemplateIdSchema.parse(templateId)
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      throw new AppError('REALNAME_DOCUMENT_FILE_REQUIRED', '请选择证件文件', 400)
    }
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    const result = await uploadRealnameDocument(req, {
      body: new Uint8Array(await file.arrayBuffer()),
      templateId: parsedTemplateId,
    })
    return successResponse(realnameDocumentSummarySchema.parse(result), traceId, { status: 201 })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
