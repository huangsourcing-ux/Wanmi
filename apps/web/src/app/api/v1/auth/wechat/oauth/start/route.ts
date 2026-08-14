import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { wechatOAuthStartSchema } from '@/schemas/auth'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { authFlowCookie, authFlowToken, startWechatOAuth } from '@/services/auth/wechat'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = wechatOAuthStartSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const flow = authFlowToken(request.headers)
    const authenticated =
      input.purpose === 'bind' ? await authenticatedCustomerRequest(payload, request) : undefined
    const req =
      authenticated?.req ?? (await createLocalReq({ req: { headers: request.headers } }, payload))
    const result = await startWechatOAuth(req, {
      bindingCustomer: authenticated?.user,
      flowToken: flow.token,
      purpose: input.purpose,
    })
    return successResponse(result, traceId, {
      headers: { 'set-cookie': authFlowCookie(flow.token) },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
