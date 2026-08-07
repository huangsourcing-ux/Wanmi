import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  realnameDocumentAccessRequestSchema,
  realnameDocumentAccessResponseSchema,
  realnameDocumentIdSchema,
} from '@/schemas/realname-documents'
import { systemAdminRequest } from '@/services/auth/admin-session'
import { createAdminRealnameDocumentAccess } from '@/services/realname/documents'

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    const { documentId } = await context.params
    const parsedDocumentId = realnameDocumentIdSchema.parse(documentId)
    const input = realnameDocumentAccessRequestSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    const result = await createAdminRealnameDocumentAccess(req, parsedDocumentId, input.mode)
    return successResponse(realnameDocumentAccessResponseSchema.parse(result), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
