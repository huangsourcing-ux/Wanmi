import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hmac } from '@/lib/crypto'
import { getEnv, resetEnvForTests } from '@/lib/env'
import {
  FixtureWestDigitalWriteTransport,
  timeoutAfterSubmission,
} from '@/providers/westdigital-write-fixtures'
import {
  WestDigitalWriteAdapter,
  WestDigitalWriteTransportError,
} from '@/providers/westdigital-write'
import {
  addCustomerDnsRecord,
  deleteCustomerDnsRecordBatch,
  deleteCustomerDnsRecord,
  getCustomerDnsRecord,
  listCustomerDnsRecords,
  modifyCustomerDnsRecord,
  previewCustomerDnsRecordBatchDelete,
  setCustomerDnsRecordPaused,
} from '@/services/domains/dns-records'
import { requestCustomerNameserverChange } from '@/services/domains/nameserver-changes'

import { realnameTemplateFixture } from '../fixtures/realname'
import { issueStepUpGrantFixture } from '../fixtures/step-up'
import { ignorePayloadNotFound } from '../test-cleanup'

const fixturePrefix = `d9d1-dns-${randomUUID()}`
let payload: Payload
const assetIds: Array<number | string> = []
const customerIds: Array<number | string> = []
const templateIds: Array<number | string> = []

type FixtureRecord = {
  host: string
  id: string
  line: '' | 'LCNC' | 'LEDU' | 'LFOR' | 'LMOB' | 'LSEO' | 'LTEL'
  paused: boolean
  priority: number
  ttl: number
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'SRV' | 'TXT'
  value: string
}

function customerIdentity(customerId: number | string) {
  return { collection: 'customers' as const, id: customerId, status: 'active' }
}

