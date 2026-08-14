import { hmac, randomOpaqueToken, decryptSecret } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import type { Customer } from '@/payload-types'
import { createCaptchaProvider, type CaptchaProvider } from '@/providers/aliyuncaptcha'
import {
  createWechatOfficialProvider,
  type WechatEvent,
  type WechatOfficialProvider,
  wechatOAuthAuthorizationUrl,
} from '@/providers/wechatofficial'
import type { WechatQrCreateInput } from '@/schemas/auth'
import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

import { authTransactionDatabase, inAuthTransaction } from './atomic'
import { clientHashes, userAgentSummary } from './client-facts'
import {
  authenticateVerifiedWechat,
  bindVerifiedIdentity,
  createRegistrationIntent,
  identityProviderInstance,
  protectedIdentifier,
  type IdentityAuthenticationResult,
} from './customer-identities'

type QrSceneRecord = {
  bindingCustomer?: number | Customer | null
  browserSessionHash: string
  confirmedAt?: string | null
  deviceSummary: string
  expiresAt: string
  id: number
  identifierEncrypted?: string | null
  identifierHash?: string | null
  providerInstanceId: string
  purpose: 'bind' | 'login'
  status: 'confirmed' | 'consumed' | 'created' | 'expired' | 'rejected' | 'scanned'
}

function relationId(value: number | Customer | null | undefined): number | undefined {
  return typeof value === 'object' && value ? value.id : (value ?? undefined)
}

export function authFlowToken(headers: Headers): { created: boolean; token: string } {
  const name = getEnv().CUSTOMER_AUTH_FLOW_COOKIE
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    const candidate = key === name ? decodeURIComponent(value.join('=')) : ''
    if (/^[A-Za-z0-9_-]{43}$/u.test(candidate)) return { created: false, token: candidate }
  }
  return { created: true, token: randomOpaqueToken() }
}

export function authFlowCookie(token: string): string {
  const env = getEnv()
  return `${env.CUSTOMER_AUTH_FLOW_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${env.CUSTOMER_AUTH_FLOW_SECONDS}; HttpOnly; Secure; SameSite=Lax`
}

export async function startWechatOAuth(
  req: PayloadRequest,
  input: {
    bindingCustomer?: Customer
    flowToken: string
    purpose: 'bind' | 'login'
  },
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  if (input.purpose === 'bind' && !input.bindingCustomer) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '绑定微信前需要登录', 401)
  }
  const state = randomOpaqueToken()
  const expiresAt = new Date(Date.now() + getEnv().CUSTOMER_AUTH_FLOW_SECONDS * 1_000).toISOString()
  await req.payload.create({
    collection: 'wechatOAuthStates',
    data: {
      bindingCustomer: input.bindingCustomer?.id,
      browserSessionHash: hmac(input.flowToken, getEnv().SESSION_PEPPER),
      expiresAt,
      providerInstanceId: identityProviderInstance('wechat'),
      purpose: input.purpose,
      stateHash: hmac(state, getEnv().SESSION_PEPPER),
    },
    overrideAccess: true,
    req,
  })
  const redirectUri = new URL(
    '/api/v1/auth/wechat/oauth/callback',
    getEnv().NEXT_PUBLIC_SERVER_URL,
  ).toString()
  return { authorizationUrl: wechatOAuthAuthorizationUrl({ redirectUri, state }), expiresAt }
}

async function claimOAuthState(
  req: PayloadRequest,
  input: { code: string; flowToken: string; state: string },
): Promise<{ bindingCustomer?: number; purpose: 'bind' | 'login' }> {
  return inAuthTransaction(req, async () => {
    const database = await authTransactionDatabase(req)
    const now = new Date().toISOString()
    const state = await database.execute(sql`
      UPDATE wechat_o_auth_states
      SET consumed_at = ${now}, updated_at = NOW()
      WHERE state_hash = ${hmac(input.state, getEnv().SESSION_PEPPER)}
        AND browser_session_hash = ${hmac(input.flowToken, getEnv().SESSION_PEPPER)}
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING id
    `)
    const stateId = state.rows?.[0]?.id
    if (typeof stateId !== 'number') {
      throw new AppError('WECHAT_OAUTH_STATE_INVALID', '微信授权状态无效或已使用', 401)
    }
    try {
      await req.payload.create({
        collection: 'wechatAuthorizationCodes',
        data: {
          codeHash: hmac(input.code, getEnv().SESSION_PEPPER),
          processedAt: now,
        },
        overrideAccess: true,
        req,
      })
    } catch {
      throw new AppError('WECHAT_OAUTH_CODE_REPLAYED', '微信授权码已使用', 401)
    }
    const record = await req.payload.findByID({
      collection: 'wechatOAuthStates',
      depth: 0,
      id: stateId,
      overrideAccess: true,
      req,
    })
    return { bindingCustomer: relationId(record.bindingCustomer), purpose: record.purpose }
  })
}

