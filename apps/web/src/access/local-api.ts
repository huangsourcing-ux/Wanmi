import type { Payload, PayloadRequest, SelectType, Where } from 'payload'

import { recordAuditEvent } from '@/services/audit/record-audit-event'

type UserFindArgs = {
  collection: string
  depth?: number
  draft?: boolean
  limit?: number
  page?: number
  req?: PayloadRequest
  select?: SelectType
  sort?: string
  user: NonNullable<PayloadRequest['user']>
  where?: Where
}

type UserCountArgs = {
  collection: string
  draft?: boolean
  req?: PayloadRequest
  user: NonNullable<PayloadRequest['user']>
  where?: Where
}

export async function findAsUser(payload: Payload, args: UserFindArgs) {
  return payload.find({
    ...args,
    collection: args.collection as never,
    overrideAccess: false,
  } as never)
}

export async function countAsUser(payload: Payload, args: UserCountArgs) {
  return payload.count({
    ...args,
    collection: args.collection as never,
    overrideAccess: false,
  } as never)
}

export async function systemFindForJob(
  payload: Payload,
  args: Omit<UserFindArgs, 'user' | 'req'> & { req: PayloadRequest },
  auditReason: string,
) {
  if (!auditReason.trim()) throw new Error('System access requires an audit reason')
  await recordAuditEvent(args.req, {
    action: 'system.local_api.read',
    actor: { type: 'system' },
    metadata: { collection: args.collection, reason: auditReason },
    targetId: args.collection,
  })
  return payload.find({
    ...args,
    collection: args.collection as never,
    overrideAccess: true,
  } as never)
}
