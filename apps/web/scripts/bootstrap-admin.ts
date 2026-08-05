import config from '@payload-config'
import {
  commitTransaction,
  createLocalReq,
  getPayload,
  initTransaction,
  killTransaction,
} from 'payload'

import { encryptSecret } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import {
  createTotp,
  createTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCodes,
} from '@/services/auth/totp'

async function main() {
  const email = process.env.WANMI_BOOTSTRAP_ADMIN_EMAIL
  const password = process.env.WANMI_BOOTSTRAP_ADMIN_PASSWORD
  if (!email || !password || password.length < 14 || password.length > 128) {
    throw new Error(
      'Set WANMI_BOOTSTRAP_ADMIN_EMAIL and a 14+ character WANMI_BOOTSTRAP_ADMIN_PASSWORD',
    )
  }
  const payload = await getPayload({ config })
  const existing = await payload.count({ collection: 'admins', overrideAccess: true })
  if (existing.totalDocs > 0) throw new Error('Bootstrap is only allowed when no admin exists')

  const env = getEnv()
  const secret = createTotpSecret()
  const recoveryCodes = generateRecoveryCodes()
  const req = await createLocalReq({}, payload)
  const startedTransaction = await initTransaction(req)
  try {
    const admin = await payload.create({
      collection: 'admins',
      context: { adminAccountOperation: 'bootstrap', suppressAdminAccountAudit: true },
      data: { email, password, roles: ['system_admin'], status: 'active' },
      overrideAccess: true,
      req,
    })
    await payload.create({
      collection: 'adminMfaCredentials',
      data: {
        admin: admin.id,
        configuredAt: new Date().toISOString(),
        failedAttempts: 0,
        recoveryCodeHashes: hashRecoveryCodes(recoveryCodes),
        secretEncrypted: encryptSecret(secret, env.TOTP_ENCRYPTION_KEY),
        version: 0,
      },
      overrideAccess: true,
      req,
    })
    if (startedTransaction) await commitTransaction(req)
  } catch (error) {
    if (startedTransaction) await killTransaction(req)
    throw error
  }
  process.stdout.write(
    `TOTP URI (store securely, shown once):\n${createTotp(secret, email).toString()}\n`,
  )
  process.stdout.write(
    `Recovery codes (store securely, shown once):\n${recoveryCodes.join('\n')}\n`,
  )
  await payload.db.destroy?.()
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Admin bootstrap failed'}\n`)
  process.exitCode = 1
})
