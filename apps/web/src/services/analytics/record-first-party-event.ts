import type { Payload } from 'payload'

import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { createTraceId } from '@/lib/request-id'
import { firstPartyEventSchema, type FirstPartyEventInput } from '@/schemas/analytics'
import { sanitizeSensitiveData } from '@/services/privacy/sanitize-sensitive-data'

async function enforceGlobalAdmissionLimit(payload: Payload): Promise<void> {
  const since = new Date(Date.now() - 60_000).toISOString()
  const recent = await payload.count({
    collection: 'firstPartyEvents',
    overrideAccess: true,
    where: { createdAt: { greater_than: since } },
  })
  if (recent.totalDocs >= getEnv().FIRST_PARTY_EVENT_LIMIT_PER_MINUTE) {
    throw new AppError('EVENT_RATE_LIMITED', '事件入口暂时繁忙', 429)
  }
}

export async function recordFirstPartyEvent(
  payload: Payload,
  candidate: unknown,
): Promise<{ traceId: string }> {
  const input = firstPartyEventSchema.parse(candidate)
  await enforceGlobalAdmissionLimit(payload)
  const traceId = createTraceId()
  const safeInput = sanitizeSensitiveData<FirstPartyEventInput>(input)
  const storedInput =
    safeInput.event === 'tool_failed' ? { ...safeInput, succeeded: false } : safeInput
  await payload.create({
    collection: 'firstPartyEvents',
    data: { ...storedInput, traceId },
    overrideAccess: true,
  })
  return { traceId }
}
