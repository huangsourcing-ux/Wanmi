import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { wechatQrPollSchema } from '@/schemas/auth'
import { authFlowToken, pollWechatQr } from '@/services/auth/wechat'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = wechatQrPollSchema.parse(await request.json())
    const flow = authFlowToken(request.headers)
    if (flow.created) {
      throw new AppError('WECHAT_AUTH_FLOW_REQUIRED', '二维码浏览器会话已失效', 401)
    }
    const payload = await getPayload({ config })
    const req = await createLocalReq({ req: { headers: request.headers } }, payload)
    return successResponse(await pollWechatQr(req, input.scene, flow.token), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
