import config from '@payload-config'
import { getPayload } from 'payload'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { vipOperationalPromotionSchema } from '@/schemas/vip-tiers'
import { systemAdminRequest } from '@/services/auth/admin-session'
import { promoteCustomerVipTier } from '@/services/vip/tiers'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = vipOperationalPromotionSchema.parse(await readAdminCommerceBody(request))
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse(await promoteCustomerVipTier(req, input), traceId, { status: 201 })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
