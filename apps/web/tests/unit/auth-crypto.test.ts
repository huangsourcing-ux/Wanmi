import * as OTPAuth from 'otpauth'
import { describe, expect, it, vi } from 'vitest'

import { decryptSecret, encryptSecret, randomOpaqueToken } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { verifyAdminTotpBeforeLogin } from '@/services/auth/totp'

describe('authentication crypto', () => {
  it('uses a 256-bit opaque session token', () => {
    expect(Buffer.from(randomOpaqueToken(), 'base64url')).toHaveLength(32)
  })

  it('round-trips AES-256-GCM encrypted secrets', () => {
    const encrypted = encryptSecret('BASE32SECRET', getEnv().TOTP_ENCRYPTION_KEY)
    expect(encrypted).not.toContain('BASE32SECRET')
    expect(decryptSecret(encrypted, getEnv().TOTP_ENCRYPTION_KEY)).toBe('BASE32SECRET')
  })

  it('rejects missing TOTP before Payload creates an admin session', async () => {
    await expect(
      verifyAdminTotpBeforeLogin({
        req: { headers: new Headers(), payload: { update: vi.fn() } },
        user: { id: 1, totpEnabled: true, totpSecretEncrypted: 'encrypted' },
      } as never),
    ).rejects.toThrow(/TOTP/)
  })

  it('accepts one current TOTP and persists its time step', async () => {
    const secret = new OTPAuth.Secret({ size: 20 })
    const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret })
    const update = vi.fn().mockResolvedValue({})
    await verifyAdminTotpBeforeLogin({
      req: {
        headers: new Headers({ 'x-wanmi-totp': totp.generate() }),
        payload: { update },
      },
      user: {
        id: 1,
        totpEnabled: true,
        totpSecretEncrypted: encryptSecret(secret.base32, getEnv().TOTP_ENCRYPTION_KEY),
      },
    } as never)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'admins',
        data: { totpLastUsedStep: expect.any(Number) },
        id: 1,
        overrideAccess: true,
      }),
    )
  })
})
