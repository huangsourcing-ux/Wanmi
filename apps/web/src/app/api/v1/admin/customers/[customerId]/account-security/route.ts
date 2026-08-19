import config from '@payload-config'
import { getPayload } from 'payload'
import { z } from 'zod'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  adminCustomerAccountActionSchema,
  customerAccountStateResponseSchema,
  customerSessionSecurityResponseSchema,
} from '@/schemas/auth'
import {
  revokeCustomerSessionsForSecurityEvent,
  transitionCustomerAccount,
} from '@/services/auth/account-state'
import { createAdminApprovalRequest } from '@/services/admin/approvals'
import { systemAdminRequest } from '@/services/auth/admin-session'

const customerIdSchema = z.coerce.number().int().positive()
const MAX_BODY_BYTES = 8_192

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 账号安全请求', 415)
  }
  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_BODY_BYTES) {
    throw new AppError('ACCOUNT_SECURITY_REQUEST_TOO_LARGE', '账号安全请求过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('ACCOUNT_SECURITY_REQUEST_TOO_LARGE', '账号安全请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

export async function POST(request: Request, context: { params: Promise<{ customerId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    const input = adminCustomerAccountActionSchema.parse(await readBody(request))
    const customerId = customerIdSchema.parse((await context.params).customerId)
    const payload = await getPayload({ config })
    const { req, user } = await systemAdminRequest(payload, request)
    const actor = { id: user.id, type: 'admin' as const }
    if (input.action === 'revoke_sessions') {
      const result = await revokeCustomerSessionsForSecurityEvent(req, {
        actor,
        customerId,
        evidence: input.evidence,
        reason: input.reason,
      })
      return successResponse(customerSessionSecurityResponseSchema.parse(result), traceId)
    }
    if (
      input.status === 'active' &&
      (input.expectedStatus === 'restricted' || input.expectedStatus === 'suspended')
    ) {
      const approval = await createAdminApprovalRequest(req, {
        customerId,
        evidenceReference: input.evidence.reference,
        expectedRestrictions: input.expectedRestrictions,
        expectedStatus: input.expectedStatus,
        operationType: 'high_risk_account_unfreeze',
        reasonNote: input.reason,
      })
      return successResponse(approval, traceId, { status: 201 })
    }
    const result = await transitionCustomerAccount(req, {
      actor,
      customerId,
      evidence: input.evidence,
      expectedRestrictions: input.expectedRestrictions,
      expectedStatus: input.expectedStatus,
      reason: input.reason,
      restrictions: input.restrictions,
      status: input.status,
    })
    return successResponse(customerAccountStateResponseSchema.parse(result), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
