import {
  commitTransaction,
  initTransaction,
  killTransaction,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { decryptSecret, encryptSecret, hmac, randomOpaqueToken } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import type { AdminRole } from '@/lib/domain'
import type { Admin } from '@/payload-types'
import type { AdminInvitationCreateInput } from '@/schemas/auth'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

import { safeAdminSummary } from './admin-session'
import {
  createTotp,
  createTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCodes,
  validateTotpAt,
} from './totp'

const INVITATION_TTL_MILLISECONDS = 24 * 60 * 60 * 1_000

type Invitation = {
  consumedAt?: string | null
  createdAt: string
  email: string
  expiresAt: string
  id: number
  purpose: 'mfa_reset' | 'new_admin'
  revokedAt?: string | null
  roles: AdminRole[]
  targetAdmin?: { id: number } | number | null
  tokenHash: string
  totpSecretEncrypted: string
}

function relationId(value: Invitation['targetAdmin']): number | null {
  if (value === null || value === undefined) return null
  return typeof value === 'object' ? value.id : value
}

export function safeInvitationSummary(invitation: Invitation) {
  const pending =
    !invitation.consumedAt &&
    !invitation.revokedAt &&
    new Date(invitation.expiresAt).getTime() > Date.now()
  return {
    consumedAt: invitation.consumedAt ?? null,
    createdAt: invitation.createdAt,
    email: invitation.email,
    expiresAt: invitation.expiresAt,
    id: invitation.id,
    pending,
    purpose: invitation.purpose,
    revokedAt: invitation.revokedAt ?? null,
    roles: invitation.roles,
    targetAdminId: relationId(invitation.targetAdmin),
  }
}

function invitationTokenHash(token: string): string {
  return hmac(token, getEnv().SESSION_PEPPER)
}

function assertUsable(invitation: Invitation | undefined): asserts invitation is Invitation {
  if (
    !invitation ||
    invitation.consumedAt ||
    invitation.revokedAt ||
    new Date(invitation.expiresAt).getTime() <= Date.now()
  ) {
    throw new AppError('ADMIN_INVITATION_INVALID', '邀请无效或已过期', 401)
  }
}

async function findInvitation(payload: Payload, token: string, req?: PayloadRequest) {
  const result = await payload.find({
    collection: 'adminInvitations',
    limit: 1,
    overrideAccess: true,
    ...(req ? { req } : {}),
    where: { tokenHash: { equals: invitationTokenHash(token) } },
  })
  return result.docs[0] as Invitation | undefined
}

export async function listAdminInvitations(req: PayloadRequest) {
  const result = await req.payload.find({
    collection: 'adminInvitations',
    limit: 100,
    overrideAccess: true,
    req,
    sort: '-createdAt',
  })
  return result.docs.map((doc) => safeInvitationSummary(doc as Invitation))
}

export async function createAdminInvitation(
  req: PayloadRequest,
  input: AdminInvitationCreateInput,
) {
  let email: string
  let roles: AdminRole[]
  let targetAdmin: number | undefined

  if (input.purpose === 'new_admin') {
    const existing = await req.payload.count({
      collection: 'admins',
      overrideAccess: true,
      req,
      where: { email: { equals: input.email } },
    })
    if (existing.totalDocs) {
      throw new AppError('ADMIN_EMAIL_EXISTS', '该管理员邮箱已存在', 409)
    }
    email = input.email
    roles = input.roles
  } else {
    let admin: Admin
    try {
      admin = (await req.payload.findByID({
        collection: 'admins',
        id: input.targetAdminId,
        overrideAccess: true,
        req,
      })) as Admin
    } catch {
      throw new AppError('ADMIN_NOT_FOUND', '未找到管理员账号', 404)
    }
    email = admin.email
    roles = admin.roles
    targetAdmin = admin.id
  }

  const token = randomOpaqueToken()
  const secret = createTotpSecret()
  const now = new Date()
  const invitation = (await req.payload.create({
    collection: 'adminInvitations',
    data: {
      createdBy: req.user!.id,
      email,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MILLISECONDS).toISOString(),
      purpose: input.purpose,
      roles,
      targetAdmin,
      tokenHash: invitationTokenHash(token),
      totpSecretEncrypted: encryptSecret(secret, getEnv().TOTP_ENCRYPTION_KEY),
    },
    overrideAccess: true,
    req,
  })) as Invitation
  await recordAuditEvent(req, {
    action: 'admin.invitation.created',
    metadata: { purpose: invitation.purpose },
    targetId: invitation.id,
    targetType: 'admin-invitation',
  })
  const invitationUrl = new URL('/admin/enroll', getEnv().NEXT_PUBLIC_SERVER_URL)
  invitationUrl.hash = `token=${token}`
  return { invitation: safeInvitationSummary(invitation), invitationUrl: invitationUrl.toString() }
}

