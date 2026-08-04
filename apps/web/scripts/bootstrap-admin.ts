import { randomBytes } from 'node:crypto'

import config from '@payload-config'
import * as OTPAuth from 'otpauth'
import { getPayload } from 'payload'

import { encryptSecret, hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'

async function main() {
  const email = process.env.WANMI_BOOTSTRAP_ADMIN_EMAIL
  const password = process.env.WANMI_BOOTSTRAP_ADMIN_PASSWORD
  if (!email || !password || password.length < 14) {
    throw new Error(
      'Set WANMI_BOOTSTRAP_ADMIN_EMAIL and a 14+ character WANMI_BOOTSTRAP_ADMIN_PASSWORD',
    )
  }
  const payload = await getPayload({ config })
  const existing = await payload.count({ collection: 'admins', overrideAccess: true })
  if (existing.totalDocs > 0) throw new Error('Bootstrap is only allowed when no admin exists')

  const env = getEnv()
  const secret = new OTPAuth.Secret({ size: 20 })
  const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(9).toString('base64url'))
  await payload.create({
    collection: 'admins',
    data: {
      email,
      password,
      recoveryCodeHashes: recoveryCodes.map((code) => hmac(code, env.SESSION_PEPPER)),
      roles: ['system_admin'],
      totpEnabled: true,
      totpSecretEncrypted: encryptSecret(secret.base32, env.TOTP_ENCRYPTION_KEY),
    },
    overrideAccess: true,
  })
  const totp = new OTPAuth.TOTP({ issuer: 'Wanmi.AI', label: email, secret })
  process.stdout.write(`TOTP URI (store securely, shown once):\n${totp.toString()}\n`)
  process.stdout.write(
    `Recovery codes (store securely, shown once):\n${recoveryCodes.join('\n')}\n`,
  )
  await payload.db.destroy?.()
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Admin bootstrap failed'}\n`)
  process.exitCode = 1
})
