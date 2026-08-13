import type { PayloadRequest } from 'payload'
import { z } from 'zod'

export const COMMERCE_WORKER_HEARTBEAT_KEY = 'operations.worker.heartbeat.commerce.v1'

const commerceWorkerHeartbeatSchema = z
  .object({
    lastSeenAt: z.iso.datetime(),
    role: z.literal('commerce'),
    schemaVersion: z.literal(1),
  })
  .strict()

export async function recordCommerceWorkerHeartbeat(
  req: PayloadRequest,
  now: Date = new Date(),
): Promise<void> {
  const value = commerceWorkerHeartbeatSchema.parse({
    lastSeenAt: now.toISOString(),
    role: 'commerce',
    schemaVersion: 1,
  })
  const found = await req.payload.find({
    collection: 'siteSettings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { key: { equals: COMMERCE_WORKER_HEARTBEAT_KEY } },
  })
  if (found.docs[0]) {
    await req.payload.update({
      collection: 'siteSettings',
      data: { value },
      id: found.docs[0].id,
      overrideAccess: true,
      req,
    })
    return
  }
  await req.payload.create({
    collection: 'siteSettings',
    data: {
      description: 'Commerce Worker 脱敏存活心跳；不保存任务、客户或 provider 数据',
      key: COMMERCE_WORKER_HEARTBEAT_KEY,
      value,
    },
    overrideAccess: true,
    req,
  })
}

export async function commerceWorkerHeartbeatAgeMinutes(
  req: PayloadRequest,
  observedAt: string,
): Promise<null | number> {
  const found = await req.payload.find({
    collection: 'siteSettings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { key: { equals: COMMERCE_WORKER_HEARTBEAT_KEY } },
  })
  const parsed = commerceWorkerHeartbeatSchema.safeParse(found.docs[0]?.value)
  if (!parsed.success) return null
  return Math.max(
    0,
    Math.floor((Date.parse(observedAt) - Date.parse(parsed.data.lastSeenAt)) / 60_000),
  )
}
