import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  legacyProfileCompletionResponseSchema,
  legacyProfileCompletionSchema,
} from '@/schemas/privacy'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { completeLegacyCustomerProfile } from '@/services/privacy/customer-consents'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = legacyProfileCompletionSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    const result = await completeLegacyCustomerProfile(req, user, input)
    return successResponse(legacyProfileCompletionResponseSchema.parse(result), traceId, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
