import config from '@payload-config'
import { getPayload } from 'payload'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { adminApprovalCreateSchema } from '@/schemas/admin-approvals'
import { createAdminApprovalRequest, listAdminApprovalRequests } from '@/services/admin/approvals'
import { systemAdminRequest } from '@/services/auth/admin-session'

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse({ requests: await listAdminApprovalRequests(req) }, traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = adminApprovalCreateSchema.parse(await readAdminCommerceBody(request))
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse(await createAdminApprovalRequest(req, input), traceId, { status: 201 })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
