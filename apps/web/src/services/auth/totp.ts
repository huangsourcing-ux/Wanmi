import { randomBytes } from 'node:crypto'

import * as OTPAuth from 'otpauth'
import {
  createLocalReq,
  type CollectionBeforeLoginHook,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { decryptSecret, hmac, safeEqualHex } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { getTraceId } from '@/lib/request-id'

const TOTP_ALGORITHM = 'SHA1'
const TOTP_DIGITS = 6
const TOTP_PERIOD_SECONDS = 30
const TOTP_WINDOW = 1
const MFA_MAX_ATTEMPTS = 5
const MFA_LOCK_MILLISECONDS = 10 * 60 * 1000

type Credential = {
  admin: { id: number | string } | number | string
  failedAttempts: number
  id: number | string
  lastUsedStep?: number | null
  lockedUntil?: string | null
  recoveryCodeHashes: string[]
  secretEncrypted: string
  version: number
}

type AdminMfaContext = {
  adminMfa?: { recoveryCode?: string; totp?: string }
  adminMfaMethod?: 'recovery_code' | 'totp'
}

function adminId(credential: Credential): number | string {
  return typeof credential.admin === 'object' ? credential.admin.id : credential.admin
}

async function findCredential(
  payload: Payload,
  id: number | string,
  req?: PayloadRequest,
): Promise<Credential | undefined> {
  const result = await payload.find({
    collection: 'adminMfaCredentials',
    limit: 1,
    overrideAccess: true,
    ...(req ? { req } : {}),
    where: { admin: { equals: id } },
  })
  return result.docs[0] as Credential | undefined
}

function isLocked(credential: Credential, now = Date.now()): boolean {
  return Boolean(credential.lockedUntil && new Date(credential.lockedUntil).getTime() > now)
}

async function writeMfaAudit(
  payload: Payload,
  req: PayloadRequest,
  action: string,
  targetId: number | string,
  metadata?: Record<string, unknown>,
) {
  await payload.create({
    collection: 'auditLogs',
    data: {
      action,
      actorId: String(targetId),
      actorType: 'admin',
      metadata,
      targetId: String(targetId),
      targetType: 'admin',
      traceId: getTraceId(req.headers),
    },
    overrideAccess: true,
    req,
  })
}

async function registerFailedFactor(
  payload: Payload,
  req: PayloadRequest,
  initial: Credential,
): Promise<void> {
  let credential = initial
  const failureReq = await createLocalReq({ req: { headers: req.headers } }, payload)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (isLocked(credential)) return
    const previousLockExpired = Boolean(
      credential.lockedUntil && new Date(credential.lockedUntil).getTime() <= Date.now(),
    )
    const failedAttempts = Math.min(
      MFA_MAX_ATTEMPTS,
      (previousLockExpired ? 0 : credential.failedAttempts) + 1,
    )
    const lockedUntil =
      failedAttempts >= MFA_MAX_ATTEMPTS
        ? new Date(Date.now() + MFA_LOCK_MILLISECONDS).toISOString()
        : null
    const claimed = await payload.update({
      collection: 'adminMfaCredentials',
      data: { failedAttempts, lockedUntil, version: credential.version + 1 },
      overrideAccess: true,
      req: failureReq,
      where: {
        and: [{ id: { equals: credential.id } }, { version: { equals: credential.version } }],
      },
    })
    if (claimed.docs.length) {
      const targetId = adminId(credential)
      await writeMfaAudit(payload, failureReq, 'admin.auth.mfa_failed', targetId, {
        failedAttempts,
      })
      if (lockedUntil) {
        await writeMfaAudit(payload, failureReq, 'admin.auth.mfa_locked', targetId, {
          lockedMinutes: MFA_LOCK_MILLISECONDS / 60_000,
        })
      }
      return
    }
    const refreshed = await findCredential(payload, adminId(credential), failureReq)
    if (!refreshed) return
    credential = refreshed
  }
  throw new AppError('ADMIN_MFA_CONFLICT', '身份验证状态发生冲突，请重试', 409)
}

export function createTotp(secretBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    issuer: 'Wanmi.AI',
    label,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  })
}

