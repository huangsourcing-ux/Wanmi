import config from '@payload-config'
import { getPayload } from 'payload'
import { z } from 'zod'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { getRuntimeWechatPayProvider } from '@/providers/wechatpay'
import { paymentRecoveryRequestSchema } from '@/schemas/admin-commerce'
import { systemAdminRequest } from '@/services/auth/admin-session'
import { replayArchivedWechatPaymentNotification } from '@/services/commerce/payments'

export const runtime = 'nodejs'

const notificationIdSchema = z.string().trim().min(3).max(128)

export async function POST(
  request: Request,
  context: { params: Promise<{ notificationId: string }> },
) {
  const traceId = getTraceId(request.headers)
  try {
    const input = paymentRecoveryRequestSchema.parse(await readAdminCommerceBody(request))
    const { notificationId } = await context.params
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    const result = await replayArchivedWechatPaymentNotification(
      req,
      notificationIdSchema.parse(notificationId),
      { ...input, provider: getRuntimeWechatPayProvider(), traceId },
    )
    return successResponse(result, getTraceId(req.headers))
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
