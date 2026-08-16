import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import * as OTPAuth from 'otpauth'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { GET as listInvitationRoute } from '@/app/api/v1/admin/auth/invitations/route'
import { POST as loginRoute } from '@/app/api/v1/admin/auth/login/route'
import { POST as logoutRoute } from '@/app/api/v1/admin/auth/logout/route'
import {
  DELETE as revokeAllSessionsRoute,
  GET as listSessionsRoute,
} from '@/app/api/v1/admin/auth/sessions/[adminId]/route'
import { DELETE as revokeSessionRoute } from '@/app/api/v1/admin/auth/sessions/[adminId]/[sessionId]/route'
import { encryptSecret, hmac, randomOpaqueToken } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import type { AdminRole } from '@/lib/domain'
import type { Admin } from '@/payload-types'
import {
  acceptAdminInvitation,
  createAdminInvitation,
  resolveAdminInvitation,
  revokeAdminInvitation,
} from '@/services/auth/admin-invitations'
import { createTotp, createTotpSecret, hashRecoveryCodes } from '@/services/auth/totp'

import {
  ANCHOR_SYSTEM_ADMIN_EMAIL,
  ANCHOR_SYSTEM_ADMIN_PASSWORD,
  ensureAnchorSystemAdmin,
  ignorePayloadNotFound,
} from '../test-cleanup'

const anchorEmail = ANCHOR_SYSTEM_ADMIN_EMAIL
const anchorPassword = ANCHOR_SYSTEM_ADMIN_PASSWORD
const fixturePrefix = `d1-admin-auth-${randomUUID()}`
const createdAdminIds = new Set<number>()
const traceIds = new Set<string>()

let payload: Payload
let anchor: Admin
let anchorSecret: string

function requestHeaders(extra?: Record<string, string>) {
  const traceId = randomUUID()
  traceIds.add(traceId)
  return new Headers({ 'x-request-id': traceId, ...extra })
}

async function systemRequest(): Promise<PayloadRequest> {
  const req = await createLocalReq({ req: { headers: requestHeaders() } }, payload)
  req.user = { ...anchor, collection: 'admins' }
  return req
}

async function createAdminFixture(
  role: AdminRole,
  suffix: string = randomUUID(),
): Promise<{ admin: Admin; password: string; recoveryCodes: string[]; secret: string }> {
  const password = `D1-fixture-password-${suffix}`
  const admin = await payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap' },
    data: {
      email: `${fixturePrefix}-${suffix}@example.test`,
      password,
      roles: [role],
      status: 'active',
    },
    overrideAccess: true,
  })
  createdAdminIds.add(admin.id)
  const secret = createTotpSecret()
  const recoveryCodes = Array.from(
    { length: 8 },
    (_value, index) => `fixture-${suffix}-${index}-recovery`,
  )
  await payload.create({
    collection: 'adminMfaCredentials',
    data: {
      admin: admin.id,
      configuredAt: new Date().toISOString(),
      failedAttempts: 0,
      recoveryCodeHashes: hashRecoveryCodes(recoveryCodes),
      secretEncrypted: encryptSecret(secret, getEnv().TOTP_ENCRYPTION_KEY),
      version: 0,
    },
    overrideAccess: true,
  })
  return { admin, password, recoveryCodes, secret }
}

async function replaceCredential(
  adminId: number,
  options?: { recoveryCodes?: string[]; secret?: string },
) {
  const credential = await payload.find({
    collection: 'adminMfaCredentials',
    limit: 1,
    overrideAccess: true,
    where: { admin: { equals: adminId } },
  })
  const secret = options?.secret ?? createTotpSecret()
  const recoveryCodes =
    options?.recoveryCodes ?? Array.from({ length: 8 }, () => `recovery-${randomUUID()}`)
  const data = {
    configuredAt: new Date().toISOString(),
    failedAttempts: 0,
    lastUsedStep: null,
    lockedUntil: null,
    recoveryCodeHashes: hashRecoveryCodes(recoveryCodes),
    secretEncrypted: encryptSecret(secret, getEnv().TOTP_ENCRYPTION_KEY),
    version: (credential.docs[0]?.version ?? -1) + 1,
  }
  if (credential.docs[0]) {
    await payload.update({
      collection: 'adminMfaCredentials',
      data,
      id: credential.docs[0].id,
      overrideAccess: true,
    })
  } else {
    await payload.create({
      collection: 'adminMfaCredentials',
      data: { ...data, admin: adminId },
      overrideAccess: true,
    })
  }
  return { recoveryCodes, secret }
}

