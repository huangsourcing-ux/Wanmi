import config from '@payload-config'
import { getPayload } from 'payload'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  adminSessionAdminParamsSchema,
  adminSessionListResponseSchema,
  adminSessionRevokeResponseSchema,
} from '@/schemas/auth'
import {
  clearAdminCookie,
  findAdminForSessionManagement,
  revokeAdminSessions,
  safeSessions,
  systemAdminRequest,
} from '@/services/auth/admin-session'

type Args = { params: Promise<{ adminId: string }> }

export async function GET(request: Request, { params }: Args) {
  const traceId = getTraceId(request.headers)
  try {
    const { adminId: id } = adminSessionAdminParamsSchema.parse(await params)
    const payload = await getPayload({ config })
    const { req, user } = await systemAdminRequest(payload, request)
    const admin = await findAdminForSessionManagement(req, id)
    return successResponse(
      adminSessionListResponseSchema.parse({
        adminId: admin.id,
        sessions: safeSessions(admin, user._sid),
      }),
      traceId,
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}

export async function DELETE(request: Request, { params }: Args) {
  const traceId = getTraceId(request.headers)
  try {
    const { adminId: id } = adminSessionAdminParamsSchema.parse(await params)
    const payload = await getPayload({ config })
    const { req, user } = await systemAdminRequest(payload, request)
    const admin = await findAdminForSessionManagement(req, id)
    const result = await revokeAdminSessions(req, user, admin)
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
