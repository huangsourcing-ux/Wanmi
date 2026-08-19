import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { systemAdminRequest } from '@/services/auth/admin-session'
import { listAdminNotificationDeliveries } from '@/services/notifications/outbox'

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse({ deliveries: await listAdminNotificationDeliveries(req) }, traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
