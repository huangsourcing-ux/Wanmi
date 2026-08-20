import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { invitationCodeDisableResponseSchema } from '@/schemas/auth'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { disableCustomerInvitationCode } from '@/services/invitations/binding'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    return successResponse(
      invitationCodeDisableResponseSchema.parse(await disableCustomerInvitationCode(req)),
      traceId,
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
