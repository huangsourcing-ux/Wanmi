import { randomUUID } from 'node:crypto'

import type { Payload, PayloadRequest } from 'payload'

import { hmac, randomOpaqueToken } from '@/lib/crypto'
import type { StepUpPurpose } from '@/lib/domain'
import { getEnv } from '@/lib/env'
import { clientHashes } from '@/services/auth/client-facts'

export async function issueStepUpGrantFixture(
  payload: Payload,
  req: PayloadRequest,
  customerId: number,
  purpose: StepUpPurpose,
) {
  const deviceId = `step-up-fixture-device-${randomUUID()}`
  const stepUpToken = randomOpaqueToken()
  const { deviceHash, ipHash } = clientHashes(req.headers, deviceId)
  await payload.create({
    collection: 'stepUpGrants',
    data: {
      customer: customerId,
      deviceHash,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ipHash,
      purpose,
      tokenHash: hmac(stepUpToken, getEnv().SESSION_PEPPER),
    },
    overrideAccess: true,
    req,
  })
  return { deviceId, stepUpToken }
}
