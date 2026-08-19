import config from '@payload-config'
import { getPayload } from 'payload'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  adminApprovalDecisionSchema,
  adminApprovalRequestIdSchema,
} from '@/schemas/admin-approvals'
import { decideAdminApprovalRequest } from '@/services/admin/approvals'
import { systemAdminRequest } from '@/services/auth/admin-session'

export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    const { requestId } = adminApprovalRequestIdSchema.parse(await context.params)
    const input = adminApprovalDecisionSchema.parse(await readAdminCommerceBody(request))
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse(await decideAdminApprovalRequest(req, requestId, input), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
