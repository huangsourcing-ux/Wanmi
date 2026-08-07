import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { logoutSchema } from '@/schemas/auth'
import { clearCustomerCookie, rawCustomerToken, revokeSessions } from '@/services/auth/otp'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = logoutSchema.parse(await request.json().catch(() => ({})))
    const payload = await getPayload({ config })
    const req = await createLocalReq({ req: { headers: request.headers } }, payload)
    await revokeSessions(req, rawCustomerToken(request.headers), input.scope)
    return successResponse({ loggedOut: true, scope: input.scope }, traceId, {
      headers: { 'set-cookie': clearCustomerCookie() },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
