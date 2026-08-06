import type { Payload } from 'payload'

import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { logger } from '@/lib/logging'
import { createTraceId } from '@/lib/request-id'
import { firstPartyEventSchema, type FirstPartyEventInput } from '@/schemas/analytics'
import { sanitizeSensitiveData } from '@/services/privacy/sanitize-sensitive-data'
import {
  payloadToolObservabilityStore,
  type ToolObservabilityStore,
} from '@/services/observability/tool-observability'

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
  options: { observability?: ToolObservabilityStore } = {},
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
  if (safeInput.event === 'tool_completed' || safeInput.event === 'tool_failed') {
    try {
      await (options.observability ?? payloadToolObservabilityStore(payload)).record({
        durationBucket: safeInput.durationBucket,
        scope: 'tool',
        succeeded: safeInput.event === 'tool_completed' && safeInput.succeeded,
        tool: safeInput.tool,
      })
    } catch (error) {
      logger.warn({
        errorType: error instanceof Error ? error.name : 'UnknownError',
        event: 'observability.persist_failed',
        scope: 'tool',
        tool: safeInput.tool,
      })
    }
  }
  return { traceId }
}
