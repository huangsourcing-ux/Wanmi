import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { createLocalReq } from 'payload'

import { encryptSecret } from '../../src/lib/crypto'
import type { AdminRole } from '../../src/lib/domain'
import { getEnv } from '../../src/lib/env'
import { createTotpSecret, hashRecoveryCodes } from '../../src/services/auth/totp'
import { getFixturePayload } from './redirect-fixture'

const statePath = resolve(process.cwd(), 'test-results/admin-auth-fixture.json')
const systemEmail = 'e2e-system-admin@example.test'
const systemPassword = 'E2E-system-admin-password-2026'
const systemRecoveryCode = 'e2e-system-recovery-code'
const disabledEmail = 'e2e-disabled-admin@example.test'
const disabledPassword = 'E2E-disabled-admin-password-2026'
const disabledRecoveryCode = 'e2e-disabled-recovery-code'
const roleAccounts = {
  ad_operator: {
    email: 'e2e-ad-operator@example.test',
    password: 'E2E-ad-operator-password-2026',
    recoveryCode: 'e2e-ad-operator-recovery-code',
  },
  analyst: {
    email: 'e2e-analyst@example.test',
    password: 'E2E-analyst-password-2026',
    recoveryCode: 'e2e-analyst-recovery-code',
  },
  content_editor: {
    email: 'e2e-content-editor@example.test',
    password: 'E2E-content-editor-password-2026',
    recoveryCode: 'e2e-content-editor-recovery-code',
  },
} as const

type RoleAccount = {
  email: string
  password: string
  recoveryCode: string
}

export type AdminAuthFixtureState = {
  disabledEmail: string
  disabledPassword: string
  disabledRecoveryCode: string
  invitationPassword: string
  invitationUrl: string
  invitedEmail: string
  roleAccounts: Record<'ad_operator' | 'analyst' | 'content_editor', RoleAccount>
  systemEmail: string
  systemPassword: string
  systemRecoveryCode: string
}

async function replaceCredential(
  adminId: number,
  recoveryCode: string,
  secret = createTotpSecret(),
) {
  const payload = await getFixturePayload()
  const existing = await payload.find({
    collection: 'adminMfaCredentials',
    limit: 1,
    overrideAccess: true,
    where: { admin: { equals: adminId } },
  })
  const data = {
    configuredAt: new Date().toISOString(),
    failedAttempts: 0,
    lastUsedStep: null,
    lockedUntil: null,
    recoveryCodeHashes: hashRecoveryCodes([
      recoveryCode,
      ...Array.from({ length: 7 }, (_value, index) => `${recoveryCode}-${index + 2}`),
    ]),
    secretEncrypted: encryptSecret(secret, getEnv().TOTP_ENCRYPTION_KEY),
    version: (existing.docs[0]?.version ?? -1) + 1,
  }
  if (existing.docs[0]) {
    await payload.update({
      collection: 'adminMfaCredentials',
      data,
      id: existing.docs[0].id,
      overrideAccess: true,
    })
  } else {
    await payload.create({
      collection: 'adminMfaCredentials',
      data: { ...data, admin: adminId },
      overrideAccess: true,
    })
  }
}

async function findOrCreateAdmin(
  email: string,
  password: string,
  roles: AdminRole[],
  status: 'active' | 'disabled',
) {
  const payload = await getFixturePayload()
  const existing = await payload.find({
    collection: 'admins',
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: email } },
  })
  if (existing.docs[0]) {
    return payload.update({
      collection: 'admins',
      context: { adminAccountOperation: 'mfa-reset', suppressAdminAccountAudit: true },
      data: { password, roles, status },
      id: existing.docs[0].id,
      overrideAccess: true,
    })
  }
  return payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap' },
    data: { email, password, roles, status },
    overrideAccess: true,
  })
}

export async function createAdminAuthFixture() {
  const payload = await getFixturePayload()
  const { createAdminInvitation } = await import('../../src/services/auth/admin-invitations')
  const systemAdmin = await findOrCreateAdmin(
    systemEmail,
    systemPassword,
    ['system_admin'],
    'active',
  )
  await replaceCredential(systemAdmin.id, systemRecoveryCode)
  const disabledAdmin = await findOrCreateAdmin(
    disabledEmail,
    disabledPassword,
    ['analyst'],
    'disabled',
  )
  await replaceCredential(disabledAdmin.id, disabledRecoveryCode)
  for (const [role, account] of Object.entries(roleAccounts) as [
    'ad_operator' | 'analyst' | 'content_editor',
    RoleAccount,
  ][]) {
    const roleAdmin = await findOrCreateAdmin(account.email, account.password, [role], 'active')
    await replaceCredential(roleAdmin.id, account.recoveryCode)
  }

  const staleInvitations = await payload.find({
    collection: 'adminInvitations',
    limit: 100,
    overrideAccess: true,
    where: { email: { contains: 'e2e-invited-' } },
  })
  for (const invitation of staleInvitations.docs) {
    await payload.delete({
      collection: 'adminInvitations',
      id: invitation.id,
      overrideAccess: true,
    })
  }
  const req = await createLocalReq({}, payload)
  req.user = { ...systemAdmin, collection: 'admins' }
  const invitedEmail = `e2e-invited-${Date.now()}@example.test`
  const invitation = await createAdminInvitation(req, {
    email: invitedEmail,
    purpose: 'new_admin',
    roles: ['analyst'],
  })
  const state: AdminAuthFixtureState = {
    disabledEmail,
    disabledPassword,
    disabledRecoveryCode,
    invitationPassword: 'E2E-invited-admin-password-2026',
    invitationUrl: invitation.invitationUrl.replace(
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3100',
    ),
    invitedEmail,
    roleAccounts,
    systemEmail,
    systemPassword,
    systemRecoveryCode,
  }
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
}

export async function readAdminAuthFixture(): Promise<AdminAuthFixtureState> {
  return JSON.parse(await readFile(statePath, 'utf8')) as AdminAuthFixtureState
}

export async function removeAdminAuthFixture() {
  const payload = await getFixturePayload()
  let state: AdminAuthFixtureState | undefined
  try {
    state = await readAdminAuthFixture()
  } catch {
    return
  }
  const invitations = await payload.find({
    collection: 'adminInvitations',
    limit: 100,
    overrideAccess: true,
    where: { email: { equals: state.invitedEmail } },
  })
  for (const invitation of invitations.docs) {
    await payload.delete({
      collection: 'adminInvitations',
      id: invitation.id,
      overrideAccess: true,
    })
  }
  const invited = await payload.find({
    collection: 'admins',
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: state.invitedEmail } },
  })
  for (const admin of invited.docs) {
    const credentials = await payload.find({
      collection: 'adminMfaCredentials',
      overrideAccess: true,
      where: { admin: { equals: admin.id } },
    })
    for (const credential of credentials.docs) {
      await payload.delete({
        collection: 'adminMfaCredentials',
        id: credential.id,
        overrideAccess: true,
      })
    }
    await payload.delete({ collection: 'admins', id: admin.id, overrideAccess: true })
  }
  await unlink(statePath).catch(() => undefined)
}
