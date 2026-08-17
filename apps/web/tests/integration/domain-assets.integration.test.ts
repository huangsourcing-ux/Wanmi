import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mockFailure, mockSuccess } from '@/providers/mock'
import type { SmsProvider } from '@/providers/types'
import {
  FixtureWestDigitalWriteTransport,
  timeoutAfterSubmission,
} from '@/providers/westdigital-write-fixtures'
import { WestDigitalWriteAdapter } from '@/providers/westdigital-write'
import {
  getCustomerDomainAsset,
  listCustomerDomainAssets,
  syncCustomerDomainAsset,
} from '@/services/domains/domain-assets'
import { runDomainExpiryReminders } from '@/services/domains/expiry-reminders'
import {
  enqueueNameserverReviewQuery,
  requestCustomerNameserverChange,
  runNameserverChange,
} from '@/services/domains/nameserver-changes'

import { fulfillmentQuoteSnapshotFixture } from '../fixtures/commerce'
import { realnameTemplateFixture } from '../fixtures/realname'
import { issueStepUpGrantFixture } from '../fixtures/step-up'
import {
  ensureAnchorSystemAdmin,
  findOrCreateUniqueFixture,
  ignorePayloadNotFound,
} from '../test-cleanup'

const fixturePrefix = `d6-domain-assets-${randomUUID()}`
let payload: Payload
const assetIds: Array<number | string> = []
const customerIds: Array<number | string> = []
const templateIds: Array<number | string> = []

type Customer = Awaited<ReturnType<typeof createCustomer>>

async function request(suffix: string, user?: Record<string, unknown>): Promise<PayloadRequest> {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) } },
    payload,
  )
  if (user) req.user = user as never
  return req
}

async function createCustomer(suffix: string) {
  const phone = `+861${String(Math.abs(hash(`${fixturePrefix}-${suffix}`)))
    .padStart(10, '0')
    .slice(0, 10)}`
  const fixture = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'customers',
        data: {
          capabilityRestrictions: [],
          phone,
          phoneMasked: `***${phone.slice(-4)}`,
          status: 'active',
        },
        overrideAccess: true,
      }),
    find: async () => {
      const found = await payload.find({
        collection: 'customers',
        limit: 1,
        overrideAccess: true,
        where: { phone: { equals: phone } },
      })
      return found.docs[0]
    },
    path: 'phone',
    tableName: 'customers',
  })
  customerIds.push(fixture.value.id)
  return fixture.value
}

function hash(value: string): number {
  let result = 0
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) % 10_000_000_000
  return result
}

async function createTemplate(customerId: number | string, suffix: string) {
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `D6-${hash(`${fixturePrefix}-${suffix}`)}` }),
      customer: customerId as never,
    },
    overrideAccess: true,
  })
  templateIds.push(template.id)
  return template
}

async function createAsset(
  customerId: number | string,
  templateId: number | string,
  suffix: string,
  expiresAt = '2028-08-08T04:00:00.000Z',
) {
  const domainAscii = `d6${hash(`${fixturePrefix}-${suffix}`)}-${randomUUID().slice(0, 8)}.com`
  const fixture = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'domainAssets',
        data: {
          customer: customerId as never,
          domainAscii,
          expiresAt,
          lastSyncedAt: '2026-08-08T04:00:00.000Z',
          nameservers: ['ns1.before.example', 'ns2.before.example'],
          realnameTemplate: templateId as never,
          registeredAt: '2026-08-08T04:00:00.000Z',
          registrar: 'west',
          status: 'active',
          syncReviewStatus: 'none',
          syncVersion: 0,
          upstreamOwnershipStatus: 'unknown',
        },
        overrideAccess: true,
      }),
    find: async () => {
      const found = await payload.find({
        collection: 'domainAssets',
        limit: 1,
        overrideAccess: true,
        where: { domainAscii: { equals: domainAscii } },
      })
      return found.docs[0]
    },
    path: 'domainAscii',
    tableName: 'domain_assets',
  })
  assetIds.push(fixture.value.id)
  return fixture.value
}

