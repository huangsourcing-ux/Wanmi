import type { PayloadRequest } from 'payload'

import { isAdminUser, isCustomerUser } from '@/access/roles'
import { getTraceId } from '@/lib/request-id'

export type AuditEventInput = {
  action: string
  metadata?: Record<string, unknown>
  targetId?: number | string
  targetType: string
}

function actor(req: PayloadRequest): {
  actorId?: string
  actorType: 'admin' | 'anonymous' | 'customer' | 'provider' | 'system'
} {
  if (isAdminUser(req.user)) return { actorId: String(req.user.id), actorType: 'admin' }
  if (isCustomerUser(req.user)) return { actorId: String(req.user.id), actorType: 'customer' }
  if (req.user) return { actorType: 'system' }
  return { actorType: 'anonymous' }
}

export async function recordAuditEvent(req: PayloadRequest, input: AuditEventInput): Promise<void> {
  await req.payload.create({
    collection: 'auditLogs',
    data: {
      action: input.action,
      ...actor(req),
      metadata: input.metadata,
      targetId: input.targetId === undefined ? undefined : String(input.targetId),
      targetType: input.targetType,
      traceId: getTraceId(req.headers),
    },
    overrideAccess: true,
    req,
  })
}
