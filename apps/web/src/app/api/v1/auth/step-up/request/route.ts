import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { stepUpRequestSchema } from '@/schemas/auth'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { requestStepUpOtp } from '@/services/auth/step-up'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = stepUpRequestSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const { req, user } = await authenticatedCustomerRequest(payload, request)
    return successResponse(
      await requestStepUpOtp(req, user, input, request.headers, traceId),
      traceId,
      { status: 202 },
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
