import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AdminRole } from '@/lib/domain'
import { recordFirstPartyEvent } from '@/services/analytics/record-first-party-event'

let payload: Payload
const createdIds: Array<number | string> = []

function admin(role: AdminRole, id: number, status: 'active' | 'disabled' = 'active') {
  return {
    collection: 'admins' as const,
    email: `${role}-${id}@example.test`,
    id,
    roles: [role],
    status,
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  for (const id of createdIds.reverse()) {
    await payload
      .delete({ collection: 'firstPartyEvents', id, overrideAccess: true })
      .catch(() => undefined)
  }
  await payload.db.destroy?.()
})

describe('D1 first-party event persistence and access', () => {
  it('stores only approved aggregate dimensions and denies every non-system reader', async () => {
    const result = await recordFirstPartyEvent(payload, {
      event: 'tool_submitted',
      fromLocalHistory: false,
      inputType: 'full_domain',
      schemaVersion: 1,
      tld: 'net',
      tool: 'domain-search',
    })
    const stored = await payload.find({
      collection: 'firstPartyEvents',
      limit: 1,
      overrideAccess: true,
      where: { traceId: { equals: result.traceId } },
    })
    expect(stored.docs).toHaveLength(1)
    const event = stored.docs[0]!
    createdIds.push(event.id)
    expect(event).toMatchObject({
      event: 'tool_submitted',
      fromLocalHistory: false,
      inputType: 'full_domain',
      schemaVersion: 1,
      tld: 'net',
      tool: 'domain-search',
      traceId: result.traceId,
    })
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('wanmi.net')
    for (const forbidden of [
      'clientId',
      'cookie',
      'domain',
      'ip',
      'query',
      'referrer',
      'sessionId',
      'url',
      'userAgent',
    ]) {
      expect(event).not.toHaveProperty(forbidden)
    }

    const readers = [
      undefined,
      { collection: 'customers', id: 2101 },
      admin('content_editor', 2102),
      admin('ad_operator', 2103),
      admin('analyst', 2104),
      admin('system_admin', 2105, 'disabled'),
    ]
    for (const user of readers) {
      await expect(
        payload.find({
          collection: 'firstPartyEvents',
          overrideAccess: false,
          user: user as never,
          where: { traceId: { equals: result.traceId } },
        }),
      ).rejects.toThrow()
    }

    const systemView = await payload.find({
      collection: 'firstPartyEvents',
      overrideAccess: false,
      user: admin('system_admin', 2106) as never,
      where: { traceId: { equals: result.traceId } },
    })
    expect(systemView.docs).toHaveLength(1)
  })

  it('rejects generic mutations and complete-domain attempts before persistence', async () => {
    const systemAdmin = admin('system_admin', 2201)
    const rejectedTld = `${randomUUID()}.wanmi.net`
    await expect(
      payload.create({
        collection: 'firstPartyEvents',
        data: {
          event: 'page_viewed',
          pageType: 'home',
          schemaVersion: 1,
          traceId: 'generic-create-must-fail',
        },
        overrideAccess: false,
        user: systemAdmin as never,
      }),
    ).rejects.toThrow()

    const before = await payload.count({
      collection: 'firstPartyEvents',
      overrideAccess: true,
      where: { tld: { equals: rejectedTld } },
    })
    expect(before.totalDocs).toBe(0)
    await expect(
      recordFirstPartyEvent(payload, {
        event: 'tool_submitted',
        fromLocalHistory: false,
        inputType: 'full_domain',
        schemaVersion: 1,
        tld: rejectedTld,
        tool: 'domain-search',
      }),
    ).rejects.toThrow()
    const after = await payload.count({
      collection: 'firstPartyEvents',
      overrideAccess: true,
      where: { tld: { equals: rejectedTld } },
    })
    expect(after.totalDocs).toBe(0)
  })

  it('stores closed advertising dimensions without a query, account or cross-site identifier', async () => {
    const result = await recordFirstPartyEvent(payload, {
      campaignId: '3c9cc764-74fd-4baa-94e9-48865e85efb1',
      conversionType: 'landing_viewed',
      event: 'ad_converted',
      pageType: 'content',
      placementCode: 'content-inline',
      schemaVersion: 1,
    })
    const stored = await payload.find({
      collection: 'firstPartyEvents',
      limit: 1,
      overrideAccess: true,
      where: { traceId: { equals: result.traceId } },
    })
    expect(stored.docs).toHaveLength(1)
    const event = stored.docs[0]!
    createdIds.push(event.id)
    expect(event).toMatchObject({
      campaignId: '3c9cc764-74fd-4baa-94e9-48865e85efb1',
      conversionType: 'landing_viewed',
      event: 'ad_converted',
      pageType: 'content',
      placementCode: 'content-inline',
    })
    for (const forbidden of [
      'clientId',
      'cookie',
      'crossSiteId',
      'customerId',
      'domain',
      'query',
      'sessionId',
      'userId',
    ]) {
      expect(event).not.toHaveProperty(forbidden)
    }
  })
})
