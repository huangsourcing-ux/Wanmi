import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { smsRequestSchema } from '@/schemas/auth'
import { requestOtp } from '@/services/auth/otp'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = smsRequestSchema.parse(await request.json())
    const payload = await getPayload({ config })
    return successResponse(await requestOtp(payload, input, request.headers, traceId), traceId, {
      status: 202,
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
