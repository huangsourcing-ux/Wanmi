import { randomInt, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hmac, randomOpaqueToken } from '@/lib/crypto'
import {
  CUSTOMER_ACCOUNT_STATUSES,
  CUSTOMER_ACCOUNT_TRANSITIONS,
  CUSTOMER_CAPABILITY_RESTRICTIONS,
  type CustomerAccountStatus,
  type CustomerCapabilityRestriction,
} from '@/lib/domain'
import { getEnv } from '@/lib/env'
import {
  accountRestrictions,
  assertCustomerAccountCapability,
  assertCustomerAccountCapabilityFromSnapshot,
  revokeCustomerSessionsForSecurityEvent,
  transitionCustomerAccount,
  type CustomerCapability,
} from '@/services/auth/account-state'
import {
  authenticateVerifiedPhone,
  bindVerifiedIdentity,
  identityProviderInstance,
  protectedIdentifier,
  unbindCustomerIdentity,
} from '@/services/auth/customer-identities'
import { customerSessionStrategy } from '@/services/auth/customer-strategy'
import { revokeAllCustomerSessions } from '@/services/auth/customer-sessions'
import {
  authenticatedCustomerRequest,
  requestCustomerDeletion,
  revokeSessions,
} from '@/services/auth/otp'
import { createCustomerOrder } from '@/services/commerce/order-creation'
import { createWechatPayment } from '@/services/commerce/payments'
import { listCustomerDomainAssets } from '@/services/domains/domain-assets'
import { requestCustomerNameserverChange } from '@/services/domains/nameserver-changes'
import { createRealnameDocumentAccess } from '@/services/realname/documents'
import { createRealnameTemplate } from '@/services/realname/templates'

import { issueStepUpGrantFixture } from '../fixtures/step-up'

let payload: Payload

const accountStateSource = readFileSync(
  fileURLToPath(new URL('../../src/services/auth/account-state.ts', import.meta.url)),
  'utf8',
)
const customerSessionsSource = readFileSync(
  fileURLToPath(new URL('../../src/services/auth/customer-sessions.ts', import.meta.url)),
  'utf8',
)

const transitionCases = Object.entries(CUSTOMER_ACCOUNT_TRANSITIONS).flatMap(([from, targets]) =>
  targets.map((to) => ({ from: from as CustomerAccountStatus, to })),
)

const capabilityCases: Array<{
  capability: CustomerCapability
  code: string
  restriction: CustomerCapabilityRestriction
}> = [
  {
    capability: 'login',
    code: 'ACCOUNT_LOGIN_DISABLED',
    restriction: 'login_disabled',
  },
  {
    capability: 'purchase',
    code: 'ACCOUNT_PURCHASE_DISABLED',
    restriction: 'purchase_disabled',
  },
  {
    capability: 'balance_spend',
    code: 'ACCOUNT_BALANCE_SPEND_DISABLED',
    restriction: 'balance_spend_disabled',
  },
  {
    capability: 'domain_write',
    code: 'ACCOUNT_DOMAIN_WRITE_DISABLED',
    restriction: 'domain_write_disabled',
  },
  {
    capability: 'identity_change',
    code: 'ACCOUNT_IDENTITY_CHANGE_DISABLED',
    restriction: 'identity_change_disabled',
  },
  {
    capability: 'refund',
    code: 'ACCOUNT_REFUND_REVIEW_REQUIRED',
    restriction: 'refund_review',
  },
]

function headers(suffix: string = randomUUID()): Headers {
  return new Headers({
    'user-agent': `Wanmi-D9A-A3/${suffix}`,
    'x-forwarded-for': `198.51.100.${randomInt(1, 250)}`,
    'x-request-id': `d9a-a3-${suffix}`,
  })
}

async function request(suffix: string = randomUUID()): Promise<PayloadRequest> {
  return createLocalReq({ req: { headers: headers(suffix) } }, payload)
}

async function requestFor(user: unknown, suffix: string = randomUUID()): Promise<PayloadRequest> {
  const req = await request(suffix)
  req.user = user as never
  return req
}

function restrictionsFor(status: CustomerAccountStatus): CustomerCapabilityRestriction[] {
  return status === 'restricted' ? ['purchase_disabled'] : []
}

async function customer(
  status: CustomerAccountStatus,
  capabilityRestrictions = restrictionsFor(status),
) {
  const suffix = randomUUID()
  return payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions,
      phone: `a3-${suffix}`,
      phoneMasked: `a3-***${suffix.slice(-4)}`,
      status,
    },
    overrideAccess: true,
  })
}

function evidence(reference: string = randomUUID()) {
  return {
    observedAt: new Date().toISOString(),
    reference: `a3:${reference}`,
    source: 'security_event' as const,
  }
}

async function storedCustomer(id: number) {
  return payload.findByID({ collection: 'customers', id, overrideAccess: true })
}

async function stateAuditCount(customerId: number) {
  return payload.count({
    collection: 'auditLogs',
    overrideAccess: true,
    where: {
      and: [
        { action: { equals: 'customer.account_state.changed' } },
        { targetId: { equals: String(customerId) } },
      ],
    },
  })
}

async function capturedError(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
    return undefined
  } catch (error) {
    return error
  }
}

