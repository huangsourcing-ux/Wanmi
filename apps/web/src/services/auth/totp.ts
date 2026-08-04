import * as OTPAuth from 'otpauth'
import type { CollectionBeforeLoginHook } from 'payload'

import { decryptSecret, hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'

export const verifyAdminTotpBeforeLogin: CollectionBeforeLoginHook = async ({ req, user }) => {
  const typed = user as typeof user & {
    recoveryCodeHashes?: string[] | null
    totpEnabled?: boolean | null
    totpLastUsedStep?: number | null
    totpSecretEncrypted?: string | null
  }

  if (!typed.totpEnabled || !typed.totpSecretEncrypted) {
    throw new AppError('TOTP_ENROLLMENT_REQUIRED', '管理员必须先完成 TOTP 配置', 401)
  }

  const recoveryCode = req.headers.get('x-wanmi-recovery-code')
  if (recoveryCode) {
    const candidate = hmac(recoveryCode, getEnv().SESSION_PEPPER)
    const remaining = (typed.recoveryCodeHashes ?? []).filter((hash: string) => hash !== candidate)
    if (remaining.length === (typed.recoveryCodeHashes ?? []).length) {
      throw new AppError('INVALID_TOTP', '验证码无效', 401)
    }
    await req.payload.update({
      collection: 'admins',
      id: user.id,
      data: { recoveryCodeHashes: remaining },
      overrideAccess: true,
      req,
    })
    return user
  }

  const token = req.headers.get('x-wanmi-totp')
  if (!token || !/^\d{6}$/.test(token)) throw new AppError('TOTP_REQUIRED', '需要 TOTP 验证码', 401)

  const secret = decryptSecret(typed.totpSecretEncrypted, getEnv().TOTP_ENCRYPTION_KEY)
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret })
  const delta = totp.validate({ token, window: 1 })
  if (delta === null) throw new AppError('INVALID_TOTP', '验证码无效', 401)

  const step = Math.floor(Date.now() / 30_000) + delta
  if (
    typed.totpLastUsedStep !== null &&
    typed.totpLastUsedStep !== undefined &&
    step <= typed.totpLastUsedStep
  ) {
    throw new AppError('TOTP_REPLAYED', '验证码已使用', 401)
  }

  await req.payload.update({
    collection: 'admins',
    id: user.id,
    data: { totpLastUsedStep: step },
    overrideAccess: true,
    req,
  })
  return user
}
