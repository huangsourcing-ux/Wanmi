export const REBUILD_STEP_NAMES = [
  'prepare-environment-and-network',
  'pull-digest-image',
  'run-payload-migrations',
  'start-web',
  'verify-readyz',
  'start-commerce-worker',
  'recover-unfinished-commerce-jobs',
  'start-nginx',
]

export async function executeRebuildPlan(steps) {
  for (const name of REBUILD_STEP_NAMES) {
    const step = steps[name]
    if (typeof step !== 'function') throw new Error(`Missing rebuild step: ${name}`)
    await step()
  }
}
