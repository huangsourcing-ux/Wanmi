import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { smsVerifySchema } from '@/schemas/auth'
import { customerCookie, verifyOtp } from '@/services/auth/otp'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = smsVerifySchema.parse(await request.json())
    const payload = await getPayload({ config })
    const req = await createLocalReq({ req: { headers: request.headers } }, payload)
    const result = await verifyOtp(req, input, request.headers)
    if (result.kind === 'registration_required') {
      return successResponse(result, traceId)
    }
    return successResponse(
      { customer: result.customer, expiresAt: result.expiresAt, kind: result.kind },
      traceId,
      { headers: { 'set-cookie': customerCookie(result.token, result.expiresAt) } },
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
