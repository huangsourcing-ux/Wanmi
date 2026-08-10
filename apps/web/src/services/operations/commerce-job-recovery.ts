import { sql } from '@payloadcms/db-postgres'
import {
  commitTransaction,
  initTransaction,
  killTransaction,
  type PayloadRequest,
  type Where,
} from 'payload'

import { AppError } from '@/lib/errors'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

type RecoveredJob = {
  id: number | string
  workflowSlug?: null | string
}

async function database(req: PayloadRequest) {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as
    | {
        execute(statement: ReturnType<typeof sql>): Promise<{ rows?: RecoveredJob[] }>
      }
    | undefined
  if (!current) {
    throw new AppError('COMMERCE_JOB_RECOVERY_UNAVAILABLE', '无法原子恢复 commerce Job', 503)
  }
  return current
}

export async function inspectUnfinishedCommerceJobs(req: PayloadRequest): Promise<{
  processing: number
  runnable: number
  total: number
}> {
  const base: Where[] = [
    { queue: { equals: 'commerce' } },
    { completedAt: { exists: false } },
    { hasError: { not_equals: true } },
  ]
  const [total, processing, runnable] = await Promise.all([
    req.payload.count({
      collection: 'payload-jobs',
      overrideAccess: true,
      req,
      where: { and: base },
    }),
    req.payload.count({
      collection: 'payload-jobs',
      overrideAccess: true,
      req,
      where: { and: [...base, { processing: { equals: true } }] },
    }),
    req.payload.count({
      collection: 'payload-jobs',
      overrideAccess: true,
      req,
      where: { and: [...base, { processing: { equals: false } }] },
    }),
  ])
  return {
    processing: processing.totalDocs,
    runnable: runnable.totalDocs,
    total: total.totalDocs,
  }
}

export async function recoverInterruptedCommerceJobs(
  req: PayloadRequest,
  input: { interruptedBefore: Date; traceId: string },
): Promise<{ recovered: RecoveredJob[] }> {
  if (!Number.isFinite(input.interruptedBefore.getTime())) {
    throw new AppError('COMMERCE_JOB_RECOVERY_CUTOFF_INVALID', '恢复截止时间无效', 400)
  }
  if (input.interruptedBefore.getTime() > Date.now() + 5_000) {
    throw new AppError('COMMERCE_JOB_RECOVERY_CUTOFF_FUTURE', '恢复截止时间不能位于未来', 400)
  }

  const started = await initTransaction(req)
  try {
    const recovered = await (
      await database(req)
    ).execute(sql`
      UPDATE payload_jobs
      SET processing = FALSE,
          updated_at = NOW()
      WHERE queue = 'commerce'
        AND processing IS TRUE
        AND completed_at IS NULL
        AND has_error IS NOT TRUE
        AND updated_at <= ${input.interruptedBefore.toISOString()}::timestamptz
      RETURNING id, workflow_slug AS "workflowSlug"
    `)
    const jobs = recovered.rows ?? []
    for (const job of jobs) {
      await recordAuditEvent(req, {
        action: 'commerce.job.interrupted_released',
        actor: { type: 'system' },
        metadata: {
          interruptedBefore: input.interruptedBefore.toISOString(),
          jobId: String(job.id),
          traceId: input.traceId,
          workflowSlug: job.workflowSlug ?? 'unknown',
        },
        targetId: job.id,
      })
    }
    if (started) await commitTransaction(req)
    return { recovered: jobs }
  } catch (error) {
    if (started) await killTransaction(req)
    throw error
  }
}
