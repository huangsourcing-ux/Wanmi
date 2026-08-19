import config from '@payload-config'
import { getPayload } from 'payload'
import { z } from 'zod'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { accountRecoveryDecisionSchema } from '@/schemas/auth'
import { createAdminApprovalRequest } from '@/services/admin/approvals'
import { systemAdminRequest } from '@/services/auth/admin-session'

const MAX_BODY_BYTES = 8_192
const reviewIdSchema = z.coerce.number().int().positive()

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 账户找回审核请求', 415)
  }
  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES) {
    throw new AppError('ACCOUNT_RECOVERY_REVIEW_TOO_LARGE', '账户找回审核请求过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('ACCOUNT_RECOVERY_REVIEW_TOO_LARGE', '账户找回审核请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}

export async function POST(request: Request, context: { params: Promise<{ reviewId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    const decision = accountRecoveryDecisionSchema.parse(await readBody(request))
    const reviewId = reviewIdSchema.parse((await context.params).reviewId)
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    const review = await req.payload.findByID({
      collection: 'manualReviews',
      depth: 0,
      id: reviewId,
      overrideAccess: true,
      req,
    })
    const customerId = Number(review.customer)
    if (
      !Number.isSafeInteger(customerId) ||
      customerId <= 0 ||
      review.reasonCode !== 'customer_account_recovery' ||
      review.status !== 'open'
    ) {
      throw new AppError('ACCOUNT_RECOVERY_REVIEW_INVALID', '账户找回审核不可用', 409)
    }
    const result = await createAdminApprovalRequest(req, {
      customerId,
      decision: decision.conclusion,
      operationType: 'account_recovery',
      reasonNote: decision.note,
      reviewId,
    })
    return successResponse(result, traceId, { status: 201 })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
