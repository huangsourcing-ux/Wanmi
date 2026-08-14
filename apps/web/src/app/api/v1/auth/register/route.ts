import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { getEnv } from '@/lib/env'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { customerRegistrationSchema } from '@/schemas/auth'
import { registerCustomer } from '@/services/auth/customer-identities'
import { customerCookie } from '@/services/auth/otp'

function cookieValue(headers: Headers, name: string): string | null {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return null
}

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = customerRegistrationSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const req = await createLocalReq({ req: { headers: request.headers } }, payload)
    const result = await registerCustomer(
      req,
      input,
      request.headers,
      cookieValue(request.headers, getEnv().CUSTOMER_AUTH_FLOW_COOKIE),
    )
    return successResponse(
      { customer: result.customer, expiresAt: result.expiresAt, kind: result.kind },
      traceId,
      { headers: { 'set-cookie': customerCookie(result.token, result.expiresAt) } },
    )
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
