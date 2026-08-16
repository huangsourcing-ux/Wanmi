import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { personalInformationResponseSchema } from '@/schemas/privacy'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { readPersonalInformation } from '@/services/privacy/personal-information'

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    const result = await readPersonalInformation(req, { customerId: user.id, mode: 'view' })
    return successResponse(personalInformationResponseSchema.parse(result), traceId, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
