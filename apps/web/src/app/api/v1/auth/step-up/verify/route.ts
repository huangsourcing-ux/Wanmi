import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { stepUpGrantResponseSchema, stepUpVerifySchema } from '@/schemas/auth'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { verifyStepUpOtp } from '@/services/auth/step-up'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = stepUpVerifySchema.parse(await request.json())
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    const grant = await verifyStepUpOtp(req, user, input, request.headers)
    return successResponse(stepUpGrantResponseSchema.parse(grant), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