async function createSession(customerId: number, revokedAt?: string) {
  const token = randomOpaqueToken()
  const session = await payload.create({
    collection: 'customerSessions',
    data: {
      customer: customerId,
      deviceHash: hmac(`device:${token}`, getEnv().SESSION_PEPPER),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ipHash: hmac(`ip:${token}`, getEnv().SESSION_PEPPER),
      lastSeenAt: new Date().toISOString(),
      revokedAt,
      tokenHash: hmac(token, getEnv().SESSION_PEPPER),
    },
    overrideAccess: true,
  })
  return { session, token }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9-A A3 account state and capability restrictions', () => {
  it('exposes exactly the approved six states, six restrictions, and explicit transition graph', () => {
    expect(CUSTOMER_ACCOUNT_STATUSES).toEqual([
      'pending_registration',
      'active',
      'restricted',
      'suspended',
      'closing',
      'closed',
    ])
    expect(CUSTOMER_CAPABILITY_RESTRICTIONS).toEqual([
      'login_disabled',
      'purchase_disabled',
      'balance_spend_disabled',
      'domain_write_disabled',
      'identity_change_disabled',
      'refund_review',
    ])
    expect(transitionCases).toEqual([
      { from: 'pending_registration', to: 'active' },
      { from: 'active', to: 'restricted' },
      { from: 'active', to: 'suspended' },
      { from: 'active', to: 'closing' },
      { from: 'restricted', to: 'active' },
      { from: 'restricted', to: 'suspended' },
      { from: 'restricted', to: 'closing' },
      { from: 'suspended', to: 'active' },
      { from: 'suspended', to: 'restricted' },
      { from: 'suspended', to: 'closing' },
      { from: 'closing', to: 'active' },
      { from: 'closing', to: 'closed' },
    ])
  })

  it('rejects an admin actor without the system_admin role', async () => {
    const account = await customer('active')
    const req = await requestFor(
      { collection: 'admins', id: 'a3-analyst', roles: ['analyst'], status: 'active' },
      'actor-admin-role',
    )
    await expect(
      transitionCustomerAccount(req, {
        actor: { id: 'a3-analyst', type: 'admin' },
        customerId: account.id,
        evidence: evidence('actor-admin-role'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'unauthorized_admin_attempt',
        restrictions: ['purchase_disabled'],
        status: 'restricted',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_FORBIDDEN', status: 403 })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('rejects an admin actor whose asserted id does not match the authenticated admin', async () => {
    const account = await customer('active')
    const req = await requestFor(
      { collection: 'admins', id: 'a3-admin-session', roles: ['system_admin'], status: 'active' },
      'actor-admin-id',
    )
    await expect(
      transitionCustomerAccount(req, {
        actor: { id: 'a3-admin-claim', type: 'admin' },
        customerId: account.id,
        evidence: evidence('actor-admin-id'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'forged_admin_actor',
        restrictions: ['purchase_disabled'],
        status: 'restricted',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_FORBIDDEN', status: 403 })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('rejects a customer actor when the authenticated principal is not a customer', async () => {
    const account = await customer('active')
    const req = await requestFor(
      { collection: 'admins', id: account.id, roles: ['system_admin'], status: 'active' },
      'actor-customer-principal',
    )
    await expect(
      transitionCustomerAccount(req, {
        actor: { id: account.id, type: 'customer' },
        customerId: account.id,
        evidence: evidence('actor-customer-principal'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'forged_customer_actor',
        restrictions: [],
        status: 'closing',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_FORBIDDEN', status: 403 })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('rejects a customer actor id that does not match the authenticated customer', async () => {
    const account = await customer('active')
    const req = await requestFor({ ...account, collection: 'customers' }, 'actor-customer-id')
    await expect(
      transitionCustomerAccount(req, {
        actor: { id: account.id + 1, type: 'customer' },
        customerId: account.id,
        evidence: evidence('actor-customer-id'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'forged_customer_actor_id',
        restrictions: [],
        status: 'closing',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_FORBIDDEN', status: 403 })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('rejects a customer changing another customerId even with a matching actor id', async () => {
    const caller = await customer('active')
    const target = await customer('active')
    const req = await requestFor({ ...caller, collection: 'customers' }, 'actor-customer-owner')
    await expect(
      transitionCustomerAccount(req, {
        actor: { id: caller.id, type: 'customer' },
        customerId: target.id,
        evidence: evidence('actor-customer-owner'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'cross_customer_closure',
        restrictions: [],
        status: 'closing',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_FORBIDDEN', status: 403 })
    await expect(storedCustomer(target.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('rejects customer targets other than closing', async () => {
    const account = await customer('active')
    const req = await requestFor({ ...account, collection: 'customers' }, 'actor-customer-target')
    await expect(
      transitionCustomerAccount(req, {
        actor: { id: account.id, type: 'customer' },
        customerId: account.id,
        evidence: evidence('actor-customer-target-restricted'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'customer_self_restriction',
        restrictions: ['purchase_disabled'],
        status: 'restricted',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_FORBIDDEN', status: 403 })
    await expect(
      transitionCustomerAccount(req, {
        actor: { id: account.id, type: 'customer' },
        customerId: account.id,
        evidence: evidence('actor-customer-target-closed'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'customer_direct_close',
        restrictions: [],
        status: 'closed',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_TRANSITION_INVALID', status: 409 })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('rejects customer self-service from non active or restricted source states', async () => {
    const suspended = await customer('suspended')
    const suspendedReq = await requestFor(
      { ...suspended, collection: 'customers' },
      'actor-customer-source-suspended',
    )
    await expect(
      transitionCustomerAccount(suspendedReq, {
        actor: { id: suspended.id, type: 'customer' },
        customerId: suspended.id,
        evidence: evidence('actor-customer-source-suspended'),
        expectedRestrictions: [],
        expectedStatus: 'suspended',
        reason: 'suspended_self_closure',
        restrictions: [],
        status: 'closing',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_FORBIDDEN', status: 403 })

    const closing = await customer('closing')
    const closingReq = await requestFor(
      { ...closing, collection: 'customers' },
      'actor-customer-source-closing',
    )
    await expect(
      transitionCustomerAccount(closingReq, {
        actor: { id: closing.id, type: 'customer' },
        customerId: closing.id,
        evidence: evidence('actor-customer-source-closing'),
        expectedRestrictions: [],
        expectedStatus: 'closing',
        reason: 'closing_self_close',
        restrictions: [],
        status: 'closed',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_FORBIDDEN', status: 403 })

    const closed = await customer('closed')
    const closedReq = await requestFor(
      { ...closed, collection: 'customers' },
      'actor-customer-source-closed',
    )
    await expect(
      transitionCustomerAccount(closedReq, {
        actor: { id: closed.id, type: 'customer' },
        customerId: closed.id,
        evidence: evidence('actor-customer-source-closed'),
        expectedRestrictions: [],
        expectedStatus: 'closed',
        reason: 'closed_self_reopen',
        restrictions: [],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_TRANSITION_INVALID', status: 409 })
    await expect(stateAuditCount(suspended.id)).resolves.toMatchObject({ totalDocs: 0 })
    await expect(stateAuditCount(closing.id)).resolves.toMatchObject({ totalDocs: 0 })
    await expect(stateAuditCount(closed.id)).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('rejects a system actor whenever req.user is present', async () => {
    const account = await customer('active')
    const req = await requestFor({ ...account, collection: 'customers' }, 'actor-system-user')
    await expect(
      transitionCustomerAccount(req, {
        actor: { type: 'system' },
        customerId: account.id,
        evidence: evidence('actor-system-user'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'forged_system_actor',
        restrictions: ['purchase_disabled'],
        status: 'restricted',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_FORBIDDEN', status: 403 })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('rejects an empty restriction set for a restricted target state', async () => {
    const account = await customer('active')
    await expect(
      transitionCustomerAccount(await request('invariant-target-restricted'), {
        actor: { type: 'system' },
        customerId: account.id,
        evidence: evidence('invariant-target-restricted'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'invalid_restricted_target',
        restrictions: [],
        status: 'restricted',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_RESTRICTIONS_MISMATCH', status: 400 })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('rejects restrictions on a non-restricted target state', async () => {
    const account = await customer('restricted', ['purchase_disabled'])
    await expect(
      transitionCustomerAccount(await request('invariant-target-active'), {
        actor: { type: 'system' },
        customerId: account.id,
        evidence: evidence('invariant-target-active'),
        expectedRestrictions: ['purchase_disabled'],
        expectedStatus: 'restricted',
        reason: 'invalid_active_target',
        restrictions: ['purchase_disabled'],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_RESTRICTIONS_MISMATCH', status: 400 })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'restricted' })
  })

  it('rejects an inconsistent expected state snapshot before CAS', async () => {
    const account = await customer('restricted', [])
    await expect(
      transitionCustomerAccount(await request('invariant-expected'), {
        actor: { type: 'system' },
        customerId: account.id,
        evidence: evidence('invariant-expected'),
        expectedRestrictions: [],
        expectedStatus: 'restricted',
        reason: 'invalid_expected_snapshot',
        restrictions: [],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_RESTRICTIONS_MISMATCH', status: 400 })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'restricted' })
  })

  it.each([
    ['non-array', {}],
    ['duplicate', ['purchase_disabled', 'purchase_disabled']],
    ['unknown', ['not_a_capability']],
  ] as const)('rejects %s restriction input at the transition boundary', async (_case, value) => {
    const account = await customer('active')
    await expect(
      transitionCustomerAccount(await request(`restriction-input-${_case}`), {
        actor: { type: 'system' },
        customerId: account.id,
        evidence: evidence(`restriction-input-${_case}`),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'invalid_restriction_input',
        restrictions: value as never,
        status: 'restricted',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTIONS_INVALID', status: 400 })
  })

  it('rejects a non-array persisted restriction snapshot with the stable storage error', () => {
    expect(() =>
      accountRestrictions({ capabilityRestrictions: {} as never, id: 1, status: 'active' }),
    ).toThrow(expect.objectContaining({ code: 'ACCOUNT_RESTRICTIONS_INVALID', status: 500 }))
  })

  it.each([
    ['non-array', {}],
    ['duplicate', ['purchase_disabled', 'purchase_disabled']],
    ['unknown', ['not_a_capability']],
  ] as const)(
    'rejects %s restrictions at the persisted customer field boundary',
    async (_case, value) => {
      const suffix = randomUUID()
      await expect(
        payload.create({
          collection: 'customers',
          data: {
            capabilityRestrictions: value as never,
            phone: `a3-invalid-${suffix}`,
            phoneMasked: `a3-***${suffix.slice(-4)}`,
            status: 'active',
          },
          overrideAccess: true,
        }),
      ).rejects.toThrow()
      await expect(
        payload.count({
          collection: 'customers',
          overrideAccess: true,
          where: { phone: { equals: `a3-invalid-${suffix}` } },
        }),
      ).resolves.toMatchObject({ totalDocs: 0 })
    },
  )

  it('rejects an unknown account status snapshot and a missing account lookup', async () => {
    expect(() =>
      assertCustomerAccountCapabilityFromSnapshot(
        { capabilityRestrictions: [], id: 1, status: 'future_state' },
        'login',
      ),
    ).toThrow(expect.objectContaining({ code: 'ACCOUNT_STATE_INVALID' }))
    await expect(
      assertCustomerAccountCapability(await request('missing-account'), 2_147_483_647, 'login'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND', status: 404 })
  })

  it('rejects same-state no-op transitions with the stable no-op code', async () => {
    const active = await customer('active')
    await expect(
      transitionCustomerAccount(await request('noop-active'), {
        actor: { type: 'system' },
        customerId: active.id,
        evidence: evidence('noop-active'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'noop_active',
        restrictions: [],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_NOOP', status: 409 })
    const restricted = await customer('restricted', ['purchase_disabled'])
    await expect(
      transitionCustomerAccount(await request('noop-restricted'), {
        actor: { type: 'system' },
        customerId: restricted.id,
        evidence: evidence('noop-restricted'),
        expectedRestrictions: ['purchase_disabled'],
        expectedStatus: 'restricted',
        reason: 'noop_restricted',
        restrictions: ['purchase_disabled'],
        status: 'restricted',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_NOOP', status: 409 })
  })

  it('allows a restricted replacement that only appends a capability restriction', async () => {
    const account = await customer('restricted', ['purchase_disabled'])
    await expect(
      transitionCustomerAccount(await request('replacement-append'), {
        actor: { type: 'system' },
        customerId: account.id,
        evidence: evidence('replacement-append'),
        expectedRestrictions: ['purchase_disabled'],
        expectedStatus: 'restricted',
        reason: 'append_refund_restriction',
        restrictions: ['purchase_disabled', 'refund_review'],
        status: 'restricted',
      }),
    ).resolves.toMatchObject({
      capabilityRestrictions: ['purchase_disabled', 'refund_review'],
      status: 'restricted',
    })
  })

  it('canonicalizes restriction order before comparison and persistence', () => {
    expect(
      accountRestrictions({
        capabilityRestrictions: ['purchase_disabled', 'login_disabled'],
        id: 1,
        status: 'restricted',
      }),
    ).toEqual(['login_disabled', 'purchase_disabled'])
  })

  it.each(capabilityCases)(
    'fails closed with $code for the $restriction restriction',
    async ({ capability, code, restriction }) => {
      const account = await customer('restricted', [restriction])
      await expect(
        assertCustomerAccountCapability(await request(code), account.id, capability),
      ).rejects.toMatchObject({ code, status: 403 })
    },
  )

  it.each([
    ['pending_registration', 'ACCOUNT_PENDING_REGISTRATION'],
    ['suspended', 'ACCOUNT_SUSPENDED'],
    ['closing', 'ACCOUNT_CLOSING'],
    ['closed', 'ACCOUNT_CLOSED'],
  ] as const)('fails closed for the %s status with %s', (status, code) => {
    for (const { capability } of capabilityCases) {
      expect(() =>
        assertCustomerAccountCapabilityFromSnapshot(
          { capabilityRestrictions: [], id: 1, status },
          capability,
        ),
      ).toThrow(expect.objectContaining({ code }))
    }
  })

  it('allows restricted login while denying login_disabled sessions with a stable code', async () => {
    const readable = await customer('restricted', ['purchase_disabled'])
    const readableSession = await createSession(readable.id)
    await expect(
      authenticatedCustomerRequest(
        payload,
        new Request('http://wanmi.local/api/v1/domains', {
          headers: {
            cookie: `${getEnv().CUSTOMER_SESSION_COOKIE}=${readableSession.token}`,
          },
        }),
      ),
    ).resolves.toMatchObject({ user: { id: readable.id, status: 'restricted' } })

    const blocked = await customer('restricted', ['login_disabled'])
    const blockedSession = await createSession(blocked.id)
    await expect(
      capturedError(() =>
        authenticatedCustomerRequest(
          payload,
          new Request('http://wanmi.local/api/v1/domains', {
            headers: {
              cookie: `${getEnv().CUSTOMER_SESSION_COOKIE}=${blockedSession.token}`,
            },
          }),
        ),
      ),
    ).resolves.toMatchObject({ code: 'ACCOUNT_LOGIN_DISABLED', status: 403 })
  })

  it('enforces the login capability at verified-login, strategy, and request restoration points', async () => {
    const phone = `139${String(randomInt(0, 100_000_000)).padStart(8, '0')}`
    const normalizedPhone = `+86${phone}`
    const account = await payload.create({
      collection: 'customers',
      data: {
        capabilityRestrictions: ['login_disabled'],
        phone: normalizedPhone,
        phoneMasked: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
        status: 'restricted',
      },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(normalizedPhone),
        boundAt: new Date().toISOString(),
        customer: account.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    await expect(
      authenticateVerifiedPhone(await request('surface-verified-login'), {
        deviceHash: hmac('a3-verified-device', getEnv().SESSION_PEPPER),
        ipHash: hmac('a3-verified-ip', getEnv().SESSION_PEPPER),
        phone,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_LOGIN_DISABLED', status: 403 })
    await expect(
      payload.count({
        collection: 'customerSessions',
        overrideAccess: true,
        where: { customer: { equals: account.id } },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })

    const { token } = await createSession(account.id)
    const cookie = `${getEnv().CUSTOMER_SESSION_COOKIE}=${token}`
    await expect(
      customerSessionStrategy.authenticate({
        headers: new Headers({ cookie }),
        payload,
      }),
    ).resolves.toEqual({ user: null })
    await expect(
      authenticatedCustomerRequest(
        payload,
        new Request('http://wanmi.local/api/v1/auth/session', { headers: { cookie } }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_LOGIN_DISABLED', status: 403 })
  })

  it('blocks existing purchase, identity, and domain-write entry points before partial work', async () => {
    const purchaseBlocked = await customer('restricted', ['purchase_disabled'])
    const purchaseReq = await request('surface-purchase')
    purchaseReq.user = { ...purchaseBlocked, collection: 'customers' }
    await expect(
      createCustomerOrder(
        purchaseReq,
        { quoteRef: randomUUID() },
        {
          customer: { collection: 'customers', id: purchaseBlocked.id, status: 'restricted' },
          provider: {} as never,
          traceId: 'surface-purchase',
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PURCHASE_DISABLED' })
    await expect(
      createWechatPayment(
        purchaseReq,
        'not-created',
        { channel: 'native' },
        {
          customer: { collection: 'customers', id: purchaseBlocked.id, status: 'restricted' },
          provider: {} as never,
          traceId: 'surface-payment',
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PURCHASE_DISABLED' })

    const identityBlocked = await customer('restricted', ['identity_change_disabled'])
    const identityReq = await request('surface-identity')
    identityReq.user = { ...identityBlocked, collection: 'customers' }
    await expect(
      bindVerifiedIdentity(identityReq, identityBlocked, randomOpaqueToken(), 'surface-bind'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_IDENTITY_CHANGE_DISABLED' })
    await expect(
      unbindCustomerIdentity(identityReq, identityBlocked, 999_999, 'surface-unbind'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_IDENTITY_CHANGE_DISABLED' })

    const domainBlocked = await customer('restricted', ['domain_write_disabled'])
    const domainReq = await request('surface-domain')
    domainReq.user = { ...domainBlocked, collection: 'customers' }
    await expect(
      requestCustomerNameserverChange(
        domainReq,
        999_999,
        {
          confirmed: true,
          deviceId: 'surface-domain-device-0001',
          nameservers: ['ns1.example.test', 'ns2.example.test'],
          stepUpToken: randomOpaqueToken(),
        },
        {
          customer: { collection: 'customers', id: domainBlocked.id, status: 'restricted' },
          traceId: 'surface-domain',
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DOMAIN_WRITE_DISABLED' })
  })

  it('blocks domain reads and both real-name customer surfaces when login is disabled', async () => {
    const blocked = await customer('restricted', ['login_disabled'])
    const req = await requestFor({ ...blocked, collection: 'customers' }, 'surface-read-gates')
    await expect(
      listCustomerDomainAssets(req, {
        collection: 'customers',
        id: blocked.id,
        status: 'restricted',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_LOGIN_DISABLED', status: 403 })
    await expect(createRealnameDocumentAccess(req, 2_147_483_647, 'view')).rejects.toMatchObject({
      code: 'ACCOUNT_LOGIN_DISABLED',
      status: 403,
    })
    await expect(createRealnameTemplate(req, {} as never)).rejects.toMatchObject({
      code: 'ACCOUNT_LOGIN_DISABLED',
      status: 403,
    })
  })

  it('requires step-up before account deletion or Name Server work can begin', async () => {
    const account = await customer('active')
    const req = await requestFor({ ...account, collection: 'customers' }, 'surface-step-up')
    const invalidGrant = {
      deviceId: 'a3-invalid-step-up-device',
      stepUpToken: randomOpaqueToken(),
    }
    await expect(requestCustomerDeletion(req, account, invalidGrant)).rejects.toMatchObject({
      code: 'STEP_UP_GRANT_INVALID',
      status: 403,
    })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'active' })
    await expect(
      requestCustomerNameserverChange(
        req,
        2_147_483_647,
        {
          ...invalidGrant,
          confirmed: true,
          nameservers: ['ns1.example.test', 'ns2.example.test'],
        },
        {
          customer: { collection: 'customers', id: account.id, status: 'active' },
          traceId: 'surface-step-up',
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID', status: 403 })
    await expect(
      payload.count({
        collection: 'nameserverChanges',
        overrideAccess: true,
        where: { customer: { equals: account.id } },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('rejects deletion source states before attempting step-up authorization', async () => {
    const account = await customer('suspended')
    const req = await requestFor({ ...account, collection: 'customers' }, 'deletion-source-state')
    await expect(
      requestCustomerDeletion(req, account, {
        deviceId: 'a3-invalid-state-device',
        stepUpToken: randomOpaqueToken(),
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_TRANSITION_INVALID', status: 409 })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'suspended' })
  })

  it('records a restricted self-closure request without prematurely transitioning or revoking sessions', async () => {
    const account = await customer('restricted', ['purchase_disabled'])
    const req = await requestFor({ ...account, collection: 'customers' }, 'deletion-transition')
    const grant = await issueStepUpGrantFixture(payload, req, account.id, 'account_deletion')
    const { session } = await createSession(account.id)
    await expect(requestCustomerDeletion(req, account, grant)).resolves.toMatchObject({
      status: 'pending',
    })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({
      capabilityRestrictions: ['purchase_disabled'],
      status: 'restricted',
    })
    await expect(
      payload.findByID({ collection: 'customerSessions', id: session.id, overrideAccess: true }),
    ).resolves.toEqual(expect.objectContaining({ revokedAt: null }))
  })

  it('rejects deletion and Name Server writes during cooldown despite valid purpose grants', async () => {
    const account = await customer('active')
    const cooled = await payload.update({
      collection: 'customers',
      data: { identityRiskCooldownStartedAt: new Date().toISOString() },
      id: account.id,
      overrideAccess: true,
    })
    const req = await request('surface-cooldown')
    req.user = { ...cooled, collection: 'customers' }

    const deletionGrant = await issueStepUpGrantFixture(
      payload,
      req,
      account.id,
      'account_deletion',
    )
    await expect(requestCustomerDeletion(req, cooled, deletionGrant)).rejects.toMatchObject({
      code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE',
      status: 403,
    })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'active' })

    const nameserverGrant = await issueStepUpGrantFixture(
      payload,
      req,
      account.id,
      'nameserver_change',
    )
    await expect(
      requestCustomerNameserverChange(
        req,
        999_999,
        {
          ...nameserverGrant,
          confirmed: true,
          nameservers: ['ns1.example.test', 'ns2.example.test'],
        },
        {
          customer: { collection: 'customers', id: account.id, status: 'active' },
          traceId: 'surface-cooldown',
        },
      ),
    ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE', status: 403 })
    await expect(
      payload.count({
        collection: 'nameserverChanges',
        overrideAccess: true,
        where: { customer: { equals: account.id } },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('rejects inconsistent active/restricted records instead of silently broadening access', () => {
    expect(() =>
      assertCustomerAccountCapabilityFromSnapshot(
        { capabilityRestrictions: ['purchase_disabled'], id: 1, status: 'active' },
        'login',
      ),
    ).toThrow(expect.objectContaining({ code: 'ACCOUNT_STATE_INVALID' }))
    expect(() =>
      assertCustomerAccountCapabilityFromSnapshot(
        { capabilityRestrictions: [], id: 1, status: 'restricted' },
        'login',
      ),
    ).toThrow(expect.objectContaining({ code: 'ACCOUNT_STATE_INVALID' }))
  })

  it.each(transitionCases)(
    'atomically allows exactly one of 8 concurrent $from -> $to transitions',
    async ({ from, to }) => {
      const account = await customer(from)
      const expectedRestrictions = restrictionsFor(from)
      const restrictions = restrictionsFor(to)
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, async (_, index) =>
          transitionCustomerAccount(await request(`${from}-${to}-${index}`), {
            actor: { type: 'system' },
            customerId: account.id,
            evidence: evidence(`${from}-${to}`),
            expectedRestrictions,
            expectedStatus: from,
            reason: `concurrent_${from}_to_${to}`,
            restrictions,
            status: to,
          }),
        ),
      )
      const fulfilled = results.filter((result) => result.status === 'fulfilled')
      const rejected = results.filter((result) => result.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(7)
      expect(
        rejected.every((result) => result.reason?.code === 'ACCOUNT_STATE_TRANSITION_CONFLICT'),
      ).toBe(true)
      await expect(storedCustomer(account.id)).resolves.toMatchObject({
        capabilityRestrictions: restrictions,
        status: to,
      })
      await expect(
        payload.count({
          collection: 'customerSecurityEvents',
          overrideAccess: true,
          where: {
            and: [
              { customer: { equals: account.id } },
              { event: { equals: 'account_state_changed' } },
            ],
          },
        }),
      ).resolves.toMatchObject({ totalDocs: 1 })
      await expect(
        payload.count({
          collection: 'auditLogs',
          overrideAccess: true,
          where: {
            and: [
              { action: { equals: 'customer.account_state.changed' } },
              { targetId: { equals: String(account.id) } },
            ],
          },
        }),
      ).resolves.toMatchObject({ totalDocs: 1 })
    },
  )

  it('atomically allows exactly one concurrent restricted capability-set replacement', async () => {
    const account = await customer('restricted', ['purchase_disabled'])
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        transitionCustomerAccount(await request(`restrictions-${index}`), {
          actor: { type: 'system' },
          customerId: account.id,
          evidence: evidence('replace-restrictions'),
          expectedRestrictions: ['purchase_disabled'],
          expectedStatus: 'restricted',
          reason: 'replace_capability_restrictions',
          restrictions: ['domain_write_disabled'],
          status: 'restricted',
        }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(7)
    await expect(storedCustomer(account.id)).resolves.toMatchObject({
      capabilityRestrictions: ['domain_write_disabled'],
      status: 'restricted',
    })
  })

  it('revokes sessions when a non-operational state blocks login', async () => {
    const account = await customer('active')
    const { session } = await createSession(account.id)
    await transitionCustomerAccount(await request('auto-revoke-status'), {
      actor: { type: 'system' },
      customerId: account.id,
      evidence: evidence('auto-revoke-status'),
      expectedRestrictions: [],
      expectedStatus: 'active',
      reason: 'security_suspension',
      restrictions: [],
      status: 'suspended',
    })
    await expect(
      payload.findByID({ collection: 'customerSessions', id: session.id, overrideAccess: true }),
    ).resolves.toEqual(expect.objectContaining({ revokedAt: expect.any(String) }))
    await expect(
      payload.count({
        collection: 'auditLogs',
        overrideAccess: true,
        where: {
          and: [
            { action: { equals: 'customer.account_sessions.revoked' } },
            { targetId: { equals: String(account.id) } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 1 })
  })

  it('revokes sessions when restricted gains login_disabled', async () => {
    const account = await customer('active')
    const { session } = await createSession(account.id)
    await transitionCustomerAccount(await request('auto-revoke-restriction'), {
      actor: { type: 'system' },
      customerId: account.id,
      evidence: evidence('auto-revoke-restriction'),
      expectedRestrictions: [],
      expectedStatus: 'active',
      reason: 'disable_login',
      restrictions: ['login_disabled'],
      status: 'restricted',
    })
    await expect(
      payload.findByID({ collection: 'customerSessions', id: session.id, overrideAccess: true }),
    ).resolves.toEqual(expect.objectContaining({ revokedAt: expect.any(String) }))
  })

  it('does not revoke sessions for a restricted capability that leaves login enabled', async () => {
    const account = await customer('active')
    const { session } = await createSession(account.id)
    await transitionCustomerAccount(await request('auto-revoke-not-needed'), {
      actor: { type: 'system' },
      customerId: account.id,
      evidence: evidence('auto-revoke-not-needed'),
      expectedRestrictions: [],
      expectedStatus: 'active',
      reason: 'disable_purchase_only',
      restrictions: ['purchase_disabled'],
      status: 'restricted',
    })
    await expect(
      payload.findByID({ collection: 'customerSessions', id: session.id, overrideAccess: true }),
    ).resolves.toMatchObject({ revokedAt: null })
  })

  it('sets deletionRequestedAt on closing and clears it only when closing returns to active', async () => {
    const account = await customer('active')
    const closing = await transitionCustomerAccount(await request('closing-date-set'), {
      actor: { type: 'system' },
      changedAt: '2026-08-16T08:00:00.000Z',
      customerId: account.id,
      evidence: evidence('closing-date-set'),
      expectedRestrictions: [],
      expectedStatus: 'active',
      reason: 'start_closure',
      restrictions: [],
      status: 'closing',
    })
    expect(closing.deletionRequestedAt).toBe('2026-08-16T08:00:00.000Z')
    await expect(storedCustomer(account.id)).resolves.toMatchObject({
      deletionRequestedAt: '2026-08-16T08:00:00.000Z',
      status: 'closing',
    })
    const restored = await transitionCustomerAccount(await request('closing-date-clear'), {
      actor: { type: 'system' },
      customerId: account.id,
      evidence: evidence('closing-date-clear'),
      expectedRestrictions: [],
      expectedStatus: 'closing',
      reason: 'cancel_closure',
      restrictions: [],
      status: 'active',
    })
    expect(restored.deletionRequestedAt).toBeUndefined()
    await expect(storedCustomer(account.id)).resolves.toMatchObject({
      deletionRequestedAt: null,
      status: 'active',
    })
  })

  it('records reason, operator, evidence, time, prior state, and resulting restrictions append-only', async () => {
    const account = await customer('active')
    const changeEvidence = evidence('append-only-audit')
    const changed = await transitionCustomerAccount(await request('append-only-audit'), {
      actor: { type: 'system' },
      customerId: account.id,
      evidence: changeEvidence,
      expectedRestrictions: [],
      expectedStatus: 'active',
      reason: 'automated_security_signal',
      restrictions: ['login_disabled', 'purchase_disabled'],
      status: 'restricted',
    })
    const securityEvents = await payload.find({
      collection: 'customerSecurityEvents',
      limit: 2,
      overrideAccess: true,
      where: {
        and: [{ customer: { equals: account.id } }, { event: { equals: 'account_state_changed' } }],
      },
    })
    expect(securityEvents.docs).toHaveLength(1)
    expect(securityEvents.docs[0]?.safeMetadata).toMatchObject({
      actor: { type: 'system' },
      changedAt: changed.changedAt,
      evidence: changeEvidence,
      from: { capabilityRestrictions: [], status: 'active' },
      reason: 'automated_security_signal',
      to: {
        capabilityRestrictions: ['login_disabled', 'purchase_disabled'],
        status: 'restricted',
      },
    })
    const auditEvents = await payload.find({
      collection: 'auditLogs',
      limit: 2,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'customer.account_state.changed' } },
          { targetId: { equals: String(account.id) } },
        ],
      },
    })
    expect(auditEvents.docs).toHaveLength(1)
    expect(auditEvents.docs[0]).toMatchObject({
      actorType: 'system',
      metadata: {
        changedAt: changed.changedAt,
        evidence: changeEvidence,
        reason: 'automated_security_signal',
      },
    })
  })

  it('rejects unlisted and no-op transitions before writing an audit event', async () => {
    const account = await customer('closed')
    await expect(
      transitionCustomerAccount(await request('invalid-transition'), {
        actor: { type: 'system' },
        customerId: account.id,
        evidence: evidence('invalid-transition'),
        expectedRestrictions: [],
        expectedStatus: 'closed',
        reason: 'invalid_reopen_attempt',
        restrictions: [],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_TRANSITION_INVALID' })
    await expect(
      payload.count({
        collection: 'auditLogs',
        overrideAccess: true,
        where: {
          and: [
            { action: { equals: 'customer.account_state.changed' } },
            { targetId: { equals: String(account.id) } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('keeps the account-state CAS target id predicate behaviorally necessary', async () => {
    const decoy = await customer('restricted', ['balance_spend_disabled', 'refund_review'])
    const target = await customer('active')
    await expect(
      transitionCustomerAccount(await request('predicate-state-id'), {
        actor: { type: 'system' },
        customerId: target.id,
        evidence: evidence('predicate-state-id'),
        expectedRestrictions: ['balance_spend_disabled', 'refund_review'],
        expectedStatus: 'restricted',
        reason: 'predicate_state_id',
        restrictions: [],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_TRANSITION_CONFLICT' })
    await expect(storedCustomer(target.id)).resolves.toMatchObject({ status: 'active' })
    await expect(storedCustomer(decoy.id)).resolves.toMatchObject({
      capabilityRestrictions: ['balance_spend_disabled', 'refund_review'],
      status: 'restricted',
    })
  })

  it('keeps the account-state CAS expected status predicate behaviorally necessary', async () => {
    const account = await customer('suspended')
    await expect(
      transitionCustomerAccount(await request('predicate-state-status'), {
        actor: { type: 'system' },
        customerId: account.id,
        evidence: evidence('predicate-state-status'),
        expectedRestrictions: [],
        expectedStatus: 'active',
        reason: 'predicate_state_status',
        restrictions: ['purchase_disabled'],
        status: 'restricted',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_TRANSITION_CONFLICT' })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({ status: 'suspended' })
  })

  it('keeps the account-state CAS expected restrictions predicate behaviorally necessary', async () => {
    const account = await customer('restricted', ['login_disabled'])
    await expect(
      transitionCustomerAccount(await request('predicate-state-restrictions'), {
        actor: { type: 'system' },
        customerId: account.id,
        evidence: evidence('predicate-state-restrictions'),
        expectedRestrictions: ['purchase_disabled'],
        expectedStatus: 'restricted',
        reason: 'predicate_state_restrictions',
        restrictions: [],
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_TRANSITION_CONFLICT' })
    await expect(storedCustomer(account.id)).resolves.toMatchObject({
      capabilityRestrictions: ['login_disabled'],
      status: 'restricted',
    })
  })

  it('keeps the revoke-all customer id predicate behaviorally necessary', async () => {
    const target = await customer('active')
    const foreign = await customer('active')
    const { session } = await createSession(foreign.id)
    await expect(
      revokeAllCustomerSessions(await request('predicate-session-customer'), target.id, 'test'),
    ).resolves.toBe(0)
    await expect(
      payload.findByID({
        collection: 'customerSessions',
        id: session.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ revokedAt: null })
  })

  it('keeps the revoke-all active-session predicate behaviorally necessary', async () => {
    const account = await customer('active')
    const originallyRevokedAt = new Date(Date.now() - 60_000).toISOString()
    const { session } = await createSession(account.id, originallyRevokedAt)
    await expect(
      revokeAllCustomerSessions(await request('predicate-session-active'), account.id, 'test'),
    ).resolves.toBe(0)
    await expect(
      payload.findByID({
        collection: 'customerSessions',
        id: session.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ revokedAt: originallyRevokedAt })
  })

  it('revokes every target session in one security action without touching another customer', async () => {
    const account = await customer('active')
    const foreign = await customer('active')
    await Promise.all([createSession(account.id), createSession(account.id)])
    const foreignSession = await createSession(foreign.id)
    await expect(
      revokeCustomerSessionsForSecurityEvent(await request('security-revoke'), {
        actor: { type: 'system' },
        customerId: account.id,
        evidence: evidence('security-revoke'),
        reason: 'credential_compromise_reported',
      }),
    ).resolves.toEqual({ revokedCount: 2 })
    await expect(
      payload.count({
        collection: 'customerSessions',
        overrideAccess: true,
        where: {
          and: [{ customer: { equals: account.id } }, { revokedAt: { exists: false } }],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
    await expect(
      payload.findByID({
        collection: 'customerSessions',
        id: foreignSession.session.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ revokedAt: null })
    await expect(
      payload.count({
        collection: 'auditLogs',
        overrideAccess: true,
        where: {
          and: [
            { action: { equals: 'customer.account_sessions.revoked' } },
            { targetId: { equals: String(account.id) } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 1 })
    await expect(
      payload.count({
        collection: 'customerSecurityEvents',
        overrideAccess: true,
        where: {
          and: [{ customer: { equals: account.id } }, { event: { equals: 'sessions_revoked' } }],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 1 })
  })

  it('rejects unauthorized use of the one-action security session revocation service', async () => {
    const account = await customer('active')
    const { session } = await createSession(account.id)
    const req = await requestFor({ ...account, collection: 'customers' }, 'security-revoke-auth')
    await expect(
      revokeCustomerSessionsForSecurityEvent(req, {
        actor: { id: account.id, type: 'customer' },
        customerId: account.id,
        evidence: evidence('security-revoke-auth'),
        reason: 'unauthorized_self_revoke_security_action',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_STATE_CHANGE_FORBIDDEN', status: 403 })
    await expect(
      payload.findByID({ collection: 'customerSessions', id: session.id, overrideAccess: true }),
    ).resolves.toMatchObject({ revokedAt: null })
    await expect(
      payload.count({
        collection: 'auditLogs',
        overrideAccess: true,
        where: {
          and: [
            { action: { equals: 'customer.account_sessions.revoked' } },
            { targetId: { equals: String(account.id) } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('keeps logout-all routed through the all-session revocation branch', async () => {
    const account = await customer('active')
    const first = await createSession(account.id)
    const second = await createSession(account.id)
    await revokeSessions(await request('logout-all-branch'), first.token, 'all')
    await expect(
      payload.count({
        collection: 'customerSessions',
        overrideAccess: true,
        where: {
          and: [{ customer: { equals: account.id } }, { revokedAt: { exists: false } }],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
    await expect(
      payload.findByID({
        collection: 'customerSessions',
        id: second.session.id,
        overrideAccess: true,
      }),
    ).resolves.toEqual(expect.objectContaining({ revokedAt: expect.any(String) }))
  })

  it('keeps every application SQL WHERE predicate as a supplemental source contract', () => {
    expect(accountStateSource).toContain('WHERE id = ${input.customerId}')
    expect(accountStateSource).toContain('AND status = ${input.expectedStatus}')
    expect(accountStateSource).toContain(
      'AND capability_restrictions = ${expectedRestrictionsJson}::jsonb',
    )
    expect(customerSessionsSource).toContain('WHERE customer_id = ${customerId}')
    expect(customerSessionsSource).toContain('AND revoked_at IS NULL')
  })
})
