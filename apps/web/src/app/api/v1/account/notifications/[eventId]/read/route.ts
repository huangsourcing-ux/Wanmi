import config from '@payload-config'
import { getPayload } from 'payload'
import { z } from 'zod'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { markCustomerNotificationRead } from '@/services/notifications/outbox'

const paramsSchema = z.object({ eventId: z.coerce.number().int().positive() })

export async function POST(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    const { eventId } = paramsSchema.parse(await context.params)
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    return successResponse(await markCustomerNotificationRead(req, eventId), traceId, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
