import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { identityBindSchema } from '@/schemas/auth'
import { bindVerifiedIdentity } from '@/services/auth/customer-identities'
import { authenticatedCustomerRequest } from '@/services/auth/otp'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = identityBindSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    return successResponse(
      await bindVerifiedIdentity(req, user, input.registrationToken, traceId),
      traceId,
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
