import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { invitationBindResponseSchema, invitationBindSchema } from '@/schemas/auth'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { bindCustomerInvitation } from '@/services/invitations/binding'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = invitationBindSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    const result = await bindCustomerInvitation(req, {
      code: input.invitationCode,
      deviceId: input.deviceId,
      headers: request.headers,
    })
    return successResponse(invitationBindResponseSchema.parse(result), traceId, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
