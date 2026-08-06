import { randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { createPricingPostHandler } from '@/app/api/v1/tools/pricing/route'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import { pricingResultSchema } from '@/schemas/pricing'
import { createPriceCalculationHash } from '@/services/pricing/price-snapshots'
import type {
  PriceSnapshotInput,
  PriceSnapshotStore,
  StoredPriceSnapshot,
} from '@/services/pricing/price-snapshots'

class MemorySnapshotStore implements PriceSnapshotStore {
  readonly records: StoredPriceSnapshot[] = []

  async findLatest(input: { ruleKey: string; ruleVersion: 1; tld: string }) {
    return this.records.find(
      (record) =>
        record.tld === input.tld &&
        record.calculation.rule.key === input.ruleKey &&
        record.calculation.rule.version === input.ruleVersion,
    )
  }

  async record(input: PriceSnapshotInput) {
    const calculationHash = createPriceCalculationHash(input)
    const existing = this.records.find((record) => record.calculationHash === calculationHash)
    if (existing) return existing
    const stored: StoredPriceSnapshot = {
      ...input,
      calculationHash,
      createdAt: input.providerObservedAt,
      snapshotRef: randomUUID(),
    }
    this.records.push(stored)
    return stored
  }
}

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3000/api/v1/tools/pricing', {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

function fixtureHandler() {
  const snapshots = new MemorySnapshotStore()
  const getSnapshotStore = vi.fn(async () => snapshots)
  const handler = createPricingPostHandler({
    getSnapshotStore,
    provider: new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() }),
  })
  return { getSnapshotStore, handler, snapshots }
}

describe('POST /api/v1/tools/pricing', () => {
  it('returns no-store public prices without cookies or internal calculation inputs', async () => {
    const { handler, snapshots } = fixtureHandler()
    const response = await handler(
      request('{}', {
        'x-request-id': 'trace-pricing-route',
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-request-id')).toBe('trace-pricing-route')

    const body = pricingResultSchema.parse(await response.json())
    expect(body.state).toBe('ready')
    if (!('data' in body)) throw new Error('Expected pricing data')
    expect(body.data.items).toHaveLength(10)
    expect(snapshots.records).toHaveLength(9)
    for (const item of body.data.items) {
      expect(item).not.toHaveProperty('upstreamRegistrationPriceFen')
      expect(item).not.toHaveProperty('upstreamRenewalPriceFen')
      expect(item).not.toHaveProperty('rule')
      expect(item).not.toHaveProperty('markupAmountFen')
    }
  })

  it('rejects 11 TLDs explicitly before opening the snapshot store', async () => {
    const { getSnapshotStore, handler } = fixtureHandler()
    const response = await handler(
      request(
        JSON.stringify({
          tlds: ['com', 'cn', 'net', 'org', 'top', 'xyz', 'vip', 'cc', 'tv', 'com.cn', 'io'],
        }),
      ),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'PRICING_TLD_LIMIT_EXCEEDED',
      detail: '单次最多查询 10 个域名后缀，当前提交了 11 个',
      retryable: false,
    })
    expect(getSnapshotStore).not.toHaveBeenCalled()
  })

  it('rejects duplicates, malformed JSON, non-JSON and bodies over 4 KiB', async () => {
    const { handler } = fixtureHandler()
    const duplicate = await handler(request(JSON.stringify({ tlds: ['com', '.COM'] })))
    expect(duplicate.status).toBe(400)
    expect((await duplicate.json()).code).toBe('PRICING_DUPLICATE_TLD')

    const malformed = await handler(request('{'))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).code).toBe('INVALID_REQUEST')

    const media = await handler(request('{}', { 'content-type': 'text/plain' }))
    expect(media.status).toBe(415)
    expect((await media.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE')

    const oversized = await handler(request('{}', { 'content-length': '4097' }))
    expect(oversized.status).toBe(413)
    expect((await oversized.json()).code).toBe('PRICING_REQUEST_TOO_LARGE')
  })
})
