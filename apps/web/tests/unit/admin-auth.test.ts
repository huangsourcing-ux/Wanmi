import * as OTPAuth from 'otpauth'
import { describe, expect, it, vi } from 'vitest'

vi.mock('payload', async (importOriginal) => {
  const original = await importOriginal<typeof import('payload')>()
  return {
    ...original,
    createLocalReq: vi.fn(async ({ req }: { req: { headers: Headers } }, payload: unknown) => ({
      ...req,
      context: {},
      payload,
    })),
  }
})

import { isActiveAdminUser } from '@/access/roles'
import { guardAdminAccountChange } from '@/services/auth/admin-account'
import {
  createTotpSecret,
  hashRecoveryCodes,
  validateTotpAt,
  verifyAdminTotpBeforeLogin,
} from '@/services/auth/totp'
import {
  adminInvitationAcceptSchema,
  adminInvitationCreateSchema,
  adminLoginSchema,
  adminPasswordSchema,
} from '@/schemas/auth'
import { encryptSecret } from '@/lib/crypto'
import { getEnv } from '@/lib/env'

describe('administrator authentication contracts', () => {
  it('enforces the 14–128 character password boundary', () => {
    expect(adminPasswordSchema.safeParse('x'.repeat(13)).success).toBe(false)
    expect(adminPasswordSchema.safeParse('x'.repeat(14)).success).toBe(true)
    expect(adminPasswordSchema.safeParse('x'.repeat(128)).success).toBe(true)
    expect(adminPasswordSchema.safeParse('x'.repeat(129)).success).toBe(false)
    expect(
      adminInvitationAcceptSchema.safeParse({ password: 'x'.repeat(14), totp: '123456' }).success,
    ).toBe(true)
  })

  it('requires exactly one second factor and validates invitation purposes', () => {
    const base = { email: 'ADMIN@example.test', password: 'x'.repeat(14) }
    expect(adminLoginSchema.safeParse(base).success).toBe(false)
    expect(adminLoginSchema.safeParse({ ...base, totp: '123456' }).success).toBe(true)
    expect(
      adminLoginSchema.safeParse({ ...base, recoveryCode: 'recover-code', totp: '123456' }).success,
    ).toBe(false)
    expect(
      adminInvitationCreateSchema.safeParse({
        email: 'invite@example.test',
        purpose: 'new_admin',
        roles: ['analyst', 'analyst'],
      }).data,
    ).toMatchObject({ roles: ['analyst'] })
    expect(
      adminInvitationCreateSchema.safeParse({ purpose: 'mfa_reset', targetAdminId: 8 }).success,
    ).toBe(true)
  })

  it('uses SHA-1, six digits, 30-second periods and a ±1 validation window', () => {
    const secret = createTotpSecret()
    const timestamp = 1_800_000_000_000
    const totp = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    })
    expect(validateTotpAt(secret, totp.generate({ timestamp }), timestamp)).toBe(
      Math.floor(timestamp / 30_000),
    )
    expect(
      validateTotpAt(secret, totp.generate({ timestamp: timestamp - 30_000 }), timestamp),
    ).toBe(Math.floor(timestamp / 30_000) - 1)
    expect(
      validateTotpAt(secret, totp.generate({ timestamp: timestamp + 30_000 }), timestamp),
    ).toBe(Math.floor(timestamp / 30_000) + 1)
    expect(
      validateTotpAt(secret, totp.generate({ timestamp: timestamp + 60_000 }), timestamp),
    ).toBeNull()
  })

  it('uses 256-bit HMAC hashes and never stores raw recovery codes', () => {
    const [hash] = hashRecoveryCodes(['recovery-code-fixture'])
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).not.toContain('recovery-code-fixture')
  })

  it('consumes the final recovery code without leaving a reusable placeholder', async () => {
    const recoveryCode = 'last-recovery-code'
    const credential = {
      admin: 1,
      failedAttempts: 0,
      id: 8,
      lastUsedStep: null,
      lockedUntil: null,
      recoveryCodeHashes: hashRecoveryCodes([recoveryCode]),
      secretEncrypted: encryptSecret(createTotpSecret(), getEnv().TOTP_ENCRYPTION_KEY),
      version: 2,
    }
    const update = vi.fn().mockResolvedValue({ docs: [{ ...credential, recoveryCodeHashes: [] }] })
    await expect(
      verifyAdminTotpBeforeLogin({
        req: {
          context: { adminMfa: { recoveryCode } },
          headers: new Headers({ 'x-request-id': 'last-recovery-unit' }),
          payload: {
            create: vi.fn().mockResolvedValue({ id: 1 }),
            find: vi.fn().mockResolvedValue({ docs: [credential] }),
            update,
          },
        },
        user: { id: 1, status: 'active' },
      } as never),
    ).resolves.toMatchObject({ id: 1 })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ recoveryCodeHashes: [] }) }),
    )
  })

  it('recognizes only active administrators for RBAC', () => {
    expect(
      isActiveAdminUser({ collection: 'admins', id: 1, roles: ['system_admin'], status: 'active' }),
    ).toBe(true)
    expect(
      isActiveAdminUser({
        collection: 'admins',
        id: 1,
        roles: ['system_admin'],
        status: 'disabled',
      }),
    ).toBe(false)
  })

  it('locks the second factor for ten minutes on the fifth CAS-protected failure', async () => {
    const secret = createTotpSecret()
    const credential = {
      admin: 1,
      failedAttempts: 4,
      id: 7,
      lastUsedStep: null,
      lockedUntil: null,
      recoveryCodeHashes: [],
      secretEncrypted: encryptSecret(secret, getEnv().TOTP_ENCRYPTION_KEY),
      version: 3,
    }
    const update = vi.fn().mockResolvedValue({ docs: [{ ...credential, failedAttempts: 5 }] })
    const create = vi.fn().mockResolvedValue({ id: 1 })
    await expect(
      verifyAdminTotpBeforeLogin({
        req: {
          context: { adminMfa: { totp: '000000' } },
          headers: new Headers({ 'x-request-id': 'mfa-lock-unit' }),
          payload: { create, find: vi.fn().mockResolvedValue({ docs: [credential] }), update },
        },
        user: { id: 1, status: 'active' },
      } as never),
    ).rejects.toThrow(/第二因素/)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failedAttempts: 5, lockedUntil: expect.any(String) }),
        where: { and: [{ id: { equals: 7 } }, { version: { equals: 3 } }] },
      }),
    )
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('protects the last active system administrator', async () => {
    await expect(
      guardAdminAccountChange({
        data: { status: 'disabled' },
        operation: 'update',
        originalDoc: { id: 1, roles: ['system_admin'], status: 'active' },
        req: {
          context: {},
          payload: { count: vi.fn().mockResolvedValue({ totalDocs: 1 }) },
          user: { collection: 'admins', id: 1, roles: ['system_admin'], status: 'active' },
        },
      } as never),
    ).rejects.toThrow(/最后一个/)
  })
})
