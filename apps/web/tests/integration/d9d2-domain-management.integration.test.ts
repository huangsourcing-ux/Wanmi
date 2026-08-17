import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { protectedIdentifier, identityProviderInstance } from '@/services/auth/customer-identities'
import {
  downloadDomainCertificate,
  getDomainCapabilityDeclaration,
  modifyDomainManagementPassword,
  revealDomainManagementPassword,
  transferDomainToApprovedTemplate,
  updateDomainContactInformation,
} from '@/services/domains/domain-management'
import { syncCustomerDomainAsset } from '@/services/domains/domain-assets'
import { addCustomerDnsRecord } from '@/services/domains/dns-records'
import {
  type DomainCapabilityDeclaration,
  type DomainCapabilityName,
  WESTDIGITAL_DOMAIN_CAPABILITIES,
} from '@/services/domains/capabilities'
import { FixtureWestDigitalWriteTransport } from '@/providers/westdigital-write-fixtures'
import {
  WestDigitalWriteAdapter,
  WestDigitalWriteTransportError,
  type WestDigitalWriteTransportRequest,
} from '@/providers/westdigital-write'
import { submitRealnameTemplate, syncRealnameTemplateStatus } from '@/services/realname/templates'

import { approvedRealnameProviderFixture, realnameTemplateFixture } from '../fixtures/realname'
import { issueStepUpGrantFixture } from '../fixtures/step-up'
import { ignorePayloadNotFound } from '../test-cleanup'

const fixturePrefix = `d9d2-domain-${randomUUID()}`
const assetIds: Array<number | string> = []
const customerIds: Array<number | string> = []
const identityIds: Array<number | string> = []
const templateIds: Array<number | string> = []
let payload: Payload

type Ownership = 'not_owned' | 'owned' | 'unavailable'

function customerIdentity(customerId: number | string, status = 'active') {
  return { collection: 'customers' as const, id: customerId, status }
}

function hash(value: string): number {
  let result = 0
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) % 100_000_000
  return result
}

async function requestFor(
  customer: { id: number | string; status?: null | string },
  suffix: string,
): Promise<PayloadRequest> {
  const req = await createLocalReq(
    {
      req: {
        headers: new Headers({
          'user-agent': `Wanmi-D9D2/${suffix}`,
          'x-forwarded-for': '198.51.100.52',
          'x-request-id': `${fixturePrefix}-${suffix}`,
        }),
      },
    },
    payload,
  )
  req.user = { ...customer, collection: 'customers' } as never
  return req
}

async function systemRequest(suffix: string): Promise<PayloadRequest> {
  return createLocalReq(
    {
      req: {
        headers: new Headers({
          'user-agent': `Wanmi-D9D2-System/${suffix}`,
          'x-forwarded-for': '198.51.100.53',
          'x-request-id': `${fixturePrefix}-system-${suffix}`,
        }),
      },
    },
    payload,
  )
}

async function createCustomer(
  suffix: string,
  options: {
    capabilityRestrictions?: string[]
    cooldown?: boolean
    identities?: Array<'phone' | 'wechat'>
  } = {},
) {
  const phone = `+86139${String(hash(`${fixturePrefix}-${suffix}`)).padStart(8, '0')}`
  const customer = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: options.capabilityRestrictions ?? [],
      identityRiskCooldownStartedAt: options.cooldown ? new Date().toISOString() : undefined,
      phone,
      phoneMasked: `+86139****${phone.slice(-4)}`,
      status: options.capabilityRestrictions?.length ? 'restricted' : 'active',
    },
    overrideAccess: true,
  })
  customerIds.push(customer.id)
  for (const provider of options.identities ?? []) {
    const identifier = provider === 'phone' ? phone : `${fixturePrefix}-openid-${suffix}`
    const protectedValue = protectedIdentifier(identifier)
    const identity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedValue,
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

async function createTemplate(
  customer: { id: number | string; status?: null | string },
  suffix: string,
  approved = true,
) {
  const req = await requestFor(customer, `${suffix}-template`)
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `D9D2-${suffix}-${randomUUID().slice(0, 8)}` }),
      customer: Number(customer.id),
    },
    overrideAccess: true,
  })
  templateIds.push(template.id)
  if (!approved) {
    return {
      ...template,
      id: Number(template.id),
      providerTemplateId: template.providerTemplateId ?? null,
    }
  }
  const providerTemplateId = String(2_000_000 + Number(template.id))
  await submitRealnameTemplate(
    req,
    template.id,
    approvedRealnameProviderFixture(providerTemplateId),
  )
  const approvedTemplate = await syncRealnameTemplateStatus(
    await systemRequest(`${suffix}-template-sync`),
    template.id,
    approvedRealnameProviderFixture(providerTemplateId),
  )
  return {
    ...approvedTemplate,
    id: Number(approvedTemplate.id),
    providerTemplateId: approvedTemplate.providerTemplateId ?? null,
  }
}

async function createFixture(
  suffix: string,
  options: {
    capabilityRestrictions?: string[]
    cooldown?: boolean
    identities?: Array<'phone' | 'wechat'>
  } = {},
) {
  const customer = await createCustomer(suffix, options)
  const template = await createTemplate(customer, `${suffix}-base`)
  const asset = await payload.create({
    collection: 'domainAssets',
    data: {
      customer: Number(customer.id),
      domainAscii: `${suffix}-${randomUUID().slice(0, 8)}.example`,
      expiresAt: '2028-08-17T04:00:00.000Z',
      lastSyncedAt: '2026-08-17T04:00:00.000Z',
      nameservers: ['ns1.before.example', 'ns2.before.example'],
      realnameTemplate: Number(template.id),
      registeredAt: '2026-08-17T04:00:00.000Z',
      registrar: 'west',
      status: 'active',
      syncReviewStatus: 'none',
      syncVersion: 0,
      upstreamOwnershipStatus: 'unknown',
    },
    overrideAccess: true,
  })
  assetIds.push(asset.id)
  return {
    asset: { ...asset, id: Number(asset.id) },
    customer,
    req: await requestFor(customer, suffix),
    template,
  }
}

function ownedAssetResponse(input: WestDigitalWriteTransportRequest) {
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
        expdate: '2028-08-17 12:00:00',
        id: '44169980',
        regdate: '2026-08-17 12:00:00',
        registrars: 'west',
      },
      result: 200,
    },
    status: 200,
  }
}

function managedProvider(
  options: {
    certificate?: string
    managementPassword?: string
    onRequest?: (input: WestDigitalWriteTransportRequest) => Promise<void> | void
    ownership?: Ownership
  } = {},
) {
  let managementPassword = options.managementPassword ?? 'D9D2-Initial-Secret'
  let providerTemplateId = '2000001'
  const transport = new FixtureWestDigitalWriteTransport(async (input) => {
    await options.onRequest?.(input)
    const clientid = `${fixturePrefix}-${input.requestId}`
    if (input.operation === 'asset_query') {
      if (options.ownership === 'not_owned') {
        return { body: { clientid, result: 404 }, status: 200 }
      }
      if (options.ownership === 'unavailable') {
        throw new WestDigitalWriteTransportError('TEMPORARILY_UNAVAILABLE', 'not_submitted')
      }
      return ownedAssetResponse(input)
    }
    if (input.operation === 'domain_management_password_get') {
      return {
        body: { clientid, data: { domainpwd: managementPassword }, result: 200 },
        status: 200,
      }
    }
    if (input.operation === 'domain_management_password_modify') {
      managementPassword = input.body.domainpwd!
      return { body: { clientid, result: 200 }, status: 200 }
    }
    if (input.operation === 'domain_contact_update') {
      return { body: { clientid, data: {}, result: 200 }, status: 200 }
    }
    if (input.operation === 'domain_template_transfer') {
      providerTemplateId = input.body.c_sysid!
      return { body: { clientid, data: {}, result: 200 }, status: 200 }
    }
    if (input.operation === 'domain_information_query') {
      return {
        body: {
          clientid,
          data: { c_sysid: Number(providerTemplateId), domain: input.body.domain },
          result: 200,
        },
        status: 200,
      }
    }
    if (input.operation === 'domain_certificate_get') {
      return {
        body: {
          clientid,
          data: {
            certurl: options.certificate ?? Buffer.from('fixture-certificate').toString('base64'),
          },
          result: 200,
        },
        status: 200,
      }
    }
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
    if (input.operation === 'dns_record_add') {
      return { body: { clientid, data: { id: 901 }, result: 200 }, status: 200 }
    }
    throw new Error(`Unexpected fixture operation ${input.operation}`)
  })
  return { provider: new WestDigitalWriteAdapter({ transport }), transport }
}