async function createOrder(customer: Customer, templateId: number | string, suffix: string) {
  const domainAscii = `${suffix}-${randomUUID()}.com`
  const quoteRef = randomUUID()
  const quoteFixture = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'quotes',
        data: {
          availabilityObservedAt: new Date().toISOString(),
          availabilityRequestId: `${fixturePrefix}-availability-${suffix}`,
          calculationFormula: 'registration_price_plus_annual_renewal_price',
          calculationVersion: 1,
          createdTraceId: `${fixturePrefix}-quote-${suffix}`,
          currency: 'CNY',
          customer: customer.id,
          domainAscii,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          priceClass: 'standard',
          provider: 'westdigital_fixture',
          providerCacheStatus: 'miss',
          providerObservedAt: new Date().toISOString(),
          providerProductId: `${fixturePrefix}-product-${suffix}`,
          providerRequestId: `${fixturePrefix}-price-${suffix}`,
          quotedAt: new Date().toISOString(),
          quoteIntegrityHash: '7'.repeat(64),
          quoteRef,
          registrationPriceMinor: 2_999,
          renewalPriceMinor: 2_999,
          ruleFixedAmountMinor: 0,
          ruleKey: `${fixturePrefix}-rule-${suffix}`,
          ruleMode: 'fixed',
          ruleSource: 'wanmi_fixture',
          ruleVersion: 1,
          roundingMode: 'half_up_to_fen',
          schemaVersion: 1,
          sourceCalculationHash: '8'.repeat(64),
          sourcePriceSnapshotRef: randomUUID(),
          tld: 'com',
          upstreamCostMinor: 2_999,
          upstreamRegistrationPriceMinor: 2_999,
          upstreamRenewalPriceMinor: 2_999,
          userPriceMinor: 2_999,
          years: 1,
        },
        overrideAccess: true,
      }),
    find: async () => {
      const found = await payload.find({
        collection: 'quotes',
        limit: 1,
        overrideAccess: true,
        where: { quoteRef: { equals: quoteRef } },
      })
      return found.docs[0]
    },
    path: 'quoteRef',
    tableName: 'quotes',
  })
  const orderNumber = `${fixturePrefix}-${suffix}-${randomUUID()}`
  const orderFixture = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'orders',
        data: {
          amountMinor: 2_999,
          currency: 'CNY',
          customer: customer.id,
          domainAscii,
          orderNumber,
          quote: quoteFixture.value.id,
          quoteSnapshot: fulfillmentQuoteSnapshotFixture({
            amountMinor: 2_999,
            customerId: customer.id,
            domainAscii,
            quoteId: quoteFixture.value.id,
          }),
          realnameTemplate: templateId as never,
          status: 'pending_payment',
        },
        overrideAccess: true,
      }),
    find: async () => {
      const found = await payload.find({
        collection: 'orders',
        limit: 1,
        overrideAccess: true,
        where: { orderNumber: { equals: orderNumber } },
      })
      return found.docs[0]
    },
    path: 'orderNumber',
    tableName: 'orders',
  })
  return orderFixture.value
}

function assetResponse(
  domainAscii: string,
  nameservers: string[],
  expires = '2028-08-08 12:00:00',
) {
  return {
    body: {
      clientid: `${fixturePrefix}-asset-client`,
      data: {
        dns1: nameservers[0] ?? '',
        dns2: nameservers[1] ?? '',
        dns3: nameservers[2] ?? '',
        dns4: '',
        dns5: '',
        dns6: '',
        domain: domainAscii,
        expdate: expires,
        id: '44169980',
        regdate: '2026-08-08 12:00:00',
        registrars: 'west-confirmed',
      },
      result: 200,
    },
    status: 200,
  }
}

