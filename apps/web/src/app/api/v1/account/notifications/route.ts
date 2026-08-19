import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { listCustomerNotifications } from '@/services/notifications/outbox'

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    return successResponse({ notifications: await listCustomerNotifications(req) }, traceId, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
