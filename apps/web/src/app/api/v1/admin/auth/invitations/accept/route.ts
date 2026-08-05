import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  adminInvitationAcceptResponseSchema,
  adminInvitationAcceptSchema,
  adminInvitationBearerSchema,
} from '@/schemas/auth'
import { acceptAdminInvitation } from '@/services/auth/admin-invitations'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const token = adminInvitationBearerSchema.parse(request.headers.get('authorization'))
    const input = adminInvitationAcceptSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const req = await createLocalReq({ req: { headers: request.headers } }, payload)
    return successResponse(
      adminInvitationAcceptResponseSchema.parse(await acceptAdminInvitation(req, token, input)),
      traceId,
      { status: 201 },
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
