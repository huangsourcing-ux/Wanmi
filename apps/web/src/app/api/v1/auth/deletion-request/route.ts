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
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    const input = customerDeletionRequestSchema.parse(await request.json())
    const result = await requestCustomerDeletion(req, user, input)
    return successResponse(customerDeletionResponseSchema.parse(result), traceId, {
      headers: { 'set-cookie': clearCustomerCookie() },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
