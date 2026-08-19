import config from '@payload-config'
import { getPayload } from 'payload'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { adminApprovalPolicyUpdateSchema } from '@/schemas/admin-approvals'
import {
  readAdminApprovalPolicy,
  updateAdminApprovalPolicy,
} from '@/services/admin/approval-policy'
import { systemAdminRequest } from '@/services/auth/admin-session'

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse({ value: await readAdminApprovalPolicy(req) }, traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}

export async function PATCH(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = adminApprovalPolicyUpdateSchema.parse(await readAdminCommerceBody(request))
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse(await updateAdminApprovalPolicy(req, input), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
