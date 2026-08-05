import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  adminInvitationCreateResponseSchema,
  adminInvitationCreateSchema,
  adminInvitationListResponseSchema,
} from '@/schemas/auth'
import { createAdminInvitation, listAdminInvitations } from '@/services/auth/admin-invitations'
import { systemAdminRequest } from '@/services/auth/admin-session'

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse(
      adminInvitationListResponseSchema.parse({ invitations: await listAdminInvitations(req) }),
      traceId,
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = adminInvitationCreateSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse(
      adminInvitationCreateResponseSchema.parse(await createAdminInvitation(req, input)),
      traceId,
      { status: 201 },
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
