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
        req: { context: {}, headers: new Headers(), payload: { update: vi.fn() } },
        user: { id: 1, status: 'active' },
      } as never),
    ).rejects.toThrow(/第二因素/)
  })

  it('accepts one current TOTP and persists its time step', async () => {
    const secret = new OTPAuth.Secret({ size: 20 })
    const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret })
    const update = vi.fn().mockResolvedValue({ docs: [{ id: 9 }] })
    const create = vi.fn().mockResolvedValue({ id: 10 })
    const find = vi.fn().mockResolvedValue({
      docs: [
        {
          admin: 1,
          failedAttempts: 0,
          id: 9,
          lastUsedStep: null,
          lockedUntil: null,
          recoveryCodeHashes: [],
          secretEncrypted: encryptSecret(secret.base32, getEnv().TOTP_ENCRYPTION_KEY),
          version: 0,
        },
      ],
    })
    await verifyAdminTotpBeforeLogin({
      req: {
        context: { adminMfa: { totp: totp.generate() } },
        headers: new Headers(),
        payload: { create, find, update },
      },
      user: { id: 1, status: 'active' },
    } as never)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'adminMfaCredentials',
        data: expect.objectContaining({ lastUsedStep: expect.any(Number), version: 1 }),
        overrideAccess: true,
      }),
    )
  })
})
