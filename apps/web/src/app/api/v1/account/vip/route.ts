import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { readCustomerVipStatus } from '@/services/vip/tiers'

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    return successResponse(await readCustomerVipStatus(req), traceId, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
