import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { getEnv } from '@/lib/env'
import { getTraceId, problemResponse } from '@/lib/errors'
import { resolveWechatCallbackEcho, verifyWechatCallback } from '@/providers/wechatofficial'
import { handleWechatQrEvent } from '@/services/auth/wechat'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const echo = url.searchParams.get('echostr') ?? ''
  const resolved = resolveWechatCallbackEcho({
    encrypted: url.searchParams.get('encrypt_type') === 'aes',
    echo,
    nonce: url.searchParams.get('nonce'),
    signatureValue: url.searchParams.get('msg_signature') ?? url.searchParams.get('signature'),
    timestamp: url.searchParams.get('timestamp'),
  })
  return new Response(resolved ?? 'invalid signature', {
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
    status: resolved === null ? 401 : 200,
  })
}

export async function POST(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const maxBytes = getEnv().WECHAT_OFFICIAL_RESPONSE_MAX_BYTES
    const body = await request.text()
    if (Buffer.byteLength(body, 'utf8') > maxBytes)
      return new Response('payload too large', { status: 413 })
    const url = new URL(request.url)
    const event = verifyWechatCallback({
      body,
      nonce: url.searchParams.get('nonce'),
      signatureValue: url.searchParams.get('msg_signature') ?? url.searchParams.get('signature'),
      timestamp: url.searchParams.get('timestamp'),
    })
    if (!event) return new Response('invalid signature', { status: 401 })
    const payload = await getPayload({ config })
    const req = await createLocalReq({ req: { headers: request.headers } }, payload)
    await handleWechatQrEvent(req, event, traceId)
    return new Response('success', {
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
