import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

import { hmac, randomOpaqueToken } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import type { Customer } from '@/payload-types'

import { authTransactionDatabase, inAuthTransaction } from './atomic'
import { recordCustomerSecurityEvent } from './security-events'

export async function issueCustomerSession(
  req: PayloadRequest,
  input: {
    customer: Customer
    deviceHash: string
    ipHash: string
    now?: Date
  },
): Promise<{ expiresAt: string; token: string }> {
  const now = input.now ?? new Date()
  const env = getEnv()
  const expiresAt = new Date(now.getTime() + env.CUSTOMER_SESSION_SECONDS * 1_000).toISOString()
  const token = randomOpaqueToken()
  await req.payload.update({
    collection: 'customerSessions',
    data: { revokedAt: now.toISOString() },
    overrideAccess: true,
    req,
    where: {
      and: [
        { customer: { equals: input.customer.id } },
        { deviceHash: { equals: input.deviceHash } },
        { revokedAt: { exists: false } },
      ],
    },
  })
  await req.payload.create({
    collection: 'customerSessions',
    data: {
      customer: input.customer.id,
      deviceHash: input.deviceHash,
      expiresAt,
      ipHash: input.ipHash,
      lastSeenAt: now.toISOString(),
      tokenHash: hmac(token, env.SESSION_PEPPER),
    },
    overrideAccess: true,
    req,
  })
  await recordCustomerSecurityEvent(req, input.customer.id, 'login_succeeded', {
    deviceHash: input.deviceHash,
    ipHash: input.ipHash,
  })
  return { expiresAt, token }
}

export async function revokeAllCustomerSessions(
  req: PayloadRequest,
  customerId: number,
  reason: string,
): Promise<number> {
  return inAuthTransaction(req, async () => {
    const now = new Date().toISOString()
    const database = await authTransactionDatabase(req)
    const revoked = await database.execute(sql`
      UPDATE customer_sessions
      SET revoked_at = ${now}, updated_at = NOW()
      WHERE customer_id = ${customerId}
        AND revoked_at IS NULL
      RETURNING id
    `)
    const revokedCount = revoked.rows?.length ?? 0
    await recordCustomerSecurityEvent(req, customerId, 'sessions_revoked', {
      reason,
      revokedCount,
      scope: 'all',
    })
    return revokedCount
  })
}
