import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { getEnv } from '@/lib/env'

type WechatApiError = { errcode?: number; errmsg?: string }

export type WechatEvent = {
  event: 'SCAN' | 'subscribe'
  eventKey: string
  fromUserName: string
}

export interface WechatOfficialProvider {
  createTemporaryQr(input: {
    expiresSeconds: number
    scene: string
    traceId: string
  }): Promise<{ expiresSeconds: number; requestId: string; ticket: string; url: string }>
  exchangeOAuthCode(input: {
    code: string
    traceId: string
  }): Promise<{ openid: string; requestId: string }>
  sendLoginConfirmation(input: {
    confirmationUrl: string
    deviceSummary: string
    openid: string
    traceId: string
  }): Promise<{ requestId: string }>
  sendSecurityNotice(input: {
    content?: string
    openid: string
    traceId: string
  }): Promise<{ requestId: string }>
}

function requireWechatOfficialLiveConfiguration(): {
  appId: string
  appSecret: string
} {
  const env = getEnv()
  const missing = [
    'WECHAT_OFFICIAL_APP_ID',
    'WECHAT_OFFICIAL_APP_SECRET',
    'WECHAT_OFFICIAL_CALLBACK_TOKEN',
    'WECHAT_OFFICIAL_ENCODING_AES_KEY',
    'WECHAT_OFFICIAL_OAUTH_DOMAIN',
  ].filter((key) => !process.env[key]?.trim())
  if (missing.length > 0) {
    throw new Error(`Wechat Official live configuration is missing: ${missing.join(', ')}`)
  }
  return { appId: env.WECHAT_OFFICIAL_APP_ID!, appSecret: env.WECHAT_OFFICIAL_APP_SECRET! }
}

async function boundedJson<T>(response: Response): Promise<T> {
  const maxBytes = getEnv().WECHAT_OFFICIAL_RESPONSE_MAX_BYTES
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('WECHAT_RESPONSE_TOO_LARGE')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new Error('WECHAT_RESPONSE_TOO_LARGE')
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as T
}

function apiFailure(body: WechatApiError): never {
  throw new Error(`WECHAT_OFFICIAL_API_${String(body.errcode ?? 'INVALID')}`)
}

class FixtureWechatOfficialProvider implements WechatOfficialProvider {
  async exchangeOAuthCode(input: { code: string; traceId: string }) {
    const digest = createHmac('sha256', getEnv().SESSION_PEPPER).update(input.code).digest('hex')
    return { openid: `fixture-${digest}`, requestId: `wechat-oauth-fixture-${input.traceId}` }
  }

  async createTemporaryQr(input: { expiresSeconds: number; scene: string; traceId: string }) {
    const ticket = createHmac('sha256', getEnv().SESSION_PEPPER).update(input.scene).digest('hex')
    return {
      expiresSeconds: input.expiresSeconds,
      requestId: `wechat-qr-fixture-${input.traceId}`,
      ticket,
      url: `https://fixture.invalid/qrcode/${encodeURIComponent(ticket)}`,
    }
  }

  async sendLoginConfirmation(input: { traceId: string }) {
    return { requestId: `wechat-confirm-fixture-${input.traceId}` }
  }

  async sendSecurityNotice(input: { traceId: string }) {
    return { requestId: `wechat-security-fixture-${input.traceId}` }
  }
}

let cachedAccessToken: { expiresAt: number; token: string } | undefined

class LiveWechatOfficialProvider implements WechatOfficialProvider {
  private readonly appId: string
  private readonly appSecret: string

  constructor() {
    const configuration = requireWechatOfficialLiveConfiguration()
    this.appId = configuration.appId
    this.appSecret = configuration.appSecret
  }

