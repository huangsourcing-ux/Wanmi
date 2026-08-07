import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AdminRole } from '@/lib/domain'
import { calculateTldPrice, FIXTURE_PRICING_RULES } from '@/services/pricing/price-calculation'
import {
  createPriceCalculationHash,
  PayloadPriceSnapshotStore,
  type PriceSnapshotInput,
} from '@/services/pricing/price-snapshots'

const fixturePrefix = `d2-pricing-${randomUUID()}`
const fixtureTld = fixturePrefix
const createdIds: Array<number | string> = []
let payload: Payload

function admin(role: AdminRole, id: number) {
  return {
    collection: 'admins' as const,
    email: `${role}-${id}@example.test`,
    id,
    roles: [role],
    status: 'active' as const,
  }
}

function snapshotInput(overrides: Partial<PriceSnapshotInput> = {}): PriceSnapshotInput {
  const fixtureRule = {
    ...FIXTURE_PRICING_RULES.com!,
    key: `${fixturePrefix}-rule`,
    tld: fixtureTld,
  }
  return {
    calculation: calculateTldPrice({
      registrationPriceFen: 2_000,
      renewalPriceFen: 3_000,
      rule: fixtureRule,
    }),
    providerCacheExpiresAt: '2026-08-06T13:00:00.000Z',
    providerCacheStatus: 'miss',
    providerObservedAt: '2026-08-06T12:00:00.000Z',
    providerProductId: `${fixturePrefix}-product`,
    providerRequestId: `${fixturePrefix}-request`,
    representativeDomainAscii: `wanmi.${fixtureTld}`,
    tld: fixtureTld,
    traceId: `${fixturePrefix}-trace`,
    ...overrides,
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  for (const id of createdIds) {
    await payload.delete({ collection: 'priceSnapshots', id, overrideAccess: true }).catch(() => {})
  }
  await payload.db.destroy?.()
})

describe('D2-07 price snapshot persistence and access', () => {
  it('deduplicates concurrent writes by calculation hash and returns the latest matching snapshot', async () => {
    const store = new PayloadPriceSnapshotStore(payload)
    const input = snapshotInput()
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => store.record(input)))
    expect(new Set(concurrent.map((snapshot) => snapshot.snapshotRef)).size).toBe(1)
    expect(new Set(concurrent.map((snapshot) => snapshot.calculationHash))).toEqual(
      new Set([createPriceCalculationHash(input)]),
    )

    const firstRows = await payload.find({
      collection: 'priceSnapshots',
      overrideAccess: true,
      where: { calculationHash: { equals: concurrent[0]!.calculationHash } },
    })
    expect(firstRows.totalDocs).toBe(1)
    createdIds.push(firstRows.docs[0]!.id)

    const newer = await store.record(
      snapshotInput({
        providerObservedAt: '2026-08-06T12:05:00.000Z',
        providerRequestId: `${fixturePrefix}-request-newer`,
        traceId: `${fixturePrefix}-trace-newer`,
      }),
    )
    const newerRow = await payload.find({
      collection: 'priceSnapshots',
      overrideAccess: true,
      where: { snapshotRef: { equals: newer.snapshotRef } },
    })
    createdIds.push(newerRow.docs[0]!.id)

    expect(
      await store.findLatest({
        ruleKey: input.calculation.rule.key,
        ruleVersion: input.calculation.rule.version,
        tld: input.tld,
      }),
    ).toMatchObject({
      providerObservedAt: '2026-08-06T12:05:00.000Z',
      snapshotRef: newer.snapshotRef,
    })

    await expect(
      payload.create({
        collection: 'priceSnapshots',
        data: {
          calculationFormula: input.calculation.calculationFormula,
          calculationHash: concurrent[0]!.calculationHash,
          calculationVersion: 1,
          createdTraceId: `${fixturePrefix}-duplicate-hash`,
          currency: 'CNY',
          oneYearTotalMinor: input.calculation.oneYearTotalFen,
          priceClass: 'standard',
          provider: 'westdigital_fixture',
          providerCacheStatus: 'miss',
          providerObservedAt: '2026-08-06T12:10:00.000Z',
          providerProductId: `${fixturePrefix}-duplicate-product`,
          providerRequestId: `${fixturePrefix}-duplicate-request`,
          registrationPriceMinor: input.calculation.registrationPriceFen,
          representativeDomainAscii: input.representativeDomainAscii,
          renewalPriceMinor: input.calculation.renewalPriceFen,
          ruleFixedAmountMinor: 500,
          ruleKey: input.calculation.rule.key,
          ruleMode: 'fixed',
          ruleSource: 'wanmi_fixture',
          ruleVersion: 1,
          roundingMode: 'half_up_to_fen',
          schemaVersion: 1,
          snapshotRef: randomUUID(),
          threeYearTotalMinor: input.calculation.threeYearTotalFen,
          tld: input.tld,
          upstreamRegistrationPriceMinor: input.calculation.upstreamRegistrationPriceFen,
          upstreamRenewalPriceMinor: input.calculation.upstreamRenewalPriceFen,
        },
        overrideAccess: true,
      }),
    ).rejects.toThrow()
  })

  it('allows only system administrators to read and denies generic mutations to every actor', async () => {
    const store = new PayloadPriceSnapshotStore(payload)
    const snapshot = await store.record(
      snapshotInput({
        providerObservedAt: '2026-08-06T12:20:00.000Z',
        providerRequestId: `${fixturePrefix}-access-request`,
        traceId: `${fixturePrefix}-access-trace`,
      }),
    )
    const stored = await payload.find({
      collection: 'priceSnapshots',
      overrideAccess: true,
      where: { snapshotRef: { equals: snapshot.snapshotRef } },
    })
    const id = stored.docs[0]!.id
    createdIds.push(id)

    const actors = [
      undefined,
      { collection: 'customers' as const, id: 2100, status: 'active' as const },
      admin('content_editor', 2101),
      admin('ad_operator', 2102),
      admin('analyst', 2103),
      admin('system_admin', 2104),
    ]
    for (const actor of actors.slice(0, -1)) {
      await expect(
        payload.find({
          collection: 'priceSnapshots',
          overrideAccess: false,
          user: actor as never,
          where: { id: { equals: id } },
        }),
      ).rejects.toThrow()
    }
    const systemView = await payload.find({
      collection: 'priceSnapshots',
      overrideAccess: false,
      user: actors.at(-1) as never,
      where: { id: { equals: id } },
    })
    expect(systemView.docs).toHaveLength(1)
    expect(systemView.docs[0]).toMatchObject({
      upstreamRegistrationPriceMinor: 2_000,
      upstreamRenewalPriceMinor: 3_000,
    })

    for (const actor of actors) {
      await expect(
        payload.create({
          collection: 'priceSnapshots',
          data: {} as never,
          overrideAccess: false,
          user: actor as never,
        }),
      ).rejects.toThrow()
      await expect(
        payload.update({
          collection: 'priceSnapshots',
          data: { createdTraceId: `${fixturePrefix}-forbidden-update` },
          id,
          overrideAccess: false,
          user: actor as never,
        }),
      ).rejects.toThrow()
      await expect(
        payload.delete({
          collection: 'priceSnapshots',
          id,
          overrideAccess: false,
          user: actor as never,
        }),
      ).rejects.toThrow()
    }
  })
})
