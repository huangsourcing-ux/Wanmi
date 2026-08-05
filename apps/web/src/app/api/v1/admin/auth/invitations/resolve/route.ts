import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { adminInvitationBearerSchema, adminInvitationResolveResponseSchema } from '@/schemas/auth'
import { resolveAdminInvitation } from '@/services/auth/admin-invitations'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const token = adminInvitationBearerSchema.parse(request.headers.get('authorization'))
    const payload = await getPayload({ config })
    return successResponse(
      adminInvitationResolveResponseSchema.parse(await resolveAdminInvitation(payload, token)),
      traceId,
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
