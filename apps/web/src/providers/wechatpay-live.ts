import { getEnv } from '@/lib/env'
import { assertLiveRuntimeTransportAllowed } from '@/lib/provider-write-guardrails'
import { readBoundedBody } from '@/providers/read-control'
import type {
  WechatPayTransport,
  WechatPayTransportRequest,
  WechatPayTransportResponse,
} from '@/providers/wechatpay'

const WECHATPAY_ORIGIN = 'https://api.mch.weixin.qq.com'
const ALLOWED_REQUESTS = [
  ['POST', /^\/v3\/pay\/transactions\/(?:native|h5)$/u],
  ['POST', /^\/v3\/pay\/transactions\/out-trade-no\/[A-Za-z0-9_*-]{1,32}\/close$/u],
  [
    'GET',
    /^\/v3\/pay\/transactions\/out-trade-no\/[A-Za-z0-9_*-]{1,32}\?mchid=[A-Za-z0-9_-]{1,32}$/u,
  ],
  ['POST', /^\/v3\/refund\/domestic\/refunds$/u],
  ['GET', /^\/v3\/refund\/domestic\/refunds\/[A-Za-z0-9_*-]{1,64}$/u],
] as const

function requestAllowed(request: WechatPayTransportRequest): boolean {
  return ALLOWED_REQUESTS.some(
    ([method, pattern]) => request.method === method && pattern.test(request.path),
  )
}

export class LiveWechatPayTransport implements WechatPayTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {
    assertLiveRuntimeTransportAllowed('wechatpay')
  }

  async request(input: WechatPayTransportRequest): Promise<WechatPayTransportResponse> {
    if (!requestAllowed(input)) throw new Error('Wechat Pay transport path is not allowlisted')
    const env = getEnv()
    const response = await this.fetchImpl(`${WECHATPAY_ORIGIN}${input.path}`, {
      body: input.method === 'POST' ? input.body : undefined,
      headers: {
        accept: 'application/json',
        authorization: input.authorization,
        ...(input.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        'user-agent': 'Wanmi.AI/1.0',
        'x-request-id': input.traceId,
      },
      method: input.method,
      redirect: 'error',
      signal: AbortSignal.timeout(env.WECHATPAY_TIMEOUT_MS),
    })
    const bytes = await readBoundedBody(response, env.WECHATPAY_RESPONSE_MAX_BYTES)
    return {
      body: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      headers: new Headers(response.headers),
      status: response.status,
    }
  }
}
