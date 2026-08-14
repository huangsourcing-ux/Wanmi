import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { identityIdParamsSchema } from '@/schemas/auth'
import { unbindCustomerIdentity } from '@/services/auth/customer-identities'
import { authenticatedCustomerRequest } from '@/services/auth/otp'

export async function DELETE(
  request: Request,
  context: { params: Promise<{ identityId: string }> },
) {
  const traceId = getTraceId(request.headers)
  try {
    const { identityId } = identityIdParamsSchema.parse(await context.params)
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    return successResponse(await unbindCustomerIdentity(req, user, identityId, traceId), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
