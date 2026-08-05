import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { getFixturePayload } from './redirect-fixture'

const statePath = resolve(process.cwd(), 'test-results/first-party-event-fixture.json')

export async function createFirstPartyEventFixture() {
  const startedAt = new Date(Date.now() - 1_000).toISOString()
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify({ startedAt }), 'utf8')
}

export async function removeFirstPartyEventFixture() {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { startedAt: string }
  const payload = await getFixturePayload()
  while (true) {
    const events = await payload.find({
      collection: 'firstPartyEvents',
      limit: 100,
      overrideAccess: true,
      where: { createdAt: { greater_than: state.startedAt } },
    })
    if (!events.docs.length) break
    for (const event of events.docs) {
      await payload.delete({ collection: 'firstPartyEvents', id: event.id, overrideAccess: true })
    }
  }
  await unlink(statePath).catch(() => undefined)
}