async function customerReq(customer: Customer, suffix: string) {
  return request(suffix, { ...customer, collection: 'customers' })
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  const changes = await payload.find({
    collection: 'nameserverChanges',
    limit: 500,
    overrideAccess: true,
    where: { createdTraceId: { contains: fixturePrefix } },
  })
  for (const change of changes.docs) {
    const reviews = await payload.find({
      collection: 'manualReviews',
      limit: 100,
      overrideAccess: true,
      where: { nameserverChange: { equals: change.id } },
    })
    for (const review of reviews.docs) {
      await ignorePayloadNotFound(() =>
        payload.delete({ collection: 'manualReviews', id: review.id, overrideAccess: true }),
      )
    }
    if (change.providerOperation) {
      const operationId =
        typeof change.providerOperation === 'object'
          ? change.providerOperation.id
          : change.providerOperation
      await ignorePayloadNotFound(() =>
        payload.delete({ collection: 'providerOperations', id: operationId, overrideAccess: true }),
      )
    }
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'nameserverChanges', id: change.id, overrideAccess: true }),
    )
  }
  for (const collection of ['domainExpiryReminders', 'auditLogs'] as const) {
    const rows = await payload.find({
      collection,
      limit: 500,
      overrideAccess: true,
      where:
        collection === 'domainExpiryReminders'
          ? { createdTraceId: { contains: fixturePrefix } }
          : { traceId: { contains: fixturePrefix } },
    })
    for (const row of rows.docs) {
      await ignorePayloadNotFound(() =>
        payload.delete({ collection, id: row.id, overrideAccess: true }),
      )
    }
  }
  const jobs = await payload.find({
    collection: 'payload-jobs',
    limit: 500,
    overrideAccess: true,
    where: { workflowSlug: { in: ['domainExpiryReminders', 'nameserverChange'] } },
  })
  for (const job of jobs.docs) {
    if (JSON.stringify(job.input).includes(fixturePrefix)) {
      await ignorePayloadNotFound(() =>
        payload.delete({ collection: 'payload-jobs', id: job.id, overrideAccess: true }),
      )
    }
  }
  for (const order of (
    await payload.find({
      collection: 'orders',
      limit: 100,
      overrideAccess: true,
      where: { orderNumber: { contains: fixturePrefix } },
    })
  ).docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'orders', id: order.id, overrideAccess: true }),
    )
  }
  for (const quote of (
    await payload.find({
      collection: 'quotes',
      limit: 100,
      overrideAccess: true,
      where: { createdTraceId: { contains: fixturePrefix } },
    })
  ).docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'quotes', id: quote.id, overrideAccess: true }),
    )
  }
  for (const assetId of assetIds) {
    await payload.db.pool.query('DELETE FROM domain_asset_sync_events WHERE asset_id = $1', [
      assetId,
    ])
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'domainAssets', id: assetId, overrideAccess: true }),
    )
  }
  for (const templateId of templateIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'realnameTemplates', id: templateId, overrideAccess: true }),
    )
  }
  for (const grant of (
    await payload.find({
      collection: 'stepUpGrants',
      limit: 100,
      overrideAccess: true,
      where: { customer: { in: customerIds } },
    })
  ).docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'stepUpGrants', id: grant.id, overrideAccess: true }),
    )
  }
  for (const customerId of customerIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'customers', id: customerId, overrideAccess: true }),
    )
  }
}, 60_000)

