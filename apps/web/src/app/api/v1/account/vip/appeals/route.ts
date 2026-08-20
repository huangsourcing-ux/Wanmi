import config from '@payload-config'
import { getPayload } from 'payload'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { vipTierAppealCreateSchema } from '@/schemas/vip-tiers'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { recordVipTierCorrectionAppeal } from '@/services/vip/tiers'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = vipTierAppealCreateSchema.parse(await readAdminCommerceBody(request))
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    return successResponse(await recordVipTierCorrectionAppeal(req, input), traceId, {
      status: 201,
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
