import config from '@payload-config'
import { getPayload } from 'payload'
import { z } from 'zod'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { salesStopResolutionSchema } from '@/schemas/balance-control'
import { systemAdminRequest } from '@/services/auth/admin-session'
import { resolvePaidOrderSalesStop } from '@/services/commerce/balance-control'

const orderNumberSchema = z.string().trim().min(1).max(80)

export async function POST(
  request: Request,
  context: { params: Promise<{ orderNumber: string }> },
) {
  const traceId = getTraceId(request.headers)
  try {
    const input = salesStopResolutionSchema.parse(await readAdminCommerceBody(request))
    const { orderNumber } = await context.params
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    const result = await resolvePaidOrderSalesStop(req, orderNumberSchema.parse(orderNumber), input)
    return successResponse(result, getTraceId(req.headers))
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