async function resetAnchorPassword() {
  anchor = await payload.update({
    collection: 'admins',
    context: { adminAccountOperation: 'mfa-reset', suppressAdminAccountAudit: true },
    data: { password: anchorPassword },
    id: anchor.id,
    overrideAccess: true,
  })
}

function totp(secret: string, timestamp = Date.now()): string {
  return createTotp(secret, 'integration').generate({ timestamp })
}

function cookieHeader(response: Response): string {
  const cookie = response.headers.get('set-cookie')
  if (!cookie) throw new Error('Expected administrator session cookie')
  return cookie.split(';', 1)[0]!
}

async function httpLogin(input: {
  email: string
  password: string
  recoveryCode?: string
  totp?: string
}) {
  return loginRoute(
    new Request('http://wanmi.local/api/v1/admin/auth/login', {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID() },
      method: 'POST',
    }),
  )
}

function routeArgs(id: number, sessionId?: string) {
  return {
    params: Promise.resolve({ adminId: String(id), ...(sessionId ? { sessionId } : {}) }),
  } as never
}

beforeAll(async () => {
  payload = await getPayload({ config })
  anchor = await ensureAnchorSystemAdmin(payload)
  const replaced = await replaceCredential(anchor.id)
  anchorSecret = replaced.secret
  anchor = await payload.update({
    collection: 'admins',
    context: { adminAccountOperation: 'security-hook' },
    data: { sessions: [] },
    id: anchor.id,
    overrideAccess: true,
  })
})

afterAll(async () => {
  const cleanupReq = await systemRequest()
  const invitations = await payload.find({
    collection: 'adminInvitations',
    limit: 1_000,
    overrideAccess: true,
    where: { email: { contains: fixturePrefix } },
  })
  for (const invitation of invitations.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({
        collection: 'adminInvitations',
        id: invitation.id,
        overrideAccess: true,
      }),
    )
  }
  for (const id of createdAdminIds) {
    const credentials = await payload.find({
      collection: 'adminMfaCredentials',
      overrideAccess: true,
      where: { admin: { equals: id } },
    })
    for (const credential of credentials.docs) {
      await ignorePayloadNotFound(() =>
        payload.delete({
          collection: 'adminMfaCredentials',
          id: credential.id,
          overrideAccess: true,
        }),
      )
    }
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'admins', id, overrideAccess: true, req: cleanupReq }),
    )
  }
  if (traceIds.size) {
    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 1_000,
      overrideAccess: true,
      where: { traceId: { in: [...traceIds] } },
    })
    for (const audit of audits.docs) {
      await ignorePayloadNotFound(() =>
        payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true }),
      )
    }
  }
  await payload.db.destroy?.()
}, 60_000)

