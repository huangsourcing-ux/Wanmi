import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { defaultCustomerProfileTypeSchema } from '@/schemas/auth'
import { changeDefaultCustomerProfileType } from '@/services/auth/customer-identities'
import { authenticatedCustomerRequest } from '@/services/auth/otp'

export async function PATCH(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = defaultCustomerProfileTypeSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    return successResponse(
      await changeDefaultCustomerProfileType(req, user, input.defaultCustomerProfileType),
      traceId,
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
