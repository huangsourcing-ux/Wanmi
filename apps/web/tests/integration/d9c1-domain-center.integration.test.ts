import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { mockSuccess } from '@/providers/mock'
import type { SmsProvider } from '@/providers/types'
import { resetEnvForTests } from '@/lib/env'
import {
  FixtureWestDigitalWriteTransport,
  type WestDigitalWriteFixtureHandler,
} from '@/providers/westdigital-write-fixtures'
import {
  WestDigitalWriteAdapter,
  WestDigitalWriteTransportError,
  type WestDigitalWriteTransportRequest,
} from '@/providers/westdigital-write'
import { protectedIdentifier, identityProviderInstance } from '@/services/auth/customer-identities'
import { listCustomerDomainAssets } from '@/services/domains/domain-assets'
import { WESTDIGITAL_DOMAIN_CAPABILITIES } from '@/services/domains/capabilities'
import { setCustomerDomainLockStatus } from '@/services/domains/domain-management'
import {
  updateCustomerDomainExpiryReminderPreferences,
  updateCustomerDomainTags,
} from '@/services/domains/domain-preferences'
import { runDomainExpiryReminders } from '@/services/domains/expiry-reminders'

import { realnameTemplateFixture } from '../fixtures/realname'
import { issueStepUpGrantFixture } from '../fixtures/step-up'
import { ignorePayloadNotFound } from '../test-cleanup'

const fixturePrefix = `d9c1-domain-center-${randomUUID()}`
const assetIds: Array<number | string> = []
const customerIds: Array<number | string> = []
const identityIds: Array<number | string> = []
const templateIds: Array<number | string> = []
let payload: Payload

function customerIdentity(customerId: number | string) {
  return { collection: 'customers' as const, id: customerId, status: 'active' }
}

function hash(value: string): number {
  let result = 0
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) % 100_000_000
  return result
}

async function requestFor(customer: { id: number | string }, suffix: string) {
  const req = await createLocalReq(
    {
      req: {
        headers: new Headers({
          'user-agent': `Wanmi-D9C1/${suffix}`,
          'x-forwarded-for': '198.51.100.61',
          'x-request-id': `${fixturePrefix}-${suffix}`,
        }),
      },
    },
    payload,
  )
  req.user = { ...customer, collection: 'customers' } as never
  return req
}

async function createCustomer(
  suffix: string,
  options: {
    cooldown?: boolean
    identities?: Array<'phone' | 'wechat'>
    restricted?: boolean
  } = {},
) {
  const phone = `+86138${String(hash(`${fixturePrefix}-${suffix}`)).padStart(8, '0')}`
  const customer = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: options.restricted ? ['domain_write_disabled'] : [],
      identityRiskCooldownStartedAt: options.cooldown ? new Date().toISOString() : undefined,
      phone,
      phoneMasked: `+86138****${phone.slice(-4)}`,
      status: options.restricted ? 'restricted' : 'active',
    },
    overrideAccess: true,
  })
  customerIds.push(customer.id)
  for (const provider of options.identities ?? []) {
    const identifier = provider === 'phone' ? phone : `${fixturePrefix}-openid-${suffix}`
    const identity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(identifier),
        boundAt: new Date().toISOString(),
        customer: Number(customer.id),
        provider,
        providerInstanceId: identityProviderInstance(provider),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    identityIds.push(identity.id)
  }
  return { ...customer, id: Number(customer.id) }
}

async function createTemplate(customerId: number, suffix: string) {
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `D9C1-${suffix}-${randomUUID().slice(0, 8)}` }),
      customer: customerId,
    },
    overrideAccess: true,
  })
  templateIds.push(template.id)
  return template
}

async function createAsset(
  customerId: number,
  templateId: number | string,
  suffix: string,
  options: {
    domainLockStatus?: 'locked' | 'unlocked' | 'unknown'
    expiresAt?: string
    status?: 'active' | 'expired' | 'pending' | 'unknown'
    tags?: string[]
  } = {},
) {
  const asset = await payload.create({
    collection: 'domainAssets',
    data: {
      customer: customerId,
      domainAscii: `${suffix}-${randomUUID().slice(0, 8)}.example`,
      domainLockStatus: options.domainLockStatus ?? 'unknown',
      expiresAt: options.expiresAt ?? '2028-08-18T04:00:00.000Z',
      expiryReminderChannels: ['in_app', 'sms'],
      expiryReminderDays: [30, 7, 1],
      lastSyncedAt: '2026-08-18T04:00:00.000Z',
      nameservers: ['ns1.before.example', 'ns2.before.example'],
      realnameTemplate: Number(templateId),
      registeredAt: '2026-08-18T04:00:00.000Z',
      registrar: 'west',
      status: options.status ?? 'active',
      syncReviewStatus: 'none',
      syncVersion: 0,
      tags: options.tags ?? [],
      upstreamOwnershipStatus: 'unknown',
    },
    overrideAccess: true,
  })
  assetIds.push(asset.id)
  return { ...asset, id: Number(asset.id) }
}

function assetResponse(input: WestDigitalWriteTransportRequest) {
  return {
    body: {
      clientid: `${fixturePrefix}-${input.requestId}`,
      data: {
        dns1: 'ns1.before.example',
        dns2: 'ns2.before.example',
        dns3: '',
        dns4: '',
        dns5: '',
        dns6: '',
        domain: input.body.domain,
        expdate: '2028-08-18 12:00:00',
        id: '44169980',
        regdate: '2026-08-18 12:00:00',
        registrars: 'west',
      },
      result: 200,
    },
    status: 200,
  }
}

