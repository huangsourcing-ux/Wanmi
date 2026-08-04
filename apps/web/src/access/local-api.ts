import type { Payload, PayloadRequest, SelectType, Where } from 'payload'

import { getTraceId } from '@/lib/errors'

type UserFindArgs = {
  collection: string
  depth?: number
  limit?: number
  page?: number
  req?: PayloadRequest
  select?: SelectType
  sort?: string
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

export async function systemFindForJob(
  payload: Payload,
  args: Omit<UserFindArgs, 'user' | 'req'> & { req: PayloadRequest },
  auditReason: string,
) {
  if (!auditReason.trim()) throw new Error('System access requires an audit reason')
  await payload.create({
    collection: 'auditLogs',
    data: {
      action: 'system.local_api.read',
      actorType: 'system',
      metadata: { collection: args.collection, reason: auditReason },
      targetType: args.collection,
      traceId: getTraceId(args.req.headers),
    },
    overrideAccess: true,
    req: args.req,
  })
  return payload.find({
    ...args,
    collection: args.collection as never,
    overrideAccess: true,
  } as never)
}
