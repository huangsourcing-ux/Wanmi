import { createHash, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import type { WestDigitalWriteProvider } from '@/providers/types'
import {
  previewCustomerNameserverBatchChange,
  queryCustomerNameserverBatchChange,
  requestCustomerNameserverBatchChange,
  runNameserverChange,
} from '@/services/domains/nameserver-changes'

import { realnameTemplateFixture } from '../fixtures/realname'
import { issueStepUpGrantFixture } from '../fixtures/step-up'
import { ignorePayloadNotFound } from '../test-cleanup'

const fixturePrefix = `d9d3-ns-batch-${randomUUID()}`
const customerIds: Array<number | string> = []
const templateIds: Array<number | string> = []
const assetIds: Array<number | string> = []
let payload: Payload

type Fixture = Awaited<ReturnType<typeof createFixture>>

function identity(customerId: number | string) {
  return { collection: 'customers' as const, id: customerId, status: 'active' }
}

function hash(value: string): number {
  let result = 0
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) % 1_000_000_000
  return result
}

async function request(
  customer: { id: number | string; status?: null | string },
  suffix: string,
): Promise<PayloadRequest> {
  const req = await createLocalReq(
    {
      req: {
        headers: new Headers({
          'user-agent': `Wanmi-D9D3/${suffix}`,
          'x-forwarded-for': '198.51.100.93',
          'x-request-id': `${fixturePrefix}-${suffix}`,
        }),
      },
    },
    payload,
  )
  req.user = { ...customer, collection: 'customers' } as never
  return req
}

async function createFixture(
  suffix: string,
  count = 3,
  options: { capabilityRestrictions?: string[]; cooldown?: boolean } = {},
) {
  const phone = `+8618${String(Math.abs(hash(`${fixturePrefix}-${suffix}`)))
    .padStart(9, '0')
    .slice(0, 9)}`
  const customer = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: options.capabilityRestrictions ?? [],
      identityRiskCooldownStartedAt: options.cooldown ? new Date().toISOString() : undefined,
      phone,
      phoneMasked: `***${phone.slice(-4)}`,
      status: options.capabilityRestrictions?.length ? 'restricted' : 'active',
    },
    overrideAccess: true,
  })
  customerIds.push(customer.id)
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `D9D3-${suffix}-${randomUUID().slice(0, 8)}` }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  templateIds.push(template.id)
  const assets = []
  for (let index = 0; index < count; index += 1) {
    const asset = await payload.create({
      collection: 'domainAssets',
      data: {
        customer: customer.id,
        domainAscii: `${suffix}-${index}-${randomUUID().slice(0, 8)}.example`,
        expiresAt: '2028-08-18T04:00:00.000Z',
        lastSyncedAt: '2026-08-18T04:00:00.000Z',
        nameservers: ['ns1.before.example', 'ns2.before.example'],
        realnameTemplate: template.id,
        registeredAt: '2026-08-18T04:00:00.000Z',
        registrar: 'west',
        status: 'active',
        syncReviewStatus: 'none',
        syncVersion: 0,
        upstreamOwnershipStatus: 'unknown',
      },
      overrideAccess: true,
    })
    assets.push(asset)
    assetIds.push(asset.id)
  }
  return { assets, customer, req: await request(customer, suffix), template }
}

const requestedNameservers = ['ns1.after.example', 'ns2.after.example']

function itemChangeKey(assetId: number | string, nameservers = requestedNameservers) {
  return `nameserver:${assetId}:${createHash('sha256').update(nameservers.join('\n')).digest('hex')}`
}

async function preview(fixture: Fixture, assetIdsInput: number[], batchKey = randomUUID()) {
  const result = await previewCustomerNameserverBatchChange(
    fixture.req,
    { assetIds: assetIdsInput, batchKey, nameservers: requestedNameservers },
    {
      customer: identity(fixture.customer.id),
      traceId: `${fixturePrefix}-preview-${batchKey}`,
    },
  )
  if (!('data' in result)) throw new Error('Expected NS batch preview')
  return result.data
}

async function grant(fixture: Fixture) {
  return issueStepUpGrantFixture(
    payload,
    fixture.req,
    Number(fixture.customer.id),
    'nameserver_change',
  )
}

