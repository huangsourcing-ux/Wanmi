import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import {
  inspectUnfinishedCommerceJobs,
  recoverInterruptedCommerceJobs,
} from '@/services/operations/commerce-job-recovery'

const acknowledgement = 'D7-07-RECOVER-INTERRUPTED'

async function main() {
  if (process.env.WANMI_COMMERCE_RECOVERY_ACK !== acknowledgement) {
    throw new Error(`WANMI_COMMERCE_RECOVERY_ACK must equal ${acknowledgement}`)
  }
  const cutoffValue = process.env.WANMI_COMMERCE_RECOVERY_BEFORE
  const interruptedBefore = new Date(cutoffValue ?? '')
  if (!cutoffValue || !Number.isFinite(interruptedBefore.getTime())) {
    throw new Error('WANMI_COMMERCE_RECOVERY_BEFORE must be an ISO timestamp')
  }

  const payload = await getPayload({ config })
  try {
    const req = await createLocalReq({}, payload)
    const before = await inspectUnfinishedCommerceJobs(req)
    const result = await recoverInterruptedCommerceJobs(req, {
      interruptedBefore,
      traceId: `commerce-recovery-${randomUUID()}`,
    })
    const after = await inspectUnfinishedCommerceJobs(req)
    process.stdout.write(
      `D7_RECOVERY_RESULT ${JSON.stringify({
        after,
        before,
        recoveredCount: result.recovered.length,
        recoveredJobIds: result.recovered.map(({ id }) => String(id)),
        status: 'passed',
      })}\n`,
    )
  } finally {
    await payload.db.destroy?.()
  }
}

await main()
