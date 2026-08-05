import config from '@payload-config'
import {
  createLocalReq,
  getPayload,
  loginOperation,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { generateExpiredPayloadCookie, generatePayloadCookie } from 'payload/shared'

import { hasRole, isActiveAdminUser } from '@/access/roles'
import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import type { AdminLoginInput } from '@/schemas/auth'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

import { auditAdminLoginSuccess } from './totp'

type AdminUser = {
  _sid?: string
  collection: 'admins'
  email: string
  id: number | string
  roles: ('content_editor' | 'ad_operator' | 'analyst' | 'system_admin')[]
  sessions?: { createdAt?: string | null; expiresAt: string; id: string }[] | null
  status: 'active' | 'disabled'
}

function adminCollection(payload: Payload) {
  return payload.collections.admins
}

function adminCookie(payload: Payload, token: string): string {
  return generatePayloadCookie({
    collectionAuthConfig: adminCollection(payload).config.auth,
    cookiePrefix: payload.config.cookiePrefix,
    token,
  })
}

export function clearAdminCookie(payload: Payload): string {
  return generateExpiredPayloadCookie({
    collectionAuthConfig: adminCollection(payload).config.auth,
    cookiePrefix: payload.config.cookiePrefix,
  })
}

export function safeAdminSummary(user: AdminUser) {
  return { email: user.email, id: user.id, roles: user.roles, status: user.status }
}

async function auditLoginFailure(payload: Payload, request: Request, email: string): Promise<void> {
  const req = await createLocalReq({ req: { headers: request.headers } }, payload)
  await recordAuditEvent(req, {
    action: 'admin.auth.login_failed',
    actor: { type: 'anonymous' },
    metadata: { emailHash: hmac(email, getEnv().SESSION_PEPPER) },
  })
}

export async function loginAdmin(request: Request, input: AdminLoginInput) {
  const payload = await getPayload({ config })
  const req = await createLocalReq(
    {
      context: {
        adminMfa: { recoveryCode: input.recoveryCode, totp: input.totp },
      },
      req: { headers: request.headers },
    },
    payload,
  )
  try {
    const result = await loginOperation({
      collection: adminCollection(payload),
      data: { email: input.email, password: input.password },
      overrideAccess: false,
      req,
    })
    if (!result.token || !result.user || !isActiveAdminUser(result.user)) {
      throw new AppError('ADMIN_AUTH_INVALID', '邮箱、密码或第二因素无效', 401)
    }
    await auditAdminLoginSuccess(req, result.user.id, input.recoveryCode ? 'recovery_code' : 'totp')
    return {
      admin: safeAdminSummary(result.user as AdminUser),
      cookie: adminCookie(payload, result.token),
    }
  } catch (error) {
    await auditLoginFailure(payload, request, input.email).catch((auditError: unknown) => {
      payload.logger.error({ err: auditError, msg: 'Failed to audit administrator login failure' })
    })
    if (error instanceof AppError && error.status >= 500) throw error
    throw new AppError('ADMIN_AUTH_INVALID', '邮箱、密码或第二因素无效', 401)
  }
}

export async function authenticatedAdminRequest(
  payload: Payload,
  request: Request,
): Promise<{ req: PayloadRequest; user: AdminUser }> {
  const req = await createLocalReq({ req: { headers: request.headers } }, payload)
  const result = await payload.auth({ headers: request.headers, req })
  if (!isActiveAdminUser(result.user)) {
    throw new AppError('ADMIN_AUTH_REQUIRED', '需要管理员身份验证', 401)
  }
  req.user = result.user
  return { req, user: result.user as AdminUser }
}

export async function systemAdminRequest(payload: Payload, request: Request) {
  const authenticated = await authenticatedAdminRequest(payload, request)
  if (!hasRole(authenticated.user, ['system_admin'])) {
    throw new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', '仅系统管理员可执行此操作', 403)
  }
  return authenticated
}

export function safeSessions(admin: AdminUser, currentSid?: string) {
  const now = Date.now()
  return (admin.sessions ?? [])
    .filter((session) => new Date(session.expiresAt).getTime() > now)
    .map((session) => ({
      createdAt: session.createdAt ?? null,
      current: session.id === currentSid,
      expiresAt: session.expiresAt,
      id: session.id,
    }))
    .sort((left, right) => right.expiresAt.localeCompare(left.expiresAt))
}

export async function findAdminForSessionManagement(
  req: PayloadRequest,
  id: number | string,
): Promise<AdminUser> {
  try {
    return (await req.payload.findByID({
      collection: 'admins',
      id,
      overrideAccess: true,
      req,
    })) as AdminUser
  } catch {
    throw new AppError('ADMIN_NOT_FOUND', '未找到管理员账号', 404)
  }
}

export async function revokeAdminSessions(
  req: PayloadRequest,
  actor: AdminUser,
  target: AdminUser,
  sessionId?: string,
) {
  const remaining = sessionId
    ? (target.sessions ?? []).filter((session) => session.id !== sessionId)
    : []
  await req.payload.update({
    collection: 'admins',
    context: { adminAccountOperation: 'security-hook' },
    data: { sessions: remaining },
    id: target.id,
    overrideAccess: true,
    req,
  })
  await recordAuditEvent(req, {
    action: sessionId ? 'admin.session.revoked' : 'admin.sessions.revoked_all',
    actor: { id: actor.id, type: 'admin' },
    metadata: {
      sessionIdHash: sessionId ? hmac(sessionId, getEnv().SESSION_PEPPER) : undefined,
    },
    targetId: target.id,
  })
  return {
    clearCookie:
      String(actor.id) === String(target.id) &&
      (!sessionId || Boolean(actor._sid && actor._sid === sessionId)),
    sessions: safeSessions({ ...target, sessions: remaining }, actor._sid),
  }
}
