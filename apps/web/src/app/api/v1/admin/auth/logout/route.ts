import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { adminLogoutResponseSchema, logoutSchema } from '@/schemas/auth'
import {
  authenticatedAdminRequest,
  clearAdminCookie,
  revokeAdminSessions,
} from '@/services/auth/admin-session'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const { scope } = logoutSchema.parse(await request.json().catch(() => ({})))
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedAdminRequest(payload, request)
    await revokeAdminSessions(req, user, user, scope === 'current' ? user._sid : undefined)
    return successResponse(adminLogoutResponseSchema.parse({ loggedOut: true, scope }), traceId, {
      headers: { 'set-cookie': clearAdminCookie(payload) },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
