import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { adminApprovalRequestIdSchema } from '@/schemas/admin-approvals'
import { executeSupportedAdminOperation } from '@/services/admin/operation-executors'
import { systemAdminRequest } from '@/services/auth/admin-session'

export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    const { requestId } = adminApprovalRequestIdSchema.parse(await context.params)
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse(await executeSupportedAdminOperation(req, requestId), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
