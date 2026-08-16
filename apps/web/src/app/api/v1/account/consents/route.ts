import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { consentDecisionResponseSchema, customerConsentDecisionSchema } from '@/schemas/privacy'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { recordCustomerConsentDecision } from '@/services/privacy/customer-consents'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = customerConsentDecisionSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    const result = await recordCustomerConsentDecision(req, user, input)
    return successResponse(consentDecisionResponseSchema.parse(result), traceId, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