export async function revokeAdminInvitation(req: PayloadRequest, id: number | string) {
  const revoked = await req.payload.update({
    collection: 'adminInvitations',
    data: { revokedAt: new Date().toISOString() },
    overrideAccess: true,
    req,
    where: {
      and: [
        { id: { equals: id } },
        { consumedAt: { exists: false } },
        { revokedAt: { exists: false } },
      ],
    },
  })
  if (!revoked.docs.length) {
    throw new AppError('ADMIN_INVITATION_NOT_REVOCABLE', '邀请不存在或已失效', 409)
  }
  await recordAuditEvent(req, {
    action: 'admin.invitation.revoked',
    targetId: id,
    targetType: 'admin-invitation',
  })
  return safeInvitationSummary(revoked.docs[0] as Invitation)
}

export async function resolveAdminInvitation(payload: Payload, token: string) {
  const invitation = await findInvitation(payload, token)
  assertUsable(invitation)
  const secret = decryptSecret(invitation.totpSecretEncrypted, getEnv().TOTP_ENCRYPTION_KEY)
  return {
    invitation: safeInvitationSummary(invitation),
    provisioningUri: createTotp(secret, invitation.email).toString(),
  }
}

export async function acceptAdminInvitation(
  req: PayloadRequest,
  token: string,
  input: { password: string; totp: string },
) {
  const startedTransaction = await initTransaction(req)
  try {
    const invitation = await findInvitation(req.payload, token, req)
    assertUsable(invitation)
    const secret = decryptSecret(invitation.totpSecretEncrypted, getEnv().TOTP_ENCRYPTION_KEY)
    if (validateTotpAt(secret, input.totp) === null) {
      throw new AppError('ADMIN_INVITATION_TOTP_INVALID', 'TOTP 验证码无效', 401)
    }

    const now = new Date().toISOString()
    const consumed = await req.payload.update({
      collection: 'adminInvitations',
      data: { consumedAt: now },
      overrideAccess: true,
      req,
      where: {
        and: [
          { id: { equals: invitation.id } },
          { consumedAt: { exists: false } },
          { revokedAt: { exists: false } },
          { expiresAt: { greater_than: now } },
        ],
      },
    })
    if (!consumed.docs.length) {
      throw new AppError('ADMIN_INVITATION_INVALID', '邀请无效或已过期', 401)
    }

    const recoveryCodes = generateRecoveryCodes()
    let admin: Admin
    if (invitation.purpose === 'new_admin') {
      admin = (await req.payload.create({
        collection: 'admins',
        context: {
          adminAccountOperation: 'invitation',
          suppressAdminAccountAudit: true,
        },
        data: {
          email: invitation.email,
          password: input.password,
          roles: invitation.roles,
          status: 'active',
        },
        overrideAccess: true,
        req,
      })) as Admin
    } else {
      const targetId = relationId(invitation.targetAdmin)
      if (!targetId) throw new AppError('ADMIN_INVITATION_INVALID', '邀请数据不完整', 409)
      admin = (await req.payload.update({
        collection: 'admins',
        context: {
          adminAccountOperation: 'mfa-reset',
          suppressAdminAccountAudit: true,
        },
        data: { password: input.password },
        id: targetId,
        overrideAccess: true,
        req,
      })) as Admin
    }

    const existingCredential = await req.payload.find({
      collection: 'adminMfaCredentials',
      limit: 1,
      overrideAccess: true,
      req,
      where: { admin: { equals: admin.id } },
    })
    const credentialData = {
      admin: admin.id,
      configuredAt: now,
      failedAttempts: 0,
      lastUsedStep: null,
      lockedUntil: null,
      recoveryCodeHashes: hashRecoveryCodes(recoveryCodes),
      secretEncrypted: encryptSecret(secret, getEnv().TOTP_ENCRYPTION_KEY),
      version: 0,
    }
    if (existingCredential.docs[0]) {
      await req.payload.update({
        collection: 'adminMfaCredentials',
        data: credentialData,
        id: existingCredential.docs[0].id,
        overrideAccess: true,
        req,
      })
    } else {
      await req.payload.create({
        collection: 'adminMfaCredentials',
        data: credentialData,
        overrideAccess: true,
        req,
      })
    }
    req.user = admin
    await recordAuditEvent(req, {
      action:
        invitation.purpose === 'mfa_reset'
          ? 'admin.mfa.reset_completed'
          : 'admin.invitation.accepted',
      metadata: { purpose: invitation.purpose },
      targetId: admin.id,
      targetType: 'admin',
    })

    if (startedTransaction) await commitTransaction(req)
    return { admin: safeAdminSummary(admin), recoveryCodes }
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    throw error
  }
}