async function request(
  customer: { id: number | string; status?: null | string },
  suffix: string,
): Promise<PayloadRequest> {
  const req = await createLocalReq(
    {
      req: {
        headers: new Headers({
          'user-agent': `Wanmi-D9D1/${suffix}`,
          'x-forwarded-for': '198.51.100.47',
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
  options: { capabilityRestrictions?: string[]; cooldown?: boolean } = {},
) {
  const phone = `+8619${String(Math.abs(hash(`${fixturePrefix}-${suffix}`)))
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
      ...realnameTemplateFixture({ displayName: `D9D1-${suffix}-${randomUUID().slice(0, 8)}` }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  templateIds.push(template.id)
  const asset = await payload.create({
    collection: 'domainAssets',
    data: {
      customer: customer.id,
      domainAscii: `${suffix}-${randomUUID().slice(0, 8)}.example`,
      expiresAt: '2028-08-17T04:00:00.000Z',
      lastSyncedAt: '2026-08-17T04:00:00.000Z',
      nameservers: ['ns1.before.example', 'ns2.before.example'],
      realnameTemplate: template.id,
      registeredAt: '2026-08-17T04:00:00.000Z',
      registrar: 'west',
      status: 'active',
    },
    overrideAccess: true,
  })
  assetIds.push(asset.id)
  return { asset, customer, req: await request(customer, suffix), template }
}

function hash(value: string): number {
  let result = 0
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) % 1_000_000_000
  return result
}

function statefulProvider(initial: FixtureRecord[] = []) {
  const records = new Map(initial.map((record) => [record.id, { ...record }]))
  let nextId = Math.max(700, ...initial.map((record) => Number(record.id))) + 1
  const transport = new FixtureWestDigitalWriteTransport((input) => {
    const clientid = `${fixturePrefix}-${input.requestId}`
    if (input.operation === 'dns_record_add') {
      const id = String(nextId++)
      records.set(id, {
        host: input.body.host!,
        id,
        line: input.body.line! as FixtureRecord['line'],
        paused: false,
        priority: Number(input.body.level),
        ttl: Number(input.body.ttl),
        type: input.body.type! as FixtureRecord['type'],
        value: input.body.value!,
      })
      return { body: { clientid, data: { id }, result: 200 }, status: 200 }
    }
    if (input.operation === 'dns_record_modify') {
      const current = records.get(input.body.id!)
      if (!current) return { body: { clientid, result: 404 }, status: 200 }
      records.set(current.id, {
        ...current,
        priority: Number(input.body.level),
        ttl: Number(input.body.ttl),
        value: input.body.value!,
      })
      return { body: { clientid, result: 200 }, status: 200 }
    }
    if (input.operation === 'dns_record_delete') {
      records.delete(input.body.id!)
      return { body: { clientid, result: 200 }, status: 200 }
    }
    if (input.operation === 'dns_record_pause') {
      const current = records.get(input.body.id!)
      if (!current) return { body: { clientid, result: 404 }, status: 200 }
      records.set(current.id, { ...current, paused: input.body.val === '1' })
      return { body: { clientid, result: 200 }, status: 200 }
    }
    const filtered = [...records.values()].filter(
      (record) =>
        (!input.body.host || record.host === input.body.host) &&
        (!input.body.type || record.type === input.body.type) &&
        (!input.body.value || record.value === input.body.value),
    )
    const limit = Number(input.body.limit ?? 20)
    const page = Number(input.body.pageno ?? 1)
    return {
      body: {
        clientid,
        data: {
          items: filtered.slice((page - 1) * limit, page * limit).map((record) => ({
            id: record.id,
            item: record.host,
            level: record.priority,
            line: record.line,
            pause: record.paused ? 1 : 0,
            ttl: record.ttl,
            type: record.type,
            value: record.value,
          })),
          limit,
          pagecount: filtered.length === 0 ? 0 : Math.ceil(filtered.length / limit),
          pageno: page,
          total: filtered.length,
        },
        result: 200,
      },
      status: 200,
    }
  })
  return { provider: new WestDigitalWriteAdapter({ transport }), records, transport }
}

function ordinaryRecord(host = 'www', value = '192.0.2.10') {
  return {
    host,
    idempotencyKey: randomUUID(),
    line: '默认' as const,
    priority: 10,
    ttl: 600,
    type: 'A' as const,
    value,
  }
}

function resignPreviewToken(
  token: string,
  mutate: (payload: Record<string, unknown>) => void,
): string {
  const [encoded] = token.split('.')
  if (!encoded) throw new Error('Preview fixture token is malformed')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
  mutate(payload)
  const changed = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${changed}.${hmac(changed, getEnv().SESSION_PEPPER)}`
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvForTests()
})

afterAll(async () => {
  if (customerIds.length) {
    await payload.db.pool.query(
      'DELETE FROM dns_record_changes WHERE customer_id = ANY($1::int[])',
      [customerIds.map(Number)],
    )
    await payload.db.pool.query(
      "DELETE FROM provider_operations WHERE operation::text LIKE 'dns_record_%' AND target_id = ANY($1::text[])",
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
  for (const grant of grants.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'stepUpGrants', id: grant.id, overrideAccess: true }),
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

describe('D9-D-1 DNS record management', () => {
  it('adds an ordinary subdomain without step-up and records scoped append-only audit history', async () => {
    const { asset, customer, req } = await createFixture('ordinary-add')
    const { provider, transport } = statefulProvider()
    const input = ordinaryRecord()
    const mutation = addCustomerDnsRecord(req, asset.id, input, {
      customer: customerIdentity(customer.id),
      provider,
      traceId: `${fixturePrefix}-ordinary-add`,
    })
    await expect(mutation).resolves.toMatchObject({
      data: { status: 'succeeded' },
      state: 'ready',
    })
    const result = await mutation
    expect(transport.writeCount).toBe(1)

    const listed = await listCustomerDnsRecords(
      req,
      asset.id,
      { limit: 20, page: 1 },
      {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-ordinary-list`,
      },
    )
    expect(listed).toMatchObject({ data: { total: 1 }, state: 'ready' })
    const id = 'data' in result ? result.data.providerRecordId! : 'missing'
    await expect(
      getCustomerDnsRecord(req, asset.id, id, {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-ordinary-detail`,
      }),
    ).resolves.toMatchObject({ data: { host: 'www', lineLabel: '默认', type: 'A' } })

    const changes = await payload.find({
      collection: 'dnsRecordChanges',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { asset: { equals: asset.id } },
          { customer: { equals: customer.id } },
          { operation: { equals: 'add' } },
        ],
      },
    })
    expect(changes.totalDocs).toBe(2)
    expect(changes.docs.map((change) => change.event).sort()).toEqual(['confirmed', 'requested'])
    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'domain.dns_record.change_recorded' } },
          { actorId: { equals: String(customer.id) } },
          { traceId: { equals: `${fixturePrefix}-ordinary-add` } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(2)
    expect(audits.docs.every((audit) => audit.targetId)).toBe(true)
    expect(JSON.stringify(audits.docs)).not.toContain(input.idempotencyKey)
    const scopedAsset = await payload.find({
      collection: 'domainAssets',
      limit: 1,
      overrideAccess: true,
      where: { and: [{ id: { equals: asset.id } }, { customer: { equals: customer.id } }] },
    })
    expect(scopedAsset.docs).toHaveLength(1)
    expect(scopedAsset.docs[0]).toMatchObject({
      dnsChangeCount: 1,
      dnsChangeWindowStartedAt: expect.any(String),
      dnsMutationLeaseExpiresAt: null,
      dnsMutationLeaseKey: null,
    })
  })

  it('returns not-found for a provider record id that is absent from the owned domain', async () => {
    const { asset, customer, req } = await createFixture('detail-not-found')
    const { provider, transport } = statefulProvider()
    await expect(
      getCustomerDnsRecord(req, asset.id, '404404', {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-detail-not-found`,
      }),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_NOT_FOUND', status: 404 })
    expect(transport.writeCount).toBe(0)
  })

  it.each(['modify', 'delete', 'pause'] as const)(
    'rejects an absent provider record at the %s preflight call point',
    async (operation) => {
      const { asset, customer, req } = await createFixture(`missing-preflight-${operation}`)
      const { provider, transport } = statefulProvider()
      const options = {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-missing-preflight-${operation}`,
      }
      const mutation =
        operation === 'modify'
          ? modifyCustomerDnsRecord(
              req,
              asset.id,
              '404405',
              {
                idempotencyKey: randomUUID(),
                priority: 10,
                ttl: 600,
                value: '192.0.2.1',
              },
              options,
            )
          : operation === 'delete'
            ? deleteCustomerDnsRecord(
                req,
                asset.id,
                '404405',
                { idempotencyKey: randomUUID() },
                options,
              )
            : setCustomerDnsRecordPaused(
                req,
                asset.id,
                '404405',
                { idempotencyKey: randomUUID(), paused: true },
                options,
              )
      await expect(mutation).rejects.toMatchObject({ code: 'DNS_RECORD_NOT_FOUND', status: 404 })
      expect(transport.writeCount).toBe(0)
    },
  )

  it('replays one stable business key without writing and permits a later re-add with a new key', async () => {
    const { asset, customer, req } = await createFixture('business-key')
    const { provider, records, transport } = statefulProvider()
    const firstInput = ordinaryRecord('repeat', '192.0.2.77')
    const options = {
      customer: customerIdentity(customer.id),
      provider,
      traceId: `${fixturePrefix}-business-key`,
    }
    const firstPromise = addCustomerDnsRecord(req, asset.id, firstInput, options)
    await expect(firstPromise).resolves.toMatchObject({
      data: { idempotentReplay: false, status: 'succeeded' },
    })
    const first = await firstPromise
    const replayPromise = addCustomerDnsRecord(req, asset.id, firstInput, {
      ...options,
      traceId: `${fixturePrefix}-business-key-replay`,
    })
    await expect(replayPromise).resolves.toMatchObject({
      data: { idempotentReplay: true, status: 'succeeded' },
    })
    const replay = await replayPromise
    const reboundPromise = addCustomerDnsRecord(
      req,
      asset.id,
      { ...firstInput, value: '192.0.2.88' },
      { ...options, traceId: `${fixturePrefix}-business-key-rebound` },
    )
    await expect(reboundPromise).resolves.toMatchObject({
      data: { idempotentReplay: true, status: 'succeeded' },
    })
    const rebound = await reboundPromise
    expect(replay).toMatchObject({ data: { idempotentReplay: true, status: 'succeeded' } })
    expect(rebound).toMatchObject({ data: { idempotentReplay: true, status: 'succeeded' } })
    expect(transport.writeCount).toBe(1)

    const firstRecordId = 'data' in first ? first.data.providerRecordId! : 'missing'
    await deleteCustomerDnsRecord(
      req,
      asset.id,
      firstRecordId,
      { idempotencyKey: randomUUID() },
      { ...options, traceId: `${fixturePrefix}-business-key-delete` },
    )
    await addCustomerDnsRecord(
      req,
      asset.id,
      { ...firstInput, idempotencyKey: randomUUID() },
      { ...options, traceId: `${fixturePrefix}-business-key-readd` },
    )
    expect(transport.writeCount).toBe(3)
    expect([...records.values()]).toEqual([
      expect.objectContaining({ host: 'repeat', value: '192.0.2.77' }),
    ])
  })

  it('keeps append-only change history owner-scoped and rejects every generic mutation', async () => {
    const owner = await createFixture('history-owner')
    const other = await createFixture('history-other')
    const { provider } = statefulProvider()
    await addCustomerDnsRecord(owner.req, owner.asset.id, ordinaryRecord('history'), {
      customer: customerIdentity(owner.customer.id),
      provider,
      traceId: `${fixturePrefix}-history-owner`,
    })
    const visible = await payload.find({
      collection: 'dnsRecordChanges',
      limit: 10,
      overrideAccess: false,
      req: owner.req,
      user: owner.req.user,
      where: {
        and: [{ asset: { equals: owner.asset.id } }, { customer: { equals: owner.customer.id } }],
      },
    })
    const hidden = await payload.find({
      collection: 'dnsRecordChanges',
      limit: 10,
      overrideAccess: false,
      req: other.req,
      user: other.req.user,
      where: {
        and: [{ asset: { equals: owner.asset.id } }, { customer: { equals: owner.customer.id } }],
      },
    })
    expect(visible.totalDocs).toBe(2)
    expect(hidden.totalDocs).toBe(0)
    const eventId = visible.docs[0]!.id
    await expect(
      payload.create({
        collection: 'dnsRecordChanges',
        data: {} as never,
        overrideAccess: false,
        req: owner.req,
        user: owner.req.user,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.update({
        collection: 'dnsRecordChanges',
        data: { event: 'failed' },
        id: eventId,
        overrideAccess: false,
        req: owner.req,
        user: owner.req.user,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.delete({
        collection: 'dnsRecordChanges',
        id: eventId,
        overrideAccess: false,
        req: owner.req,
        user: owner.req.user,
      }),
    ).rejects.toMatchObject({ status: 403 })
    const unchanged = await payload.find({
      collection: 'dnsRecordChanges',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [{ asset: { equals: owner.asset.id } }, { customer: { equals: owner.customer.id } }],
      },
    })
    expect(unchanged.totalDocs).toBe(2)
  })

  it('rejects duplicate and over-limit adds before a provider write', async () => {
    vi.stubEnv('DNS_RECORD_MAX_PER_DOMAIN', '1')
    resetEnvForTests()
    const duplicate = await createFixture('duplicate-record')
    const duplicateProvider = statefulProvider([
      {
        host: 'www',
        id: '171',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.10',
      },
    ])
    await expect(
      addCustomerDnsRecord(duplicate.req, duplicate.asset.id, ordinaryRecord(), {
        customer: customerIdentity(duplicate.customer.id),
        provider: duplicateProvider.provider,
        traceId: `${fixturePrefix}-duplicate-record`,
      }),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_LIMIT_EXCEEDED', status: 409 })
    expect(duplicateProvider.transport.writeCount).toBe(0)

    vi.stubEnv('DNS_RECORD_MAX_PER_DOMAIN', '2')
    resetEnvForTests()
    const duplicateWithinLimit = await createFixture('duplicate-within-limit')
    const duplicateWithinLimitProvider = statefulProvider([
      {
        host: 'www',
        id: '172',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.10',
      },
    ])
    await expect(
      addCustomerDnsRecord(
        duplicateWithinLimit.req,
        duplicateWithinLimit.asset.id,
        ordinaryRecord(),
        {
          customer: customerIdentity(duplicateWithinLimit.customer.id),
          provider: duplicateWithinLimitProvider.provider,
          traceId: `${fixturePrefix}-duplicate-within-limit`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_DUPLICATE', status: 409 })
    expect(duplicateWithinLimitProvider.transport.writeCount).toBe(0)
  })

  it.each([
    ['host', { host: 'other' }],
    ['line', { line: 'LTEL' as const }],
    ['type', { type: 'AAAA' as const }],
    ['value', { value: '192.0.2.99' }],
  ])('does not collapse distinct DNS records that differ by %s', async (field, difference) => {
    const { asset, customer, req } = await createFixture(`distinct-${field}`)
    const { provider, transport } = statefulProvider([
      {
        host: 'www',
        id: '173',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.10',
        ...difference,
      },
    ])
    await expect(
      addCustomerDnsRecord(req, asset.id, ordinaryRecord(), {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-distinct-${field}`,
      }),
    ).resolves.toMatchObject({ data: { status: 'succeeded' } })
    expect(transport.writeCount).toBe(1)
  })

  it('returns bounded query failures and never converts them into a local DNS fact', async () => {
    const { asset, customer, req } = await createFixture('query-failure')
    const unavailableTransport = new FixtureWestDigitalWriteTransport(() => ({
      body: {},
      status: 503,
    }))
    const unavailable = new WestDigitalWriteAdapter({ transport: unavailableTransport })
    await expect(
      listCustomerDnsRecords(
        req,
        asset.id,
        { limit: 20, page: 1 },
        {
          customer: customerIdentity(customer.id),
          provider: unavailable,
          traceId: `${fixturePrefix}-query-unavailable`,
        },
      ),
    ).resolves.toMatchObject({ problem: { code: 'WESTDIGITAL_QUERY_UNAVAILABLE' }, state: 'error' })
    await expect(
      getCustomerDnsRecord(req, asset.id, '181', {
        customer: customerIdentity(customer.id),
        provider: unavailable,
        traceId: `${fixturePrefix}-detail-unavailable`,
      }),
    ).resolves.toMatchObject({ problem: { code: 'WESTDIGITAL_QUERY_UNAVAILABLE' }, state: 'error' })
    await expect(
      addCustomerDnsRecord(req, asset.id, ordinaryRecord('unavailable'), {
        customer: customerIdentity(customer.id),
        provider: unavailable,
        traceId: `${fixturePrefix}-add-query-unavailable`,
      }),
    ).rejects.toMatchObject({ code: 'WESTDIGITAL_QUERY_UNAVAILABLE', status: 503 })
    expect(unavailableTransport.writeCount).toBe(0)

    const rateTransport = new FixtureWestDigitalWriteTransport(() => {
      throw new WestDigitalWriteTransportError('RATE_LIMITED', 'not_submitted')
    })
    await expect(
      listCustomerDnsRecords(
        req,
        asset.id,
        { limit: 20, page: 1 },
        {
          customer: customerIdentity(customer.id),
          provider: new WestDigitalWriteAdapter({ transport: rateTransport }),
          traceId: `${fixturePrefix}-query-rate-limited`,
        },
      ),
    ).resolves.toMatchObject({
      problem: { code: 'WESTDIGITAL_RATE_LIMITED' },
      state: 'rate_limited',
    })
    expect(rateTransport.writeCount).toBe(0)
  })

  it('records an explicit upstream rejection as failed without a local DNS fact', async () => {
    const { asset, customer, req } = await createFixture('explicit-rejection')
    const transport = new FixtureWestDigitalWriteTransport((input) => {
      const clientid = `${fixturePrefix}-${input.requestId}`
      if (input.operation === 'dns_record_query') {
        return {
          body: {
            clientid,
            data: { items: [], limit: 100, pagecount: 0, pageno: 1, total: 0 },
            result: 200,
          },
          status: 200,
        }
      }
      return { body: { clientid, result: 404 }, status: 200 }
    })
    const result = await addCustomerDnsRecord(req, asset.id, ordinaryRecord('rejected'), {
      customer: customerIdentity(customer.id),
      provider: new WestDigitalWriteAdapter({ transport }),
      traceId: `${fixturePrefix}-explicit-rejection`,
    })
    expect(result).toMatchObject({ data: { status: 'failed' }, state: 'degraded' })
    expect(transport.writeCount).toBe(1)
    const changes = await payload.find({
      collection: 'dnsRecordChanges',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { asset: { equals: asset.id } },
          { customer: { equals: customer.id } },
          { operation: { equals: 'add' } },
        ],
      },
    })
    expect(changes.totalDocs).toBe(2)
    expect(changes.docs.map((change) => change.event).sort()).toEqual(['failed', 'requested'])
    expect(
      changes.docs.every(
        (change) => change.confirmedRecord === null || change.confirmedRecord === undefined,
      ),
    ).toBe(true)
  })

  it.each([
    ['root A', ordinaryRecord('@')],
    [
      'root CNAME',
      {
        host: '@',
        idempotencyKey: randomUUID(),
        line: '默认' as const,
        priority: 10,
        ttl: 600,
        type: 'CNAME' as const,
        value: 'target.example',
      },
    ],
    [
      'MX',
      {
        host: 'mail',
        idempotencyKey: randomUUID(),
        line: '默认' as const,
        priority: 10,
        ttl: 600,
        type: 'MX' as const,
        value: 'mx.example',
      },
    ],
  ])('rejects %s without its purpose-bound step-up grant', async (_label, record) => {
    const { asset, customer, req } = await createFixture(`missing-step-up-${record.type}`)
    const { provider, transport } = statefulProvider()
    await expect(
      addCustomerDnsRecord(
        req,
        asset.id,
        { ...record, confirmed: true },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-missing-step-up-${record.type}`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_REQUIRED', status: 403 })
    expect(transport.requests).toHaveLength(0)
  })

  it('requires secondary confirmation independently from a valid root-record step-up grant', async () => {
    const { asset, customer, req } = await createFixture('root-confirmation')
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'dns_record_change',
    )
    const { provider, transport } = statefulProvider()
    await expect(
      addCustomerDnsRecord(
        req,
        asset.id,
        { ...ordinaryRecord('@'), ...grant },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-root-confirmation`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_CONFIRMATION_REQUIRED', status: 400 })
    expect(transport.requests).toHaveLength(0)
  })

  it.each(['deviceId', 'stepUpToken'] as const)(
    'requires the high-risk %s even when the other step-up field is present',
    async (missingField) => {
      const { asset, customer, req } = await createFixture(`root-missing-${missingField}`)
      const grant = await issueStepUpGrantFixture(
        payload,
        req,
        Number(customer.id),
        'dns_record_change',
      )
      const { provider, transport } = statefulProvider()
      const riskFields = { ...grant } as { deviceId?: string; stepUpToken?: string }
      delete riskFields[missingField]
      await expect(
        addCustomerDnsRecord(
          req,
          asset.id,
          { ...ordinaryRecord('@'), ...riskFields, confirmed: true },
          {
            customer: customerIdentity(customer.id),
            provider,
            traceId: `${fixturePrefix}-root-missing-${missingField}`,
          },
        ),
      ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_REQUIRED', status: 403 })
      expect(transport.requests).toHaveLength(0)
    },
  )

  it('rejects a purpose-mismatched high-risk grant before a provider write', async () => {
    const { asset, customer, req } = await createFixture('root-wrong-purpose')
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'nameserver_change',
    )
    const { provider, transport } = statefulProvider()
    await expect(
      addCustomerDnsRecord(
        req,
        asset.id,
        { ...ordinaryRecord('@'), ...grant, confirmed: true },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-root-wrong-purpose`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID', status: 403 })
    expect(transport.requests).toHaveLength(0)
  })

  it('accepts confirmed root A and MX changes with their distinct step-up purposes', async () => {
    const { asset, customer, req } = await createFixture('high-risk-success')
    const dnsGrant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'dns_record_change',
    )
    const mxGrant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'mx_record_change',
    )
    const { provider, transport } = statefulProvider()
    await expect(
      addCustomerDnsRecord(
        req,
        asset.id,
        { ...ordinaryRecord('@'), ...dnsGrant, confirmed: true },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-root-success`,
        },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' } })
    await expect(
      addCustomerDnsRecord(
        req,
        asset.id,
        {
          ...mxGrant,
          confirmed: true,
          host: 'mail',
          idempotencyKey: randomUUID(),
          line: '默认',
          priority: 10,
          ttl: 600,
          type: 'MX',
          value: 'mx.example',
        },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-mx-success`,
        },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' } })
    expect(transport.writeCount).toBe(2)
    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 50,
      overrideAccess: true,
      where: {
        and: [
          { actorId: { equals: String(customer.id) } },
          { traceId: { contains: `${fixturePrefix}-` } },
        ],
      },
    })
    const serializedAudit = JSON.stringify(audits.docs)
    expect(serializedAudit).not.toContain(dnsGrant.stepUpToken)
    expect(serializedAudit).not.toContain(dnsGrant.deviceId)
    expect(serializedAudit).not.toContain(mxGrant.stepUpToken)
    expect(serializedAudit).not.toContain(mxGrant.deviceId)
  })

  it.each(['add', 'modify', 'delete', 'pause'] as const)(
    'rechecks high-risk authorization at the %s idempotent-replay call point',
    async (operation) => {
      const { asset, customer, req } = await createFixture(`high-risk-replay-${operation}`)
      const initial =
        operation === 'add'
          ? []
          : [
              {
                host: '@',
                id: '78',
                line: '' as const,
                paused: false,
                priority: 10,
                ttl: 600,
                type: 'A' as const,
                value: '192.0.2.78',
              },
            ]
      const { provider, transport } = statefulProvider(initial)
      const grant = await issueStepUpGrantFixture(
        payload,
        req,
        Number(customer.id),
        'dns_record_change',
      )
      const idempotencyKey = randomUUID()
      const options = {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-high-risk-replay-${operation}`,
      }
      const first =
        operation === 'add'
          ? addCustomerDnsRecord(
              req,
              asset.id,
              { ...ordinaryRecord('@'), ...grant, confirmed: true, idempotencyKey },
              options,
            )
          : operation === 'modify'
            ? modifyCustomerDnsRecord(
                req,
                asset.id,
                '78',
                {
                  ...grant,
                  confirmed: true,
                  idempotencyKey,
                  priority: 10,
                  ttl: 600,
                  value: '192.0.2.79',
                },
                options,
              )
            : operation === 'delete'
              ? deleteCustomerDnsRecord(
                  req,
                  asset.id,
                  '78',
                  { ...grant, confirmed: true, idempotencyKey },
                  options,
                )
              : setCustomerDnsRecordPaused(
                  req,
                  asset.id,
                  '78',
                  { ...grant, confirmed: true, idempotencyKey, paused: true },
                  options,
                )
      await expect(first).resolves.toMatchObject({ data: { status: 'succeeded' } })

      const replay =
        operation === 'add'
          ? addCustomerDnsRecord(
              req,
              asset.id,
              { ...ordinaryRecord('@'), confirmed: true, idempotencyKey },
              options,
            )
          : operation === 'modify'
            ? modifyCustomerDnsRecord(
                req,
                asset.id,
                '999999',
                {
                  confirmed: true,
                  idempotencyKey,
                  priority: 99,
                  ttl: 60,
                  value: '192.0.2.199',
                },
                options,
              )
            : operation === 'delete'
              ? deleteCustomerDnsRecord(
                  req,
                  asset.id,
                  '999999',
                  { confirmed: true, idempotencyKey },
                  options,
                )
              : setCustomerDnsRecordPaused(
                  req,
                  asset.id,
                  '999999',
                  { confirmed: true, idempotencyKey, paused: false },
                  options,
                )
      await expect(replay).rejects.toMatchObject({ code: 'STEP_UP_GRANT_REQUIRED', status: 403 })
      expect(transport.writeCount).toBe(1)
    },
  )

  it.each(['modify', 'delete', 'pause'] as const)(
    'rejects high-risk root A %s at its own call point without step-up',
    async (operation) => {
      const { asset, customer, req } = await createFixture(`high-risk-${operation}`)
      const { provider, transport } = statefulProvider([
        {
          host: '@',
          id: '79',
          line: '',
          paused: false,
          priority: 10,
          ttl: 600,
          type: 'A',
          value: '192.0.2.79',
        },
      ])
      const options = {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-high-risk-${operation}`,
      }
      const mutation =
        operation === 'modify'
          ? modifyCustomerDnsRecord(
              req,
              asset.id,
              '79',
              {
                confirmed: true,
                idempotencyKey: randomUUID(),
                priority: 10,
                ttl: 600,
                value: '192.0.2.80',
              },
              options,
            )
          : operation === 'delete'
            ? deleteCustomerDnsRecord(
                req,
                asset.id,
                '79',
                { confirmed: true, idempotencyKey: randomUUID() },
                options,
              )
            : setCustomerDnsRecordPaused(
                req,
                asset.id,
                '79',
                { confirmed: true, idempotencyKey: randomUUID(), paused: true },
                options,
              )
      await expect(mutation).rejects.toMatchObject({ code: 'STEP_UP_GRANT_REQUIRED', status: 403 })
      expect(transport.writeCount).toBe(0)
    },
  )

  it('modifies, pauses with val 1, resumes with val 0, and deletes one record', async () => {
    const { asset, customer, req } = await createFixture('lifecycle')
    const { provider, transport } = statefulProvider([
      {
        host: 'api',
        id: '81',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.20',
      },
    ])
    const options = {
      customer: customerIdentity(customer.id),
      provider,
      traceId: `${fixturePrefix}-lifecycle`,
    }
    const modifyKey = randomUUID()
    await expect(
      modifyCustomerDnsRecord(
        req,
        asset.id,
        '81',
        {
          idempotencyKey: modifyKey,
          priority: 20,
          ttl: 900,
          value: '192.0.2.21',
        },
        { ...options, traceId: `${fixturePrefix}-modify` },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' } })
    await expect(
      modifyCustomerDnsRecord(
        req,
        asset.id,
        '999999',
        { idempotencyKey: modifyKey, priority: 99, ttl: 60, value: '192.0.2.199' },
        { ...options, traceId: `${fixturePrefix}-modify-replay` },
      ),
    ).resolves.toMatchObject({
      data: { idempotentReplay: true, providerRecordId: '81', status: 'succeeded' },
    })
    const pauseKey = randomUUID()
    await expect(
      setCustomerDnsRecordPaused(
        req,
        asset.id,
        '81',
        { idempotencyKey: pauseKey, paused: true },
        { ...options, traceId: `${fixturePrefix}-pause` },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' } })
    await expect(
      setCustomerDnsRecordPaused(
        req,
        asset.id,
        '999999',
        { idempotencyKey: pauseKey, paused: false },
        { ...options, traceId: `${fixturePrefix}-pause-replay` },
      ),
    ).resolves.toMatchObject({
      data: { idempotentReplay: true, providerRecordId: '81', status: 'succeeded' },
    })
    await expect(
      setCustomerDnsRecordPaused(
        req,
        asset.id,
        '81',
        { idempotencyKey: randomUUID(), paused: false },
        { ...options, traceId: `${fixturePrefix}-resume` },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' } })
    const deleteKey = randomUUID()
    await expect(
      deleteCustomerDnsRecord(
        req,
        asset.id,
        '81',
        { idempotencyKey: deleteKey },
        { ...options, traceId: `${fixturePrefix}-delete` },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' } })
    await expect(
      deleteCustomerDnsRecord(
        req,
        asset.id,
        '999999',
        { idempotencyKey: deleteKey },
        { ...options, traceId: `${fixturePrefix}-delete-replay` },
      ),
    ).resolves.toMatchObject({
      data: { idempotentReplay: true, providerRecordId: '81', status: 'succeeded' },
    })
    expect(
      transport.requests
        .filter((item) => item.operation === 'dns_record_pause')
        .map((item) => item.body.val),
    ).toEqual(['1', '0'])
    expect(transport.writeCount).toBe(4)
    const changes = await payload.find({
      collection: 'dnsRecordChanges',
      limit: 20,
      overrideAccess: true,
      where: { and: [{ asset: { equals: asset.id } }, { customer: { equals: customer.id } }] },
    })
    expect(changes.totalDocs).toBe(8)
  })

  it('requires step-up and a bound preview before batch deletion, then deletes exactly previewed records', async () => {
    const { asset, customer, req } = await createFixture('batch-delete')
    const { provider, records, transport } = statefulProvider([
      {
        host: 'one',
        id: '91',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.31',
      },
      {
        host: 'two',
        id: '92',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.32',
      },
    ])
    await expect(
      previewCustomerDnsRecordBatchDelete(
        req,
        asset.id,
        { recordIds: ['161', '161'] },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-batch-binding-duplicate`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_BATCH_DUPLICATE_ID', status: 400 })
    expect(transport.requests).toHaveLength(0)
    const preview = await previewCustomerDnsRecordBatchDelete(
      req,
      asset.id,
      { recordIds: ['91', '92'] },
      {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-batch-preview`,
      },
    )
    expect(preview).toMatchObject({ data: { items: [{ id: '91' }, { id: '92' }] }, state: 'ready' })
    if (!('data' in preview)) throw new Error('Expected batch preview')
    await expect(
      deleteCustomerDnsRecordBatch(
        req,
        asset.id,
        { previewToken: preview.data.previewToken, recordIds: ['91', '92'] },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-batch-missing-step-up`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_REQUIRED', status: 403 })
    expect(transport.writeCount).toBe(0)

    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'dns_bulk_delete',
    )
    for (const missingField of ['deviceId', 'stepUpToken'] as const) {
      const incomplete = { ...grant } as { deviceId?: string; stepUpToken?: string }
      delete incomplete[missingField]
      await expect(
        deleteCustomerDnsRecordBatch(
          req,
          asset.id,
          {
            ...incomplete,
            previewToken: preview.data.previewToken,
            recordIds: ['91', '92'],
          },
          {
            customer: customerIdentity(customer.id),
            provider,
            traceId: `${fixturePrefix}-batch-missing-${missingField}`,
          },
        ),
      ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_REQUIRED', status: 403 })
    }
    const wrongPurposeGrant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'dns_record_change',
    )
    await expect(
      deleteCustomerDnsRecordBatch(
        req,
        asset.id,
        {
          ...wrongPurposeGrant,
          previewToken: preview.data.previewToken,
          recordIds: ['91', '92'],
        },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-batch-wrong-purpose`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID', status: 403 })
    expect(transport.writeCount).toBe(0)
    await expect(
      deleteCustomerDnsRecordBatch(
        req,
        asset.id,
        { ...grant, previewToken: preview.data.previewToken, recordIds: ['91', '92'] },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-batch-delete`,
        },
      ),
    ).resolves.toMatchObject({
      data: { items: [{ status: 'succeeded' }, { status: 'succeeded' }] },
    })
    expect(transport.writeCount).toBe(2)
    expect(records.size).toBe(0)
  })

  it('rejects a stale batch preview before any provider write', async () => {
    const { asset, customer, req } = await createFixture('batch-stale')
    const { provider, records, transport } = statefulProvider([
      {
        host: 'one',
        id: '101',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.41',
      },
      {
        host: 'two',
        id: '102',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.42',
      },
    ])
    const preview = await previewCustomerDnsRecordBatchDelete(
      req,
      asset.id,
      { recordIds: ['101', '102'] },
      {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-stale-preview`,
      },
    )
    if (!('data' in preview)) throw new Error('Expected batch preview')
    records.set('101', { ...records.get('101')!, value: '192.0.2.99' })
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'dns_bulk_delete',
    )
    await expect(
      deleteCustomerDnsRecordBatch(
        req,
        asset.id,
        { ...grant, previewToken: preview.data.previewToken, recordIds: ['101', '102'] },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-stale-delete`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_PREVIEW_STALE', status: 409 })
    expect(transport.writeCount).toBe(0)
    expect(records.size).toBe(2)
  })

  it('binds batch preview signatures, version, asset, expiry, ids, and record digest', async () => {
    const { asset, customer, req } = await createFixture('batch-binding')
    const { provider, transport } = statefulProvider([
      {
        host: 'one',
        id: '161',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.161',
      },
      {
        host: 'two',
        id: '162',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.162',
      },
    ])
    const preview = await previewCustomerDnsRecordBatchDelete(
      req,
      asset.id,
      { recordIds: ['161', '162'] },
      {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-batch-binding-preview`,
      },
    )
    if (!('data' in preview)) throw new Error('Expected bound batch preview')
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'dns_bulk_delete',
    )
    const [encoded, signature] = preview.data.previewToken.split('.')
    if (!encoded || !signature) throw new Error('Expected signed preview fixture')
    const invalidJson = Buffer.from('{').toString('base64url')
    const tokens = [
      `${preview.data.previewToken.slice(0, -1)}x`,
      `${encoded}.${signature.startsWith('0') ? '1' : '0'}${signature.slice(1)}`,
      `${preview.data.previewToken}.extra`,
      `.${signature}`,
      `${encoded}.`,
      `${invalidJson}.${hmac(invalidJson, getEnv().SESSION_PEPPER)}`,
      resignPreviewToken(preview.data.previewToken, (value) => {
        value.version = 2
      }),
      resignPreviewToken(preview.data.previewToken, (value) => {
        value.assetId = String(Number(asset.id) + 1)
      }),
      resignPreviewToken(preview.data.previewToken, (value) => {
        value.expiresAt = '2026-08-17T00:00:00.000Z'
      }),
      resignPreviewToken(preview.data.previewToken, (value) => {
        delete value.expiresAt
      }),
      resignPreviewToken(preview.data.previewToken, (value) => {
        value.recordIds = ['161', '999']
      }),
      resignPreviewToken(preview.data.previewToken, (value) => {
        value.recordIds = '161,162'
      }),
      resignPreviewToken(preview.data.previewToken, (value) => {
        delete value.recordDigest
      }),
    ]
    for (const [index, previewToken] of tokens.entries()) {
      await expect(
        deleteCustomerDnsRecordBatch(
          req,
          asset.id,
          { ...grant, previewToken, recordIds: ['161', '162'] },
          {
            customer: customerIdentity(customer.id),
            provider,
            traceId: `${fixturePrefix}-batch-binding-${index}`,
          },
        ),
      ).rejects.toMatchObject({ code: 'DNS_RECORD_PREVIEW_INVALID', status: 409 })
    }
    expect(transport.writeCount).toBe(0)
  })

  it('enforces the configurable per-domain mutation rate before another provider write', async () => {
    vi.stubEnv('DNS_RECORD_CHANGE_LIMIT_PER_MINUTE', '1')
    resetEnvForTests()
    const { asset, customer, req } = await createFixture('rate-limit')
    const { provider, transport } = statefulProvider()
    await expect(
      addCustomerDnsRecord(req, asset.id, ordinaryRecord('one'), {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-rate-one`,
      }),
    ).resolves.toMatchObject({ data: { status: 'succeeded' } })
    await expect(
      addCustomerDnsRecord(req, asset.id, ordinaryRecord('two'), {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-rate-two`,
      }),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_RATE_LIMITED', status: 429 })
    expect(transport.writeCount).toBe(1)
  })

  it('rejects a batch whose change count alone exceeds the configured per-minute limit', async () => {
    vi.stubEnv('DNS_RECORD_CHANGE_LIMIT_PER_MINUTE', '1')
    resetEnvForTests()
    const { asset, customer, req } = await createFixture('batch-rate-delta')
    await payload.db.pool.query(
      `UPDATE domain_assets
       SET dns_change_window_started_at = NOW() - INTERVAL '2 minutes', dns_change_count = 999
       WHERE id = $1 AND customer_id = $2`,
      [asset.id, customer.id],
    )
    const { provider, transport } = statefulProvider([
      {
        host: 'one',
        id: '171',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.171',
      },
      {
        host: 'two',
        id: '172',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.172',
      },
    ])
    const options = {
      customer: customerIdentity(customer.id),
      provider,
      traceId: `${fixturePrefix}-batch-rate-delta`,
    }
    const preview = await previewCustomerDnsRecordBatchDelete(
      req,
      asset.id,
      { recordIds: ['171', '172'] },
      options,
    )
    if (!('data' in preview)) throw new Error('Expected batch rate preview')
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'dns_bulk_delete',
    )
    await expect(
      deleteCustomerDnsRecordBatch(
        req,
        asset.id,
        { ...grant, previewToken: preview.data.previewToken, recordIds: ['171', '172'] },
        options,
      ),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_RATE_LIMITED', status: 429 })
    expect(transport.writeCount).toBe(0)
  })

  it('reclaims an expired lease and resets an expired high-count rate window', async () => {
    const { asset, customer, req } = await createFixture('expired-window')
    await payload.db.pool.query(
      `UPDATE domain_assets
       SET dns_mutation_lease_key = $1,
           dns_mutation_lease_expires_at = NOW() - INTERVAL '1 minute',
           dns_change_window_started_at = NOW() - INTERVAL '2 minutes',
           dns_change_count = 999
       WHERE id = $2 AND customer_id = $3`,
      [`${fixturePrefix}-expired-lease`, asset.id, customer.id],
    )
    const { provider, transport } = statefulProvider()
    await expect(
      addCustomerDnsRecord(req, asset.id, ordinaryRecord('expired'), {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-expired-window`,
      }),
    ).resolves.toMatchObject({ data: { status: 'succeeded' } })
    expect(transport.writeCount).toBe(1)
    const scopedAsset = await payload.find({
      collection: 'domainAssets',
      limit: 1,
      overrideAccess: true,
      where: { and: [{ id: { equals: asset.id } }, { customer: { equals: customer.id } }] },
    })
    expect(scopedAsset.docs).toHaveLength(1)
    expect(scopedAsset.docs[0]).toMatchObject({
      dnsChangeCount: 1,
      dnsMutationLeaseExpiresAt: null,
      dnsMutationLeaseKey: null,
    })
    expect(new Date(scopedAsset.docs[0]!.dnsChangeWindowStartedAt!).getTime()).toBeGreaterThan(
      Date.now() - 30_000,
    )
  })

  it('atomically admits exactly one concurrent mutation for the same domain and business key', async () => {
    const { asset, customer } = await createFixture('concurrent-lease')
    const { provider, transport } = statefulProvider()
    const input = ordinaryRecord('concurrent')
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, async (_, index) =>
        addCustomerDnsRecord(
          await request(customer, `concurrent-lease-${index}`),
          asset.id,
          input,
          {
            customer: customerIdentity(customer.id),
            provider,
            traceId: `${fixturePrefix}-concurrent-lease-${index}`,
          },
        ),
      ),
    )
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(
      rejected.every(
        (result) =>
          result.reason instanceof Error &&
          ['DNS_RECORD_MUTATION_IN_PROGRESS', 'DNS_RECORD_RATE_LIMITED'].includes(
            (result.reason as { code?: string }).code ?? '',
          ),
      ),
    ).toBe(true)
    expect(transport.writeCount).toBe(1)
    const scopedAsset = await payload.find({
      collection: 'domainAssets',
      limit: 1,
      overrideAccess: true,
      where: { and: [{ id: { equals: asset.id } }, { customer: { equals: customer.id } }] },
    })
    expect(scopedAsset.docs).toHaveLength(1)
    expect(scopedAsset.docs[0]?.dnsChangeCount).toBe(1)
  })

  it('fails closed without clearing a lease that changed before release', async () => {
    const { asset, customer, req } = await createFixture('lease-lost')
    let submitted = false
    const transport = new FixtureWestDigitalWriteTransport(async (input) => {
      const clientid = `${fixturePrefix}-${input.requestId}`
      if (input.operation === 'dns_record_add') {
        submitted = true
        return { body: { clientid, data: { id: 131 }, result: 200 }, status: 200 }
      }
      if (submitted) {
        await payload.db.pool.query(
          `UPDATE domain_assets
           SET dns_mutation_lease_key = $1,
               dns_mutation_lease_expires_at = NOW() + INTERVAL '5 minutes'
           WHERE id = $2 AND customer_id = $3`,
          [`${fixturePrefix}-intruder-lease`, asset.id, customer.id],
        )
      }
      return {
        body: {
          clientid,
          data: {
            items: submitted
              ? [
                  {
                    id: 131,
                    item: 'lease-lost',
                    level: 10,
                    line: '',
                    pause: 0,
                    ttl: 600,
                    type: 'A',
                    value: '192.0.2.10',
                  },
                ]
              : [],
            limit: 100,
            pagecount: submitted ? 1 : 0,
            pageno: 1,
            total: submitted ? 1 : 0,
          },
          result: 200,
        },
        status: 200,
      }
    })
    const provider = new WestDigitalWriteAdapter({ transport })
    await expect(
      addCustomerDnsRecord(req, asset.id, ordinaryRecord('lease-lost'), {
        customer: customerIdentity(customer.id),
        provider,
        traceId: `${fixturePrefix}-lease-lost`,
      }),
    ).rejects.toMatchObject({ code: 'DNS_RECORD_MUTATION_LEASE_LOST', status: 503 })
    expect(transport.writeCount).toBe(1)
    const scopedAsset = await payload.find({
      collection: 'domainAssets',
      limit: 1,
      overrideAccess: true,
      where: { and: [{ id: { equals: asset.id } }, { customer: { equals: customer.id } }] },
    })
    expect(scopedAsset.docs).toHaveLength(1)
    expect(scopedAsset.docs[0]?.dnsMutationLeaseKey).toBe(`${fixturePrefix}-intruder-lease`)
    await payload.db.pool.query(
      `UPDATE domain_assets
       SET dns_mutation_lease_key = NULL, dns_mutation_lease_expires_at = NULL
       WHERE id = $1 AND customer_id = $2 AND dns_mutation_lease_key = $3`,
      [asset.id, customer.id, `${fixturePrefix}-intruder-lease`],
    )
  })

  it('applies the A3 domain-write capability gate at every DNS mutation entry point', async () => {
    const { asset, customer, req } = await createFixture('capability', {
      capabilityRestrictions: ['domain_write_disabled'],
    })
    const { provider, transport } = statefulProvider([
      {
        host: 'blocked',
        id: '111',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.51',
      },
      {
        host: 'blocked2',
        id: '112',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.52',
      },
    ])
    const options = {
      customer: customerIdentity(customer.id),
      provider,
      traceId: `${fixturePrefix}-capability`,
    }
    await expect(
      addCustomerDnsRecord(req, asset.id, ordinaryRecord(), options),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_DOMAIN_WRITE_DISABLED',
      status: 403,
    })
    await expect(
      modifyCustomerDnsRecord(
        req,
        asset.id,
        '111',
        {
          idempotencyKey: randomUUID(),
          priority: 10,
          ttl: 600,
          value: '192.0.2.61',
        },
        options,
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DOMAIN_WRITE_DISABLED' })
    await expect(
      deleteCustomerDnsRecord(req, asset.id, '111', { idempotencyKey: randomUUID() }, options),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DOMAIN_WRITE_DISABLED' })
    await expect(
      setCustomerDnsRecordPaused(
        req,
        asset.id,
        '111',
        { idempotencyKey: randomUUID(), paused: true },
        options,
      ),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_DOMAIN_WRITE_DISABLED',
    })
    await expect(
      previewCustomerDnsRecordBatchDelete(req, asset.id, { recordIds: ['111', '112'] }, options),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DOMAIN_WRITE_DISABLED' })
    await expect(
      deleteCustomerDnsRecordBatch(
        req,
        asset.id,
        { previewToken: 'x'.repeat(80), recordIds: ['111', '112'] },
        options,
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DOMAIN_WRITE_DISABLED' })
    expect(transport.requests).toHaveLength(0)
  })

  it('enforces asset ownership independently at every DNS read and mutation call point', async () => {
    const owner = await createFixture('ownership-owner')
    const other = await createFixture('ownership-other')
    const { provider, transport } = statefulProvider([
      {
        host: 'other',
        id: '121',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.121',
      },
      {
        host: 'other2',
        id: '122',
        line: '',
        paused: false,
        priority: 10,
        ttl: 600,
        type: 'A',
        value: '192.0.2.122',
      },
    ])
    const options = {
      customer: customerIdentity(owner.customer.id),
      provider,
      traceId: `${fixturePrefix}-ownership`,
    }
    const attempts = await Promise.allSettled([
      listCustomerDnsRecords(owner.req, other.asset.id, { limit: 20, page: 1 }, options),
      getCustomerDnsRecord(owner.req, other.asset.id, '121', options),
      addCustomerDnsRecord(owner.req, other.asset.id, ordinaryRecord(), options),
      modifyCustomerDnsRecord(
        owner.req,
        other.asset.id,
        '121',
        { idempotencyKey: randomUUID(), priority: 10, ttl: 600, value: '192.0.2.123' },
        options,
      ),
      deleteCustomerDnsRecord(
        owner.req,
        other.asset.id,
        '121',
        { idempotencyKey: randomUUID() },
        options,
      ),
      setCustomerDnsRecordPaused(
        owner.req,
        other.asset.id,
        '121',
        { idempotencyKey: randomUUID(), paused: true },
        options,
      ),
      previewCustomerDnsRecordBatchDelete(
        owner.req,
        other.asset.id,
        { recordIds: ['121', '122'] },
        options,
      ),
      deleteCustomerDnsRecordBatch(
        owner.req,
        other.asset.id,
        {
          previewToken: 'x'.repeat(80),
          recordIds: ['121', '122'],
        },
        options,
      ),
    ])
    expect(attempts).toHaveLength(8)
    expect(
      attempts.every(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: string }).code === 'DOMAIN_ASSET_NOT_FOUND',
      ),
    ).toBe(true)
    expect(transport.requests).toHaveLength(0)
    const changes = await payload.find({
      collection: 'dnsRecordChanges',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ asset: { equals: other.asset.id } }, { customer: { equals: owner.customer.id } }],
      },
    })
    expect(changes.totalDocs).toBe(0)
  })

  it('keeps an unknown upstream write pending-query and replays only status queries', async () => {
    const { asset, customer, req } = await createFixture('unknown')
    const transport = new FixtureWestDigitalWriteTransport((input) => {
      if (input.operation === 'dns_record_add') timeoutAfterSubmission()
      const clientid = `${fixturePrefix}-${input.requestId}`
      return {
        body: {
          clientid,
          data: { items: [], limit: 100, pagecount: 0, pageno: 1, total: 0 },
          result: 200,
        },
        status: 200,
      }
    })
    const provider = new WestDigitalWriteAdapter({ transport })
    const options = {
      customer: customerIdentity(customer.id),
      provider,
      traceId: `${fixturePrefix}-unknown-first`,
    }
    const unknownRecord = ordinaryRecord('unknown')
    const first = await addCustomerDnsRecord(req, asset.id, unknownRecord, options)
    const replay = await addCustomerDnsRecord(req, asset.id, unknownRecord, {
      ...options,
      traceId: `${fixturePrefix}-unknown-replay`,
    })
    expect(first).toMatchObject({ data: { status: 'pending_query' }, state: 'degraded' })
    expect(replay).toMatchObject({
      data: { idempotentReplay: true, status: 'pending_query' },
      state: 'degraded',
    })
    expect(transport.writeCount).toBe(1)
    expect(
      transport.requests.filter((item) => item.operation === 'dns_record_query').length,
    ).toBeGreaterThanOrEqual(2)
    const changes = await payload.find({
      collection: 'dnsRecordChanges',
      limit: 10,
      overrideAccess: true,
      where: { and: [{ asset: { equals: asset.id } }, { customer: { equals: customer.id } }] },
    })
    expect(changes.totalDocs).toBe(2)
    expect(changes.docs.map((change) => change.event).sort()).toEqual([
      'pending_query',
      'requested',
    ])
  })

  it.each([
    ['host', { item: 'other' }],
    ['record id', { id: 142 }],
    ['line', { line: 'LTEL' }],
    ['priority', { level: 11 }],
    ['ttl', { ttl: 601 }],
    ['type', { type: 'AAAA' }],
    ['value', { value: '192.0.2.142' }],
  ] as const)(
    'does not confirm an add when the queried %s differs from the requested record',
    async (field, mismatch) => {
      const fieldSlug = field.replaceAll(' ', '-')
      const { asset, customer, req } = await createFixture(`confirm-mismatch-${fieldSlug}`)
      let submitted = false
      const transport = new FixtureWestDigitalWriteTransport((input) => {
        const clientid = `${fixturePrefix}-${input.requestId}`
        if (input.operation === 'dns_record_add') {
          submitted = true
          return { body: { clientid, data: { id: 141 }, result: 200 }, status: 200 }
        }
        return {
          body: {
            clientid,
            data: {
              items: submitted
                ? [
                    {
                      id: 141,
                      item: 'mismatch',
                      level: 10,
                      line: '',
                      pause: 0,
                      ttl: 600,
                      type: 'A',
                      value: '192.0.2.10',
                      ...mismatch,
                    },
                  ]
                : [],
              limit: 100,
              pagecount: submitted ? 1 : 0,
              pageno: 1,
              total: submitted ? 1 : 0,
            },
            result: 200,
          },
          status: 200,
        }
      })
      const provider = new WestDigitalWriteAdapter({ transport })
      await expect(
        addCustomerDnsRecord(req, asset.id, ordinaryRecord('mismatch'), {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-confirm-mismatch-${fieldSlug}`,
        }),
      ).resolves.toMatchObject({ data: { status: 'pending_query' }, state: 'degraded' })
      expect(transport.writeCount).toBe(1)
    },
  )

  it('does not confirm pause when the provider keeps the record enabled', async () => {
    const { asset, customer, req } = await createFixture('pause-not-confirmed')
    const transport = new FixtureWestDigitalWriteTransport((input) => {
      const clientid = `${fixturePrefix}-${input.requestId}`
      if (input.operation === 'dns_record_pause') {
        return { body: { clientid, result: 200 }, status: 200 }
      }
      return {
        body: {
          clientid,
          data: {
            items: [
              {
                id: 151,
                item: 'pause-not-confirmed',
                level: 10,
                line: '',
                pause: 0,
                ttl: 600,
                type: 'A',
                value: '192.0.2.151',
              },
            ],
            limit: 100,
            pagecount: 1,
            pageno: 1,
            total: 1,
          },
          result: 200,
        },
        status: 200,
      }
    })
    const provider = new WestDigitalWriteAdapter({ transport })
    await expect(
      setCustomerDnsRecordPaused(
        req,
        asset.id,
        '151',
        { idempotencyKey: randomUUID(), paused: true },
        {
          customer: customerIdentity(customer.id),
          provider,
          traceId: `${fixturePrefix}-pause-not-confirmed`,
        },
      ),
    ).resolves.toMatchObject({ data: { status: 'pending_query' }, state: 'degraded' })
    expect(transport.writeCount).toBe(1)
  })

  it('rejects NS changes without a valid nameserver step-up grant', async () => {
    const { asset, customer, req } = await createFixture('ns-step-up')
    await expect(
      requestCustomerNameserverChange(
        req,
        asset.id,
        {
          confirmed: true,
          deviceId: `missing-device-${randomUUID()}`,
          nameservers: ['ns1.after.example', 'ns2.after.example'],
          stepUpToken: 'A'.repeat(43),
        },
        { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-ns-step-up` },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID', status: 403 })
    const changes = await payload.find({
      collection: 'nameserverChanges',
      limit: 1,
      overrideAccess: true,
      where: { and: [{ asset: { equals: asset.id } }, { customer: { equals: customer.id } }] },
    })
    expect(changes.totalDocs).toBe(0)
  })

  it('rejects NS changes without secondary confirmation even with a valid grant', async () => {
    const { asset, customer, req } = await createFixture('ns-confirmation')
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'nameserver_change',
    )
    await expect(
      requestCustomerNameserverChange(
        req,
        asset.id,
        {
          ...grant,
          confirmed: false,
          nameservers: ['ns1.after.example', 'ns2.after.example'],
        } as never,
        { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-ns-confirmation` },
      ),
    ).rejects.toMatchObject({ code: 'NAMESERVER_CONFIRMATION_REQUIRED', status: 400 })
    const changes = await payload.find({
      collection: 'nameserverChanges',
      limit: 1,
      overrideAccess: true,
      where: { and: [{ asset: { equals: asset.id } }, { customer: { equals: customer.id } }] },
    })
    expect(changes.totalDocs).toBe(0)
  })

  it('rejects NS changes during the identity-risk cooldown even with a valid grant', async () => {
    const { asset, customer, req } = await createFixture('ns-cooldown', { cooldown: true })
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      Number(customer.id),
      'nameserver_change',
    )
    await expect(
      requestCustomerNameserverChange(
        req,
        asset.id,
        { ...grant, confirmed: true, nameservers: ['ns1.after.example', 'ns2.after.example'] },
        { customer: customerIdentity(customer.id), traceId: `${fixturePrefix}-ns-cooldown` },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE', status: 403 })
    const changes = await payload.find({
      collection: 'nameserverChanges',
      limit: 1,
      overrideAccess: true,
      where: { and: [{ asset: { equals: asset.id } }, { customer: { equals: customer.id } }] },
    })
    expect(changes.totalDocs).toBe(0)
  })
})
