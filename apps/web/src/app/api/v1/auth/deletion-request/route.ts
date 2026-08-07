import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { customerDeletionRequestSchema, customerDeletionResponseSchema } from '@/schemas/auth'
import {
  authenticatedCustomerRequest,
  clearCustomerCookie,
  requestCustomerDeletion,
} from '@/services/auth/otp'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    customerDeletionRequestSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    const result = await requestCustomerDeletion(req, user)
    return successResponse(customerDeletionResponseSchema.parse(result), traceId, {
      headers: { 'set-cookie': clearCustomerCookie() },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