async function passwordGrant(req: PayloadRequest, customerId: number | string) {
  return issueStepUpGrantFixture(payload, req, Number(customerId), 'domain_management_password')
}

async function realnameGrant(req: PayloadRequest, customerId: number | string) {
  return issueStepUpGrantFixture(payload, req, Number(customerId), 'realname_change')
}

async function settle<T>(work: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await work() }
  } catch (reason) {
    return { reason, status: 'rejected' }
  }
}

function withoutCapability(name: DomainCapabilityName): DomainCapabilityDeclaration {
  return {
    ...WESTDIGITAL_DOMAIN_CAPABILITIES,
    [name]: { ...WESTDIGITAL_DOMAIN_CAPABILITIES[name], supported: false },
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
      'DELETE FROM domain_asset_sync_events WHERE customer_id = ANY($1::int[])',
      [customerIds.map(Number)],
    )
    await payload.db.pool.query(
      'DELETE FROM customer_security_events WHERE customer_id = ANY($1::int[])',
      [customerIds.map(Number)],
    )
    await payload.db.pool.query(
      'DELETE FROM dns_record_changes WHERE customer_id = ANY($1::int[])',
      [customerIds.map(Number)],
    )
    await payload.db.pool.query(
      "DELETE FROM provider_operations WHERE target_id = ANY($1::text[]) AND operation::text IN ('domain_management_password', 'domain_contact_update', 'domain_template_transfer', 'dns_record_add')",
      [assetIds.map(String)],
    )
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 1_000,
    overrideAccess: true,
    where: { traceId: { contains: fixturePrefix } },
  })
  for (const audit of audits.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true }),
    )
  }
  for (const identityId of identityIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'customerIdentities', id: identityId, overrideAccess: true }),
    )
  }
  const grants = await payload.find({
    collection: 'stepUpGrants',
    limit: 1_000,
    overrideAccess: true,
    where: { customer: { in: customerIds } },
  })
  for (const grant of grants.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'stepUpGrants', id: grant.id, overrideAccess: true }),
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
  await payload.db.destroy?.()
}, 90_000)

