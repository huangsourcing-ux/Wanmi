import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { recoverInterruptedCommerceJobs } from '@/services/operations/commerce-job-recovery'

const prefix = `d7-job-recovery-${randomUUID()}`
const jobIds: Array<number | string> = []
let payload: Payload

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  for (const jobId of jobIds) {
    await payload.delete({ collection: 'payload-jobs', id: jobId, overrideAccess: true })
    await payload.delete({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'commerce.job.interrupted_released' } },
          { targetId: { equals: String(jobId) } },
        ],
      },
    })
  }
  await payload.db.destroy?.()
})

describe('D7-07 interrupted commerce Job recovery', () => {
  it('atomically releases one interrupted Job under concurrent recovery attempts', async () => {
    const job = await payload.jobs.queue({
      input: {
        operationKey: `${prefix}-operation`,
        orderId: 2_147_000_000,
        traceId: prefix,
      },
      overrideAccess: true,
      queue: 'commerce',
      workflow: 'commerceFulfillment',
    })
    jobIds.push(job.id)
    await payload.update({
      collection: 'payload-jobs',
      data: { processing: true },
      id: job.id,
      overrideAccess: true,
    })

    const interruptedBefore = new Date()
    const results = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        recoverInterruptedCommerceJobs(await createLocalReq({}, payload), {
          interruptedBefore,
          traceId: `${prefix}-${index}`,
        }),
      ),
    )
    expect(results.flatMap(({ recovered }) => recovered.map(({ id }) => id))).toEqual([job.id])
    expect(
      (
        await payload.findByID({
          collection: 'payload-jobs',
          id: job.id,
          overrideAccess: true,
        })
      ).processing,
    ).toBe(false)
    const audits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'commerce.job.interrupted_released' } },
          { targetId: { equals: String(job.id) } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(1)
  })
})
