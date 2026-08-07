import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  readPublicAdvertisement,
  resolvePublicAdTarget,
} from '@/services/advertising/read-public-ad'
import { runAdvertisingMaintenance } from '@/services/advertising/maintenance'

const fixturePrefix = `d3-advertising-${randomUUID()}`
const created: Array<{
  collection: 'adCreatives' | 'adPlacements' | 'adSchedules' | 'advertisers'
  id: number | string
}> = []
let payload: Payload

const adOperator = {
  collection: 'admins' as const,
  email: 'd3-ad-operator@example.test',
  id: 9101,
  roles: ['ad_operator' as const],
  status: 'active' as const,
}
const analyst = {
  collection: 'admins' as const,
  email: 'd3-analyst@example.test',
  id: 9102,
  roles: ['analyst' as const],
  status: 'active' as const,
}

async function operatorReq(traceId: string) {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': traceId }) } },
    payload,
  )
  req.user = adOperator as never
  return req
}

async function systemReq(traceId: string) {
  return createLocalReq({ req: { headers: new Headers({ 'x-request-id': traceId }) } }, payload)
}

async function remember<T extends { id: number | string }>(
  collection: (typeof created)[number]['collection'],
  operation: Promise<T>,
): Promise<T> {
  const document = await operation
  created.push({ collection, id: document.id })
  return document
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  for (const fixture of created.reverse()) {
    await payload
      .delete({ collection: fixture.collection, id: fixture.id, overrideAccess: true })
      .catch(() => undefined)
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 100,
    overrideAccess: true,
    where: { targetType: { equals: 'advertising' } },
  })
  for (const audit of audits.docs.filter((document) =>
    document.traceId.startsWith(fixturePrefix),
  )) {
    await payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true })
  }
  await payload.db.destroy?.()
})