function managedProvider(mode: 'failed' | 'not_owned' | 'owned' | 'unknown' = 'owned') {
  const handler: WestDigitalWriteFixtureHandler = (input) => {
    const clientid = `${fixturePrefix}-${input.requestId}`
    if (input.operation === 'asset_query') {
      return mode === 'not_owned'
        ? { body: { clientid, result: 404 }, status: 200 }
        : assetResponse(input)
    }
    if (input.operation === 'domain_lock') {
      if (mode === 'unknown') throw new WestDigitalWriteTransportError('TIMEOUT', 'unknown')
      return mode === 'failed'
        ? { body: { clientid, result: 404 }, status: 200 }
        : { body: { clientid, result: 200 }, status: 200 }
    }
    throw new Error(`Unexpected fixture operation ${input.operation}`)
  }
  const transport = new FixtureWestDigitalWriteTransport(handler)
  return { provider: new WestDigitalWriteAdapter({ transport }), transport }
}

function smsProvider(): SmsProvider {
  return {
    health: vi.fn(async () => mockSuccess({ healthy: true }, `${fixturePrefix}-sms-health`)),
    queryReceipt: vi.fn(async () =>
      mockSuccess({ status: 'delivered' as const }, `${fixturePrefix}-sms-receipt`),
    ),
    sendDomainExpiry: vi.fn(async () =>
      mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: `${fixturePrefix}-sms-message`,
        },
        `${fixturePrefix}-sms-send`,
      ),
    ),
    sendOtp: vi.fn(async () =>
      mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: `${fixturePrefix}-otp`,
        },
        `${fixturePrefix}-otp-send`,
      ),
    ),
    sendStepUpOtp: vi.fn(async () =>
      mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: `${fixturePrefix}-step-up`,
        },
        `${fixturePrefix}-step-up-send`,
      ),
    ),
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  if (customerIds.length) {
    await payload.db.pool.query(
      'DELETE FROM domain_management_events WHERE customer_id = ANY($1::int[])',
      [customerIds.map(Number)],
    )
    await payload.db.pool.query(
      'DELETE FROM customer_security_events WHERE customer_id = ANY($1::int[])',
      [customerIds.map(Number)],
    )
    await payload.db.pool.query(
      "DELETE FROM provider_operations WHERE target_id = ANY($1::text[]) AND operation::text = 'domain_lock'",
      [assetIds.map(String)],
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
  for (const grant of (
    await payload.find({
      collection: 'stepUpGrants',
      limit: 500,
      overrideAccess: true,
      where: { customer: { in: customerIds } },
    })
  ).docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'stepUpGrants', id: grant.id, overrideAccess: true }),
    )
  }
  for (const identityId of identityIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'customerIdentities', id: identityId, overrideAccess: true }),
    )
  }
  for (const assetId of assetIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'domainAssets', id: assetId, overrideAccess: true }),
    )
  }
  for (const templateId of templateIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'realnameTemplates', id: templateId, overrideAccess: true }),
    )
  }
  for (const customerId of customerIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'customers', id: customerId, overrideAccess: true }),
    )
  }
}, 60_000)

