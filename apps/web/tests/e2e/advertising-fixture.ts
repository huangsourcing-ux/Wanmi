import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { getFixturePayload } from './redirect-fixture'
import { AD_MAINTENANCE_CONTEXT } from '../../src/lib/advertising'

const statePath = resolve(process.cwd(), 'test-results/advertising-fixture.json')
const fixturePrefix = 'e2e-d3-advertising'

type PreviousPlacement = {
  description: string
  deviceScope: 'all' | 'desktop' | 'mobile'
  enabled: boolean
  height: number
  name: string
  pageTypes: ('home' | 'tool' | 'content' | 'tld')[]
  position: 'after_core_result' | 'content_inline' | 'tld_inline' | 'home_native'
  width: number
}

export type AdvertisingFixtureState = {
  advertiserId: number
  creativeId: number
  expiredPublicId: string
  expiredScheduleId: number
  externalTarget: string
  placementCreated: boolean
  placementId: number
  placementPrevious?: PreviousPlacement
  publicId: string
  scheduleId: number
}

async function staleFixtureCleanup() {
  const payload = await getFixturePayload()
  for (const collection of ['adSchedules', 'adCreatives', 'advertisers'] as const) {
    const stale = await payload.find({
      collection,
      depth: 0,
      limit: 50,
      overrideAccess: true,
      where: { name: { contains: fixturePrefix } },
    })
    for (const document of stale.docs) {
      await payload.delete({ collection, id: document.id, overrideAccess: true })
    }
  }
}

export async function createAdvertisingFixture() {
  const payload = await getFixturePayload()
  await staleFixtureCleanup()
  const existingPlacement = (
    await payload.find({
      collection: 'adPlacements',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { code: { equals: 'tool-after-result' } },
    })
  ).docs[0]
  const placementPrevious: PreviousPlacement | undefined = existingPlacement
    ? {
        description: existingPlacement.description,
        deviceScope: existingPlacement.deviceScope,
        enabled: existingPlacement.enabled,
        height: existingPlacement.height,
        name: existingPlacement.name,
        pageTypes: existingPlacement.pageTypes,
        position: existingPlacement.position,
        width: existingPlacement.width,
      }
    : undefined
  const placement = existingPlacement
    ? await payload.update({
        collection: 'adPlacements',
        data: {
          description: 'E2E 核心工具结果之后广告位',
          deviceScope: 'all',
          enabled: true,
          height: 90,
          name: `${fixturePrefix} placement`,
          pageTypes: ['tool'],
          position: 'after_core_result',
          width: 970,
        },
        id: existingPlacement.id,
        overrideAccess: true,
      })
    : await payload.create({
        collection: 'adPlacements',
        data: {
          code: 'tool-after-result',
          description: 'E2E 核心工具结果之后广告位',
          deviceScope: 'all',
          enabled: true,
          height: 90,
          name: `${fixturePrefix} placement`,
          pageTypes: ['tool'],
          position: 'after_core_result',
          width: 970,
        },
        overrideAccess: true,
      })
  const advertiser = await payload.create({
    collection: 'advertisers',
    data: {
      allowedHosts: [{ host: 'ads.example.test' }],
      name: `${fixturePrefix} advertiser`,
      status: 'active',
    },
    overrideAccess: true,
  })
  const externalTarget = 'https://ads.example.test/landing?campaign=d3-e2e'
  const creative = await payload.create({
    collection: 'adCreatives',
    data: {
      advertiser: advertiser.id,
      body: '用于验证广告标识、外链属性和查询隐私。',
      creativeType: 'text',
      headline: 'D3 受控广告测试',
      name: `${fixturePrefix} creative`,
      status: 'approved',
      targetCheckFailure: 'none',
      targetCheckStatus: 'pending',
      targetType: 'external',
      targetUrl: externalTarget,
    },
    overrideAccess: true,
  })
  const targetCheckedAt = new Date().toISOString()
  await payload.update({
    collection: 'adCreatives',
    context: {
      [AD_MAINTENANCE_CONTEXT]: {
        expectedUpdatedAt: creative.updatedAt,
        kind: 'target-check',
        targetCheckFailure: 'none',
        targetCheckedAt,
        targetCheckStatus: 'reachable',
      },
    },
    data: {
      targetCheckFailure: 'none',
      targetCheckedAt,
      targetCheckStatus: 'reachable',
    },
    id: creative.id,
    overrideAccess: true,
  })
  const schedule = await payload.create({
    collection: 'adSchedules',
    data: {
      advertiser: advertiser.id,
      creative: creative.id,
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      name: `${fixturePrefix} active schedule`,
      placement: placement.id,
      priority: 1000,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
    } as never,
    overrideAccess: true,
  })
  const expiredSchedule = await payload.create({
    collection: 'adSchedules',
    data: {
      advertiser: advertiser.id,
      creative: creative.id,
      endsAt: new Date(Date.now() - 60_000).toISOString(),
      name: `${fixturePrefix} expired schedule`,
      placement: placement.id,
      priority: 999,
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
      status: 'ended',
    } as never,
    overrideAccess: true,
  })
  const state: AdvertisingFixtureState = {
    advertiserId: advertiser.id,
    creativeId: creative.id,
    expiredPublicId: expiredSchedule.publicId,
    expiredScheduleId: expiredSchedule.id,
    externalTarget,
    placementCreated: !existingPlacement,
    placementId: placement.id,
    placementPrevious,
    publicId: schedule.publicId,
    scheduleId: schedule.id,
  }
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(state), 'utf8')
}

export async function readAdvertisingFixture(): Promise<AdvertisingFixtureState> {
  return JSON.parse(await readFile(statePath, 'utf8')) as AdvertisingFixtureState
}

export async function removeAdvertisingFixture() {
  const payload = await getFixturePayload()
  let state: AdvertisingFixtureState | undefined
  try {
    state = await readAdvertisingFixture()
  } catch {
    await staleFixtureCleanup()
    return
  }
  for (const id of [state.expiredScheduleId, state.scheduleId]) {
    await payload
      .delete({ collection: 'adSchedules', id, overrideAccess: true })
      .catch(() => undefined)
  }
  await payload
    .delete({ collection: 'adCreatives', id: state.creativeId, overrideAccess: true })
    .catch(() => undefined)
  await payload
    .delete({ collection: 'advertisers', id: state.advertiserId, overrideAccess: true })
    .catch(() => undefined)
  if (state.placementCreated) {
    await payload
      .delete({ collection: 'adPlacements', id: state.placementId, overrideAccess: true })
      .catch(() => undefined)
  } else if (state.placementPrevious) {
    await payload.update({
      collection: 'adPlacements',
      data: state.placementPrevious,
      id: state.placementId,
      overrideAccess: true,
    })
  }
  await unlink(statePath).catch(() => undefined)
}
