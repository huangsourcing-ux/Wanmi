import config from '@payload-config'
import { getPayload } from 'payload'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { adminSessionIdParamsSchema, adminSessionRevokeResponseSchema } from '@/schemas/auth'
import {
  clearAdminCookie,
  findAdminForSessionManagement,
  revokeAdminSessions,
  systemAdminRequest,
} from '@/services/auth/admin-session'

type Args = { params: Promise<{ adminId: string; sessionId: string }> }

export async function DELETE(request: Request, { params }: Args) {
  const traceId = getTraceId(request.headers)
  try {
    const { adminId: id, sessionId: sid } = adminSessionIdParamsSchema.parse(await params)
    const payload = await getPayload({ config })
    const { req, user } = await systemAdminRequest(payload, request)
    const admin = await findAdminForSessionManagement(req, id)
    const result = await revokeAdminSessions(req, user, admin, sid)
    return successResponse(
      adminSessionRevokeResponseSchema.parse({
        adminId: admin.id,
        revoked: true,
        sessions: result.sessions,
      }),
      traceId,
      result.clearCookie ? { headers: { 'set-cookie': clearAdminCookie(payload) } } : undefined,
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