export async function completeWechatOAuth(
  req: PayloadRequest,
  input: {
    code: string
    flowToken: string
    headers: Headers
    state: string
    traceId: string
  },
  options: { provider?: WechatOfficialProvider } = {},
): Promise<IdentityAuthenticationResult | { identityId: number; kind: 'bound'; status: 'bound' }> {
  const claimed = await claimOAuthState(req, input)
  const exchanged = await (options.provider ?? createWechatOfficialProvider()).exchangeOAuthCode({
    code: input.code,
    traceId: input.traceId,
  })
  const flowHash = hmac(input.flowToken, getEnv().SESSION_PEPPER)
  const ipHash = clientHashes(input.headers, input.flowToken).ipHash
  if (claimed.purpose === 'bind') {
    if (!claimed.bindingCustomer || req.user?.collection !== 'customers') {
      throw new AppError('CUSTOMER_AUTH_REQUIRED', '绑定微信前需要登录', 401)
    }
    if (String(req.user.id) !== String(claimed.bindingCustomer)) {
      throw new AppError('WECHAT_OAUTH_BINDING_MISMATCH', '微信绑定会话不匹配', 403)
    }
    const intent = await createRegistrationIntent(req, {
      deviceHash: flowHash,
      identifier: exchanged.openid,
      ipHash,
      provider: 'wechat',
      source: 'wechat_oauth',
    })
    const bound = await bindVerifiedIdentity(
      req,
      req.user as Customer,
      intent.registrationToken,
      input.traceId,
    )
    return { ...bound, kind: 'bound' }
  }
  return inAuthTransaction(req, () =>
    authenticateVerifiedWechat(req, {
      deviceHash: flowHash,
      ipHash,
      openid: exchanged.openid,
      source: 'wechat_oauth',
    }),
  )
}

export async function createWechatQrScene(
  req: PayloadRequest,
  input: WechatQrCreateInput & {
    bindingCustomer?: Customer
    flowToken: string
    headers: Headers
    traceId: string
  },
  options: { captchaProvider?: CaptchaProvider; provider?: WechatOfficialProvider } = {},
): Promise<{ expiresAt: string; qrUrl: string; scene: string; status: 'created' }> {
  if (input.purpose === 'bind' && !input.bindingCustomer) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '绑定微信前需要登录', 401)
  }
  const captcha = await (options.captchaProvider ?? createCaptchaProvider()).verify({
    captchaVerifyParam: input.captchaVerifyParam,
    purpose: 'qrcode',
    traceId: input.traceId,
  })
  if (!captcha.ok) throw new AppError('CAPTCHA_REJECTED', '人机校验未通过', 403)

  const scene = randomOpaqueToken()
  const requestedTtl = getEnv().WECHAT_QR_TTL_SECONDS
  const qr = await (options.provider ?? createWechatOfficialProvider()).createTemporaryQr({
    expiresSeconds: requestedTtl,
    scene,
    traceId: input.traceId,
  })
  const expiresAt = new Date(
    Date.now() + Math.min(requestedTtl, qr.expiresSeconds) * 1_000,
  ).toISOString()
  await req.payload.create({
    collection: 'wechatLoginScenes',
    data: {
      bindingCustomer: input.bindingCustomer?.id,
      browserSessionHash: hmac(input.flowToken, getEnv().SESSION_PEPPER),
      deviceSummary: userAgentSummary(input.headers),
      expiresAt,
      pollCount: 0,
      providerInstanceId: identityProviderInstance('wechat'),
      providerTicketHash: hmac(qr.ticket, getEnv().SESSION_PEPPER),
      purpose: input.purpose,
      sceneHash: hmac(scene, getEnv().SESSION_PEPPER),
      status: 'created',
    },
    overrideAccess: true,
    req,
  })
  return { expiresAt, qrUrl: qr.url, scene, status: 'created' }
}

