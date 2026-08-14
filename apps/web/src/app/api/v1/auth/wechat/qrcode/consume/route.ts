import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { wechatQrConsumeSchema } from '@/schemas/auth'
import { authenticatedCustomerRequest, customerCookie } from '@/services/auth/otp'
import { authFlowToken, consumeWechatQr } from '@/services/auth/wechat'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = wechatQrConsumeSchema.parse(await request.json())
    const flow = authFlowToken(request.headers)
    if (flow.created) {
      throw new AppError('WECHAT_AUTH_FLOW_REQUIRED', '二维码浏览器会话已失效', 401)
    }
    const payload = await getPayload({ config })
    const authenticated = await authenticatedCustomerRequest(payload, request).catch(
      () => undefined,
    )
    const req =
      authenticated?.req ?? (await createLocalReq({ req: { headers: request.headers } }, payload))
    const result = await consumeWechatQr(req, {
      ...input,
      flowToken: flow.token,
      headers: request.headers,
      traceId,
    })
    if (result.kind === 'authenticated') {
      return successResponse(
        { customer: result.customer, expiresAt: result.expiresAt, kind: result.kind },
        traceId,
        { headers: { 'set-cookie': customerCookie(result.token, result.expiresAt) } },
      )
    }
    return successResponse(result, traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
