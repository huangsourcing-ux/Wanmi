import config from '@payload-config'
import { getPayload } from 'payload'

const payload = await getPayload({ config })

try {
  const result = await payload.find({
    collection: 'payload-jobs',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
    select: {
      processing: true,
      queue: true,
      taskSlug: true,
      workflowSlug: true,
    },
    where: {
      and: [
        { queue: { equals: 'commerce' } },
        { completedAt: { exists: false } },
        { hasError: { not_equals: true } },
      ],
    },
  })
  const counts = new Map<string, number>()
  for (const job of result.docs) {
    const type = job.workflowSlug ?? job.taskSlug ?? 'unknown'
    const state = job.processing ? 'processing' : 'runnable'
    const key = `${type}:${state}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  process.stdout.write(
    `D7_17_COMMERCE_JOB_COUNTS ${JSON.stringify(Object.fromEntries([...counts].sort()))}\n`,
  )
} finally {
  await payload.db.destroy?.()
}