describe('D9-D-2 domain management, synchronization, and capabilities', () => {
  it('rejects password read and write independently without step-up or an active bound channel', async () => {
    const withChannel = await createFixture('password-risk-stepup', { identities: ['phone'] })
    const noChannel = await createFixture('password-risk-channel')
    const provider = managedProvider()
    const missingGrant = {
      deviceId: `missing-device-${randomUUID()}`,
      stepUpToken: 'A'.repeat(43),
    }
    const missingStepUp = [
      await settle(() =>
        revealDomainManagementPassword(withChannel.req, withChannel.asset.id, missingGrant, {
          customer: customerIdentity(withChannel.customer.id),
          provider: provider.provider,
          traceId: `${fixturePrefix}-password-risk-stepup-read`,
        }),
      ),
      await settle(() =>
        modifyDomainManagementPassword(
          withChannel.req,
          withChannel.asset.id,
          {
            ...missingGrant,
            idempotencyKey: randomUUID(),
            managementPassword: 'MissingStepUp12',
          },
          {
            customer: customerIdentity(withChannel.customer.id),
            provider: provider.provider,
            traceId: `${fixturePrefix}-password-risk-stepup-write`,
          },
        ),
      ),
    ]
    expect(
      missingStepUp.every(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: string }).code === 'STEP_UP_GRANT_INVALID',
      ),
    ).toBe(true)
    const readGrant = await passwordGrant(noChannel.req, noChannel.customer.id)
    const writeGrant = await passwordGrant(noChannel.req, noChannel.customer.id)
    const missingChannel = [
      await settle(() =>
        revealDomainManagementPassword(noChannel.req, noChannel.asset.id, readGrant, {
          customer: customerIdentity(noChannel.customer.id),
          provider: provider.provider,
          traceId: `${fixturePrefix}-password-risk-channel-read`,
        }),
      ),
      await settle(() =>
        modifyDomainManagementPassword(
          noChannel.req,
          noChannel.asset.id,
          {
            ...writeGrant,
            idempotencyKey: randomUUID(),
            managementPassword: 'MissingChannel12',
          },
          {
            customer: customerIdentity(noChannel.customer.id),
            provider: provider.provider,
            traceId: `${fixturePrefix}-password-risk-channel-write`,
          },
        ),
      ),
    ]
    expect(
      missingChannel.every(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: string }).code ===
            'DOMAIN_BOUND_CHANNEL_CONFIRMATION_REQUIRED',
      ),
    ).toBe(true)
    expect(provider.transport.requests).toHaveLength(0)
  })

  it('returns password plaintext once, notifies every active provider, and never persists or logs the value', async () => {
    const fixture = await createFixture('password-secret', { identities: ['phone', 'wechat'] })
    const secret = `D9D2-Secret-${randomUUID()}`
    const nextSecret = `D9D2-Next-${randomUUID()}`
    const managed = managedProvider({ managementPassword: secret })
    const loggerCalls: unknown[] = []
    const spies = (['debug', 'error', 'info', 'warn'] as const).map((level) =>
      vi
        .spyOn(fixture.req.payload.logger, level)
        .mockImplementation(((...values: unknown[]) =>
          loggerCalls.push([level, ...values])) as never),
    )
    try {
      const revealGrant = await passwordGrant(fixture.req, fixture.customer.id)
      const revealed = await revealDomainManagementPassword(
        fixture.req,
        fixture.asset.id,
        revealGrant,
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-password-secret-reveal`,
        },
      )
      expect(revealed).toMatchObject({ data: { managementPassword: secret }, state: 'ready' })
      const modifyGrant = await passwordGrant(fixture.req, fixture.customer.id)
      const modified = await modifyDomainManagementPassword(
        fixture.req,
        fixture.asset.id,
        {
          ...modifyGrant,
          idempotencyKey: randomUUID(),
          managementPassword: nextSecret,
        },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-password-secret-modify`,
        },
      )
      expect(modified).toMatchObject({ data: { status: 'succeeded' }, state: 'ready' })
      expect(modified).not.toHaveProperty('data.managementPassword')
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    const [audits, events, operations, notifications] = await Promise.all([
      payload.find({
        collection: 'auditLogs',
        limit: 100,
        overrideAccess: true,
        where: { traceId: { equals: `${fixturePrefix}-password-secret` } },
      }),
      payload.find({
        collection: 'domainManagementEvents',
        limit: 100,
        overrideAccess: true,
        where: {
          and: [
            { asset: { equals: fixture.asset.id } },
            { customer: { equals: fixture.customer.id } },
            { operation: { in: ['management_password_read', 'management_password_modify'] } },
          ],
        },
      }),
      payload.find({
        collection: 'providerOperations',
        limit: 20,
        overrideAccess: true,
        where: {
          and: [
            { operation: { equals: 'domain_management_password' } },
            { targetId: { equals: String(fixture.asset.id) } },
          ],
        },
      }),
      payload.find({
        collection: 'customerSecurityEvents',
        limit: 20,
        overrideAccess: true,
        where: {
          and: [
            { customer: { equals: fixture.customer.id } },
            { event: { equals: 'identity_change_notification' } },
          ],
        },
      }),
    ])
    const persisted = JSON.stringify({
      audits: audits.docs,
      events: events.docs,
      operations: operations.docs,
    })
    expect(audits.totalDocs).toBeGreaterThan(0)
    expect(events.totalDocs).toBe(4)
    expect(operations.totalDocs).toBe(1)
    expect(persisted).not.toContain(secret)
    expect(persisted).not.toContain(nextSecret)
    expect(JSON.stringify(loggerCalls)).not.toContain(secret)
    expect(JSON.stringify(loggerCalls)).not.toContain(nextSecret)
    expect(notifications.totalDocs).toBe(4)
    expect(
      notifications.docs
        .map((event) => event.safeMetadata)
        .map((metadata) => ({
          outcome: (metadata as { outcome?: unknown })?.outcome,
          provider: (metadata as { provider?: unknown })?.provider,
        })),
    ).toEqual(
      expect.arrayContaining([
        { outcome: 'sent', provider: 'phone' },
        { outcome: 'sent', provider: 'wechat' },
      ]),
    )
  })

  it('does not let a notification delivery failure roll back a completed password read', async () => {
    const fixture = await createFixture('password-notification-failure', { identities: ['phone'] })
    const grant = await passwordGrant(fixture.req, fixture.customer.id)
    const provider = managedProvider({ managementPassword: 'D9D2-Readable-After-Notice-Failure' })
    await payload.db.pool.query(
      'UPDATE customer_identities SET identifier_encrypted = $1 WHERE id = $2 AND customer_id = $3',
      ['invalid-encrypted-fixture', identityIds.at(-1), fixture.customer.id],
    )
    await expect(
      revealDomainManagementPassword(fixture.req, fixture.asset.id, grant, {
        customer: customerIdentity(fixture.customer.id),
        provider: provider.provider,
        traceId: `${fixturePrefix}-password-notification-failure`,
      }),
    ).resolves.toMatchObject({
      data: { managementPassword: 'D9D2-Readable-After-Notice-Failure' },
      state: 'ready',
    })
    const outcomes = await payload.find({
      collection: 'customerSecurityEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: fixture.customer.id } },
          { event: { equals: 'identity_change_notification' } },
        ],
      },
    })
    expect(outcomes.totalDocs).toBe(1)
    expect(outcomes.docs[0]?.safeMetadata).toMatchObject({ outcome: 'failed', provider: 'phone' })
  })

  it('rejects contact and transfer independently for foreign, unapproved, missing-step-up, and unconfirmed targets', async () => {
    const fixture = await createFixture('transfer-guards')
    const other = await createCustomer('transfer-foreign-owner')
    const foreign = await createTemplate(other, 'transfer-foreign')
    const draft = await createTemplate(fixture.customer, 'transfer-draft', false)
    const approved = await createTemplate(fixture.customer, 'transfer-approved')
    const managed = managedProvider()
    const contactForeignGrant = await realnameGrant(fixture.req, fixture.customer.id)
    await expect(
      updateDomainContactInformation(
        fixture.req,
        fixture.asset.id,
        {
          ...contactForeignGrant,
          confirmed: true,
          contactType: 'dom_id',
          idempotencyKey: randomUUID(),
          templateId: foreign.id,
        },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-contact-foreign`,
        },
      ),
    ).rejects.toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_OWNED', status: 409 })
    const contactDraftGrant = await realnameGrant(fixture.req, fixture.customer.id)
    await expect(
      updateDomainContactInformation(
        fixture.req,
        fixture.asset.id,
        {
          ...contactDraftGrant,
          confirmed: true,
          contactType: 'dom_id',
          idempotencyKey: randomUUID(),
          templateId: draft.id,
        },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-contact-draft`,
        },
      ),
    ).rejects.toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_APPROVED', status: 409 })
    await expect(
      updateDomainContactInformation(
        fixture.req,
        fixture.asset.id,
        {
          confirmed: true,
          contactType: 'dom_id',
          deviceId: `missing-contact-device-${randomUUID()}`,
          idempotencyKey: randomUUID(),
          stepUpToken: 'A'.repeat(43),
          templateId: approved.id,
        },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-contact-stepup`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID', status: 403 })
    const contactConfirmationGrant = await realnameGrant(fixture.req, fixture.customer.id)
    await expect(
      updateDomainContactInformation(
        fixture.req,
        fixture.asset.id,
        {
          ...contactConfirmationGrant,
          confirmed: false as true,
          contactType: 'dom_id',
          idempotencyKey: randomUUID(),
          templateId: approved.id,
        },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-contact-confirmation`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_REALNAME_CONFIRMATION_REQUIRED', status: 400 })
    const foreignGrant = await realnameGrant(fixture.req, fixture.customer.id)
    await expect(
      transferDomainToApprovedTemplate(
        fixture.req,
        fixture.asset.id,
        { ...foreignGrant, confirmed: true, idempotencyKey: randomUUID(), templateId: foreign.id },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-transfer-foreign`,
        },
      ),
    ).rejects.toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_OWNED', status: 409 })
    const draftGrant = await realnameGrant(fixture.req, fixture.customer.id)
    await expect(
      transferDomainToApprovedTemplate(
        fixture.req,
        fixture.asset.id,
        { ...draftGrant, confirmed: true, idempotencyKey: randomUUID(), templateId: draft.id },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-transfer-draft`,
        },
      ),
    ).rejects.toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_APPROVED', status: 409 })
    await expect(
      transferDomainToApprovedTemplate(
        fixture.req,
        fixture.asset.id,
        {
          confirmed: true,
          deviceId: `missing-device-${randomUUID()}`,
          idempotencyKey: randomUUID(),
          stepUpToken: 'A'.repeat(43),
          templateId: approved.id,
        },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-transfer-stepup`,
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID', status: 403 })
    const confirmationGrant = await realnameGrant(fixture.req, fixture.customer.id)
    await expect(
      transferDomainToApprovedTemplate(
        fixture.req,
        fixture.asset.id,
        {
          ...confirmationGrant,
          confirmed: false as true,
          idempotencyKey: randomUUID(),
          templateId: approved.id,
        },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-transfer-confirmation`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_REALNAME_CONFIRMATION_REQUIRED', status: 400 })
    expect(managed.transport.writeCount).toBe(0)
  })

  it('requires every coupled approval fact before a realname template can change a domain', async () => {
    const fixture = await createFixture('template-approval-coupling')
    const managed = managedProvider()
    const cases = [
      { column: 'status', suffix: 'status', value: 'draft' },
      { column: 'provider_review_state', suffix: 'review', value: 'pending' },
      { column: 'provider_confirmed_at', suffix: 'confirmation', value: null },
      { column: 'provider_template_id', suffix: 'provider-id', value: 'not-numeric' },
    ] as const
    const attempts: Array<PromiseSettledResult<unknown>> = []
    for (const candidate of cases) {
      const template = await createTemplate(
        fixture.customer,
        `template-approval-${candidate.suffix}`,
      )
      await payload.db.pool.query(
        `UPDATE realname_templates SET ${candidate.column} = $1 WHERE id = $2`,
        [candidate.value, template.id],
      )
      const grant = await realnameGrant(fixture.req, fixture.customer.id)
      attempts.push(
        await settle(() =>
          updateDomainContactInformation(
            fixture.req,
            fixture.asset.id,
            {
              ...grant,
              confirmed: true,
              contactType: 'dom_id',
              idempotencyKey: randomUUID(),
              templateId: template.id,
            },
            {
              customer: customerIdentity(fixture.customer.id),
              provider: managed.provider,
              traceId: `${fixturePrefix}-template-approval-${candidate.suffix}`,
            },
          ),
        ),
      )
    }
    expect(
      attempts.map((result) =>
        result.status === 'rejected' ? (result.reason as { code?: string }).code : 'fulfilled',
      ),
    ).toEqual(Array.from({ length: cases.length }, () => 'REALNAME_TEMPLATE_NOT_APPROVED'))
    expect(managed.transport.writeCount).toBe(0)
  })

  it('updates one documented contact role and transfers only to an owned approved template', async () => {
    const fixture = await createFixture('contact-transfer-success')
    const target = await createTemplate(fixture.customer, 'contact-transfer-target')
    const contactGrant = await realnameGrant(fixture.req, fixture.customer.id)
    const transferGrant = await realnameGrant(fixture.req, fixture.customer.id)
    const managed = managedProvider()
    await expect(
      updateDomainContactInformation(
        fixture.req,
        fixture.asset.id,
        {
          ...contactGrant,
          confirmed: true,
          contactType: 'dom_id',
          idempotencyKey: randomUUID(),
          templateId: target.id,
        },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-contact-success`,
        },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' }, state: 'ready' })
    await expect(
      transferDomainToApprovedTemplate(
        fixture.req,
        fixture.asset.id,
        {
          ...transferGrant,
          confirmed: true,
          idempotencyKey: randomUUID(),
          templateId: target.id,
        },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-transfer-success`,
        },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' }, state: 'ready' })
    const updated = await payload.findByID({
      collection: 'domainAssets',
      id: fixture.asset.id,
      overrideAccess: true,
    })
    expect(
      String(
        typeof updated.realnameTemplate === 'object'
          ? updated.realnameTemplate.id
          : updated.realnameTemplate,
      ),
    ).toBe(String(target.id))
    expect(updated.syncVersion).toBe(1)
    const requests = managed.transport.requests.filter((request) =>
      ['domain_contact_update', 'domain_template_transfer'].includes(request.operation),
    )
    expect(requests).toHaveLength(2)
    expect(requests[0]?.body).toMatchObject({ act: 'domainmodisub', eppidtype: 'dom_id' })
    expect(requests[1]?.body).toMatchObject({
      act: 'auditghsub',
      c_sysid: String(target.providerTemplateId),
      eppidtype: 'dom_id,admin_id,tech_id,bill_id',
    })
  })

  it('keeps certificate download at current-session risk while auditing and returning bytes', async () => {
    const fixture = await createFixture('certificate-session')
    const managed = managedProvider({
      certificate: Buffer.from('D9D2 certificate').toString('base64'),
    })
    await expect(
      downloadDomainCertificate(fixture.req, fixture.asset.id, {
        customer: customerIdentity(fixture.customer.id),
        provider: managed.provider,
        traceId: `${fixturePrefix}-certificate-session`,
      }),
    ).resolves.toMatchObject({ domainAscii: fixture.asset.domainAscii })
    const events = await payload.find({
      collection: 'domainManagementEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { asset: { equals: fixture.asset.id } },
          { customer: { equals: fixture.customer.id } },
          { operation: { equals: 'certificate_download' } },
        ],
      },
    })
    expect(events.totalDocs).toBe(2)
    expect(events.docs.map((event) => event.event).sort()).toEqual(['confirmed', 'requested'])
  })

  it('rejects a non-base64 certificate body before returning or confirming it', async () => {
    const fixture = await createFixture('certificate-invalid')
    const managed = managedProvider({ certificate: 'not-a-base64-certificate!' })
    await expect(
      downloadDomainCertificate(fixture.req, fixture.asset.id, {
        customer: customerIdentity(fixture.customer.id),
        provider: managed.provider,
        traceId: `${fixturePrefix}-certificate-invalid`,
      }),
    ).rejects.toMatchObject({ code: 'WESTDIGITAL_CERTIFICATE_INVALID', status: 503 })
    const events = await payload.find({
      collection: 'domainManagementEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { asset: { equals: fixture.asset.id } },
          { customer: { equals: fixture.customer.id } },
          { operation: { equals: 'certificate_download' } },
        ],
      },
    })
    expect(events.totalDocs).toBe(1)
    expect(events.docs[0]?.event).toBe('requested')
  })

  it('returns dedicated capability errors at every implemented capability call point', async () => {
    const fixture = await createFixture('capability-errors')
    const managed = managedProvider()
    const attempts = [
      await settle(() =>
        syncCustomerDomainAsset(fixture.req, fixture.asset.id, {
          capabilities: withoutCapability('asset_sync'),
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-capability-sync`,
        }),
      ),
      await settle(() =>
        downloadDomainCertificate(fixture.req, fixture.asset.id, {
          capabilities: withoutCapability('certificate_download'),
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-capability-certificate`,
        }),
      ),
      await settle(() =>
        updateDomainContactInformation(
          fixture.req,
          fixture.asset.id,
          {
            confirmed: true,
            contactType: 'dom_id',
            deviceId: 'capability-device-001',
            idempotencyKey: randomUUID(),
            stepUpToken: 'A'.repeat(43),
            templateId: fixture.template.id,
          },
          {
            capabilities: withoutCapability('contact_information_update'),
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-capability-contact`,
          },
        ),
      ),
      await settle(() =>
        revealDomainManagementPassword(
          fixture.req,
          fixture.asset.id,
          { deviceId: 'capability-device-002', stepUpToken: 'A'.repeat(43) },
          {
            capabilities: withoutCapability('management_password_read'),
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-capability-password-read`,
          },
        ),
      ),
      await settle(() =>
        modifyDomainManagementPassword(
          fixture.req,
          fixture.asset.id,
          {
            deviceId: 'capability-device-003',
            idempotencyKey: randomUUID(),
            managementPassword: 'NeverWritten12',
            stepUpToken: 'A'.repeat(43),
          },
          {
            capabilities: withoutCapability('management_password_write'),
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-capability-password-write`,
          },
        ),
      ),
      await settle(() =>
        transferDomainToApprovedTemplate(
          fixture.req,
          fixture.asset.id,
          {
            confirmed: true,
            deviceId: 'capability-device-004',
            idempotencyKey: randomUUID(),
            stepUpToken: 'A'.repeat(43),
            templateId: fixture.template.id,
          },
          {
            capabilities: withoutCapability('template_transfer'),
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-capability-transfer`,
          },
        ),
      ),
    ]
    expect(
      attempts.map((result) =>
        result.status === 'rejected' ? (result.reason as { code?: string }).code : 'fulfilled',
      ),
    ).toEqual([
      'DOMAIN_CAPABILITY_ASSET_SYNC_UNSUPPORTED',
      'DOMAIN_CAPABILITY_CERTIFICATE_DOWNLOAD_UNSUPPORTED',
      'DOMAIN_CAPABILITY_CONTACT_INFORMATION_UPDATE_UNSUPPORTED',
      'DOMAIN_CAPABILITY_MANAGEMENT_PASSWORD_READ_UNSUPPORTED',
      'DOMAIN_CAPABILITY_MANAGEMENT_PASSWORD_WRITE_UNSUPPORTED',
      'DOMAIN_CAPABILITY_TEMPLATE_TRANSFER_UNSUPPORTED',
    ])
    expect(managed.transport.requests).toHaveLength(0)
  })

  it('applies A3 domain-write restrictions at every management operation call point', async () => {
    const fixture = await createFixture('a3-all', {
      capabilityRestrictions: ['domain_write_disabled'],
      identities: ['phone'],
    })
    const target = await createTemplate(fixture.customer, 'a3-target')
    const managed = managedProvider()
    const attempts = await Promise.allSettled([
      revealDomainManagementPassword(
        fixture.req,
        fixture.asset.id,
        { deviceId: 'a3-device-missing-0001', stepUpToken: 'A'.repeat(43) },
        {
          customer: customerIdentity(fixture.customer.id, 'restricted'),
          provider: managed.provider,
          traceId: `${fixturePrefix}-a3-read`,
        },
      ),
      modifyDomainManagementPassword(
        fixture.req,
        fixture.asset.id,
        {
          deviceId: 'a3-device-missing-0002',
          idempotencyKey: randomUUID(),
          managementPassword: 'NeverWritten12',
          stepUpToken: 'A'.repeat(43),
        },
        {
          customer: customerIdentity(fixture.customer.id, 'restricted'),
          provider: managed.provider,
          traceId: `${fixturePrefix}-a3-password-write`,
        },
      ),
      updateDomainContactInformation(
        fixture.req,
        fixture.asset.id,
        {
          confirmed: true,
          contactType: 'dom_id',
          deviceId: 'a3-device-missing-0003',
          idempotencyKey: randomUUID(),
          stepUpToken: 'A'.repeat(43),
          templateId: target.id,
        },
        {
          customer: customerIdentity(fixture.customer.id, 'restricted'),
          provider: managed.provider,
          traceId: `${fixturePrefix}-a3-contact`,
        },
      ),
      transferDomainToApprovedTemplate(
        fixture.req,
        fixture.asset.id,
        {
          confirmed: true,
          deviceId: 'a3-device-missing-0004',
          idempotencyKey: randomUUID(),
          stepUpToken: 'A'.repeat(43),
          templateId: target.id,
        },
        {
          customer: customerIdentity(fixture.customer.id, 'restricted'),
          provider: managed.provider,
          traceId: `${fixturePrefix}-a3-transfer`,
        },
      ),
      downloadDomainCertificate(fixture.req, fixture.asset.id, {
        customer: customerIdentity(fixture.customer.id, 'restricted'),
        provider: managed.provider,
        traceId: `${fixturePrefix}-a3-certificate`,
      }),
    ])
    expect(attempts).toHaveLength(5)
    expect(
      attempts.every(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: string }).code === 'ACCOUNT_DOMAIN_WRITE_DISABLED',
      ),
    ).toBe(true)
    expect(managed.transport.requests).toHaveLength(0)
  })

  it('enforces local asset ownership at every management, synchronization, and declaration call point', async () => {
    const owner = await createFixture('local-owner')
    const other = await createFixture('local-other')
    const managed = managedProvider()
    const attempts = [
      await settle(() =>
        revealDomainManagementPassword(
          owner.req,
          other.asset.id,
          { deviceId: 'ownership-device-001', stepUpToken: 'A'.repeat(43) },
          {
            customer: customerIdentity(owner.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-local-owner-password-read`,
          },
        ),
      ),
      await settle(() =>
        modifyDomainManagementPassword(
          owner.req,
          other.asset.id,
          {
            deviceId: 'ownership-device-002',
            idempotencyKey: randomUUID(),
            managementPassword: 'NeverWritten12',
            stepUpToken: 'A'.repeat(43),
          },
          {
            customer: customerIdentity(owner.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-local-owner-password-write`,
          },
        ),
      ),
      await settle(() =>
        updateDomainContactInformation(
          owner.req,
          other.asset.id,
          {
            confirmed: true,
            contactType: 'dom_id',
            deviceId: 'ownership-device-003',
            idempotencyKey: randomUUID(),
            stepUpToken: 'A'.repeat(43),
            templateId: owner.template.id,
          },
          {
            customer: customerIdentity(owner.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-local-owner-contact`,
          },
        ),
      ),
      await settle(() =>
        transferDomainToApprovedTemplate(
          owner.req,
          other.asset.id,
          {
            confirmed: true,
            deviceId: 'ownership-device-004',
            idempotencyKey: randomUUID(),
            stepUpToken: 'A'.repeat(43),
            templateId: owner.template.id,
          },
          {
            customer: customerIdentity(owner.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-local-owner-transfer`,
          },
        ),
      ),
      await settle(() =>
        downloadDomainCertificate(owner.req, other.asset.id, {
          customer: customerIdentity(owner.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-local-owner-certificate`,
        }),
      ),
      await settle(() =>
        syncCustomerDomainAsset(owner.req, other.asset.id, {
          customer: customerIdentity(owner.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-local-owner-sync`,
        }),
      ),
      await settle(() =>
        getDomainCapabilityDeclaration(owner.req, other.asset.id, {
          customer: customerIdentity(owner.customer.id),
        }),
      ),
    ]
    expect(attempts).toHaveLength(7)
    expect(
      attempts.every(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: string }).code === 'DOMAIN_ASSET_NOT_FOUND',
      ),
    ).toBe(true)
    expect(managed.transport.requests).toHaveLength(0)
  })

  it('blocks every slice operation and an existing DNS write when upstream ownership is absent', async () => {
    const fixture = await createFixture('ownership-all', { identities: ['phone'] })
    const target = await createTemplate(fixture.customer, 'ownership-target')
    const passwordReadGrant = await passwordGrant(fixture.req, fixture.customer.id)
    const passwordWriteGrant = await passwordGrant(fixture.req, fixture.customer.id)
    const contactGrant = await realnameGrant(fixture.req, fixture.customer.id)
    const transferGrant = await realnameGrant(fixture.req, fixture.customer.id)
    const managed = managedProvider({ ownership: 'not_owned' })
    const attempts = [
      await settle(() =>
        revealDomainManagementPassword(fixture.req, fixture.asset.id, passwordReadGrant, {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-ownership-read`,
        }),
      ),
      await settle(() =>
        modifyDomainManagementPassword(
          fixture.req,
          fixture.asset.id,
          {
            ...passwordWriteGrant,
            idempotencyKey: randomUUID(),
            managementPassword: 'BlockedSecret12',
          },
          {
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-password-write`,
          },
        ),
      ),
      await settle(() =>
        updateDomainContactInformation(
          fixture.req,
          fixture.asset.id,
          {
            ...contactGrant,
            confirmed: true,
            contactType: 'dom_id',
            idempotencyKey: randomUUID(),
            templateId: target.id,
          },
          {
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-contact`,
          },
        ),
      ),
      await settle(() =>
        transferDomainToApprovedTemplate(
          fixture.req,
          fixture.asset.id,
          {
            ...transferGrant,
            confirmed: true,
            idempotencyKey: randomUUID(),
            templateId: target.id,
          },
          {
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-transfer`,
          },
        ),
      ),
      await settle(() =>
        downloadDomainCertificate(fixture.req, fixture.asset.id, {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-ownership-certificate`,
        }),
      ),
      await settle(() =>
        addCustomerDnsRecord(
          fixture.req,
          fixture.asset.id,
          {
            host: 'www',
            idempotencyKey: randomUUID(),
            line: '默认',
            priority: 10,
            ttl: 600,
            type: 'A',
            value: '192.0.2.52',
          },
          {
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-dns`,
          },
        ),
      ),
    ]
    expect(attempts).toHaveLength(6)
    expect(
      attempts.every(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: string }).code === 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED',
      ),
    ).toBe(true)
    expect(managed.transport.writeCount).toBe(0)
  })

  it('fails every management write closed when upstream ownership cannot be queried', async () => {
    const fixture = await createFixture('ownership-unknown', { identities: ['phone'] })
    const target = await createTemplate(fixture.customer, 'ownership-unknown-target')
    const passwordWriteGrant = await passwordGrant(fixture.req, fixture.customer.id)
    const contactGrant = await realnameGrant(fixture.req, fixture.customer.id)
    const transferGrant = await realnameGrant(fixture.req, fixture.customer.id)
    const managed = managedProvider({ ownership: 'unavailable' })
    const attempts = [
      await settle(() =>
        modifyDomainManagementPassword(
          fixture.req,
          fixture.asset.id,
          {
            ...passwordWriteGrant,
            idempotencyKey: randomUUID(),
            managementPassword: 'UnknownSecret12',
          },
          {
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-unknown-password`,
          },
        ),
      ),
      await settle(() =>
        updateDomainContactInformation(
          fixture.req,
          fixture.asset.id,
          {
            ...contactGrant,
            confirmed: true,
            contactType: 'dom_id',
            idempotencyKey: randomUUID(),
            templateId: target.id,
          },
          {
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-unknown-contact`,
          },
        ),
      ),
      await settle(() =>
        transferDomainToApprovedTemplate(
          fixture.req,
          fixture.asset.id,
          {
            ...transferGrant,
            confirmed: true,
            idempotencyKey: randomUUID(),
            templateId: target.id,
          },
          {
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-unknown-transfer`,
          },
        ),
      ),
      await settle(() =>
        addCustomerDnsRecord(
          fixture.req,
          fixture.asset.id,
          {
            host: 'api',
            idempotencyKey: randomUUID(),
            line: '默认',
            priority: 10,
            ttl: 600,
            type: 'A',
            value: '192.0.2.53',
          },
          {
            customer: customerIdentity(fixture.customer.id),
            provider: managed.provider,
            traceId: `${fixturePrefix}-ownership-unknown-dns`,
          },
        ),
      ),
    ]
    expect(attempts).toHaveLength(4)
    expect(
      attempts.every(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: string }).code === 'DOMAIN_UPSTREAM_OWNERSHIP_UNCONFIRMED',
      ),
    ).toBe(true)
    expect(managed.transport.writeCount).toBe(0)
  })

  it('rechecks ownership before each management lease and rejects a concurrent sync-version change', async () => {
    const passwordFixture = await createFixture('ownership-version-password', {
      identities: ['phone'],
    })
    const passwordGrantValue = await passwordGrant(passwordFixture.req, passwordFixture.customer.id)
    const passwordProvider = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'asset_query') return
        await payload.db.pool.query(
          'UPDATE domain_assets SET sync_version = sync_version + 1 WHERE id = $1',
          [passwordFixture.asset.id],
        )
      },
    })
    await expect(
      modifyDomainManagementPassword(
        passwordFixture.req,
        passwordFixture.asset.id,
        {
          ...passwordGrantValue,
          idempotencyKey: randomUUID(),
          managementPassword: 'OwnershipVersionPassword12',
        },
        {
          customer: customerIdentity(passwordFixture.customer.id),
          provider: passwordProvider.provider,
          traceId: `${fixturePrefix}-ownership-version-password`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_MANAGEMENT_STATE_CONFLICT', status: 409 })

    const contactFixture = await createFixture('ownership-version-contact')
    const contactTarget = await createTemplate(
      contactFixture.customer,
      'ownership-version-contact-target',
    )
    const contactGrant = await realnameGrant(contactFixture.req, contactFixture.customer.id)
    const contactProvider = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'asset_query') return
        await payload.db.pool.query(
          'UPDATE domain_assets SET sync_version = sync_version + 1 WHERE id = $1',
          [contactFixture.asset.id],
        )
      },
    })
    await expect(
      updateDomainContactInformation(
        contactFixture.req,
        contactFixture.asset.id,
        {
          ...contactGrant,
          confirmed: true,
          contactType: 'dom_id',
          idempotencyKey: randomUUID(),
          templateId: contactTarget.id,
        },
        {
          customer: customerIdentity(contactFixture.customer.id),
          provider: contactProvider.provider,
          traceId: `${fixturePrefix}-ownership-version-contact`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_MANAGEMENT_STATE_CONFLICT', status: 409 })

    const transferFixture = await createFixture('ownership-version-transfer')
    const transferTarget = await createTemplate(
      transferFixture.customer,
      'ownership-version-transfer-target',
    )
    const transferGrant = await realnameGrant(transferFixture.req, transferFixture.customer.id)
    const transferProvider = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'asset_query') return
        await payload.db.pool.query(
          'UPDATE domain_assets SET sync_version = sync_version + 1 WHERE id = $1',
          [transferFixture.asset.id],
        )
      },
    })
    await expect(
      transferDomainToApprovedTemplate(
        transferFixture.req,
        transferFixture.asset.id,
        {
          ...transferGrant,
          confirmed: true,
          idempotencyKey: randomUUID(),
          templateId: transferTarget.id,
        },
        {
          customer: customerIdentity(transferFixture.customer.id),
          provider: transferProvider.provider,
          traceId: `${fixturePrefix}-ownership-version-transfer`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_MANAGEMENT_STATE_CONFLICT', status: 409 })
    expect([
      passwordProvider.transport.writeCount,
      contactProvider.transport.writeCount,
      transferProvider.transport.writeCount,
    ]).toEqual([0, 0, 0])
  })

  it('records not-owned synchronization state without overwriting local asset facts', async () => {
    const fixture = await createFixture('sync-not-owned')
    const before = await payload.findByID({
      collection: 'domainAssets',
      id: fixture.asset.id,
      overrideAccess: true,
    })
    const managed = managedProvider({ ownership: 'not_owned' })
    await expect(
      syncCustomerDomainAsset(fixture.req, fixture.asset.id, {
        customer: customerIdentity(fixture.customer.id),
        provider: managed.provider,
        traceId: `${fixturePrefix}-sync-not-owned`,
      }),
    ).resolves.toMatchObject({
      problem: { code: 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED' },
      state: 'degraded',
    })
    const after = await payload.findByID({
      collection: 'domainAssets',
      id: fixture.asset.id,
      overrideAccess: true,
    })
    expect(after).toMatchObject({
      expiresAt: before.expiresAt,
      lastSyncedAt: before.lastSyncedAt,
      nameservers: before.nameservers,
      operationBlockReason: 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED',
      registrar: before.registrar,
      status: before.status,
      syncReviewStatus: 'pending',
      upstreamOwnershipStatus: 'not_owned',
    })
    const observations = await payload.find({
      collection: 'domainAssetSyncEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { asset: { equals: fixture.asset.id } },
          { customer: { equals: fixture.customer.id } },
          { outcome: { equals: 'not_owned' } },
          { resolutionStatus: { equals: 'pending' } },
        ],
      },
    })
    expect(observations.totalDocs).toBe(1)
  })

  it('detects every synchronized fact independently and never replaces the local fact', async () => {
    const managed = managedProvider()
    const cases = [
      { field: 'expiresAt', local: '2029-08-17T04:00:00.000Z' },
      { field: 'nameservers', local: ['ns1.local.example', 'ns2.local.example'] },
      { field: 'registeredAt', local: '2025-08-17T04:00:00.000Z' },
      { field: 'registrar', local: 'local-registrar' },
      { field: 'status', local: 'expired' },
    ] as const
    for (const candidate of cases) {
      const fixture = await createFixture(`sync-field-${candidate.field}`)
      await payload.update({
        collection: 'domainAssets',
        data: { [candidate.field]: candidate.local } as never,
        id: fixture.asset.id,
        overrideAccess: true,
      })
      await expect(
        syncCustomerDomainAsset(fixture.req, fixture.asset.id, {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-sync-field-${candidate.field}`,
        }),
      ).resolves.toMatchObject({
        problem: { code: 'DOMAIN_ASSET_SYNC_DIFFERENCE_PENDING' },
        state: 'degraded',
      })
      const events = await payload.find({
        collection: 'domainAssetSyncEvents',
        limit: 2,
        overrideAccess: true,
        where: { asset: { equals: fixture.asset.id } },
      })
      expect(events.totalDocs).toBe(1)
      expect(events.docs[0]?.differences).toEqual([
        expect.objectContaining({ field: candidate.field, local: candidate.local }),
      ])
      const after = await payload.findByID({
        collection: 'domainAssets',
        id: fixture.asset.id,
        overrideAccess: true,
      })
      expect(after[candidate.field]).toEqual(candidate.local)
    }
  })

  it('keeps every transfer CAS predicate necessary and marks write-after-upstream conflicts pending', async () => {
    const idFixture = await createFixture('transfer-cas-id')
    const idTarget = await createTemplate(idFixture.customer, 'transfer-cas-id-target')
    const sibling = await payload.create({
      collection: 'domainAssets',
      data: {
        customer: idFixture.customer.id,
        domainAscii: `transfer-cas-sibling-${randomUUID().slice(0, 8)}.example`,
        expiresAt: '2028-08-17T04:00:00.000Z',
        lastSyncedAt: '2026-08-17T04:00:00.000Z',
        nameservers: ['ns1.before.example', 'ns2.before.example'],
        realnameTemplate: idFixture.template.id,
        registeredAt: '2026-08-17T04:00:00.000Z',
        registrar: 'west',
        status: 'active',
        syncReviewStatus: 'none',
        syncVersion: 0,
        upstreamOwnershipStatus: 'unknown',
      },
      overrideAccess: true,
    })
    assetIds.push(sibling.id)
    const idGrant = await realnameGrant(idFixture.req, idFixture.customer.id)
    await expect(
      transferDomainToApprovedTemplate(
        idFixture.req,
        idFixture.asset.id,
        { ...idGrant, confirmed: true, idempotencyKey: randomUUID(), templateId: idTarget.id },
        {
          customer: customerIdentity(idFixture.customer.id),
          provider: managedProvider().provider,
          traceId: `${fixturePrefix}-transfer-cas-id`,
        },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' }, state: 'ready' })
    const unchangedSibling = await payload.findByID({
      collection: 'domainAssets',
      id: sibling.id,
      overrideAccess: true,
    })
    expect(
      String(
        typeof unchangedSibling.realnameTemplate === 'object'
          ? unchangedSibling.realnameTemplate.id
          : unchangedSibling.realnameTemplate,
      ),
    ).toBe(String(idFixture.template.id))

    const templateFixture = await createFixture('transfer-cas-template')
    const templateTarget = await createTemplate(
      templateFixture.customer,
      'transfer-cas-template-target',
    )
    const concurrentTemplate = await createTemplate(
      templateFixture.customer,
      'transfer-cas-template-concurrent',
    )
    const templateGrant = await realnameGrant(templateFixture.req, templateFixture.customer.id)
    const templateProvider = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'domain_template_transfer') return
        await payload.db.pool.query(
          'UPDATE domain_assets SET realname_template_id = $1 WHERE id = $2',
          [concurrentTemplate.id, templateFixture.asset.id],
        )
      },
    })
    await expect(
      transferDomainToApprovedTemplate(
        templateFixture.req,
        templateFixture.asset.id,
        {
          ...templateGrant,
          confirmed: true,
          idempotencyKey: randomUUID(),
          templateId: templateTarget.id,
        },
        {
          customer: customerIdentity(templateFixture.customer.id),
          provider: templateProvider.provider,
          traceId: `${fixturePrefix}-transfer-cas-template`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_TRANSFER_LOCAL_STATE_CONFLICT', status: 409 })
    const templateConflict = await payload.findByID({
      collection: 'domainAssets',
      id: templateFixture.asset.id,
      overrideAccess: true,
    })
    expect(
      String(
        typeof templateConflict.realnameTemplate === 'object'
          ? templateConflict.realnameTemplate.id
          : templateConflict.realnameTemplate,
      ),
    ).toBe(String(concurrentTemplate.id))

    const versionFixture = await createFixture('transfer-cas-version')
    const versionTarget = await createTemplate(
      versionFixture.customer,
      'transfer-cas-version-target',
    )
    const versionGrant = await realnameGrant(versionFixture.req, versionFixture.customer.id)
    const versionProvider = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'domain_template_transfer') return
        await payload.db.pool.query(
          'UPDATE domain_assets SET sync_version = sync_version + 1 WHERE id = $1',
          [versionFixture.asset.id],
        )
      },
    })
    await expect(
      transferDomainToApprovedTemplate(
        versionFixture.req,
        versionFixture.asset.id,
        {
          ...versionGrant,
          confirmed: true,
          idempotencyKey: randomUUID(),
          templateId: versionTarget.id,
        },
        {
          customer: customerIdentity(versionFixture.customer.id),
          provider: versionProvider.provider,
          traceId: `${fixturePrefix}-transfer-cas-version`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_TRANSFER_LOCAL_STATE_CONFLICT', status: 409 })
    const pending = await payload.find({
      collection: 'domainManagementEvents',
      limit: 10,
      overrideAccess: true,
      where: {
        and: [
          { asset: { in: [templateFixture.asset.id, versionFixture.asset.id] } },
          { errorCode: { equals: 'DOMAIN_TRANSFER_LOCAL_STATE_CONFLICT' } },
          { event: { equals: 'pending_query' } },
        ],
      },
    })
    expect(pending.totalDocs).toBe(2)
  })

  it('keeps synchronization scoped by asset, version, and an inactive management lease', async () => {
    const idFixture = await createFixture('sync-cas-id')
    const sibling = await payload.create({
      collection: 'domainAssets',
      data: {
        customer: idFixture.customer.id,
        domainAscii: `sync-cas-sibling-${randomUUID().slice(0, 8)}.example`,
        expiresAt: '2028-08-17T04:00:00.000Z',
        lastSyncedAt: '2026-08-17T04:00:00.000Z',
        nameservers: ['ns1.before.example', 'ns2.before.example'],
        realnameTemplate: idFixture.template.id,
        registeredAt: '2026-08-17T04:00:00.000Z',
        registrar: 'west',
        status: 'active',
        syncReviewStatus: 'none',
        syncVersion: 0,
        upstreamOwnershipStatus: 'unknown',
      },
      overrideAccess: true,
    })
    assetIds.push(sibling.id)
    await expect(
      syncCustomerDomainAsset(idFixture.req, idFixture.asset.id, {
        customer: customerIdentity(idFixture.customer.id),
        provider: managedProvider().provider,
        traceId: `${fixturePrefix}-sync-cas-id`,
      }),
    ).resolves.toMatchObject({ state: 'ready' })
    expect(
      (await payload.findByID({ collection: 'domainAssets', id: sibling.id, overrideAccess: true }))
        .syncVersion,
    ).toBe(0)

    const versionFixture = await createFixture('sync-cas-version')
    const versionProvider = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'asset_query') return
        await payload.db.pool.query(
          'UPDATE domain_assets SET sync_version = sync_version + 1 WHERE id = $1',
          [versionFixture.asset.id],
        )
      },
    })
    await expect(
      syncCustomerDomainAsset(versionFixture.req, versionFixture.asset.id, {
        customer: customerIdentity(versionFixture.customer.id),
        provider: versionProvider.provider,
        traceId: `${fixturePrefix}-sync-cas-version`,
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_SYNC_STATE_CONFLICT', status: 409 })

    const leaseFixture = await createFixture('sync-cas-lease')
    await payload.db.pool.query(
      `UPDATE domain_assets
       SET domain_management_lease_key = $1,
           domain_management_lease_expires_at = NOW() + INTERVAL '5 minutes'
       WHERE id = $2`,
      [`${fixturePrefix}-active-management-lease`, leaseFixture.asset.id],
    )
    await expect(
      syncCustomerDomainAsset(leaseFixture.req, leaseFixture.asset.id, {
        customer: customerIdentity(leaseFixture.customer.id),
        provider: managedProvider().provider,
        traceId: `${fixturePrefix}-sync-cas-lease`,
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_SYNC_STATE_CONFLICT', status: 409 })
    await payload.db.pool.query(
      `UPDATE domain_assets
       SET domain_management_lease_key = NULL,
           domain_management_lease_expires_at = NULL
       WHERE id = $1 AND domain_management_lease_key = $2`,
      [leaseFixture.asset.id, `${fixturePrefix}-active-management-lease`],
    )

    const expiredLeaseFixture = await createFixture('sync-cas-expired-lease')
    await payload.db.pool.query(
      `UPDATE domain_assets
       SET domain_management_lease_key = $1,
           domain_management_lease_expires_at = NOW() - INTERVAL '1 minute'
       WHERE id = $2`,
      [`${fixturePrefix}-expired-management-lease`, expiredLeaseFixture.asset.id],
    )
    await expect(
      syncCustomerDomainAsset(expiredLeaseFixture.req, expiredLeaseFixture.asset.id, {
        customer: customerIdentity(expiredLeaseFixture.customer.id),
        provider: managedProvider().provider,
        traceId: `${fixturePrefix}-sync-cas-expired-lease`,
      }),
    ).resolves.toMatchObject({ state: 'ready' })
  })

  it('uses one conditional lease at each password, contact, and transfer write call point', async () => {
    const fixture = await createFixture('management-lease', { identities: ['phone'] })
    const firstGrant = await passwordGrant(fixture.req, fixture.customer.id)
    const secondGrant = await passwordGrant(fixture.req, fixture.customer.id)
    let releaseWrite!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const release = new Promise<void>((resolve) => (releaseWrite = resolve))
    let passwordWriteCalls = 0
    const managed = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'domain_management_password_modify') return
        passwordWriteCalls += 1
        markStarted()
        if (passwordWriteCalls === 1) await release
      },
    })
    const first = modifyDomainManagementPassword(
      fixture.req,
      fixture.asset.id,
      { ...firstGrant, idempotencyKey: randomUUID(), managementPassword: 'ConcurrentSecretOne' },
      {
        customer: customerIdentity(fixture.customer.id),
        provider: managed.provider,
        traceId: `${fixturePrefix}-management-lease-first`,
      },
    )
    await started
    await expect(
      modifyDomainManagementPassword(
        await requestFor(fixture.customer, 'management-lease-second'),
        fixture.asset.id,
        { ...secondGrant, idempotencyKey: randomUUID(), managementPassword: 'ConcurrentSecretTwo' },
        {
          customer: customerIdentity(fixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-management-lease-second`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_MANAGEMENT_OPERATION_IN_PROGRESS', status: 409 })
    releaseWrite()
    await expect(first).resolves.toMatchObject({ data: { status: 'succeeded' }, state: 'ready' })
    expect(managed.transport.writeCount).toBe(1)
    const asset = await payload.findByID({
      collection: 'domainAssets',
      id: fixture.asset.id,
      overrideAccess: true,
    })
    expect(asset.domainManagementLeaseKey).toBeNull()
    expect(asset.domainManagementLeaseExpiresAt).toBeNull()

    const contactFixture = await createFixture('contact-lease')
    const contactTarget = await createTemplate(contactFixture.customer, 'contact-lease-target')
    const contactSecondReq = await requestFor(contactFixture.customer, 'contact-lease-second')
    const contactFirstGrant = await realnameGrant(contactFixture.req, contactFixture.customer.id)
    const contactSecondGrant = await realnameGrant(contactSecondReq, contactFixture.customer.id)
    let releaseContact!: () => void
    let markContactStarted!: () => void
    const contactStarted = new Promise<void>((resolve) => (markContactStarted = resolve))
    const contactRelease = new Promise<void>((resolve) => (releaseContact = resolve))
    const contactProvider = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'domain_contact_update') return
        markContactStarted()
        await contactRelease
      },
    })
    const firstContact = updateDomainContactInformation(
      contactFixture.req,
      contactFixture.asset.id,
      {
        ...contactFirstGrant,
        confirmed: true,
        contactType: 'admin_id',
        idempotencyKey: randomUUID(),
        templateId: contactTarget.id,
      },
      {
        customer: customerIdentity(contactFixture.customer.id),
        provider: contactProvider.provider,
        traceId: `${fixturePrefix}-contact-lease-first`,
      },
    )
    await contactStarted
    await expect(
      updateDomainContactInformation(
        contactSecondReq,
        contactFixture.asset.id,
        {
          ...contactSecondGrant,
          confirmed: true,
          contactType: 'admin_id',
          idempotencyKey: randomUUID(),
          templateId: contactTarget.id,
        },
        {
          customer: customerIdentity(contactFixture.customer.id),
          provider: contactProvider.provider,
          traceId: `${fixturePrefix}-contact-lease-second`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_MANAGEMENT_OPERATION_IN_PROGRESS', status: 409 })
    releaseContact()
    await expect(firstContact).resolves.toMatchObject({
      data: { status: 'succeeded' },
      state: 'ready',
    })
    expect(contactProvider.transport.writeCount).toBe(1)

    const transferFixture = await createFixture('transfer-lease')
    const transferTarget = await createTemplate(transferFixture.customer, 'transfer-lease-target')
    const transferSecondReq = await requestFor(transferFixture.customer, 'transfer-lease-second')
    const transferFirstGrant = await realnameGrant(transferFixture.req, transferFixture.customer.id)
    const transferSecondGrant = await realnameGrant(transferSecondReq, transferFixture.customer.id)
    let releaseTransfer!: () => void
    let markTransferStarted!: () => void
    const transferStarted = new Promise<void>((resolve) => (markTransferStarted = resolve))
    const transferRelease = new Promise<void>((resolve) => (releaseTransfer = resolve))
    const transferProvider = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'domain_template_transfer') return
        markTransferStarted()
        await transferRelease
      },
    })
    const firstTransfer = transferDomainToApprovedTemplate(
      transferFixture.req,
      transferFixture.asset.id,
      {
        ...transferFirstGrant,
        confirmed: true,
        idempotencyKey: randomUUID(),
        templateId: transferTarget.id,
      },
      {
        customer: customerIdentity(transferFixture.customer.id),
        provider: transferProvider.provider,
        traceId: `${fixturePrefix}-transfer-lease-first`,
      },
    )
    await transferStarted
    await expect(
      transferDomainToApprovedTemplate(
        transferSecondReq,
        transferFixture.asset.id,
        {
          ...transferSecondGrant,
          confirmed: true,
          idempotencyKey: randomUUID(),
          templateId: transferTarget.id,
        },
        {
          customer: customerIdentity(transferFixture.customer.id),
          provider: transferProvider.provider,
          traceId: `${fixturePrefix}-transfer-lease-second`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_MANAGEMENT_OPERATION_IN_PROGRESS', status: 409 })
    releaseTransfer()
    await expect(firstTransfer).resolves.toMatchObject({
      data: { status: 'succeeded' },
      state: 'ready',
    })
    expect(transferProvider.transport.writeCount).toBe(1)
  })

  it('reclaims only an expired management lease and fails closed if lease ownership changes', async () => {
    const expiredFixture = await createFixture('management-lease-expired', {
      identities: ['phone'],
    })
    await payload.db.pool.query(
      `UPDATE domain_assets
       SET domain_management_lease_key = $1,
           domain_management_lease_expires_at = NOW() - INTERVAL '1 minute'
       WHERE id = $2`,
      [`${fixturePrefix}-expired-lease`, expiredFixture.asset.id],
    )
    const expiredGrant = await passwordGrant(expiredFixture.req, expiredFixture.customer.id)
    await expect(
      modifyDomainManagementPassword(
        expiredFixture.req,
        expiredFixture.asset.id,
        {
          ...expiredGrant,
          idempotencyKey: randomUUID(),
          managementPassword: 'ExpiredLeaseReclaimed12',
        },
        {
          customer: customerIdentity(expiredFixture.customer.id),
          provider: managedProvider().provider,
          traceId: `${fixturePrefix}-management-lease-expired`,
        },
      ),
    ).resolves.toMatchObject({ data: { status: 'succeeded' }, state: 'ready' })

    const versionFixture = await createFixture('management-lease-version', {
      identities: ['phone'],
    })
    const versionGrant = await passwordGrant(versionFixture.req, versionFixture.customer.id)
    let changedVersion = false
    const versionProvider = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'asset_query' || changedVersion) return
        changedVersion = true
        await payload.db.pool.query(
          'UPDATE domain_assets SET sync_version = sync_version + 1 WHERE id = $1',
          [versionFixture.asset.id],
        )
      },
    })
    await expect(
      modifyDomainManagementPassword(
        versionFixture.req,
        versionFixture.asset.id,
        {
          ...versionGrant,
          idempotencyKey: randomUUID(),
          managementPassword: 'VersionConflict12',
        },
        {
          customer: customerIdentity(versionFixture.customer.id),
          provider: versionProvider.provider,
          traceId: `${fixturePrefix}-management-lease-version`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_MANAGEMENT_STATE_CONFLICT', status: 409 })
    expect(versionProvider.transport.writeCount).toBe(0)

    const lostFixture = await createFixture('management-lease-lost', { identities: ['phone'] })
    const lostGrant = await passwordGrant(lostFixture.req, lostFixture.customer.id)
    const intruderKey = `${fixturePrefix}-intruder-lease`
    const lostProvider = managedProvider({
      onRequest: async (input) => {
        if (input.operation !== 'domain_management_password_modify') return
        await payload.db.pool.query(
          `UPDATE domain_assets
           SET domain_management_lease_key = $1,
               domain_management_lease_expires_at = NOW() + INTERVAL '5 minutes'
           WHERE id = $2`,
          [intruderKey, lostFixture.asset.id],
        )
      },
    })
    await expect(
      modifyDomainManagementPassword(
        lostFixture.req,
        lostFixture.asset.id,
        {
          ...lostGrant,
          idempotencyKey: randomUUID(),
          managementPassword: 'LeaseLostAfterWrite12',
        },
        {
          customer: customerIdentity(lostFixture.customer.id),
          provider: lostProvider.provider,
          traceId: `${fixturePrefix}-management-lease-lost`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_MANAGEMENT_OPERATION_LEASE_LOST', status: 503 })
    expect(lostProvider.transport.writeCount).toBe(1)
    const retained = await payload.findByID({
      collection: 'domainAssets',
      id: lostFixture.asset.id,
      overrideAccess: true,
    })
    expect(retained.domainManagementLeaseKey).toBe(intruderKey)
    await payload.db.pool.query(
      `UPDATE domain_assets
       SET domain_management_lease_key = NULL,
           domain_management_lease_expires_at = NULL
       WHERE id = $1 AND domain_management_lease_key = $2`,
      [lostFixture.asset.id, intruderKey],
    )
  })

  it('enforces the A5 cooldown through both password and realname risk call points', async () => {
    const passwordFixture = await createFixture('cooldown-password', {
      cooldown: true,
      identities: ['phone'],
    })
    const realnameFixture = await createFixture('cooldown-realname', { cooldown: true })
    const target = await createTemplate(realnameFixture.customer, 'cooldown-realname-target')
    const password = await passwordGrant(passwordFixture.req, passwordFixture.customer.id)
    const realname = await realnameGrant(realnameFixture.req, realnameFixture.customer.id)
    const managed = managedProvider()
    const attempts = await Promise.allSettled([
      revealDomainManagementPassword(passwordFixture.req, passwordFixture.asset.id, password, {
        customer: customerIdentity(passwordFixture.customer.id),
        provider: managed.provider,
        traceId: `${fixturePrefix}-cooldown-password`,
      }),
      transferDomainToApprovedTemplate(
        realnameFixture.req,
        realnameFixture.asset.id,
        { ...realname, confirmed: true, idempotencyKey: randomUUID(), templateId: target.id },
        {
          customer: customerIdentity(realnameFixture.customer.id),
          provider: managed.provider,
          traceId: `${fixturePrefix}-cooldown-realname`,
        },
      ),
    ])
    expect(attempts).toHaveLength(2)
    expect(
      attempts.every(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: string }).code === 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE',
      ),
    ).toBe(true)
    expect(managed.transport.requests).toHaveLength(0)
  })
})