export function createTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => randomBytes(9).toString('base64url'))
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map((code) => hmac(code, getEnv().SESSION_PEPPER))
}

export function validateTotpAt(
  secretBase32: string,
  token: string,
  timestamp = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(token)) return null
  const totp = createTotp(secretBase32, 'verification')
  const delta = totp.validate({ token, timestamp, window: TOTP_WINDOW })
  return delta === null ? null : Math.floor(timestamp / (TOTP_PERIOD_SECONDS * 1_000)) + delta
}

function findRecoveryCodeIndex(candidate: string, hashes: string[]): number {
  const candidateHash = hmac(candidate, getEnv().SESSION_PEPPER)
  let match = -1
  for (let index = 0; index < hashes.length; index += 1) {
    if (safeEqualHex(candidateHash, hashes[index]!)) match = index
  }
  return match
}

export const verifyAdminTotpBeforeLogin: CollectionBeforeLoginHook = async ({ req, user }) => {
  const typedUser = user as typeof user & { status?: 'active' | 'disabled' }
  if (typedUser.status !== 'active') {
    throw new AppError('ADMIN_AUTH_INVALID', '邮箱、密码或第二因素无效', 401)
  }

  const context = req.context as AdminMfaContext
  const factor = context.adminMfa
  if (!factor || Boolean(factor.totp) === Boolean(factor.recoveryCode)) {
    throw new AppError('ADMIN_AUTH_INVALID', '邮箱、密码或第二因素无效', 401)
  }

  const credential = await findCredential(req.payload, user.id, req)
  if (!credential) {
    throw new AppError('ADMIN_AUTH_INVALID', '邮箱、密码或第二因素无效', 401)
  }
  if (isLocked(credential)) {
    const auditReq = await createLocalReq({ req: { headers: req.headers } }, req.payload)
    await writeMfaAudit(req.payload, auditReq, 'admin.auth.mfa_locked_rejected', user.id)
    throw new AppError('ADMIN_AUTH_INVALID', '邮箱、密码或第二因素无效', 401)
  }

  const nextData: {
    failedAttempts: number
    lastUsedStep?: number
    lockedUntil: null
    recoveryCodeHashes?: string[]
    version: number
  } = {
    failedAttempts: 0,
    lockedUntil: null,
    version: credential.version + 1,
  }

  if (factor.recoveryCode) {
    const index = findRecoveryCodeIndex(factor.recoveryCode, credential.recoveryCodeHashes)
    if (index < 0) {
      await registerFailedFactor(req.payload, req, credential)
      throw new AppError('ADMIN_AUTH_INVALID', '邮箱、密码或第二因素无效', 401)
    }
    nextData.recoveryCodeHashes = credential.recoveryCodeHashes.filter(
      (_hash, codeIndex) => codeIndex !== index,
    )
    context.adminMfaMethod = 'recovery_code'
  } else {
    const secret = decryptSecret(credential.secretEncrypted, getEnv().TOTP_ENCRYPTION_KEY)
    const step = validateTotpAt(secret, factor.totp!)
    if (step === null || (credential.lastUsedStep !== null && step <= credential.lastUsedStep!)) {
      await registerFailedFactor(req.payload, req, credential)
      throw new AppError('ADMIN_AUTH_INVALID', '邮箱、密码或第二因素无效', 401)
    }
    nextData.lastUsedStep = step
    context.adminMfaMethod = 'totp'
  }

  const claimed = await req.payload.update({
    collection: 'adminMfaCredentials',
    data: nextData,
    overrideAccess: true,
    req,
    where: {
      and: [{ id: { equals: credential.id } }, { version: { equals: credential.version } }],
    },
  })
  if (!claimed.docs.length) {
    throw new AppError('ADMIN_AUTH_INVALID', '邮箱、密码或第二因素无效', 401)
  }
  if (context.adminMfaMethod === 'recovery_code') {
    await writeMfaAudit(req.payload, req, 'admin.auth.recovery_code_used', user.id)
  }
  return user
}

export const auditAdminLoginSuccess = async (
  req: PayloadRequest,
  userId: number | string,
  method: 'recovery_code' | 'totp',
) => {
  await writeMfaAudit(req.payload, req, 'admin.auth.login_succeeded', userId, {
    factor: method,
  })
}
