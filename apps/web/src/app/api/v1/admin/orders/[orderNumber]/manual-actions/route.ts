import config from '@payload-config'
import { getPayload } from 'payload'
import { z } from 'zod'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { manualOrderActionRequestSchema } from '@/schemas/admin-commerce'
import { systemAdminRequest } from '@/services/auth/admin-session'
import { recordManualOrderAction } from '@/services/commerce/manual-actions'

const orderNumberSchema = z.string().trim().min(1).max(80)

export async function POST(
  request: Request,
  context: { params: Promise<{ orderNumber: string }> },
) {
  const traceId = getTraceId(request.headers)
  try {
    const input = manualOrderActionRequestSchema.parse(await readAdminCommerceBody(request))
    const { orderNumber } = await context.params
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    const result = await recordManualOrderAction(req, orderNumberSchema.parse(orderNumber), input)
    return successResponse(result, getTraceId(req.headers), { status: 201 })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
