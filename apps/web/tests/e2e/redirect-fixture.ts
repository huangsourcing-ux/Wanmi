import { resolve } from 'node:path'

import { config as loadDotenv } from 'dotenv'
import type { Payload } from 'payload'

export const redirectFixtureFrom = '/d1-redirect-e2e-legacy'
let fixturePayload: Payload | undefined

async function getFixturePayload() {
  if (fixturePayload) return fixturePayload
  loadDotenv({ path: resolve(process.cwd(), '.env.local') })
  const [{ default: config }, { getPayload }] = await Promise.all([
    import('../../src/payload.config'),
    import('payload'),
  ])
  fixturePayload = await getPayload({ config })
  return fixturePayload
}

export async function createRedirectFixture() {
  const payload = await getFixturePayload()
  const existing = await payload.find({
    collection: 'redirects',
    overrideAccess: true,
    where: { from: { equals: redirectFixtureFrom } },
  })
  for (const redirect of existing.docs) {
    await payload.delete({ collection: 'redirects', id: redirect.id, overrideAccess: true })
  }
  await payload.create({
    collection: 'redirects',
    data: {
      from: redirectFixtureFrom,
      to: { type: 'custom', url: '/help' },
      type: '301',
    },
    overrideAccess: true,
  })
}

export async function removeRedirectFixture() {
  const payload = await getFixturePayload()
  try {
    const existing = await payload.find({
      collection: 'redirects',
      overrideAccess: true,
      where: { from: { equals: redirectFixtureFrom } },
    })
    const targetIds = existing.docs.map((redirect) => String(redirect.id))
    for (const redirect of existing.docs) {
      await payload.delete({ collection: 'redirects', id: redirect.id, overrideAccess: true })
    }
    if (targetIds.length) {
      const audits = await payload.find({
        collection: 'auditLogs',
        limit: 100,
        overrideAccess: true,
        where: { targetId: { in: targetIds } },
      })
      for (const audit of audits.docs) {
        await payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true })
      }
    }
  } finally {
    await payload.db.destroy?.()
    fixturePayload = undefined
  }
}
