import config from '@payload-config'
import { getPayload } from 'payload'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { adminInvitationIdParamsSchema, adminInvitationRevokeResponseSchema } from '@/schemas/auth'
import { revokeAdminInvitation } from '@/services/auth/admin-invitations'
import { systemAdminRequest } from '@/services/auth/admin-session'

type Args = { params: Promise<{ id: string }> }

export async function DELETE(request: Request, { params }: Args) {
  const traceId = getTraceId(request.headers)
  try {
    const { id: invitationId } = adminInvitationIdParamsSchema.parse(await params)
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse(
      adminInvitationRevokeResponseSchema.parse({
        invitation: await revokeAdminInvitation(req, invitationId),
      }),
      traceId,
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