describe('D1-05 administrator authentication', () => {
  it('uses hidden credential collections, fixed sessions and disabled GraphQL', async () => {
    expect(payload.config.graphQL?.disable).toBe(true)
    expect(payload.config.admin.autoRefresh).toBe(false)
    expect(payload.collections.admins.config.auth.tokenExpiration).toBe(43_200)
    expect(payload.collections.admins.config.auth.useSessions).toBe(true)
    expect(payload.collections.adminMfaCredentials.config.admin.hidden).toBe(true)
    expect(payload.collections.adminInvitations.config.admin.hidden).toBe(true)
    await expect(
      payload.find({
        collection: 'adminMfaCredentials',
        overrideAccess: false,
        user: { ...anchor, collection: 'admins' },
      }),
    ).rejects.toThrow()
  })

  it('blocks forgot-password inside Payload before any reset token mutation', async () => {
    const before = await payload.findByID({
      collection: 'admins',
      id: anchor.id,
      overrideAccess: true,
      showHiddenFields: true,
    })
    await expect(
      payload.forgotPassword({
        collection: 'admins',
        data: { email: anchorEmail },
        disableEmail: true,
        overrideAccess: true,
        req: { headers: requestHeaders() },
      }),
    ).rejects.toThrow()
    const after = await payload.findByID({
      collection: 'admins',
      id: anchor.id,
      overrideAccess: true,
      showHiddenFields: true,
    })
    expect(after.resetPasswordToken ?? null).toBe(before.resetPasswordToken ?? null)
    expect(after.resetPasswordExpiration ?? null).toBe(before.resetPasswordExpiration ?? null)
  })

  it('deletes a non-final administrator with its hidden credentials and linked invitations', async () => {
    const target = await createAdminFixture('analyst', 'deletable')
    await payload.create({
      collection: 'adminInvitations',
      data: {
        createdBy: target.admin.id,
        email: target.admin.email,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        purpose: 'mfa_reset',
        roles: target.admin.roles,
        targetAdmin: target.admin.id,
        tokenHash: hmac(randomOpaqueToken(), getEnv().SESSION_PEPPER),
        totpSecretEncrypted: encryptSecret(createTotpSecret(), getEnv().TOTP_ENCRYPTION_KEY),
      },
      overrideAccess: true,
    })

    const req = await systemRequest()
    await payload.delete({
      collection: 'admins',
      id: target.admin.id,
      overrideAccess: false,
      req,
      user: req.user,
    })
    createdAdminIds.delete(target.admin.id)

    await expect(
      payload.findByID({ collection: 'admins', id: target.admin.id, overrideAccess: true }),
    ).rejects.toThrow()
    expect(
      await payload.count({
        collection: 'adminMfaCredentials',
        overrideAccess: true,
        where: { admin: { equals: target.admin.id } },
      }),
    ).toMatchObject({ totalDocs: 0 })
    expect(
      await payload.count({
        collection: 'adminInvitations',
        overrideAccess: true,
        where: {
          or: [
            { createdBy: { equals: target.admin.id } },
            { targetAdmin: { equals: target.admin.id } },
          ],
        },
      }),
    ).toMatchObject({ totalDocs: 0 })
  })

  it('creates, revokes, expires and atomically consumes one-time invitations', async () => {
    const req = await systemRequest()
    const revoked = await createAdminInvitation(req, {
      email: `${fixturePrefix}-revoked@example.test`,
      purpose: 'new_admin',
      roles: ['analyst'],
    })
    const revokedToken = new URL(revoked.invitationUrl).hash.slice('#token='.length)
    const stored = await payload.findByID({
      collection: 'adminInvitations',
      id: revoked.invitation.id,
      overrideAccess: true,
    })
    expect(stored.tokenHash).not.toBe(revokedToken)
    expect(stored.tokenHash).toBe(hmac(revokedToken, getEnv().SESSION_PEPPER))
    expect(stored.totpSecretEncrypted).not.toContain('otpauth://')
    await revokeAdminInvitation(req, revoked.invitation.id)
    await expect(resolveAdminInvitation(payload, revokedToken)).rejects.toThrow(/无效或已过期/)

    const expired = await createAdminInvitation(req, {
      email: `${fixturePrefix}-expired@example.test`,
      purpose: 'new_admin',
      roles: ['content_editor'],
    })
    const expiredToken = new URL(expired.invitationUrl).hash.slice('#token='.length)
    await payload.update({
      collection: 'adminInvitations',
      data: { expiresAt: new Date(Date.now() - 1_000).toISOString() },
      id: expired.invitation.id,
      overrideAccess: true,
    })
    await expect(resolveAdminInvitation(payload, expiredToken)).rejects.toThrow(/无效或已过期/)

    const invitation = await createAdminInvitation(req, {
      email: `${fixturePrefix}-accepted@example.test`,
      purpose: 'new_admin',
      roles: ['analyst'],
    })
    const token = new URL(invitation.invitationUrl).hash.slice('#token='.length)
    const resolved = await resolveAdminInvitation(payload, token)
    const enrollmentTotp = OTPAuth.URI.parse(resolved.provisioningUri) as OTPAuth.TOTP
    const accepted = await acceptAdminInvitation(
      await createLocalReq({ req: { headers: requestHeaders() } }, payload),
      token,
      { password: 'Invited-admin-password-2026', totp: enrollmentTotp.generate() },
    )
    createdAdminIds.add(Number(accepted.admin.id))
    expect(accepted.recoveryCodes).toHaveLength(8)
    expect(
      accepted.recoveryCodes.every((code) => Buffer.from(code, 'base64url').length === 9),
    ).toBe(true)
    const credential = await payload.find({
      collection: 'adminMfaCredentials',
      limit: 1,
      overrideAccess: true,
      where: { admin: { equals: accepted.admin.id } },
    })
    expect(credential.docs[0]?.recoveryCodeHashes).not.toContain(accepted.recoveryCodes[0])
    await expect(
      acceptAdminInvitation(
        await createLocalReq({ req: { headers: requestHeaders() } }, payload),
        token,
        { password: 'Invited-admin-password-2026', totp: enrollmentTotp.generate() },
      ),
    ).rejects.toThrow(/无效或已过期/)

    const preResetLogin = await httpLogin({
      email: accepted.admin.email,
      password: 'Invited-admin-password-2026',
      recoveryCode: accepted.recoveryCodes[0],
    })
    expect(preResetLogin.status).toBe(200)
    const beforeResetAdmin = await payload.findByID({
      collection: 'admins',
      id: accepted.admin.id,
      overrideAccess: true,
    })
    const beforeResetCredential = await payload.find({
      collection: 'adminMfaCredentials',
      limit: 1,
      overrideAccess: true,
      where: { admin: { equals: accepted.admin.id } },
    })
    const resetInvitation = await createAdminInvitation(req, {
      purpose: 'mfa_reset',
      targetAdminId: Number(accepted.admin.id),
    })
    expect(
      (
        await payload.findByID({
          collection: 'admins',
          id: accepted.admin.id,
          overrideAccess: true,
        })
      ).sessions,
    ).toHaveLength(beforeResetAdmin.sessions?.length ?? 0)
    const resetToken = new URL(resetInvitation.invitationUrl).hash.slice('#token='.length)
    const resetResolution = await resolveAdminInvitation(payload, resetToken)
    const resetTotp = OTPAuth.URI.parse(resetResolution.provisioningUri) as OTPAuth.TOTP
    const resetAccepted = await acceptAdminInvitation(
      await createLocalReq({ req: { headers: requestHeaders() } }, payload),
      resetToken,
      { password: 'Reset-admin-password-2026', totp: resetTotp.generate() },
    )
    expect(resetAccepted.admin.roles).toEqual(accepted.admin.roles)
    const afterResetAdmin = await payload.findByID({
      collection: 'admins',
      id: accepted.admin.id,
      overrideAccess: true,
    })
    expect(afterResetAdmin.sessions).toHaveLength(0)
    const afterResetCredential = await payload.find({
      collection: 'adminMfaCredentials',
      limit: 1,
      overrideAccess: true,
      where: { admin: { equals: accepted.admin.id } },
    })
    expect(afterResetCredential.docs[0]?.secretEncrypted).not.toBe(
      beforeResetCredential.docs[0]?.secretEncrypted,
    )
    expect(
      (
        await httpLogin({
          email: accepted.admin.email,
          password: 'Invited-admin-password-2026',
          recoveryCode: resetAccepted.recoveryCodes[0],
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await httpLogin({
          email: accepted.admin.email,
          password: 'Reset-admin-password-2026',
          recoveryCode: resetAccepted.recoveryCodes[0],
        })
      ).status,
    ).toBe(200)

    const concurrentInvitation = await createAdminInvitation(req, {
      email: `${fixturePrefix}-concurrent@example.test`,
      purpose: 'new_admin',
      roles: ['ad_operator'],
    })
    const concurrentToken = new URL(concurrentInvitation.invitationUrl).hash.slice('#token='.length)
    const concurrentResolution = await resolveAdminInvitation(payload, concurrentToken)
    const concurrentTotp = OTPAuth.URI.parse(concurrentResolution.provisioningUri) as OTPAuth.TOTP
    const attempts = await Promise.allSettled(
      Array.from({ length: 2 }, async () =>
        acceptAdminInvitation(
          await createLocalReq({ req: { headers: requestHeaders() } }, payload),
          concurrentToken,
          { password: 'Concurrent-admin-password-2026', totp: concurrentTotp.generate() },
        ),
      ),
    )
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    const concurrentAdmin = await payload.find({
      collection: 'admins',
      limit: 1,
      overrideAccess: true,
      where: { email: { equals: `${fixturePrefix}-concurrent@example.test` } },
    })
    createdAdminIds.add(concurrentAdmin.docs[0]!.id)
  })

  it('sets a hardened cookie, prevents MFA replay and supports remote Session revocation', async () => {
    await resetAnchorPassword()
    const recoveryCodes = Array.from({ length: 8 }, (_value, index) => `anchor-recovery-${index}`)
    const replacement = await replaceCredential(anchor.id, { recoveryCodes })
    anchorSecret = replacement.secret
    await payload.update({
      collection: 'admins',
      context: { adminAccountOperation: 'security-hook' },
      data: { sessions: [] },
      id: anchor.id,
      overrideAccess: true,
    })

    const invalidToken = totp(anchorSecret) === '000000' ? '000001' : '000000'
    const failed = await httpLogin({
      email: anchorEmail,
      password: anchorPassword,
      totp: invalidToken,
    })
    expect(failed.status).toBe(401)
    expect(
      (await payload.findByID({ collection: 'admins', id: anchor.id, overrideAccess: true }))
        .sessions,
    ).toHaveLength(0)

    const sharedToken = totp(anchorSecret)
    const concurrent = await Promise.all([
      httpLogin({ email: anchorEmail, password: anchorPassword, totp: sharedToken }),
      httpLogin({ email: anchorEmail, password: anchorPassword, totp: sharedToken }),
    ])
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 401])
    const succeeded = concurrent.find((response) => response.status === 200)!
    const cookie = succeeded.headers.get('set-cookie')!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    const loginBody = await succeeded.json()
    expect(loginBody.token).toBeUndefined()
    expect(loginBody.admin).toMatchObject({ email: anchorEmail, status: 'active' })

    const recoveryLogin = await httpLogin({
      email: anchorEmail,
      password: anchorPassword,
      recoveryCode: recoveryCodes[0],
    })
    expect(recoveryLogin.status).toBe(200)
    expect(
      (
        await httpLogin({
          email: anchorEmail,
          password: anchorPassword,
          recoveryCode: recoveryCodes[0],
        })
      ).status,
    ).toBe(401)

    const cookieRequest = cookieHeader(succeeded)
    const listed = await listSessionsRoute(
      new Request('http://wanmi.local/api/v1/admin/auth/sessions', {
        headers: {
          cookie: cookieRequest,
          'sec-fetch-site': 'same-origin',
          'x-request-id': randomUUID(),
        },
      }),
      routeArgs(anchor.id),
    )
    expect(listed.status).toBe(200)
    const listedBody = (await listed.json()) as {
      sessions: { current: boolean; id: string }[]
    }
    expect(listedBody.sessions).toHaveLength(2)
    const remote = listedBody.sessions.find((session) => !session.current)!
    const remoteRevoked = await revokeSessionRoute(
      new Request('http://wanmi.local/api/v1/admin/auth/sessions', {
        headers: {
          cookie: cookieRequest,
          'sec-fetch-site': 'same-origin',
          'x-request-id': randomUUID(),
        },
        method: 'DELETE',
      }),
      routeArgs(anchor.id, remote.id),
    )
    expect(remoteRevoked.status).toBe(200)
    expect(remoteRevoked.headers.get('set-cookie')).toBeNull()

    const allRevoked = await revokeAllSessionsRoute(
      new Request('http://wanmi.local/api/v1/admin/auth/sessions', {
        headers: {
          cookie: cookieRequest,
          'sec-fetch-site': 'same-origin',
          'x-request-id': randomUUID(),
        },
        method: 'DELETE',
      }),
      routeArgs(anchor.id),
    )
    expect(allRevoked.status).toBe(200)
    expect(allRevoked.headers.get('set-cookie')).toContain('Expires=')
    const noLongerAuthenticated = await listInvitationRoute(
      new Request('http://wanmi.local/api/v1/admin/auth/invitations', {
        headers: {
          cookie: cookieRequest,
          'sec-fetch-site': 'same-origin',
          'x-request-id': randomUUID(),
        },
      }),
    )
    expect(noLongerAuthenticated.status).toBe(401)

    const currentLogin = await httpLogin({
      email: anchorEmail,
      password: anchorPassword,
      recoveryCode: recoveryCodes[1],
    })
    const currentLogout = await logoutRoute(
      new Request('http://wanmi.local/api/v1/admin/auth/logout', {
        body: JSON.stringify({ scope: 'current' }),
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader(currentLogin),
          'sec-fetch-site': 'same-origin',
          'x-request-id': randomUUID(),
        },
        method: 'POST',
      }),
    )
    expect(currentLogout.status).toBe(200)
    expect(
      (await payload.findByID({ collection: 'admins', id: anchor.id, overrideAccess: true }))
        .sessions,
    ).toHaveLength(0)

    const rotatedA = await httpLogin({
      email: anchorEmail,
      password: anchorPassword,
      recoveryCode: recoveryCodes[2],
    })
    const rotatedB = await httpLogin({
      email: anchorEmail,
      password: anchorPassword,
      recoveryCode: recoveryCodes[3],
    })
    const rotatedSessions = (
      await payload.findByID({ collection: 'admins', id: anchor.id, overrideAccess: true })
    ).sessions
    expect(new Set(rotatedSessions?.map((session) => session.id)).size).toBe(2)
    expect(rotatedA.headers.get('set-cookie')).not.toBe(rotatedB.headers.get('set-cookie'))
    const allLogout = await logoutRoute(
      new Request('http://wanmi.local/api/v1/admin/auth/logout', {
        body: JSON.stringify({ scope: 'all' }),
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader(rotatedB),
          'sec-fetch-site': 'same-origin',
          'x-request-id': randomUUID(),
        },
        method: 'POST',
      }),
    )
    expect(allLogout.status).toBe(200)
    expect(
      (await payload.findByID({ collection: 'admins', id: anchor.id, overrideAccess: true }))
        .sessions,
    ).toHaveLength(0)
  })

  it('enforces the identity endpoint matrix and invalidates sessions after security changes', async () => {
    const fixtures = await Promise.all(
      (['content_editor', 'ad_operator', 'analyst', 'system_admin'] as const).map((role) =>
        createAdminFixture(role, `${role}-${randomUUID()}`),
      ),
    )
    const roleCookies = new Map<string, string>()
    for (const fixture of fixtures) {
      const response = await httpLogin({
        email: fixture.admin.email,
        password: fixture.password,
        recoveryCode: fixture.recoveryCodes[0],
      })
      expect(response.status).toBe(200)
      roleCookies.set(fixture.admin.roles[0]!, cookieHeader(response))
    }
    const systemCookie = roleCookies.get('system_admin')!

    expect(
      (
        await listInvitationRoute(
          new Request('http://wanmi.local/api/v1/admin/auth/invitations', {
            headers: {
              cookie: systemCookie,
              'sec-fetch-site': 'same-origin',
              'x-request-id': randomUUID(),
            },
          }),
        )
      ).status,
    ).toBe(200)
    for (const [role, cookie] of roleCookies) {
      if (role === 'system_admin') continue
      expect(
        (
          await listInvitationRoute(
            new Request('http://wanmi.local/api/v1/admin/auth/invitations', {
              headers: {
                cookie,
                'sec-fetch-site': 'same-origin',
                'x-request-id': randomUUID(),
              },
            }),
          )
        ).status,
      ).toBe(403)
    }
    expect(
      (
        await listInvitationRoute(
          new Request('http://wanmi.local/api/v1/admin/auth/invitations', {
            headers: { 'x-request-id': randomUUID() },
          }),
        )
      ).status,
    ).toBe(401)

    const customer = await payload.create({
      collection: 'customers',
      data: {
        capabilityRestrictions: [],
        phone: `fixture-${randomUUID()}`,
        phoneMasked: 'fixture-only',
        status: 'active',
      },
      overrideAccess: true,
    })
    const customerToken = randomOpaqueToken()
    const customerSession = await payload.create({
      collection: 'customerSessions',
      data: {
        customer: customer.id,
        deviceHash: hmac('device', getEnv().SESSION_PEPPER),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ipHash: hmac('ip', getEnv().SESSION_PEPPER),
        lastSeenAt: new Date().toISOString(),
        tokenHash: hmac(customerToken, getEnv().SESSION_PEPPER),
      },
      overrideAccess: true,
    })
    expect(
      (
        await listInvitationRoute(
          new Request('http://wanmi.local/api/v1/admin/auth/invitations', {
            headers: {
              cookie: `${getEnv().CUSTOMER_SESSION_COOKIE}=${customerToken}`,
              'sec-fetch-site': 'same-origin',
              'x-request-id': randomUUID(),
            },
          }),
        )
      ).status,
    ).toBe(401)
    await payload.delete({
      collection: 'customerSessions',
      id: customerSession.id,
      overrideAccess: true,
    })
    await payload.delete({ collection: 'customers', id: customer.id, overrideAccess: true })

    const target = fixtures.find((fixture) => fixture.admin.roles[0] === 'analyst')!
    const systemReq = await systemRequest()
    await payload.update({
      collection: 'admins',
      data: { roles: ['content_editor'] },
      id: target.admin.id,
      overrideAccess: false,
      req: systemReq,
      user: systemReq.user!,
    })
    expect(
      (await payload.findByID({ collection: 'admins', id: target.admin.id, overrideAccess: true }))
        .sessions,
    ).toHaveLength(0)

    const relogin = await httpLogin({
      email: target.admin.email,
      password: target.password,
      recoveryCode: target.recoveryCodes[1],
    })
    expect(relogin.status).toBe(200)
    const targetDocument = await payload.findByID({
      collection: 'admins',
      id: target.admin.id,
      overrideAccess: true,
    })
    const selfReq = await createLocalReq({ req: { headers: requestHeaders() } }, payload)
    selfReq.user = { ...targetDocument, collection: 'admins' }
    const changedPassword = 'Changed-fixture-password-2026'
    await payload.update({
      collection: 'admins',
      data: { password: changedPassword },
      id: target.admin.id,
      overrideAccess: false,
      req: selfReq,
      user: selfReq.user,
    })
    expect(
      (await payload.findByID({ collection: 'admins', id: target.admin.id, overrideAccess: true }))
        .sessions,
    ).toHaveLength(0)
    expect(
      (
        await httpLogin({
          email: target.admin.email,
          password: changedPassword,
          recoveryCode: target.recoveryCodes[2],
        })
      ).status,
    ).toBe(200)
    await payload.update({
      collection: 'admins',
      data: { status: 'disabled' },
      id: target.admin.id,
      overrideAccess: false,
      req: await systemRequest(),
      user: { ...anchor, collection: 'admins' },
    })
    expect(
      (await payload.findByID({ collection: 'admins', id: target.admin.id, overrideAccess: true }))
        .sessions,
    ).toHaveLength(0)
    expect(
      (
        await httpLogin({
          email: target.admin.email,
          password: changedPassword,
          recoveryCode: target.recoveryCodes[3],
        })
      ).status,
    ).toBe(401)
  })
})
