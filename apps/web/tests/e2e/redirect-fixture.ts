import { fileURLToPath } from 'node:url'

import { config as loadDotenv } from 'dotenv'
import { createLocalReq, type Payload } from 'payload'

export const redirectFixtureFrom = '/d1-redirect-e2e-legacy'
let fixturePayload: Payload | undefined

export async function getFixturePayload() {
  if (fixturePayload) return fixturePayload
  loadDotenv({ path: fileURLToPath(new URL('../../.env.local', import.meta.url)) })
  const [{ default: config }, { getPayload }] = await Promise.all([
    import('../../src/payload.config'),
    import('payload'),
  ])
  fixturePayload = await getPayload({ config })
  return fixturePayload
}

async function redirectFixtureRequest(payload: Payload) {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': 'e2e-redirect-fixture' }) } },
    payload,
  )
  req.user = {
    collection: 'admins',
    id: 'e2e-redirect-fixture',
    roles: ['system_admin'],
    status: 'active',
  } as never
  return req
}

export async function createRedirectFixture() {
  const payload = await getFixturePayload()
  const req = await redirectFixtureRequest(payload)
  const existing = await payload.find({
    collection: 'redirects',
    overrideAccess: true,
    where: { from: { equals: redirectFixtureFrom } },
  })
  for (const redirect of existing.docs) {
    await payload.delete({ collection: 'redirects', id: redirect.id, overrideAccess: true, req })
  }
  await payload.create({
    collection: 'redirects',
    data: {
      from: redirectFixtureFrom,
      to: { type: 'custom', url: '/help' },
      type: '301',
    },
    overrideAccess: true,
    req,
  })
}

export async function removeRedirectFixture() {
  const payload = await getFixturePayload()
  try {
    const req = await redirectFixtureRequest(payload)
    const existing = await payload.find({
      collection: 'redirects',
      overrideAccess: true,
      where: { from: { equals: redirectFixtureFrom } },
    })
    const targetIds = existing.docs.map((redirect) => String(redirect.id))
    for (const redirect of existing.docs) {
      await payload.delete({ collection: 'redirects', id: redirect.id, overrideAccess: true, req })
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
