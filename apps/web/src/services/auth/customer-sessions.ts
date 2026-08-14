import type { PayloadRequest } from 'payload'

import { hmac, randomOpaqueToken } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import type { Customer } from '@/payload-types'

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
  const now = new Date().toISOString()
  const revoked = await req.payload.update({
    collection: 'customerSessions',
    data: { revokedAt: now },
    overrideAccess: true,
    req,
    where: {
      and: [{ customer: { equals: customerId } }, { revokedAt: { exists: false } }],
    },
  })
  await recordCustomerSecurityEvent(req, customerId, 'sessions_revoked', {
    reason,
    revokedCount: revoked.docs.length,
    scope: 'all',
  })
  return revoked.docs.length
}