describe('D9-C-1 domain list, preferences and lock status', () => {
  it('keeps list, search, filters and mixed-owner batch preferences isolated to the authenticated owner', async () => {
    const owner = await createCustomer('isolation-owner')
    const other = await createCustomer('isolation-other')
    const ownerTemplate = await createTemplate(owner.id, 'isolation-owner')
    const otherTemplate = await createTemplate(other.id, 'isolation-other')
    const ownerTag = `owner-${hash(`${fixturePrefix}-owner-tag`)}`
    const otherTag = `other-${hash(`${fixturePrefix}-other-tag`)}`
    const ownerAsset = await createAsset(owner.id, ownerTemplate.id, 'owner-searchable', {
      domainLockStatus: 'locked',
      status: 'active',
      tags: [ownerTag],
    })
    const otherAsset = await createAsset(other.id, otherTemplate.id, 'other-secret', {
      domainLockStatus: 'unlocked',
      status: 'expired',
      tags: [otherTag],
    })
    await createAsset(owner.id, ownerTemplate.id, 'owner-expired-past', {
      expiresAt: '2025-08-18T04:00:00.000Z',
      status: 'active',
    })
    const req = await requestFor(owner, 'isolation')
    await expect(
      listCustomerDomainAssets(req, customerIdentity(other.id), {
        page: 1,
        pageSize: 100,
        sort: 'expiresAt',
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED', status: 401 })
    const unfiltered = await listCustomerDomainAssets(req, customerIdentity(owner.id), {
      page: 1,
      pageSize: 100,
      sort: 'expiresAt',
    })
    expect(
      'data' in unfiltered ? unfiltered.data.items.map((asset) => asset.id) : [],
    ).not.toContain(String(otherAsset.id))
    const queries = [
      { query: 'other-secret', page: 1, pageSize: 100, sort: 'expiresAt' as const },
      {
        page: 1,
        pageSize: 100,
        sort: 'expiresAt' as const,
        tag: otherTag,
      },
      {
        lockStatus: 'unlocked' as const,
        page: 1,
        pageSize: 100,
        sort: 'expiresAt' as const,
      },
      { page: 1, pageSize: 100, sort: 'expiresAt' as const, status: 'expired' as const },
      { expiresWithinDays: 0, page: 1, pageSize: 100, sort: 'expiresAt' as const },
    ]
    for (const query of queries) {
      const result = await listCustomerDomainAssets(req, customerIdentity(owner.id), query)
      const ids = 'data' in result ? result.data.items.map((asset) => asset.id) : []
      expect(ids).toEqual([])
      expect(ids).not.toContain(String(otherAsset.id))
    }
    const ownerList = await listCustomerDomainAssets(req, customerIdentity(owner.id), {
      page: 1,
      pageSize: 100,
      sort: 'expiresAt',
      tag: ownerTag,
    })
    expect('data' in ownerList ? ownerList.data.items.map((asset) => asset.id) : []).toEqual([
      String(ownerAsset.id),
    ])
    await expect(
      updateCustomerDomainExpiryReminderPreferences(
        req,
        {
          assetIds: [ownerAsset.id, otherAsset.id],
          batchKey: randomUUID(),
          channels: ['in_app'],
          thresholdDays: [1],
        },
        { customer: customerIdentity(owner.id), traceId: `${fixturePrefix}-isolation-batch` },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_BATCH_OWNERSHIP_MISMATCH', status: 404 })
    const unchanged = await payload.findByID({
      collection: 'domainAssets',
      id: otherAsset.id,
      overrideAccess: true,
    })
    expect(unchanged.expiryReminderChannels).toEqual(['in_app', 'sms'])
    expect(unchanged.expiryReminderDays).toEqual([30, 7, 1])
  })

  it('uses the access-controlled Local API source and explicit owner predicates for list and batch reads', async () => {
    const customer = await createCustomer('read-source')
    const other = await createCustomer('read-source-other')
    const template = await createTemplate(customer.id, 'read-source')
    const tag = `source-${hash(`${fixturePrefix}-read-source`)}`
    const asset = await createAsset(customer.id, template.id, 'read-source', { tags: [tag] })
    const unselected = await createAsset(customer.id, template.id, 'read-source-unselected', {
      tags: [tag],
    })
    const req = await requestFor(customer, 'read-source')
    await expect(
      listCustomerDomainAssets(req, customerIdentity(other.id), {
        page: 1,
        pageSize: 20,
        sort: 'expiresAt',
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED', status: 401 })
    await expect(
      updateCustomerDomainExpiryReminderPreferences(
        req,
        {
          assetIds: [asset.id],
          batchKey: randomUUID(),
          channels: ['in_app'],
          thresholdDays: [1],
        },
        { customer: customerIdentity(other.id), traceId: `${fixturePrefix}-principal-mismatch` },
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED', status: 401 })
    const original = req.payload.find.bind(req.payload)
    const sourceCalls: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(req.payload, 'find')
    spy.mockImplementation((async (options: unknown) => {
      const call = options as Record<string, unknown>
      const serializedWhere = JSON.stringify(call.where)
      if (call.collection === 'domainAssets' && serializedWhere.includes('"customer"')) {
        expect(call.overrideAccess).toBe(false)
        expect(call.user).toBe(req.user)
        expect(serializedWhere).toContain(`"equals":${customer.id}`)
        sourceCalls.push(call)
      }
      return original(options as never)
    }) as never)
    try {
      await listCustomerDomainAssets(req, customerIdentity(customer.id), {
        page: 1,
        pageSize: 20,
        sort: 'expiresAt',
        tag,
      })
      let batchFailure: unknown
      try {
        await updateCustomerDomainExpiryReminderPreferences(
          req,
          {
            assetIds: [asset.id],
            batchKey: randomUUID(),
            channels: ['in_app'],
            thresholdDays: [1],
          },
          { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-read-source` },
        )
      } catch (error) {
        batchFailure = error
      }
      expect(batchFailure).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    expect(sourceCalls).toHaveLength(2)
    expect(sourceCalls[0]).toMatchObject({ limit: 20, page: 1 })
    expect(sourceCalls[1]).toMatchObject({ pagination: false })
    const unchanged = await payload.findByID({
      collection: 'domainAssets',
      id: unselected.id,
      overrideAccess: true,
    })
    expect(unchanged.expiryReminderChannels).toEqual(['in_app', 'sms'])
    expect(unchanged.expiryReminderDays).toEqual([30, 7, 1])
  })

  it('returns and updates every one of more than ten explicitly selected owner assets', async () => {
    const customer = await createCustomer('pagination')
    const template = await createTemplate(customer.id, 'pagination')
    const tag = `page-${hash(`${fixturePrefix}-pagination`)}`
    const assets = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createAsset(customer.id, template.id, `pagination-${index}`, { tags: [tag] }),
      ),
    )
    const req = await requestFor(customer, 'pagination')
    const list = await listCustomerDomainAssets(req, customerIdentity(customer.id), {
      page: 1,
      pageSize: 50,
      sort: 'domainAscii',
      tag,
    })
    expect('data' in list ? list.data.items : []).toHaveLength(12)
    expect('data' in list ? list.data.total : 0).toBe(12)
    expect('data' in list ? list.data.totalPages : 0).toBe(1)
    const firstPage = await listCustomerDomainAssets(req, customerIdentity(customer.id), {
      page: 1,
      pageSize: 5,
      sort: 'domainAscii',
      tag,
    })
    const secondPage = await listCustomerDomainAssets(req, customerIdentity(customer.id), {
      page: 2,
      pageSize: 5,
      sort: 'domainAscii',
      tag,
    })
    expect('data' in firstPage ? firstPage.data.items : []).toHaveLength(5)
    expect('data' in firstPage ? firstPage.data.total : 0).toBe(12)
    expect('data' in firstPage ? firstPage.data.totalPages : 0).toBe(3)
    expect('data' in secondPage ? secondPage.data.items : []).toHaveLength(5)
    expect(
      new Set(
        [
          ...('data' in firstPage ? firstPage.data.items : []),
          ...('data' in secondPage ? secondPage.data.items : []),
        ].map((item) => item.id),
      ).size,
    ).toBe(10)
    const expectedFirstPage = await payload.db.pool.query<{ domain_ascii: string }>(
      `SELECT domain_ascii
       FROM domain_assets
       WHERE id = ANY($1::int[])
       ORDER BY domain_ascii ASC
       LIMIT 5`,
      [assets.map((asset) => Number(asset.id))],
    )
    expect('data' in firstPage ? firstPage.data.items.map((item) => item.domainAscii) : []).toEqual(
      expectedFirstPage.rows.map((row) => row.domain_ascii),
    )
    let updated:
      | Awaited<ReturnType<typeof updateCustomerDomainExpiryReminderPreferences>>
      | undefined
    let batchFailure: unknown
    try {
      updated = await updateCustomerDomainExpiryReminderPreferences(
        req,
        {
          assetIds: assets.map((asset) => asset.id),
          batchKey: randomUUID(),
          channels: ['in_app'],
          thresholdDays: [7, 1],
        },
        { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-pagination-batch` },
      )
    } catch (error) {
      batchFailure = error
    }
    expect(batchFailure).toBeUndefined()
    expect(updated).toMatchObject({ data: { updated: 12 }, state: 'ready' })
    const stored = await payload.find({
      collection: 'domainAssets',
      overrideAccess: true,
      pagination: false,
      where: { and: [{ customer: { equals: customer.id } }, { tags: { contains: tag } }] },
    })
    expect(stored.docs).toHaveLength(12)
    expect(stored.docs.every((asset) => asset.expiryReminderChannels?.join(',') === 'in_app')).toBe(
      true,
    )
    expect(stored.docs.every((asset) => asset.expiryReminderDays?.join(',') === '1,7')).toBe(true)
    const events = await payload.find({
      collection: 'domainManagementEvents',
      limit: 20,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: customer.id } },
          { operation: { equals: 'expiry_reminder_preferences_update' } },
        ],
      },
    })
    expect(events.totalDocs).toBe(12)
  })

  it('updates tags on the owned asset and exposes them to owner-scoped filtering', async () => {
    const customer = await createCustomer('tags')
    const template = await createTemplate(customer.id, 'tags')
    const asset = await createAsset(customer.id, template.id, 'tags')
    const req = await requestFor(customer, 'tags')
    const tag = `prod-${hash(`${fixturePrefix}-production`)}`
    await updateCustomerDomainTags(
      req,
      asset.id,
      { idempotencyKey: randomUUID(), tags: [tag, '重要'] },
      { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-tags` },
    )
    const result = await listCustomerDomainAssets(req, customerIdentity(customer.id), {
      page: 1,
      pageSize: 20,
      sort: 'domainAscii',
      tag,
    })
    expect('data' in result ? result.data.items[0] : undefined).toMatchObject({
      id: String(asset.id),
      tags: expect.arrayContaining([tag, '重要']),
    })
    const events = await payload.find({
      collection: 'domainManagementEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [{ asset: { equals: asset.id } }, { operation: { equals: 'tags_update' } }],
      },
    })
    expect(events.totalDocs).toBe(1)
  })

  it('applies A3 and local ownership at every D9-C-1 write call point', async () => {
    const restricted = await createCustomer('restricted', { restricted: true })
    const owner = await createCustomer('write-owner')
    const other = await createCustomer('write-other')
    const restrictedTemplate = await createTemplate(restricted.id, 'restricted')
    const ownerTemplate = await createTemplate(owner.id, 'write-owner')
    const otherTemplate = await createTemplate(other.id, 'write-other')
    const restrictedAsset = await createAsset(restricted.id, restrictedTemplate.id, 'restricted')
    const ownerAsset = await createAsset(owner.id, ownerTemplate.id, 'write-owner')
    const otherAsset = await createAsset(other.id, otherTemplate.id, 'write-other', {
      domainLockStatus: 'unlocked',
    })
    const restrictedReq = await requestFor(restricted, 'restricted')
    const ownerReq = await requestFor(owner, 'write-owner')
    const restrictedIdentity = customerIdentity(restricted.id)
    const ownerIdentity = customerIdentity(owner.id)
    const managed = managedProvider()
    for (const operation of [
      () =>
        updateCustomerDomainTags(
          restrictedReq,
          restrictedAsset.id,
          { idempotencyKey: randomUUID(), tags: ['blocked'] },
          { customer: restrictedIdentity, traceId: `${fixturePrefix}-restricted-tags` },
        ),
      () =>
        updateCustomerDomainExpiryReminderPreferences(
          restrictedReq,
          {
            assetIds: [restrictedAsset.id],
            batchKey: randomUUID(),
            channels: ['in_app'],
            thresholdDays: [1],
          },
          { customer: restrictedIdentity, traceId: `${fixturePrefix}-restricted-reminders` },
        ),
      () =>
        setCustomerDomainLockStatus(
          restrictedReq,
          restrictedAsset.id,
          { idempotencyKey: randomUUID(), locked: true },
          {
            customer: restrictedIdentity,
            provider: managed.provider,
            traceId: `${fixturePrefix}-restricted-lock`,
          },
        ),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: 'ACCOUNT_DOMAIN_WRITE_DISABLED',
        status: 403,
      })
    }
    await expect(
      updateCustomerDomainTags(
        ownerReq,
        otherAsset.id,
        { idempotencyKey: randomUUID(), tags: ['foreign'] },
        { customer: ownerIdentity, traceId: `${fixturePrefix}-foreign-tags` },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND', status: 404 })
    await expect(
      setCustomerDomainLockStatus(
        ownerReq,
        otherAsset.id,
        { idempotencyKey: randomUUID(), locked: true },
        {
          customer: ownerIdentity,
          provider: managed.provider,
          traceId: `${fixturePrefix}-foreign-lock`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND', status: 404 })
    expect(managed.transport.requests).toHaveLength(0)
    const unchanged = await payload.findByID({
      collection: 'domainAssets',
      id: ownerAsset.id,
      overrideAccess: true,
    })
    expect(unchanged.tags).toEqual([])
  })

  it('fails closed for unsupported and unchanged lock-state decisions before provider access', async () => {
    const customer = await createCustomer('lock-decisions')
    const template = await createTemplate(customer.id, 'lock-decisions')
    const asset = await createAsset(customer.id, template.id, 'lock-decisions', {
      domainLockStatus: 'locked',
    })
    const req = await requestFor(customer, 'lock-decisions')
    const managed = managedProvider()
    await expect(
      setCustomerDomainLockStatus(
        req,
        asset.id,
        { idempotencyKey: randomUUID(), locked: true },
        {
          capabilities: {
            ...WESTDIGITAL_DOMAIN_CAPABILITIES,
            domain_lock_status: {
              supported: false,
              unsupportedCode: 'DOMAIN_CAPABILITY_DOMAIN_LOCK_STATUS_UNSUPPORTED',
            },
          },
          customer: customerIdentity(customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-lock-unsupported`,
        },
      ),
    ).rejects.toMatchObject({
      code: 'DOMAIN_CAPABILITY_DOMAIN_LOCK_STATUS_UNSUPPORTED',
      status: 409,
    })
    await expect(
      setCustomerDomainLockStatus(
        req,
        asset.id,
        { idempotencyKey: randomUUID(), locked: true },
        {
          customer: customerIdentity(customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-lock-unchanged`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_LOCK_STATUS_UNCHANGED', status: 409 })
    expect(managed.transport.requests).toHaveLength(0)
  })

  it('rejects disabling the domain lock without step-up and notifies every active provider after success', async () => {
    const customer = await createCustomer('unlock', { identities: ['phone', 'wechat'] })
    const template = await createTemplate(customer.id, 'unlock')
    const asset = await createAsset(customer.id, template.id, 'unlock', {
      domainLockStatus: 'locked',
    })
    const req = await requestFor(customer, 'unlock')
    const managed = managedProvider()
    await expect(
      setCustomerDomainLockStatus(
        req,
        asset.id,
        {
          deviceId: 'd9c1-device-without-grant',
          idempotencyKey: randomUUID(),
          locked: false,
          stepUpToken: 'a'.repeat(43),
        },
        {
          customer: customerIdentity(customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-unlock-missing-step-up`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID', status: 403 })
    expect(managed.transport.requests).toHaveLength(0)
    const grant = await issueStepUpGrantFixture(payload, req, customer.id, 'domain_lock_change')
    let result: Awaited<ReturnType<typeof setCustomerDomainLockStatus>> | undefined
    let failure: unknown
    try {
      result = await setCustomerDomainLockStatus(
        req,
        asset.id,
        { ...grant, idempotencyKey: randomUUID(), locked: false },
        {
          customer: customerIdentity(customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-unlock-success`,
        },
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeUndefined()
    expect(result).toMatchObject({ data: { locked: false, status: 'succeeded' }, state: 'ready' })
    const stored = await payload.findByID({
      collection: 'domainAssets',
      id: asset.id,
      overrideAccess: true,
    })
    expect(stored.domainLockStatus).toBe('unlocked')
    const notifications = await payload.find({
      collection: 'customerSecurityEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: customer.id } },
          { event: { equals: 'identity_change_notification' } },
        ],
      },
    })
    expect(notifications.totalDocs).toBe(2)
    expect(
      notifications.docs
        .map((event) => event.safeMetadata as { outcome?: string; provider?: string })
        .map(({ outcome, provider }) => ({ outcome, provider })),
    ).toEqual(
      expect.arrayContaining([
        { outcome: 'sent', provider: 'phone' },
        { outcome: 'sent', provider: 'wechat' },
      ]),
    )
  })

  it('rejects lock disable when no active notification channel remains', async () => {
    const customer = await createCustomer('unlock-no-channel')
    const template = await createTemplate(customer.id, 'unlock-no-channel')
    const asset = await createAsset(customer.id, template.id, 'unlock-no-channel', {
      domainLockStatus: 'locked',
    })
    const req = await requestFor(customer, 'unlock-no-channel')
    const grant = await issueStepUpGrantFixture(payload, req, customer.id, 'domain_lock_change')
    const managed = managedProvider()
    await expect(
      setCustomerDomainLockStatus(
        req,
        asset.id,
        { ...grant, idempotencyKey: randomUUID(), locked: false },
        {
          customer: customerIdentity(customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-unlock-no-channel`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_LOCK_NOTIFICATION_CHANNEL_REQUIRED', status: 409 })
    expect(managed.transport.requests).toHaveLength(0)
  })

  it('binds one reused client idempotency key to each lock direction independently', async () => {
    const customer = await createCustomer('lock-direction-key', { identities: ['phone'] })
    const template = await createTemplate(customer.id, 'lock-direction-key')
    const asset = await createAsset(customer.id, template.id, 'lock-direction-key', {
      domainLockStatus: 'unlocked',
    })
    const req = await requestFor(customer, 'lock-direction-key')
    const managed = managedProvider()
    const idempotencyKey = randomUUID()
    await setCustomerDomainLockStatus(
      req,
      asset.id,
      { idempotencyKey, locked: true },
      {
        customer: customerIdentity(customer.id),
        provider: managed.provider,
        traceId: `${fixturePrefix}-lock-direction-enable`,
      },
    )
    const grant = await issueStepUpGrantFixture(payload, req, customer.id, 'domain_lock_change')
    await setCustomerDomainLockStatus(
      req,
      asset.id,
      { ...grant, idempotencyKey, locked: false },
      {
        customer: customerIdentity(customer.id),
        provider: managed.provider,
        traceId: `${fixturePrefix}-lock-direction-disable`,
      },
    )
    const writes = managed.transport.requests.filter(
      (request) => request.operation === 'domain_lock',
    )
    expect(writes).toHaveLength(2)
    expect(writes.map((request) => request.body.val)).toEqual(['1', '0'])
    const operations = await payload.find({
      collection: 'providerOperations',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [{ operation: { equals: 'domain_lock' } }, { targetId: { equals: String(asset.id) } }],
      },
    })
    expect(operations.totalDocs).toBe(2)
    expect(new Set(operations.docs.map((operation) => operation.operationKey)).size).toBe(2)
  })

  it('enables the domain lock with the current session and audit but no step-up or bound channel', async () => {
    const customer = await createCustomer('lock-enable')
    const template = await createTemplate(customer.id, 'lock-enable')
    const asset = await createAsset(customer.id, template.id, 'lock-enable', {
      domainLockStatus: 'unlocked',
    })
    const req = await requestFor(customer, 'lock-enable')
    const managed = managedProvider()
    let result: Awaited<ReturnType<typeof setCustomerDomainLockStatus>> | undefined
    let failure: unknown
    try {
      result = await setCustomerDomainLockStatus(
        req,
        asset.id,
        { idempotencyKey: randomUUID(), locked: true },
        {
          customer: customerIdentity(customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-lock-enable`,
        },
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeUndefined()
    expect(result).toMatchObject({ data: { locked: true, status: 'succeeded' }, state: 'ready' })
    const stored = await payload.findByID({
      collection: 'domainAssets',
      id: asset.id,
      overrideAccess: true,
    })
    expect(stored.domainLockStatus).toBe('locked')
    expect(stored.domainLockUpdatedAt).toBeTypeOf('string')
    expect(stored.syncVersion).toBe(1)
    const events = await payload.find({
      collection: 'domainManagementEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { asset: { equals: asset.id } },
          { customer: { equals: customer.id } },
          { operation: { equals: 'domain_lock_change' } },
        ],
      },
    })
    expect(events.totalDocs).toBe(2)
    expect(events.docs.map((event) => event.event).sort()).toEqual(['confirmed', 'requested'])
    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'domain.management.operation_recorded' } },
          { traceId: { equals: `${fixturePrefix}-lock-enable` } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(2)
    const notifications = await payload.find({
      collection: 'customerSecurityEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: customer.id } },
          { event: { equals: 'identity_change_notification' } },
        ],
      },
    })
    expect(notifications.totalDocs).toBe(0)
  })

  it('fails closed when the domain-management lease is stolen before the local lock fact CAS', async () => {
    const customer = await createCustomer('lock-lease-stolen')
    const template = await createTemplate(customer.id, 'lock-lease-stolen')
    const asset = await createAsset(customer.id, template.id, 'lock-lease-stolen', {
      domainLockStatus: 'unlocked',
    })
    const req = await requestFor(customer, 'lock-lease-stolen')
    const transport = new FixtureWestDigitalWriteTransport(async (input) => {
      if (input.operation === 'asset_query') return assetResponse(input)
      if (input.operation === 'domain_lock') {
        await payload.db.pool.query(
          `UPDATE domain_assets
           SET domain_management_lease_key = $1,
               domain_management_lease_expires_at = NOW() + INTERVAL '5 minutes'
           WHERE id = $2`,
          [`${fixturePrefix}-stolen-lease`, asset.id],
        )
        return {
          body: { clientid: `${fixturePrefix}-${input.requestId}`, result: 200 },
          status: 200,
        }
      }
      throw new Error(`Unexpected fixture operation ${input.operation}`)
    })
    let failure: unknown
    try {
      await setCustomerDomainLockStatus(
        req,
        asset.id,
        { idempotencyKey: randomUUID(), locked: true },
        {
          customer: customerIdentity(customer.id),
          provider: new WestDigitalWriteAdapter({ transport }),
          traceId: `${fixturePrefix}-lock-lease-stolen`,
        },
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'DOMAIN_MANAGEMENT_OPERATION_LEASE_LOST', status: 503 })
    const stored = await payload.findByID({
      collection: 'domainAssets',
      id: asset.id,
      overrideAccess: true,
    })
    expect(stored.domainLockStatus).toBe('unlocked')
    await payload.db.pool.query(
      `UPDATE domain_assets
       SET domain_management_lease_key = NULL,
           domain_management_lease_expires_at = NULL
       WHERE id = $1`,
      [asset.id],
    )
  })

  it.each(['failed', 'unknown'] as const)(
    'does not confirm local lock state or notify channels when the provider result is %s',
    async (mode) => {
      const customer = await createCustomer(`unlock-${mode}`, { identities: ['phone'] })
      const template = await createTemplate(customer.id, `unlock-${mode}`)
      const asset = await createAsset(customer.id, template.id, `unlock-${mode}`, {
        domainLockStatus: 'locked',
      })
      const req = await requestFor(customer, `unlock-${mode}`)
      const grant = await issueStepUpGrantFixture(payload, req, customer.id, 'domain_lock_change')
      const managed = managedProvider(mode)
      const idempotencyKey = randomUUID()
      const result = await setCustomerDomainLockStatus(
        req,
        asset.id,
        { ...grant, idempotencyKey, locked: false },
        {
          customer: customerIdentity(customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-unlock-${mode}`,
        },
      )
      const storedAfterFirstAttempt = await payload.findByID({
        collection: 'domainAssets',
        id: asset.id,
        overrideAccess: true,
      })
      expect(storedAfterFirstAttempt.domainLockStatus).toBe('locked')
      if (mode === 'failed') {
        expect(result).toMatchObject({
          problem: { code: 'WESTDIGITAL_OPERATION_FAILED' },
          state: 'error',
        })
      } else {
        expect(result).toMatchObject({
          data: { locked: false, status: 'unknown' },
          state: 'degraded',
        })
        const replay = await setCustomerDomainLockStatus(
          req,
          asset.id,
          { ...grant, idempotencyKey, locked: false },
          {
            customer: customerIdentity(customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-unlock-${mode}-replay`,
          },
        )
        expect(replay).toMatchObject({
          data: { idempotentReplay: true, locked: false, status: 'unknown' },
          state: 'degraded',
        })
      }
      const stored = await payload.findByID({
        collection: 'domainAssets',
        id: asset.id,
        overrideAccess: true,
      })
      expect(stored.domainLockStatus).toBe('locked')
      const notifications = await payload.find({
        collection: 'customerSecurityEvents',
        limit: 10,
        overrideAccess: true,
        where: {
          and: [
            { customer: { equals: customer.id } },
            { event: { equals: 'identity_change_notification' } },
          ],
        },
      })
      expect(notifications.totalDocs).toBe(0)
      expect(
        managed.transport.requests.filter((request) => request.operation === 'asset_query'),
      ).toHaveLength(1)
    },
  )

  it('rejects domain unlock during the A5 identity-risk cooldown even with a valid grant', async () => {
    const customer = await createCustomer('unlock-cooldown', {
      cooldown: true,
      identities: ['phone'],
    })
    const template = await createTemplate(customer.id, 'unlock-cooldown')
    const asset = await createAsset(customer.id, template.id, 'unlock-cooldown', {
      domainLockStatus: 'locked',
    })
    const req = await requestFor(customer, 'unlock-cooldown')
    const grant = await issueStepUpGrantFixture(payload, req, customer.id, 'domain_lock_change')
    const managed = managedProvider()
    await expect(
      setCustomerDomainLockStatus(
        req,
        asset.id,
        { ...grant, idempotencyKey: randomUUID(), locked: false },
        {
          customer: customerIdentity(customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-unlock-cooldown`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE', status: 403 })
    expect(managed.transport.requests).toHaveLength(0)
  })

  it('cannot disable the final reminder tier and the existing reminder chain honors valid channel preferences', async () => {
    const customer = await createCustomer('final-reminder')
    const template = await createTemplate(customer.id, 'final-reminder')
    const now = new Date('2026-08-18T12:00:00.000Z')
    const asset = await createAsset(customer.id, template.id, 'final-reminder', {
      expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1_000).toISOString(),
    })
    const req = await requestFor(customer, 'final-reminder')
    await expect(
      updateCustomerDomainExpiryReminderPreferences(
        req,
        {
          assetIds: [asset.id],
          batchKey: randomUUID(),
          channels: ['in_app'],
          thresholdDays: [30, 7],
        },
        { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-final-rejected` },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_EXPIRY_FINAL_REMINDER_REQUIRED', status: 400 })
    await updateCustomerDomainExpiryReminderPreferences(
      req,
      {
        assetIds: [asset.id],
        batchKey: randomUUID(),
        channels: ['in_app'],
        thresholdDays: [1],
      },
      { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-final-valid` },
    )
    const validPreferences = await payload.findByID({
      collection: 'domainAssets',
      id: asset.id,
      overrideAccess: true,
    })
    expect(validPreferences.expiryReminderChannels).toEqual(['in_app'])
    expect(validPreferences.expiryReminderDays).toEqual([1])
    await payload.update({
      collection: 'domainAssets',
      data: { expiryReminderChannels: [], expiryReminderDays: [30, 7] },
      id: asset.id,
      overrideAccess: true,
    })
    const unsupportedTemplate = await createTemplate(customer.id, 'unsupported-stored-tier')
    const unsupportedAsset = await createAsset(
      customer.id,
      unsupportedTemplate.id,
      'unsupported-stored-tier',
      { expiresAt: new Date(now.getTime() + 10 * 86_400_000).toISOString() },
    )
    await payload.update({
      collection: 'domainAssets',
      data: { expiryReminderChannels: ['in_app'], expiryReminderDays: [14] },
      id: unsupportedAsset.id,
      overrideAccess: true,
    })
    const sms = smsProvider()
    await runDomainExpiryReminders(req, {
      now: () => now,
      provider: sms,
      traceId: `${fixturePrefix}-final-run`,
    })
    expect(sms.sendDomainExpiry).not.toHaveBeenCalled()
    const reminders = await payload.find({
      collection: 'domainExpiryReminders',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { asset: { equals: asset.id } },
          { customer: { equals: customer.id } },
          { thresholdDays: { equals: 1 } },
        ],
      },
    })
    expect(reminders.totalDocs).toBe(1)
    expect(reminders.docs[0]).toMatchObject({ channel: 'in_app', status: 'delivered' })
    const unsupportedReminders = await payload.find({
      collection: 'domainExpiryReminders',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [{ asset: { equals: unsupportedAsset.id } }, { customer: { equals: customer.id } }],
      },
    })
    expect(unsupportedReminders.totalDocs).toBe(0)
  })

  it('rejects unsupported reminder tiers and an unusable configured tier set', async () => {
    const customer = await createCustomer('reminder-config')
    const template = await createTemplate(customer.id, 'reminder-config')
    const asset = await createAsset(customer.id, template.id, 'reminder-config')
    const req = await requestFor(customer, 'reminder-config')
    try {
      vi.stubEnv('DOMAIN_EXPIRY_REMINDER_DAYS', '30,7,1')
      resetEnvForTests()
      await expect(
        updateCustomerDomainExpiryReminderPreferences(
          req,
          {
            assetIds: [asset.id],
            batchKey: randomUUID(),
            channels: ['in_app'],
            thresholdDays: [14, 1],
          },
          { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-unsupported-tier` },
        ),
      ).rejects.toMatchObject({
        code: 'DOMAIN_EXPIRY_REMINDER_THRESHOLD_UNSUPPORTED',
        status: 400,
      })
      vi.stubEnv('DOMAIN_EXPIRY_REMINDER_DAYS', '999')
      resetEnvForTests()
      await expect(
        updateCustomerDomainExpiryReminderPreferences(
          req,
          {
            assetIds: [asset.id],
            batchKey: randomUUID(),
            channels: ['in_app'],
            thresholdDays: [1],
          },
          { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-empty-tiers` },
        ),
      ).rejects.toMatchObject({
        code: 'DOMAIN_EXPIRY_REMINDER_CONFIG_INVALID',
        status: 503,
      })
    } finally {
      vi.unstubAllEnvs()
      resetEnvForTests()
    }
  })

  it('rolls back preference facts and append-only evidence together on partial failures', async () => {
    const customer = await createCustomer('preference-atomicity')
    const template = await createTemplate(customer.id, 'preference-atomicity')
    const first = await createAsset(customer.id, template.id, 'preference-atomicity-1')
    const second = await createAsset(customer.id, template.id, 'preference-atomicity-2')
    const req = await requestFor(customer, 'preference-atomicity')
    const originalUpdate = req.payload.update.bind(req.payload)
    let domainUpdates = 0
    const updateSpy = vi.spyOn(req.payload, 'update')
    updateSpy.mockImplementation((async (options: Record<string, unknown>) => {
      if (options.collection === 'domainAssets') {
        domainUpdates += 1
        if (domainUpdates === 2) throw new Error('fixture second preference write failed')
      }
      return originalUpdate(options as never)
    }) as never)
    try {
      await expect(
        updateCustomerDomainExpiryReminderPreferences(
          req,
          {
            assetIds: [first.id, second.id],
            batchKey: randomUUID(),
            channels: ['in_app'],
            thresholdDays: [1],
          },
          { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-batch-rollback` },
        ),
      ).rejects.toThrow('fixture second preference write failed')
    } finally {
      updateSpy.mockRestore()
    }
    for (const assetId of [first.id, second.id]) {
      const stored = await payload.findByID({
        collection: 'domainAssets',
        id: assetId,
        overrideAccess: true,
      })
      expect(stored.expiryReminderChannels).toEqual(['in_app', 'sms'])
      expect(stored.expiryReminderDays).toEqual([30, 7, 1])
    }
    const batchEvents = await payload.find({
      collection: 'domainManagementEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: customer.id } },
          { operation: { equals: 'expiry_reminder_preferences_update' } },
        ],
      },
    })
    expect(batchEvents.totalDocs).toBe(0)

    const originalCreate = req.payload.create.bind(req.payload)
    const createSpy = vi.spyOn(req.payload, 'create')
    createSpy.mockImplementation((async (options: Record<string, unknown>) => {
      if (options.collection === 'domainManagementEvents') {
        throw new Error('fixture event write failed')
      }
      return originalCreate(options as never)
    }) as never)
    try {
      await expect(
        updateCustomerDomainTags(
          req,
          first.id,
          { idempotencyKey: randomUUID(), tags: ['atomic'] },
          { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-tags-rollback` },
        ),
      ).rejects.toThrow('fixture event write failed')
    } finally {
      createSpy.mockRestore()
    }
    const stored = await payload.findByID({
      collection: 'domainAssets',
      id: first.id,
      overrideAccess: true,
    })
    expect(stored.tags).toEqual([])
    const tagEvents = await payload.find({
      collection: 'domainManagementEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [{ asset: { equals: first.id } }, { operation: { equals: 'tags_update' } }],
      },
    })
    expect(tagEvents.totalDocs).toBe(0)
  })

  it('blocks lock changes through D6-01 when the asset is not in the current upstream account', async () => {
    const customer = await createCustomer('upstream-not-owned')
    const template = await createTemplate(customer.id, 'upstream-not-owned')
    const asset = await createAsset(customer.id, template.id, 'upstream-not-owned', {
      domainLockStatus: 'unlocked',
    })
    const req = await requestFor(customer, 'upstream-not-owned')
    const managed = managedProvider('not_owned')
    await expect(
      setCustomerDomainLockStatus(
        req,
        asset.id,
        { idempotencyKey: randomUUID(), locked: true },
        {
          customer: customerIdentity(customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-upstream-not-owned`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED', status: 409 })
    expect(
      managed.transport.requests.filter((request) => request.operation === 'domain_lock'),
    ).toHaveLength(0)
    const stored = await payload.findByID({
      collection: 'domainAssets',
      id: asset.id,
      overrideAccess: true,
    })
    expect(stored.domainLockStatus).toBe('unlocked')
  })

  it('keeps user-center change records append-only even with system override', async () => {
    const customer = await createCustomer('append-only')
    const template = await createTemplate(customer.id, 'append-only')
    const asset = await createAsset(customer.id, template.id, 'append-only')
    const req = await requestFor(customer, 'append-only')
    await updateCustomerDomainTags(
      req,
      asset.id,
      { idempotencyKey: randomUUID(), tags: ['append-only'] },
      { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-append-only` },
    )
    const event = (
      await payload.find({
        collection: 'domainManagementEvents',
        limit: 1,
        overrideAccess: true,
        where: {
          and: [
            { asset: { equals: asset.id } },
            { customer: { equals: customer.id } },
            { operation: { equals: 'tags_update' } },
          ],
        },
      })
    ).docs[0]!
    await expect(
      payload.update({
        collection: 'domainManagementEvents',
        data: { requestedValue: { tags: ['tampered'] } },
        id: event.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_MANAGEMENT_EVENT_APPEND_ONLY', status: 409 })
    await expect(
      payload.delete({
        collection: 'domainManagementEvents',
        id: event.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_MANAGEMENT_EVENT_APPEND_ONLY', status: 409 })
  })
})
