import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { wechatQrConfirmSchema } from '@/schemas/auth'
import { confirmWechatQr } from '@/services/auth/wechat'

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = wechatQrConfirmSchema.parse(await request.json())
    const payload = await getPayload({ config })
    const req = await createLocalReq({ req: { headers: request.headers } }, payload)
    return successResponse(await confirmWechatQr(req, input.confirmationToken), traceId)
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
