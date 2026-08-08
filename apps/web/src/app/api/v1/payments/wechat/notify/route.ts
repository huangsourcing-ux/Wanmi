import config from '@payload-config'
import { createLocalReq, getPayload, type PayloadRequest } from 'payload'

import { AppError, getTraceId, problemResponse } from '@/lib/errors'
import type { PaymentProvider } from '@/providers/types'
import { getRuntimeWechatPayProvider } from '@/providers/wechatpay'
import { processWechatPaymentNotification } from '@/services/commerce/payments'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 1_048_576

type Dependencies = {
  provider: PaymentProvider
  resolveRequest: (request: Request) => Promise<PayloadRequest>
}

async function defaultRequest(request: Request): Promise<PayloadRequest> {
  const payload = await getPayload({ config })
  return createLocalReq({ req: { headers: request.headers } }, payload)
}

async function readBody(request: Request): Promise<string> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受微信支付 JSON 通知', 415)
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    throw new AppError('WECHATPAY_NOTIFICATION_TOO_LARGE', '支付通知过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('WECHATPAY_NOTIFICATION_TOO_LARGE', '支付通知过大', 413)
  }
  return body
}

export function createWechatNotificationPostHandler(dependencies: Dependencies) {
  return async function POST(request: Request): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const body = await readBody(request)
      const req = await dependencies.resolveRequest(request)
      await processWechatPaymentNotification(
        req,
        { body, headers: request.headers, traceId },
        dependencies.provider,
      )
      return Response.json(
        { code: 'SUCCESS', message: '成功' },
        {
          headers: { 'cache-control': 'no-store', 'x-request-id': traceId },
          status: 200,
        },
      )
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createWechatNotificationPostHandler({
  provider: getRuntimeWechatPayProvider(),
  resolveRequest: defaultRequest,
})
