import config from '@payload-config'
import { getPayload } from 'payload'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { notificationPreferenceUpdateSchema } from '@/schemas/admin-approvals'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { updateNotificationPreference } from '@/services/notifications/outbox'

export async function PATCH(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = notificationPreferenceUpdateSchema.parse(await readAdminCommerceBody(request))
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    return successResponse(await updateNotificationPreference(req, input), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