export async function handleWechatQrEvent(
  req: PayloadRequest,
  event: WechatEvent,
  traceId: string,
  options: { provider?: WechatOfficialProvider } = {},
): Promise<'discarded' | 'processed'> {
  const rawScene =
    event.event === 'subscribe' ? event.eventKey.replace(/^qrscene_/u, '') : event.eventKey
  if (!/^[A-Za-z0-9_-]{43}$/u.test(rawScene)) return 'discarded'
  const confirmationToken = randomOpaqueToken()
  const protectedOpenid = protectedIdentifier(event.fromUserName)
  const record = await inAuthTransaction(req, async () => {
    const database = await authTransactionDatabase(req)
    const now = new Date().toISOString()
    const updated = await database.execute(sql`
      UPDATE wechat_login_scenes
      SET
        confirmation_token_hash = ${hmac(confirmationToken, getEnv().SESSION_PEPPER)},
        identifier_encrypted = ${protectedOpenid.identifierEncrypted},
        identifier_hash = ${protectedOpenid.identifierHash},
        scanned_at = ${now},
        status = 'scanned',
        updated_at = NOW()
      WHERE scene_hash = ${hmac(rawScene, getEnv().SESSION_PEPPER)}
        AND status = 'created'
        AND expires_at > NOW()
      RETURNING id
    `)
    const id = updated.rows?.[0]?.id
    if (typeof id !== 'number') return undefined
    return (await req.payload.findByID({
      collection: 'wechatLoginScenes',
      depth: 0,
      id,
      overrideAccess: true,
      req,
    })) as unknown as QrSceneRecord
  })
  if (!record) return 'discarded'
  const confirmationUrl = new URL('/auth/wechat/confirm', getEnv().NEXT_PUBLIC_SERVER_URL)
  // Keep the one-time confirmation token in the URL fragment so reverse proxies and
  // ordinary HTTP access logs never receive it. The confirmation page submits it in
  // a no-store request body only after loading.
  confirmationUrl.hash = `token=${encodeURIComponent(confirmationToken)}`
  try {
    await (options.provider ?? createWechatOfficialProvider()).sendLoginConfirmation({
      confirmationUrl: confirmationUrl.toString(),
      deviceSummary: record.deviceSummary,
      openid: event.fromUserName,
      traceId,
    })
  } catch {
    await req.payload.db.pool.query(
      `UPDATE wechat_login_scenes
       SET status = 'rejected', rejected_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'scanned'`,
      [record.id],
    )
  }
  return 'processed'
}

export async function previewWechatQrConfirmation(
  req: PayloadRequest,
  rawToken: string,
): Promise<{ deviceSummary: string; message: '正在登录 Wanmi.AI'; status: 'scanned' }> {
  const result = await req.payload.find({
    collection: 'wechatLoginScenes',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { confirmationTokenHash: { equals: hmac(rawToken, getEnv().SESSION_PEPPER) } },
        { expiresAt: { greater_than: new Date().toISOString() } },
        { status: { equals: 'scanned' } },
      ],
    },
  })
  const record = result.docs[0]
  if (!record) throw new AppError('WECHAT_QR_CONFIRMATION_INVALID', '确认请求无效或已过期', 404)
  return { deviceSummary: record.deviceSummary, message: '正在登录 Wanmi.AI', status: 'scanned' }
}

export async function confirmWechatQr(
  req: PayloadRequest,
  rawToken: string,
): Promise<{ status: 'confirmed' }> {
  return inAuthTransaction(req, async () => {
    const database = await authTransactionDatabase(req)
    const now = new Date().toISOString()
    const updated = await database.execute(sql`
      UPDATE wechat_login_scenes
      SET confirmed_at = ${now}, status = 'confirmed', updated_at = NOW()
      WHERE confirmation_token_hash = ${hmac(rawToken, getEnv().SESSION_PEPPER)}
        AND status = 'scanned'
        AND expires_at > NOW()
      RETURNING id
    `)
    if (typeof updated.rows?.[0]?.id !== 'number') {
      throw new AppError('WECHAT_QR_CONFIRMATION_INVALID', '确认请求无效或已过期', 409)
    }
    return { status: 'confirmed' }
  })
}

async function sceneForBrowser(
  req: PayloadRequest,
  scene: string,
  flowToken: string,
): Promise<QrSceneRecord> {
  const result = await req.payload.find({
    collection: 'wechatLoginScenes',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { sceneHash: { equals: hmac(scene, getEnv().SESSION_PEPPER) } },
        { browserSessionHash: { equals: hmac(flowToken, getEnv().SESSION_PEPPER) } },
      ],
    },
  })
  const record = result.docs[0] as unknown as QrSceneRecord | undefined
  if (!record) throw new AppError('WECHAT_QR_SCENE_INVALID', '二维码登录会话无效', 404)
  return record
}

