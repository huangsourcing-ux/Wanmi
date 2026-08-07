import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  realnameDocumentIdSchema,
  realnameDocumentMutationResponseSchema,
} from '@/schemas/realname-documents'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { submitRealnameDocument } from '@/services/realname/documents'

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    const { documentId } = await context.params
    const parsedDocumentId = realnameDocumentIdSchema.parse(documentId)
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    const result = await submitRealnameDocument(req, parsedDocumentId)
    return successResponse(realnameDocumentMutationResponseSchema.parse(result), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