function resignPreviewToken(token: string, mutate: (value: Record<string, unknown>) => void) {
  const [encoded] = token.split('.')
  if (!encoded) throw new Error('NS preview fixture token is malformed')
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
  mutate(value)
  const changed = Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${changed}.${hmac(changed, getEnv().SESSION_PEPPER)}`
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  if (customerIds.length) {
    await payload.db.pool.query(
      'DELETE FROM domain_batch_operation_events WHERE customer_id = ANY($1::int[])',
      [customerIds.map(Number)],
    )
    await payload.db.pool.query(
      `DELETE FROM payload_jobs
       WHERE workflow_slug::text = 'nameserverChange'
         AND input->>'traceId' LIKE $1`,
      [`${fixturePrefix}%`],
    )
    await payload.db.pool.query(
      'DELETE FROM nameserver_changes WHERE customer_id = ANY($1::int[])',
      [customerIds.map(Number)],
    )
    await payload.db.pool.query(
      `DELETE FROM provider_operations
       WHERE operation::text = 'nameserver'
         AND target_id = ANY($1::text[])`,
      [assetIds.map(String)],
    )
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 500,
    overrideAccess: true,
    where: { traceId: { contains: fixturePrefix } },
  })
  for (const audit of audits.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true }),
    )
  }
  const grants = await payload.find({
    collection: 'stepUpGrants',
    limit: 500,
    overrideAccess: true,
    where: { customer: { in: customerIds } },
  })
  for (const item of grants.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'stepUpGrants', id: item.id, overrideAccess: true }),
    )
  }
  for (const id of assetIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'domainAssets', id, overrideAccess: true }),
    )
  }
  for (const id of templateIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'realnameTemplates', id, overrideAccess: true }),
    )
  }
  for (const id of customerIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'customers', id, overrideAccess: true }),
    )
  }
  await payload.db.destroy?.()
}, 90_000)

describe('D9-D-3 Name Server batch preview and item idempotency', () => {
  it('rejects duplicate assets and duplicate nameservers before producing a preview', async () => {
    const fixture = await createFixture('duplicates', 2)
    const firstId = Number(fixture.assets[0]!.id)
    await expect(
      previewCustomerNameserverBatchChange(
        fixture.req,
        {
          assetIds: [firstId, firstId],
          batchKey: randomUUID(),
          nameservers: requestedNameservers,
        },
        { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-duplicate-assets` },
      ),
    ).rejects.toMatchObject({ code: 'NAMESERVER_BATCH_DUPLICATE_ASSET', status: 400 })
    await expect(
      previewCustomerNameserverBatchChange(
        fixture.req,
        {
          assetIds: fixture.assets.map((asset) => Number(asset.id)),
          batchKey: randomUUID(),
          nameservers: ['ns1.after.example', 'ns1.after.example'],
        },
        { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-duplicate-ns` },
      ),
    ).rejects.toMatchObject({ code: 'NAMESERVER_DUPLICATE', status: 400 })
  })

  it('rejects batch execution without a dry-run preview', async () => {
    const fixture = await createFixture('missing-preview', 2)
    const stepUp = await grant(fixture)
    await expect(
      requestCustomerNameserverBatchChange(
        fixture.req,
        {
          assetIds: fixture.assets.map((asset) => Number(asset.id)),
          batchKey: randomUUID(),
          confirmed: true,
          ...stepUp,
          nameservers: requestedNameservers,
          previewToken: '',
        },
        { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-missing-preview` },
      ),
    ).rejects.toMatchObject({ code: 'NAMESERVER_BATCH_PREVIEW_REQUIRED', status: 400 })
  })

  it('rejects batch execution without step-up even when preview and confirmation are valid', async () => {
    const fixture = await createFixture('missing-step', 2)
    const batchKey = randomUUID()
    const dryRun = await preview(
      fixture,
      fixture.assets.map((asset) => Number(asset.id)),
      batchKey,
    )
    await expect(
      requestCustomerNameserverBatchChange(
        fixture.req,
        {
          assetIds: fixture.assets.map((asset) => Number(asset.id)),
          batchKey,
          confirmed: true,
          nameservers: requestedNameservers,
          previewToken: dryRun.previewToken,
        },
        { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-missing-step` },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_REQUIRED', status: 403 })
  })

  it('rejects batch execution without secondary confirmation even with valid step-up', async () => {
    const fixture = await createFixture('missing-confirmation', 2)
    const batchKey = randomUUID()
    const dryRun = await preview(
      fixture,
      fixture.assets.map((asset) => Number(asset.id)),
      batchKey,
    )
    const stepUp = await grant(fixture)
    await expect(
      requestCustomerNameserverBatchChange(
        fixture.req,
        {
          assetIds: fixture.assets.map((asset) => Number(asset.id)),
          batchKey,
          ...stepUp,
          nameservers: requestedNameservers,
          previewToken: dryRun.previewToken,
        },
        {
          customer: identity(fixture.customer.id),
          traceId: `${fixturePrefix}-missing-confirmation`,
        },
      ),
    ).rejects.toMatchObject({ code: 'NAMESERVER_CONFIRMATION_REQUIRED', status: 400 })
  })

  it('rejects preview drift when one asset is added to the execution target set', async () => {
    const fixture = await createFixture('drift-add', 3)
    const batchKey = randomUUID()
    const dryRun = await preview(
      fixture,
      fixture.assets.slice(0, 2).map((asset) => Number(asset.id)),
      batchKey,
    )
    const stepUp = await grant(fixture)
    await expect(
      requestCustomerNameserverBatchChange(
        fixture.req,
        {
          assetIds: fixture.assets.map((asset) => Number(asset.id)),
          batchKey,
          confirmed: true,
          ...stepUp,
          nameservers: requestedNameservers,
          previewToken: dryRun.previewToken,
        },
        { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-drift-add` },
      ),
    ).rejects.toMatchObject({ code: 'NAMESERVER_BATCH_PREVIEW_INVALID', status: 409 })
  })

  it('rejects preview drift when one asset is removed from the execution target set', async () => {
    const fixture = await createFixture('drift-remove', 3)
    const batchKey = randomUUID()
    const dryRun = await preview(
      fixture,
      fixture.assets.map((asset) => Number(asset.id)),
      batchKey,
    )
    const stepUp = await grant(fixture)
    await expect(
      requestCustomerNameserverBatchChange(
        fixture.req,
        {
          assetIds: fixture.assets.slice(0, 2).map((asset) => Number(asset.id)),
          batchKey,
          confirmed: true,
          ...stepUp,
          nameservers: requestedNameservers,
          previewToken: dryRun.previewToken,
        },
        { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-drift-remove` },
      ),
    ).rejects.toMatchObject({ code: 'NAMESERVER_BATCH_PREVIEW_INVALID', status: 409 })
  })

  it('rejects preview drift when one asset versioned fact is modified', async () => {
    const fixture = await createFixture('drift-modify', 2)
    const batchKey = randomUUID()
    const ids = fixture.assets.map((asset) => Number(asset.id))
    const dryRun = await preview(fixture, ids, batchKey)
    await payload.update({
      collection: 'domainAssets',
      data: { nameservers: ['ns1.changed.example', 'ns2.changed.example'], syncVersion: 1 },
      id: fixture.assets[0]!.id,
      overrideAccess: true,
    })
    const stepUp = await grant(fixture)
    await expect(
      requestCustomerNameserverBatchChange(
        fixture.req,
        {
          assetIds: ids,
          batchKey,
          confirmed: true,
          ...stepUp,
          nameservers: requestedNameservers,
          previewToken: dryRun.previewToken,
        },
        { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-drift-modify` },
      ),
    ).rejects.toMatchObject({ code: 'NAMESERVER_BATCH_PREVIEW_STALE', status: 409 })
  })

  it('rejects a preview token issued for another customer and domain set', async () => {
    const owner = await createFixture('token-owner', 2)
    const other = await createFixture('token-other', 2)
    const batchKey = randomUUID()
    const dryRun = await preview(
      owner,
      owner.assets.map((asset) => Number(asset.id)),
      batchKey,
    )
    const stepUp = await grant(other)
    await expect(
      requestCustomerNameserverBatchChange(
        other.req,
        {
          assetIds: other.assets.map((asset) => Number(asset.id)),
          batchKey,
          confirmed: true,
          ...stepUp,
          nameservers: requestedNameservers,
          previewToken: dryRun.previewToken,
        },
        { customer: identity(other.customer.id), traceId: `${fixturePrefix}-token-other` },
      ),
    ).rejects.toMatchObject({ code: 'NAMESERVER_BATCH_PREVIEW_INVALID', status: 409 })
  })

  it('binds every NS preview token field independently', async () => {
    const fixture = await createFixture('token-fields', 2)
    const batchKey = randomUUID()
    const ids = fixture.assets.map((asset) => Number(asset.id))
    const dryRun = await preview(fixture, ids, batchKey)
    const tokens = [
      resignPreviewToken(dryRun.previewToken, (value) => {
        value.version = 2
      }),
      resignPreviewToken(dryRun.previewToken, (value) => {
        value.kind = 'other'
      }),
      resignPreviewToken(dryRun.previewToken, (value) => {
        value.customerId = String(Number(fixture.customer.id) + 1)
      }),
      resignPreviewToken(dryRun.previewToken, (value) => {
        value.batchKey = randomUUID()
      }),
      resignPreviewToken(dryRun.previewToken, (value) => {
        value.expiresAt = '2026-08-17T00:00:00.000Z'
      }),
      resignPreviewToken(dryRun.previewToken, (value) => {
        value.assetIds = [...ids].reverse().map(String)
      }),
      resignPreviewToken(dryRun.previewToken, (value) => {
        value.nameservers = ['ns3.other.example', 'ns4.other.example']
      }),
    ]
    for (const [index, previewToken] of tokens.entries()) {
      const stepUp = await grant(fixture)
      await expect(
        requestCustomerNameserverBatchChange(
          fixture.req,
          {
            assetIds: ids,
            batchKey,
            confirmed: true,
            ...stepUp,
            nameservers: requestedNameservers,
            previewToken,
          },
          {
            customer: identity(fixture.customer.id),
            traceId: `${fixturePrefix}-token-field-${index}`,
          },
        ),
      ).rejects.toMatchObject({ code: 'NAMESERVER_BATCH_PREVIEW_INVALID', status: 409 })
    }
  })

  it('queues one item per domain, exposes pending_query, and returns the same batch through owner-scoped query', async () => {
    const fixture = await createFixture('accepted', 2)
    const batchKey = randomUUID()
    const ids = fixture.assets.map((asset) => Number(asset.id))
    const dryRun = await preview(fixture, ids, batchKey)
    const stepUp = await grant(fixture)
    const result = await requestCustomerNameserverBatchChange(
      fixture.req,
      {
        assetIds: ids,
        batchKey,
        confirmed: true,
        ...stepUp,
        nameservers: requestedNameservers,
        previewToken: dryRun.previewToken,
      },
      { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-accepted` },
    )
    expect(result).toMatchObject({
      data: { items: [{ status: 'pending_query' }, { status: 'pending_query' }] },
      state: 'partial',
    })
    await expect(
      queryCustomerNameserverBatchChange(fixture.req, batchKey, {
        customer: identity(fixture.customer.id),
        traceId: `${fixturePrefix}-accepted-query`,
      }),
    ).resolves.toMatchObject({
      data: { items: [{ status: 'pending_query' }, { status: 'pending_query' }] },
      state: 'partial',
    })
    const queued = await payload.db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM payload_jobs
       WHERE workflow_slug::text = 'nameserverChange'
         AND input->>'traceId' LIKE $1`,
      [`${fixturePrefix}-accepted%`],
    )
    expect(queued.rows[0]?.count).toBe('2')
    const events = await payload.find({
      collection: 'domainBatchOperationEvents',
      limit: 20,
      overrideAccess: true,
      where: {
        and: [
          { batchKey: { equals: batchKey } },
          { customer: { equals: fixture.customer.id } },
          { event: { equals: 'requested' } },
        ],
      },
    })
    expect(events.totalDocs).toBe(2)
    await expect(
      payload.update({
        collection: 'domainBatchOperationEvents',
        data: { reasonCode: 'MUTATED' },
        id: events.docs[0]!.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_BATCH_EVENT_APPEND_ONLY', status: 409 })
    await expect(
      payload.delete({
        collection: 'domainBatchOperationEvents',
        id: events.docs[0]!.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_BATCH_EVENT_APPEND_ONLY', status: 409 })
  })

  it('queues each item exactly once for N concurrent submissions of the same batch', async () => {
    const fixture = await createFixture('concurrent-batch', 2)
    const batchKey = randomUUID()
    const ids = fixture.assets.map((asset) => Number(asset.id))
    const dryRun = await preview(fixture, ids, batchKey)
    const grants = await Promise.all(Array.from({ length: 5 }, () => grant(fixture)))
    const requests = await Promise.all(
      Array.from({ length: 5 }, (_, index) => request(fixture.customer, `ns-batch-${index}`)),
    )
    const results = await Promise.all(
      requests.map((concurrentReq, index) =>
        requestCustomerNameserverBatchChange(
          concurrentReq,
          {
            assetIds: ids,
            batchKey,
            confirmed: true,
            ...grants[index]!,
            nameservers: requestedNameservers,
            previewToken: dryRun.previewToken,
          },
          {
            customer: identity(fixture.customer.id),
            traceId: `${fixturePrefix}-concurrent-batch-${index}`,
          },
        ),
      ),
    )
    expect(results).toHaveLength(5)
    const queued = await payload.db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM payload_jobs
       WHERE workflow_slug::text = 'nameserverChange'
         AND input->>'traceId' LIKE $1`,
      [`${fixturePrefix}-concurrent-batch%`],
    )
    expect(queued.rows[0]?.count).toBe('2')
  })

  it('does not requeue completed admission work on a sequential batch retry', async () => {
    const fixture = await createFixture('sequential-retry', 2)
    const queue = vi.spyOn(payload.jobs, 'queue')
    const batchKey = randomUUID()
    const ids = fixture.assets.map((asset) => Number(asset.id))
    const dryRun = await preview(fixture, ids, batchKey)
    let changeIds: number[] = []
    for (let index = 0; index < 2; index += 1) {
      const stepUp = await grant(fixture)
      const result = await requestCustomerNameserverBatchChange(
        fixture.req,
        {
          assetIds: ids,
          batchKey,
          confirmed: true,
          ...stepUp,
          nameservers: requestedNameservers,
          previewToken: dryRun.previewToken,
        },
        {
          customer: identity(fixture.customer.id),
          traceId: `${fixturePrefix}-sequential-retry-${index}`,
        },
      )
      if ('data' in result) {
        changeIds = result.data.items.map((item) => Number(item.changeId))
      }
    }
    const queued = await payload.db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM payload_jobs
       WHERE workflow_slug::text = 'nameserverChange'
         AND (input->>'changeId')::int = ANY($1::int[])`,
      [changeIds],
    )
    expect(queued.rows[0]?.count).toBe('2')
    expect(queue).toHaveBeenCalledTimes(2)
    queue.mockRestore()
  })

  it('does not queue a terminal failed item and keeps its reason visible in partial', async () => {
    const fixture = await createFixture('terminal-failed', 2)
    const failedAsset = fixture.assets[0]!
    await payload.create({
      collection: 'nameserverChanges',
      data: {
        asset: failedAsset.id,
        changeKey: itemChangeKey(failedAsset.id),
        createdTraceId: `${fixturePrefix}-terminal-failed-seed`,
        customer: fixture.customer.id,
        failureCode: 'FIXTURE_EXPLICIT_FAILURE',
        previousNameservers: failedAsset.nameservers,
        requestedAt: new Date().toISOString(),
        requestedById: String(fixture.customer.id),
        requestedByType: 'customer',
        requestedNameservers,
        status: 'failed',
      },
      overrideAccess: true,
    })
    const batchKey = randomUUID()
    const ids = fixture.assets.map((asset) => Number(asset.id))
    const dryRun = await preview(fixture, ids, batchKey)
    const stepUp = await grant(fixture)
    const queue = vi.spyOn(payload.jobs, 'queue')
    const result = await requestCustomerNameserverBatchChange(
      fixture.req,
      {
        assetIds: ids,
        batchKey,
        confirmed: true,
        ...stepUp,
        nameservers: requestedNameservers,
        previewToken: dryRun.previewToken,
      },
      { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-terminal-failed` },
    )
    expect(result).toMatchObject({
      data: {
        items: [
          { reasonCode: 'FIXTURE_EXPLICIT_FAILURE', status: 'failed' },
          { status: 'pending_query' },
        ],
      },
      state: 'partial',
    })
    expect(queue).toHaveBeenCalledTimes(1)
    queue.mockRestore()
  })

  it('does not mark an unrelated pending item queued when admitting a batch item', async () => {
    const fixture = await createFixture('queue-row-scope', 3)
    const unrelatedAsset = fixture.assets[2]!
    const unrelated = await payload.create({
      collection: 'nameserverChanges',
      data: {
        asset: unrelatedAsset.id,
        changeKey: itemChangeKey(unrelatedAsset.id),
        createdTraceId: `${fixturePrefix}-queue-row-scope-seed`,
        customer: fixture.customer.id,
        previousNameservers: unrelatedAsset.nameservers,
        requestedAt: new Date().toISOString(),
        requestedById: String(fixture.customer.id),
        requestedByType: 'customer',
        requestedNameservers,
        status: 'pending',
      },
      overrideAccess: true,
    })
    const batchKey = randomUUID()
    const ids = fixture.assets.slice(0, 2).map((asset) => Number(asset.id))
    const dryRun = await preview(fixture, ids, batchKey)
    const stepUp = await grant(fixture)
    await requestCustomerNameserverBatchChange(
      fixture.req,
      {
        assetIds: ids,
        batchKey,
        confirmed: true,
        ...stepUp,
        nameservers: requestedNameservers,
        previewToken: dryRun.previewToken,
      },
      { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-queue-row-scope` },
    )
    const unchanged = await payload.findByID({
      collection: 'nameserverChanges',
      id: unrelated.id,
      overrideAccess: true,
    })
    expect(unchanged.jobQueuedAt).toBeNull()
  })

  it('persists an admission failure reason so later batch queries cannot turn it into pending', async () => {
    const fixture = await createFixture('queue-failure', 2)
    const batchKey = randomUUID()
    const ids = fixture.assets.map((asset) => Number(asset.id))
    const dryRun = await preview(fixture, ids, batchKey)
    const stepUp = await grant(fixture)
    const queue = vi.spyOn(payload.jobs, 'queue').mockRejectedValueOnce(new Error('fixture queue'))
    const result = await requestCustomerNameserverBatchChange(
      fixture.req,
      {
        assetIds: ids,
        batchKey,
        confirmed: true,
        ...stepUp,
        nameservers: requestedNameservers,
        previewToken: dryRun.previewToken,
      },
      { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-queue-failure` },
    )
    expect(result).toMatchObject({
      data: {
        items: [{ reasonCode: 'INTERNAL_ERROR', status: 'failed' }, { status: 'pending_query' }],
      },
      state: 'partial',
    })
    await expect(
      queryCustomerNameserverBatchChange(fixture.req, batchKey, {
        customer: identity(fixture.customer.id),
        traceId: `${fixturePrefix}-queue-failure-query`,
      }),
    ).resolves.toMatchObject({
      data: {
        items: [{ reasonCode: 'INTERNAL_ERROR', status: 'failed' }, { status: 'pending_query' }],
      },
      state: 'partial',
    })
    expect(queue).toHaveBeenCalledTimes(2)
    queue.mockRestore()
  })

  it('keeps every NS batch item behind D6 ownership blocking without an upstream write', async () => {
    const fixture = await createFixture('ownership-block', 2)
    const batchKey = randomUUID()
    const ids = fixture.assets.map((asset) => Number(asset.id))
    const dryRun = await preview(fixture, ids, batchKey)
    const stepUp = await grant(fixture)
    const submitted = await requestCustomerNameserverBatchChange(
      fixture.req,
      {
        assetIds: ids,
        batchKey,
        confirmed: true,
        ...stepUp,
        nameservers: requestedNameservers,
        previewToken: dryRun.previewToken,
      },
      { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-ownership-block` },
    )
    if (!('data' in submitted)) throw new Error('Expected submitted NS batch')
    const calls = new Map<string, number>()
    const queryAsset = vi.fn(async (input: { domainAscii: string }) => {
      const count = (calls.get(input.domainAscii) ?? 0) + 1
      calls.set(input.domainAscii, count)
      const observedAt = new Date().toISOString()
      if (count === 1) {
        return {
          data: {
            domainAscii: input.domainAscii,
            expiresAt: '2028-08-18T04:00:00.000Z',
            nameservers: ['ns1.before.example', 'ns2.before.example'],
            registeredAt: '2026-08-18T04:00:00.000Z',
            registrarCode: 'west',
            status: 'active' as const,
          },
          observedAt,
          ok: true as const,
          requestId: `${fixturePrefix}-owned-${input.domainAscii}`,
        }
      }
      return {
        error: {
          code: 'WESTDIGITAL_ASSET_NOT_IN_ACCOUNT',
          message: 'fixture not owned',
          retryable: false,
          statusKnown: true,
        },
        observedAt,
        ok: false as const,
        requestId: `${fixturePrefix}-not-owned-${input.domainAscii}`,
      }
    })
    const changeNameservers = vi.fn()
    const provider = { changeNameservers, queryAsset } as unknown as WestDigitalWriteProvider
    const settled = await Promise.allSettled(
      submitted.data.items.map(async (item) =>
        runNameserverChange(
          await request(fixture.customer, `ownership-run-${item.assetId}`),
          {
            assetId: Number(item.assetId),
            changeId: Number(item.changeId),
            operationKey: `fixture-${item.itemKey}`,
            traceId: `${fixturePrefix}-ownership-run-${item.assetId}`,
          },
          provider,
        ),
      ),
    )
    expect(settled.every((outcome) => outcome.status === 'fulfilled')).toBe(true)
    const outcomes = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    )
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'failed' }),
      expect.objectContaining({ status: 'failed' }),
    ])
    expect(changeNameservers).not.toHaveBeenCalled()
    expect(queryAsset).toHaveBeenCalledTimes(4)
    await expect(
      queryCustomerNameserverBatchChange(fixture.req, batchKey, {
        customer: identity(fixture.customer.id),
        traceId: `${fixturePrefix}-ownership-query`,
      }),
    ).resolves.toMatchObject({
      data: {
        items: [
          { reasonCode: 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED', status: 'failed' },
          { reasonCode: 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED', status: 'failed' },
        ],
      },
      state: 'partial',
    })
  })

  it('queries only the exact owner and batch instead of leaking another batch or customer', async () => {
    const fixture = await createFixture('query-scope', 2)
    const other = await createFixture('query-scope-other', 2)
    const ids = fixture.assets.map((asset) => Number(asset.id))
    const firstBatchKey = randomUUID()
    const secondBatchKey = randomUUID()
    const secondNameservers = ['ns3.after.example', 'ns4.after.example']
    const firstPreview = await preview(fixture, ids, firstBatchKey)
    const secondPreviewResult = await previewCustomerNameserverBatchChange(
      fixture.req,
      { assetIds: ids, batchKey: secondBatchKey, nameservers: secondNameservers },
      {
        customer: identity(fixture.customer.id),
        traceId: `${fixturePrefix}-query-scope-preview-b`,
      },
    )
    if (!('data' in secondPreviewResult)) throw new Error('Expected second scoped preview')
    const [firstGrant, secondGrant] = await Promise.all([grant(fixture), grant(fixture)])
    const first = await requestCustomerNameserverBatchChange(
      fixture.req,
      {
        assetIds: ids,
        batchKey: firstBatchKey,
        confirmed: true,
        ...firstGrant,
        nameservers: requestedNameservers,
        previewToken: firstPreview.previewToken,
      },
      { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-query-scope-a` },
    )
    await requestCustomerNameserverBatchChange(
      fixture.req,
      {
        assetIds: ids,
        batchKey: secondBatchKey,
        confirmed: true,
        ...secondGrant,
        nameservers: secondNameservers,
        previewToken: secondPreviewResult.data.previewToken,
      },
      { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-query-scope-b` },
    )
    if (!('data' in first)) throw new Error('Expected first scoped batch')
    const queried = await queryCustomerNameserverBatchChange(fixture.req, firstBatchKey, {
      customer: identity(fixture.customer.id),
      traceId: `${fixturePrefix}-query-scope-query`,
    })
    expect(queried).toMatchObject({
      data: { items: first.data.items.map((item) => ({ changeId: item.changeId })) },
    })
    await expect(
      queryCustomerNameserverBatchChange(other.req, firstBatchKey, {
        customer: identity(other.customer.id),
        traceId: `${fixturePrefix}-query-scope-other-query`,
      }),
    ).rejects.toMatchObject({ code: 'NAMESERVER_BATCH_NOT_FOUND', status: 404 })
  })

  it('uses item-level keys so concurrent different batches sharing items queue each item once', async () => {
    const fixture = await createFixture('concurrent-item', 2)
    const ids = fixture.assets.map((asset) => Number(asset.id))
    const firstBatchKey = randomUUID()
    const secondBatchKey = randomUUID()
    const [firstPreview, secondPreview] = await Promise.all([
      preview(fixture, ids, firstBatchKey),
      preview(fixture, ids, secondBatchKey),
    ])
    const [firstGrant, secondGrant] = await Promise.all([grant(fixture), grant(fixture)])
    const [firstReq, secondReq] = await Promise.all([
      request(fixture.customer, 'ns-item-first'),
      request(fixture.customer, 'ns-item-second'),
    ])
    await Promise.all([
      requestCustomerNameserverBatchChange(
        firstReq,
        {
          assetIds: ids,
          batchKey: firstBatchKey,
          confirmed: true,
          ...firstGrant,
          nameservers: requestedNameservers,
          previewToken: firstPreview.previewToken,
        },
        { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-concurrent-item-a` },
      ),
      requestCustomerNameserverBatchChange(
        secondReq,
        {
          assetIds: ids,
          batchKey: secondBatchKey,
          confirmed: true,
          ...secondGrant,
          nameservers: requestedNameservers,
          previewToken: secondPreview.previewToken,
        },
        { customer: identity(fixture.customer.id), traceId: `${fixturePrefix}-concurrent-item-b` },
      ),
    ])
    const queued = await payload.db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM payload_jobs
       WHERE workflow_slug::text = 'nameserverChange'
         AND input->>'traceId' LIKE $1`,
      [`${fixturePrefix}-concurrent-item%`],
    )
    expect(queued.rows[0]?.count).toBe('2')
    const keys = await payload.db.pool.query<{ count: string }>(
      `SELECT count(DISTINCT change_key)::text AS count
       FROM nameserver_changes
       WHERE customer_id = $1
         AND change_key LIKE 'nameserver:%'`,
      [fixture.customer.id],
    )
    expect(keys.rows[0]?.count).toBe('2')
  })

  it('applies A3 capability and A5 cooldown independently to NS batch entry points', async () => {
    const restricted = await createFixture('restricted', 2, {
      capabilityRestrictions: ['domain_write_disabled'],
    })
    await expect(
      previewCustomerNameserverBatchChange(
        restricted.req,
        {
          assetIds: restricted.assets.map((asset) => Number(asset.id)),
          batchKey: randomUUID(),
          nameservers: requestedNameservers,
        },
        { customer: identity(restricted.customer.id), traceId: `${fixturePrefix}-restricted` },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DOMAIN_WRITE_DISABLED', status: 403 })
    await expect(
      requestCustomerNameserverBatchChange(
        restricted.req,
        {
          assetIds: restricted.assets.map((asset) => Number(asset.id)),
          batchKey: randomUUID(),
          confirmed: true,
          nameservers: requestedNameservers,
          previewToken: 'x'.repeat(80),
        },
        {
          customer: identity(restricted.customer.id),
          traceId: `${fixturePrefix}-restricted-write`,
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DOMAIN_WRITE_DISABLED', status: 403 })
    await expect(
      queryCustomerNameserverBatchChange(restricted.req, randomUUID(), {
        customer: identity(restricted.customer.id),
        traceId: `${fixturePrefix}-restricted-query`,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DOMAIN_WRITE_DISABLED', status: 403 })

    const cooldown = await createFixture('cooldown', 2, { cooldown: true })
    const batchKey = randomUUID()
    const ids = cooldown.assets.map((asset) => Number(asset.id))
    const dryRun = await preview(cooldown, ids, batchKey)
    const stepUp = await grant(cooldown)
    await expect(
      requestCustomerNameserverBatchChange(
        cooldown.req,
        {
          assetIds: ids,
          batchKey,
          confirmed: true,
          ...stepUp,
          nameservers: requestedNameservers,
          previewToken: dryRun.previewToken,
        },
        { customer: identity(cooldown.customer.id), traceId: `${fixturePrefix}-cooldown` },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE', status: 403 })
  })
})