describe('D3 advertising model, RBAC and controlled delivery', () => {
  it('publishes through reviewed states, redacts analyst fields and serves a controlled target', async () => {
    const createAdvertiserReq = await operatorReq(`${fixturePrefix}-advertiser-create`)
    const advertiser = await remember(
      'advertisers',
      payload.create({
        collection: 'advertisers',
        data: {
          allowedHosts: [{ host: 'ADS.EXAMPLE.TEST' }],
          contactEmail: 'commercial@example.test',
          name: `${fixturePrefix} advertiser`,
          notes: 'commercial terms',
          status: 'active',
        },
        overrideAccess: false,
        req: createAdvertiserReq,
        user: adOperator as never,
      }),
    )
    expect(advertiser.status).toBe('draft')
    const activateAdvertiserReq = await operatorReq(`${fixturePrefix}-advertiser-activate`)
    await payload.update({
      collection: 'advertisers',
      data: { status: 'active' },
      id: advertiser.id,
      overrideAccess: false,
      req: activateAdvertiserReq,
      user: adOperator as never,
    })
    const placement = await remember(
      'adPlacements',
      payload.create({
        collection: 'adPlacements',
        data: {
          code: `${fixturePrefix}-tool-after-result`,
          description: '核心工具结果之后的固定广告位',
          deviceScope: 'all',
          enabled: true,
          height: 90,
          name: `${fixturePrefix} placement`,
          pageTypes: ['tool'],
          position: 'after_core_result',
          width: 970,
        },
        overrideAccess: false,
        req: await operatorReq(`${fixturePrefix}-placement-create`),
        user: adOperator as never,
      }),
    )

    const creative = await remember(
      'adCreatives',
      payload.create({
        collection: 'adCreatives',
        data: {
          advertiser: advertiser.id,
          body: '明确广告内容，不参与自然结果排序。',
          creativeType: 'text',
          headline: 'D3 广告合作内容',
          name: `${fixturePrefix} creative`,
          status: 'approved',
          targetCheckFailure: 'none',
          targetCheckStatus: 'pending',
          targetType: 'external',
          targetUrl: 'https://ads.example.test/landing?campaign=d3',
        },
        overrideAccess: false,
        req: await operatorReq(`${fixturePrefix}-creative-create`),
        user: adOperator as never,
      }),
    )
    expect(creative.status).toBe('draft')
    await payload.update({
      collection: 'adCreatives',
      data: { status: 'pending_review' },
      id: creative.id,
      overrideAccess: false,
      req: await operatorReq(`${fixturePrefix}-creative-review`),
      user: adOperator as never,
    })
    await payload.update({
      collection: 'adCreatives',
      data: { status: 'approved' },
      id: creative.id,
      overrideAccess: false,
      req: await operatorReq(`${fixturePrefix}-creative-approve`),
      user: adOperator as never,
    })
    await expect(
      payload.findByID({ collection: 'adCreatives', id: creative.id, overrideAccess: true }),
    ).resolves.toMatchObject({ status: 'approved', targetCheckStatus: 'pending' })
    const initialMaintenance = await runAdvertisingMaintenance(
      await systemReq(`${fixturePrefix}-target-initial`),
      {
        probe: async () => ({ failure: 'none', status: 'reachable' }),
      },
    )
    expect(initialMaintenance.checked).toBeGreaterThanOrEqual(1)

    const startsAt = new Date(Date.now() - 60_000).toISOString()
    const endsAt = new Date(Date.now() + 3_600_000).toISOString()
    const schedule = await remember(
      'adSchedules',
      payload.create({
        collection: 'adSchedules',
        data: {
          advertiser: advertiser.id,
          creative: creative.id,
          endsAt,
          name: `${fixturePrefix} schedule`,
          placement: placement.id,
          priority: 100,
          startsAt,
          status: 'active',
        } as never,
        overrideAccess: false,
        req: await operatorReq(`${fixturePrefix}-schedule-create`),
        user: adOperator as never,
      }),
    )
    expect(schedule.status).toBe('draft')
    expect(schedule.publicId).toMatch(/^[0-9a-f-]{36}$/)
    await payload.update({
      collection: 'adSchedules',
      data: { status: 'scheduled' },
      id: schedule.id,
      overrideAccess: false,
      req: await operatorReq(`${fixturePrefix}-schedule-scheduled`),
      user: adOperator as never,
    })
    await payload.update({
      collection: 'adSchedules',
      data: { status: 'active' },
      id: schedule.id,
      overrideAccess: false,
      req: await operatorReq(`${fixturePrefix}-schedule-active`),
      user: adOperator as never,
    })

    const analystAdvertiser = await payload.findByID({
      collection: 'advertisers',
      id: advertiser.id,
      overrideAccess: false,
      user: analyst as never,
    })
    expect(analystAdvertiser.allowedHosts).toEqual([])
    expect(analystAdvertiser).not.toHaveProperty('contactEmail')
    expect(analystAdvertiser).not.toHaveProperty('notes')
    const analystCreative = await payload.findByID({
      collection: 'adCreatives',
      id: creative.id,
      overrideAccess: false,
      user: analyst as never,
    })
    expect(analystCreative).not.toHaveProperty('targetUrl')
    await expect(
      payload.update({
        collection: 'adSchedules',
        data: { status: 'disabled' },
        id: schedule.id,
        overrideAccess: false,
        user: analyst as never,
      }),
    ).rejects.toThrow()

    const advertisement = await readPublicAdvertisement(payload, {
      pageType: 'tool',
      placementCode: placement.code,
    })
    expect(advertisement).toMatchObject({
      clickHref: `/go/ad/${schedule.publicId}`,
      external: true,
      headline: 'D3 广告合作内容',
    })
    expect(JSON.stringify(advertisement)).not.toContain('commercial@example.test')
    await expect(resolvePublicAdTarget(payload, schedule.publicId)).resolves.toEqual({
      external: true,
      targetUrl: 'https://ads.example.test/landing?campaign=d3',
    })

    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 20,
      overrideAccess: true,
      where: { targetId: { equals: String(schedule.id) } },
    })
    expect(audits.docs.map((audit) => audit.action)).toContain('advertising.change')
    expect(JSON.stringify(audits.docs)).not.toContain('ads.example.test/landing')

    const expired = await runAdvertisingMaintenance(
      await systemReq(`${fixturePrefix}-schedule-expiry`),
      {
        now: new Date(new Date(endsAt).getTime() + 1),
        probe: async () => ({ failure: 'none', status: 'reachable' }),
      },
    )
    expect(expired.expired).toBe(1)
    const replay = await runAdvertisingMaintenance(
      await systemReq(`${fixturePrefix}-schedule-expiry-replay`),
      {
        now: new Date(new Date(endsAt).getTime() + 2),
        probe: async () => ({ failure: 'none', status: 'reachable' }),
      },
    )
    expect(replay.expired).toBe(0)
    await expect(
      payload.findByID({ collection: 'adSchedules', id: schedule.id, overrideAccess: true }),
    ).resolves.toMatchObject({ status: 'ended' })
    await expect(
      readPublicAdvertisement(payload, {
        pageType: 'tool',
        placementCode: placement.code,
      }),
    ).resolves.toBeNull()
  })

  it('rejects protocol-relative, backslash and unapproved-host targets before persistence', async () => {
    const advertiser = created.find((fixture) => fixture.collection === 'advertisers')
    if (!advertiser) throw new Error('advertiser fixture missing')
    for (const [targetType, targetUrl] of [
      ['internal', '//evil.example'],
      ['internal', '/\\evil.example'],
      ['external', 'https://evil.example/landing'],
    ] as const) {
      await expect(
        payload.create({
          collection: 'adCreatives',
          data: {
            advertiser: Number(advertiser.id),
            creativeType: 'text',
            headline: 'unsafe target',
            name: `${fixturePrefix}-${targetType}-${randomUUID()}`,
            targetType,
            targetUrl,
          } as never,
          overrideAccess: false,
          req: await operatorReq(`${fixturePrefix}-unsafe-${randomUUID()}`),
          user: adOperator as never,
        }),
      ).rejects.toThrow()
    }
  })
})