  private async request(url: URL, init?: RequestInit) {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(getEnv().WECHAT_OFFICIAL_TIMEOUT_MS),
    })
  }

  private async accessToken(): Promise<string> {
    if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
      return cachedAccessToken.token
    }
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token')
    url.searchParams.set('grant_type', 'client_credential')
    url.searchParams.set('appid', this.appId)
    url.searchParams.set('secret', this.appSecret)
    const response = await this.request(url)
    const body = await boundedJson<WechatApiError & { access_token?: string; expires_in?: number }>(
      response,
    )
    if (!response.ok || !body.access_token || !body.expires_in) apiFailure(body)
    cachedAccessToken = {
      expiresAt: Date.now() + Math.max(60, body.expires_in - 120) * 1_000,
      token: body.access_token,
    }
    return body.access_token
  }

  async exchangeOAuthCode(input: { code: string; traceId: string }) {
    const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
    url.searchParams.set('appid', this.appId)
    url.searchParams.set('secret', this.appSecret)
    url.searchParams.set('code', input.code)
    url.searchParams.set('grant_type', 'authorization_code')
    const response = await this.request(url)
    const body = await boundedJson<WechatApiError & { openid?: string }>(response)
    if (!response.ok || !body.openid) apiFailure(body)
    return { openid: body.openid, requestId: input.traceId }
  }

  async createTemporaryQr(input: { expiresSeconds: number; scene: string; traceId: string }) {
    if (!getEnv().ALLOW_REAL_PROVIDER_WRITES || !getEnv().ALLOW_REAL_WECHAT_OFFICIAL_MESSAGES) {
      throw new Error('WECHAT_OFFICIAL_WRITE_DISABLED')
    }
    const url = new URL('https://api.weixin.qq.com/cgi-bin/qrcode/create')
    url.searchParams.set('access_token', await this.accessToken())
    const response = await this.request(url, {
      body: JSON.stringify({
        action_info: { scene: { scene_str: input.scene } },
        action_name: 'QR_STR_SCENE',
        expire_seconds: input.expiresSeconds,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const body = await boundedJson<
      WechatApiError & { expire_seconds?: number; ticket?: string; url?: string }
    >(response)
    if (!response.ok || !body.ticket || !body.url) apiFailure(body)
    return {
      expiresSeconds: body.expire_seconds ?? input.expiresSeconds,
      requestId: input.traceId,
      ticket: body.ticket,
      url: body.url,
    }
  }

  private async sendText(openid: string, content: string, traceId: string) {
    if (!getEnv().ALLOW_REAL_PROVIDER_WRITES || !getEnv().ALLOW_REAL_WECHAT_OFFICIAL_MESSAGES) {
      throw new Error('WECHAT_OFFICIAL_WRITE_DISABLED')
    }
    const url = new URL('https://api.weixin.qq.com/cgi-bin/message/custom/send')
    url.searchParams.set('access_token', await this.accessToken())
    const response = await this.request(url, {
      body: JSON.stringify({ msgtype: 'text', text: { content }, touser: openid }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    const body = await boundedJson<WechatApiError>(response)
    if (!response.ok || body.errcode !== 0) apiFailure(body)
    return { requestId: traceId }
  }

  async sendLoginConfirmation(input: {
    confirmationUrl: string
    deviceSummary: string
    openid: string
    traceId: string
  }) {
    return this.sendText(
      input.openid,
      `正在登录 Wanmi.AI\n设备：${input.deviceSummary}\n请确认：${input.confirmationUrl}`,
      input.traceId,
    )
  }

  async sendSecurityNotice(input: { content?: string; openid: string; traceId: string }) {
    return this.sendText(
      input.openid,
      input.content ?? 'Wanmi.AI 账号的登录身份刚刚发生变更。如非本人操作，请立即联系人工支持。',
      input.traceId,
    )
  }
}

export function createWechatOfficialProvider(): WechatOfficialProvider {
  return getEnv().WECHAT_OFFICIAL_MODE === 'live'
    ? new LiveWechatOfficialProvider()
    : new FixtureWechatOfficialProvider()
}

export function wechatOAuthAuthorizationUrl(input: { redirectUri: string; state: string }): string {
  const appId = getEnv().WECHAT_OFFICIAL_APP_ID ?? 'fixture-app'
  const url = new URL('https://open.weixin.qq.com/connect/oauth2/authorize')
  url.searchParams.set('appid', appId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'snsapi_base')
  url.searchParams.set('state', input.state)
  return `${url.toString()}#wechat_redirect`
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{40}$/u.test(left) || !/^[a-f0-9]{40}$/u.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function signature(parts: string[]): string {
  return createHash('sha1')
    .update([...parts].sort().join(''))
    .digest('hex')
}

function xmlValue(xml: string, name: string): string | undefined {
  const match = xml.match(
    new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, 'u'),
  )
  return match?.[1]?.trim()
}

function decryptWechatMessage(encrypted: string): string {
  const env = getEnv()
  const encodedKey = env.WECHAT_OFFICIAL_ENCODING_AES_KEY
  const appId = env.WECHAT_OFFICIAL_APP_ID
  if (!encodedKey || !appId) throw new Error('WECHAT_CALLBACK_CONFIGURATION_MISSING')
  const key = Buffer.from(`${encodedKey}=`, 'base64')
  if (key.length !== 32) throw new Error('WECHAT_CALLBACK_AES_KEY_INVALID')
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const padded = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ])
  const padding = padded[padded.length - 1] ?? 0
  if (padding < 1 || padding > 32) throw new Error('WECHAT_CALLBACK_PADDING_INVALID')
  const plain = padded.subarray(0, padded.length - padding)
  if (plain.length < 20) throw new Error('WECHAT_CALLBACK_PAYLOAD_INVALID')
  const messageLength = plain.readUInt32BE(16)
  const messageEnd = 20 + messageLength
  if (messageEnd > plain.length) throw new Error('WECHAT_CALLBACK_PAYLOAD_INVALID')
  const message = plain.subarray(20, messageEnd).toString('utf8')
  if (plain.subarray(messageEnd).toString('utf8') !== appId) {
    throw new Error('WECHAT_CALLBACK_APP_ID_MISMATCH')
  }
  return message
}

export function verifyWechatCallback(input: {
  body: string
  nonce: string | null
  signatureValue: string | null
  timestamp: string | null
}): WechatEvent | null {
  const token = getEnv().WECHAT_OFFICIAL_CALLBACK_TOKEN
  if (!token || !input.nonce || !input.signatureValue || !input.timestamp) return null
  const encrypted = xmlValue(input.body, 'Encrypt')
  const expected = signature(
    encrypted
      ? [token, input.timestamp, input.nonce, encrypted]
      : [token, input.timestamp, input.nonce],
  )
  if (!safeDigestEqual(expected, input.signatureValue.toLowerCase())) return null
  const xml = encrypted ? decryptWechatMessage(encrypted) : input.body
  const event = xmlValue(xml, 'Event')
  const eventKey = xmlValue(xml, 'EventKey')
  const fromUserName = xmlValue(xml, 'FromUserName')
  if ((event !== 'SCAN' && event !== 'subscribe') || !eventKey || !fromUserName) return null
  return { event, eventKey, fromUserName }
}

export function verifyWechatCallbackEcho(input: {
  encrypted?: boolean
  echo: string
  nonce: string | null
  signatureValue: string | null
  timestamp: string | null
}): boolean {
  return resolveWechatCallbackEcho(input) !== null
}

export function resolveWechatCallbackEcho(input: {
  encrypted?: boolean
  echo: string
  nonce: string | null
  signatureValue: string | null
  timestamp: string | null
}): string | null {
  const token = getEnv().WECHAT_OFFICIAL_CALLBACK_TOKEN
  if (!token || !input.nonce || !input.signatureValue || !input.timestamp) return null
  const parts = input.encrypted
    ? [token, input.timestamp, input.nonce, input.echo]
    : [token, input.timestamp, input.nonce]
  if (!safeDigestEqual(signature(parts), input.signatureValue.toLowerCase())) return null
  try {
    return input.encrypted ? decryptWechatMessage(input.echo) : input.echo
  } catch {
    return null
  }
}