export async function pollWechatQr(
  req: PayloadRequest,
  scene: string,
  flowToken: string,
): Promise<{ expiresAt: string; status: QrSceneRecord['status'] }> {
  const record = await sceneForBrowser(req, scene, flowToken)
  if (
    new Date(record.expiresAt).getTime() <= Date.now() &&
    !['consumed', 'rejected'].includes(record.status)
  ) {
    await req.payload.db.pool.query(
      `UPDATE wechat_login_scenes
       SET status = 'expired', updated_at = NOW()
       WHERE id = $1 AND status IN ('created', 'scanned', 'confirmed')`,
      [record.id],
    )
    return { expiresAt: record.expiresAt, status: 'expired' }
  }
  const cutoff = new Date(Date.now() - getEnv().WECHAT_QR_POLL_MIN_INTERVAL_MS).toISOString()
  const updated = await req.payload.db.pool.query<{ status: QrSceneRecord['status'] }>(
    `UPDATE wechat_login_scenes
     SET poll_count = poll_count + 1, last_polled_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND (last_polled_at IS NULL OR last_polled_at <= $2)
     RETURNING status`,
    [record.id, cutoff],
  )
  if (updated.rowCount !== 1) {
    throw new AppError('WECHAT_QR_POLL_RATE_LIMITED', '轮询过于频繁', 429, {
      retryAfterSeconds: 1,
    })
  }
  return { expiresAt: record.expiresAt, status: updated.rows[0]!.status }
}

export async function consumeWechatQr(
  req: PayloadRequest,
  input: {
    deviceId: string
    flowToken: string
    headers: Headers
    scene: string
    traceId: string
  },
): Promise<IdentityAuthenticationResult | { identityId: number; kind: 'bound'; status: 'bound' }> {
  const record = await inAuthTransaction(req, async () => {
    const database = await authTransactionDatabase(req)
    const now = new Date().toISOString()
    const consumed = await database.execute(sql`
      UPDATE wechat_login_scenes
      SET consumed_at = ${now}, status = 'consumed', updated_at = NOW()
      WHERE scene_hash = ${hmac(input.scene, getEnv().SESSION_PEPPER)}
        AND browser_session_hash = ${hmac(input.flowToken, getEnv().SESSION_PEPPER)}
        AND status = 'confirmed'
        AND expires_at > NOW()
      RETURNING id
    `)
    const id = consumed.rows?.[0]?.id
    if (typeof id !== 'number') {
      throw new AppError('WECHAT_QR_ALREADY_CONSUMED', '二维码未确认、已失效或已使用', 409)
    }
    return (await req.payload.findByID({
      collection: 'wechatLoginScenes',
      depth: 0,
      id,
      overrideAccess: true,
      req,
    })) as unknown as QrSceneRecord
  })
  if (!record.identifierEncrypted) {
    throw new AppError('WECHAT_QR_IDENTITY_MISSING', '二维码身份信息缺失', 409)
  }
  const openid = decryptSecret(
    record.identifierEncrypted,
    getEnv().CUSTOMER_IDENTITY_ENCRYPTION_KEY ?? getEnv().TOTP_ENCRYPTION_KEY,
  )
  const flowHash = hmac(input.flowToken, getEnv().SESSION_PEPPER)
  const ipHash = clientHashes(input.headers, input.deviceId).ipHash
  if (record.purpose === 'bind') {
    const bindingCustomerId = relationId(record.bindingCustomer)
    if (
      !bindingCustomerId ||
      req.user?.collection !== 'customers' ||
      String(req.user.id) !== String(bindingCustomerId)
    ) {
      throw new AppError('WECHAT_QR_BINDING_MISMATCH', '二维码绑定会话不匹配', 403)
    }
    const intent = await createRegistrationIntent(req, {
      deviceHash: flowHash,
      identifier: openid,
      ipHash,
      provider: 'wechat',
      source: 'wechat_qrcode',
    })
    const bound = await bindVerifiedIdentity(
      req,
      req.user as Customer,
      intent.registrationToken,
      input.traceId,
    )
    return { ...bound, kind: 'bound' }
  }
  return inAuthTransaction(req, () =>
    authenticateVerifiedWechat(req, {
      deviceHash: flowHash,
      ipHash,
      openid,
      source: 'wechat_qrcode',
    }),
  )
}