describe('D6-04 domain assets, nameservers and expiry reminders', () => {
  it('fails closed across customer asset list/detail, nameserver request and order reads', async () => {
    const owner = await createCustomer('ownership-owner')
    const other = await createCustomer('ownership-other')
    const ownerTemplate = await createTemplate(owner.id, 'ownership-owner')
    const otherTemplate = await createTemplate(other.id, 'ownership-other')
    const ownerAsset = await createAsset(
      owner.id,
      ownerTemplate.id,
      `${fixturePrefix}-ownership-owner`,
    )
    const otherAsset = await createAsset(
      other.id,
      otherTemplate.id,
      `${fixturePrefix}-ownership-other`,
    )
    const otherOrder = await createOrder(other, otherTemplate.id, 'ownership-other')
    const req = await customerReq(owner, 'ownership-gate')
    const nameserverGrant = await issueStepUpGrantFixture(
      payload,
      req,
      owner.id,
      'nameserver_change',
    )

    const list = await listCustomerDomainAssets(req, {
      collection: 'customers',
      id: owner.id,
      status: 'active',
    })
    expect('data' in list ? list.data.items.map((asset) => asset.id) : []).toEqual([
      String(ownerAsset.id),
    ])
    await expect(
      getCustomerDomainAsset(req, otherAsset.id, {
        collection: 'customers',
        id: owner.id,
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND', status: 404 })
    await expect(
      requestCustomerNameserverChange(
        req,
        otherAsset.id,
        {
          ...nameserverGrant,
          confirmed: true,
          nameservers: ['ns1.attacker.example', 'ns2.attacker.example'],
        },
        {
          customer: { collection: 'customers', id: owner.id, status: 'active' },
          traceId: `${fixturePrefix}-ownership-ns`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND', status: 404 })

    const hiddenOrder = await payload.find({
      collection: 'orders',
      limit: 1,
      overrideAccess: false,
      req,
      user: req.user,
      where: { id: { equals: otherOrder.id } },
    })
    expect(hiddenOrder.totalDocs).toBe(0)
  })

  it('records upstream differences without overwriting local facts and fails closed on query failure', async () => {
    const customer = await createCustomer('sync')
    const template = await createTemplate(customer.id, 'sync')
    const asset = await createAsset(customer.id, template.id, `${fixturePrefix}-sync`)
    const req = await customerReq(customer, 'sync')
    const successProvider = new WestDigitalWriteAdapter({
      transport: new FixtureWestDigitalWriteTransport((input) =>
        assetResponse(input.body.domain!, ['ns1.synced.example', 'ns2.synced.example']),
      ),
    })
    const synced = await syncCustomerDomainAsset(req, asset.id, {
      customer: { collection: 'customers', id: customer.id, status: 'active' },
      provider: successProvider,
      traceId: `${fixturePrefix}-sync-success`,
    })
    expect(synced).toMatchObject({
      data: {
        asset: {
          nameservers: ['ns1.before.example', 'ns2.before.example'],
          registrar: 'west',
          status: 'active',
        },
      },
      problem: { code: 'DOMAIN_ASSET_SYNC_DIFFERENCE_PENDING' },
      state: 'degraded',
    })
    const differences = await payload.find({
      collection: 'domainAssetSyncEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { asset: { equals: asset.id } },
          { outcome: { equals: 'difference' } },
          { resolutionStatus: { equals: 'pending' } },
        ],
      },
    })
    expect(differences.totalDocs).toBe(1)
    expect(differences.docs[0]?.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'nameservers' }),
        expect.objectContaining({ field: 'registrar' }),
      ]),
    )
    const beforeFailure = await payload.findByID({
      collection: 'domainAssets',
      id: asset.id,
      overrideAccess: true,
    })
    const failedProvider = new WestDigitalWriteAdapter({
      transport: new FixtureWestDigitalWriteTransport(() => ({ body: {}, status: 503 })),
    })
    const failed = await syncCustomerDomainAsset(req, asset.id, {
      customer: { collection: 'customers', id: customer.id, status: 'active' },
      provider: failedProvider,
      traceId: `${fixturePrefix}-sync-failed`,
    })
    expect(failed).toMatchObject({ meta: { stale: true }, state: 'degraded' })
    const afterFailure = await payload.findByID({
      collection: 'domainAssets',
      id: asset.id,
      overrideAccess: true,
    })
    expect(afterFailure).toMatchObject({
      expiresAt: beforeFailure.expiresAt,
      lastSyncedAt: beforeFailure.lastSyncedAt,
      nameservers: beforeFailure.nameservers,
      registrar: beforeFailure.registrar,
      status: beforeFailure.status,
    })
  })

  it('records successful nameserver before/after facts and audit in the same workflow', async () => {
    const customer = await createCustomer('nameserver-success')
    const template = await createTemplate(customer.id, 'nameserver-success')
    const asset = await createAsset(customer.id, template.id, `${fixturePrefix}-nameserver-success`)
    const req = await customerReq(customer, 'nameserver-success')
    const nameserverGrant = await issueStepUpGrantFixture(
      payload,
      req,
      customer.id,
      'nameserver_change',
    )
    const requested = ['ns1.after.example', 'ns2.after.example']
    let changed = false
    const transport = new FixtureWestDigitalWriteTransport((input) => {
      if (input.operation === 'nameserver') {
        changed = true
        return { body: { clientid: `${fixturePrefix}-ns-write`, result: 200 }, status: 200 }
      }
      return assetResponse(
        input.body.domain!,
        changed ? requested : ['ns1.before.example', 'ns2.before.example'],
      )
    })
    const queued = await requestCustomerNameserverChange(
      req,
      asset.id,
      { ...nameserverGrant, confirmed: true, nameservers: requested },
      {
        customer: { collection: 'customers', id: customer.id, status: 'active' },
        traceId: `${fixturePrefix}-nameserver-success`,
      },
    )
    if (!('data' in queued)) throw new Error('Expected queued nameserver change')
    const result = await runNameserverChange(
      req,
      {
        assetId: Number(asset.id),
        changeId: Number(queued.data.id),
        operationKey: `nameserver-change:${queued.data.id}`,
        traceId: `${fixturePrefix}-nameserver-success-run`,
      },
      new WestDigitalWriteAdapter({ transport }),
    )
    expect(result).toMatchObject({
      confirmedNameservers: requested,
      previousNameservers: ['ns1.before.example', 'ns2.before.example'],
      status: 'succeeded',
    })
    expect(transport.writeCount).toBe(1)
    const updatedAsset = await payload.findByID({
      collection: 'domainAssets',
      id: asset.id,
      overrideAccess: true,
    })
    expect(updatedAsset.nameservers).toEqual(requested)
    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 20,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'domain.nameserver.change_recorded' } },
          { traceId: { contains: `${fixturePrefix}-nameserver-success` } },
        ],
      },
    })
    expect(audits.docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: String(customer.id),
          actorType: 'customer',
          metadata: expect.objectContaining({
            after: requested,
            before: ['ns1.before.example', 'ns2.before.example'],
            outcome: 'succeeded',
          }),
        }),
      ]),
    )
  })

  it('keeps assets unchanged on explicit nameserver failure and timeout replays only queries', async () => {
    const customer = await createCustomer('nameserver-failures')
    const template = await createTemplate(customer.id, 'nameserver-failures')
    const req = await customerReq(customer, 'nameserver-failures')
    const nameserverGrant = await issueStepUpGrantFixture(
      payload,
      req,
      customer.id,
      'nameserver_change',
    )

    const explicitAsset = await createAsset(
      customer.id,
      template.id,
      `${fixturePrefix}-nameserver-explicit`,
    )
    const explicitTransport = new FixtureWestDigitalWriteTransport((input) =>
      input.operation === 'nameserver'
        ? { body: { clientid: `${fixturePrefix}-explicit`, result: 500 }, status: 200 }
        : assetResponse(input.body.domain!, ['ns1.before.example', 'ns2.before.example']),
    )
    const explicitQueued = await requestCustomerNameserverChange(
      req,
      explicitAsset.id,
      {
        ...nameserverGrant,
        confirmed: true,
        nameservers: ['ns1.failed.example', 'ns2.failed.example'],
      },
      {
        customer: { collection: 'customers', id: customer.id, status: 'active' },
        traceId: `${fixturePrefix}-nameserver-explicit`,
      },
    )
    if (!('data' in explicitQueued)) throw new Error('Expected explicit failure change')
    await expect(
      runNameserverChange(
        req,
        {
          assetId: Number(explicitAsset.id),
          changeId: Number(explicitQueued.data.id),
          operationKey: `nameserver-change:${explicitQueued.data.id}`,
          traceId: `${fixturePrefix}-nameserver-explicit-run`,
        },
        new WestDigitalWriteAdapter({ transport: explicitTransport }),
      ),
    ).resolves.toMatchObject({ status: 'failed' })
    expect(
      (
        await payload.findByID({
          collection: 'domainAssets',
          id: explicitAsset.id,
          overrideAccess: true,
        })
      ).nameservers,
    ).toEqual(['ns1.before.example', 'ns2.before.example'])

    const timeoutAsset = await createAsset(
      customer.id,
      template.id,
      `${fixturePrefix}-nameserver-timeout`,
    )
    const timeoutTransport = new FixtureWestDigitalWriteTransport((input) => {
      if (input.operation === 'nameserver') timeoutAfterSubmission()
      return assetResponse(input.body.domain!, ['ns1.before.example', 'ns2.before.example'])
    })
    const timeoutQueued = await requestCustomerNameserverChange(
      req,
      timeoutAsset.id,
      {
        ...nameserverGrant,
        confirmed: true,
        nameservers: ['ns1.timeout.example', 'ns2.timeout.example'],
      },
      {
        customer: { collection: 'customers', id: customer.id, status: 'active' },
        traceId: `${fixturePrefix}-nameserver-timeout`,
      },
    )
    if (!('data' in timeoutQueued)) throw new Error('Expected timeout change')
    const job = {
      assetId: Number(timeoutAsset.id),
      changeId: Number(timeoutQueued.data.id),
      operationKey: `nameserver-change:${timeoutQueued.data.id}`,
      traceId: `${fixturePrefix}-nameserver-timeout-run`,
    }
    await expect(
      runNameserverChange(req, job, new WestDigitalWriteAdapter({ transport: timeoutTransport })),
    ).resolves.toMatchObject({ status: 'manual_review' })
    await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        runNameserverChange(
          await customerReq(customer, `nameserver-timeout-replay-${index}`),
          job,
          new WestDigitalWriteAdapter({ transport: timeoutTransport }),
        ),
      ),
    )
    expect(timeoutTransport.writeCount).toBe(1)
    expect(
      (
        await payload.findByID({
          collection: 'domainAssets',
          id: timeoutAsset.id,
          overrideAccess: true,
        })
      ).nameservers,
    ).toEqual(['ns1.before.example', 'ns2.before.example'])

    const admin = await ensureAnchorSystemAdmin(payload)
    const adminReq = await request('manual-review-admin', { ...admin, collection: 'admins' })
    const visibleReviews = await payload.find({
      collection: 'manualReviews',
      limit: 10,
      overrideAccess: false,
      req: adminReq,
      user: adminReq.user,
      where: { nameserverChange: { equals: timeoutQueued.data.id } },
    })
    expect(visibleReviews.totalDocs).toBe(1)
    await expect(
      enqueueNameserverReviewQuery(
        req,
        timeoutQueued.data.id,
        `${fixturePrefix}-forbidden-recheck`,
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_ROLE_REQUIRED', status: 403 })
    const rechecks = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        enqueueNameserverReviewQuery(
          await request(`manual-review-recheck-${index}`, { ...admin, collection: 'admins' }),
          timeoutQueued.data.id,
          `${fixturePrefix}-manual-review-recheck-${index}`,
        ),
      ),
    )
    expect(rechecks.filter((result) => !result.idempotentReplay)).toHaveLength(1)
  })

  it('records reminder failure separately and concurrent duplicate runs send SMS only once', async () => {
    const customer = await createCustomer('reminder')
    const template = await createTemplate(customer.id, 'reminder')
    const now = new Date('2026-08-08T04:00:00.000Z')
    const asset = await createAsset(
      customer.id,
      template.id,
      `${fixturePrefix}-reminder`,
      new Date(now.getTime() + 6 * 86_400_000).toISOString(),
    )
    const before = await payload.findByID({
      collection: 'domainAssets',
      id: asset.id,
      overrideAccess: true,
    })
    let sendCount = 0
    const provider: SmsProvider = {
      health: async () => ({
        data: { healthy: true },
        observedAt: now.toISOString(),
        ok: true,
        requestId: `${fixturePrefix}-sms-health`,
      }),
      queryReceipt: async () => mockFailure('SMS_RECEIPT_UNAVAILABLE'),
      sendDomainExpiry: async () => {
        sendCount += 1
        return mockFailure('SMS_TEMPLATE_UNAPPROVED', { statusKnown: true })
      },
      sendOtp: async () => mockFailure('SMS_UNAVAILABLE'),
      sendStepUpOtp: async () => mockFailure('SMS_UNAVAILABLE'),
    }
    const runs = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        runDomainExpiryReminders(await request(`reminder-${index}`), {
          now: () => now,
          provider,
          thresholds: [1, 7, 30],
          traceId: `${fixturePrefix}-reminder-${index}`,
        }),
      ),
    )
    expect(sendCount).toBe(1)
    expect(runs.reduce((total, run) => total + run.failed, 0)).toBe(1)
    const reminders = await payload.find({
      collection: 'domainExpiryReminders',
      limit: 10,
      overrideAccess: true,
      where: { asset: { equals: asset.id } },
    })
    expect(reminders.docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'in_app', status: 'delivered', thresholdDays: 7 }),
        expect.objectContaining({
          channel: 'sms',
          failureCategory: 'template_unapproved',
          status: 'failed',
          thresholdDays: 7,
        }),
      ]),
    )
    expect(reminders.totalDocs).toBe(2)
    const after = await payload.findByID({
      collection: 'domainAssets',
      id: asset.id,
      overrideAccess: true,
    })
    expect(after).toMatchObject({
      expiresAt: before.expiresAt,
      lastSyncedAt: before.lastSyncedAt,
      nameservers: before.nameservers,
      registrar: before.registrar,
      status: before.status,
    })
  })

  it('sends expiry reminders to restricted accounts but skips suspended accounts', async () => {
    const restricted = await createCustomer('reminder-restricted')
    const suspended = await createCustomer('reminder-suspended')
    await payload.update({
      collection: 'customers',
      data: { capabilityRestrictions: ['purchase_disabled'], status: 'restricted' },
      id: restricted.id,
      overrideAccess: true,
    })
    await payload.update({
      collection: 'customers',
      data: { capabilityRestrictions: [], status: 'suspended' },
      id: suspended.id,
      overrideAccess: true,
    })
    const restrictedTemplate = await createTemplate(restricted.id, 'reminder-restricted')
    const suspendedTemplate = await createTemplate(suspended.id, 'reminder-suspended')
    const now = new Date('2031-08-08T04:00:00.000Z')
    const expiresAt = new Date(now.getTime() + 6 * 86_400_000).toISOString()
    const restrictedAsset = await createAsset(
      restricted.id,
      restrictedTemplate.id,
      'reminder-restricted',
      expiresAt,
    )
    const suspendedAsset = await createAsset(
      suspended.id,
      suspendedTemplate.id,
      'reminder-suspended',
      expiresAt,
    )
    let sendCount = 0
    const provider: SmsProvider = {
      health: async () => mockSuccess({ healthy: true }, `${fixturePrefix}-status-health`),
      queryReceipt: async () => mockFailure('NOT_USED'),
      sendDomainExpiry: async () => {
        sendCount += 1
        return mockSuccess(
          {
            accepted: true,
            deliveryStatus: 'delivered',
            providerMessageId: `${fixturePrefix}-status-message`,
          },
          `${fixturePrefix}-status-send`,
        )
      },
      sendOtp: async () => mockFailure('NOT_USED'),
      sendStepUpOtp: async () => mockFailure('NOT_USED'),
    }
    await runDomainExpiryReminders(await request('reminder-statuses'), {
      now: () => now,
      provider,
      thresholds: [7],
      traceId: `${fixturePrefix}-reminder-statuses`,
    })
    expect(sendCount).toBe(1)
    await expect(
      payload.count({
        collection: 'domainExpiryReminders',
        overrideAccess: true,
        where: { asset: { equals: restrictedAsset.id } },
      }),
    ).resolves.toMatchObject({ totalDocs: 2 })
    await expect(
      payload.count({
        collection: 'domainExpiryReminders',
        overrideAccess: true,
        where: { asset: { equals: suspendedAsset.id } },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })
})
