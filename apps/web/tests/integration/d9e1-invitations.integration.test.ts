import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest, type Where } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import type { Admin, Customer, Order } from '@/payload-types'
import { clientHashes, maskPhone } from '@/services/auth/client-facts'
import { transitionOrder } from '@/services/commerce/order-state'
import {
  bindCustomerInvitation,
  disableCustomerInvitationCode,
  generateInvitationCode,
} from '@/services/invitations/binding'
import {
  processInvitationRewardForOrderTransition,
  recheckInvitationRewardClaim,
  scanReleasedInvitationRewardsForAbuse,
} from '@/services/invitations/rewards'
import { createInvitationRewardRuleVersion } from '@/services/invitations/rules'
import {
  confirmPendingInvitationReward,
  earnPendingInvitationReward,
  readPointsBalance,
} from '@/services/points/ledger'

import { ensureAnchorSystemAdmin } from '../test-cleanup'
import { fulfillmentQuoteSnapshotFixture } from '../fixtures/commerce'
import { realnameTemplateFixture } from '../fixtures/realname'

const fixturePrefix = `d9e1-invitations-${randomUUID()}`
const customerIds: number[] = []
let admin: Admin
let payload: Payload
const ruleIds: Array<number | string> = []

function phone(): string {
  return `+86196${randomInt(10_000_000, 100_000_000)}`
}

function headers(suffix: string): Headers {
  return new Headers({
    'user-agent': 'Wanmi D9-E-1 integration fixture',
    'x-forwarded-for': `203.0.113.${(suffix.length % 200) + 1}`,
    'x-request-id': `${fixturePrefix}-${suffix}`,
  })
}

async function request(suffix: string, user?: Admin | Customer): Promise<PayloadRequest> {
  const req = await createLocalReq({ req: { headers: headers(suffix) } }, payload)
  if (user) req.user = { ...user, collection: 'roles' in user ? 'admins' : 'customers' } as never
  return req
}

async function createCustomer(suffix: string): Promise<Customer> {
  if (suffix.length === 0) throw new Error('customer fixture suffix is required')
  const customerPhone = phone()
  const customer = await payload.create({
    collection: 'customers',
    data: {
      accountType: 'registered',
      capabilityRestrictions: [],
      defaultCustomerProfileType: 'individual',
      inviteCode: generateInvitationCode(),
      phone: customerPhone,
      phoneMasked: maskPhone(customerPhone),
      registrationSource: 'phone',
      status: 'active',
    },
    overrideAccess: true,
  })
  customerIds.push(customer.id)
  return customer
}

async function bind(
  inviter: Customer,
  invitee: Customer,
  suffix: string,
  deviceId = `${fixturePrefix}-device-${suffix}`,
) {
  const reqHeaders = headers(`bind-${suffix}`)
  const req = await createLocalReq({ req: { headers: reqHeaders } }, payload)
  req.user = { ...invitee, collection: 'customers' } as never
  const relationship = await bindCustomerInvitation(req, {
    code: inviter.inviteCode!,
    deviceId,
    headers: reqHeaders,
  })
  return { deviceHash: clientHashes(reqHeaders, deviceId).deviceHash, relationship }
}

async function createOrder(
  customer: Customer,
  suffix: string,
  status: 'fulfilling' | 'paid' | 'pending_payment' | 'succeeded' = 'paid',
): Promise<Order> {
  const now = new Date()
  const domainAscii = `${suffix}-${randomUUID()}.example`
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `invite-${suffix}`.slice(0, 64) }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  const quote = await payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: now.toISOString(),
      availabilityRequestId: `${fixturePrefix}-${suffix}-availability`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `${fixturePrefix}-${suffix}-quote`,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: now.toISOString(),
      providerProductId: `${fixturePrefix}-${suffix}-product`,
      providerRequestId: `${fixturePrefix}-${suffix}-price`,
      quotedAt: now.toISOString(),
      quoteIntegrityHash: 'a'.repeat(64),
      quoteRef: randomUUID(),
      registrationPriceMinor: 1_200,
      renewalPriceMinor: 1_200,
      ruleFixedAmountMinor: 0,
      ruleKey: `${fixturePrefix}-${suffix}-rule`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
      roundingMode: 'half_up_to_fen',
      schemaVersion: 1,
      sourceCalculationHash: 'b'.repeat(64),
      sourcePriceSnapshotRef: randomUUID(),
      tld: 'example',
      upstreamCostMinor: 1_200,
      upstreamRegistrationPriceMinor: 1_200,
      upstreamRenewalPriceMinor: 1_200,
      userPriceMinor: 1_200,
      years: 1,
    },
    overrideAccess: true,
  })
  return payload.create({
    collection: 'orders',
    data: {
      amountMinor: 1_200,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      orderNumber: `${fixturePrefix}-${suffix}-${randomUUID()}`,
      quote: quote.id,
      quoteSnapshot: fulfillmentQuoteSnapshotFixture({
        amountMinor: 1_200,
        customerId: customer.id,
        domainAscii,
        quoteId: quote.id,
      }),
      realnameTemplate: template.id,
      status,
    },
    overrideAccess: true,
  })
}

async function count(collection: Parameters<Payload['count']>[0]['collection'], where: Where) {
  return (
    await payload.count({
      collection,
      overrideAccess: true,
      where,
    } as never)
  ).totalDocs
}

async function moveToFulfilling(order: Order, suffix: string) {
  return transitionOrder(await request(`${suffix}-fulfilling`), order.id, 'fulfilling', {
    actorType: 'system',
    evidence: { traceId: `${fixturePrefix}-${suffix}-fulfilling` },
    reasonCode: 'fixture.fulfillment_started',
  })
}

async function moveToPaid(order: Order, suffix: string) {
  return transitionOrder(await request(`${suffix}-paid`), order.id, 'paid', {
    actorType: 'system',
    evidence: { traceId: `${fixturePrefix}-${suffix}-paid` },
    reasonCode: 'fixture.payment_confirmed',
  })
}

async function moveToSucceeded(order: Order, suffix: string) {
  return transitionOrder(await request(`${suffix}-succeeded`), order.id, 'succeeded', {
    actorType: 'system',
    evidence: { traceId: `${fixturePrefix}-${suffix}-succeeded` },
    reasonCode: 'fixture.fulfillment_succeeded',
  })
}

async function addPhoneSignal(inviter: Customer, invitee: Customer, suffix: string) {
  const identifierHash = hmac(`${fixturePrefix}-${suffix}-same-phone`, getEnv().SESSION_PEPPER)
  for (const [customer, providerInstanceId] of [
    [inviter, `${fixturePrefix}-phone-a`],
    [invitee, `${fixturePrefix}-phone-b`],
  ] as const) {
    await payload.create({
      collection: 'customerIdentities',
      data: {
        boundAt: new Date().toISOString(),
        customer: customer.id,
        identifierEncrypted: `${fixturePrefix}-not-read`,
        identifierHash,
        provider: 'phone',
        providerInstanceId,
        status: 'unbound',
        unboundAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
  }
}

async function addRealnameSignal(inviter: Customer, order: Order, suffix: string) {
  const source = await payload.findByID({
    collection: 'realnameTemplates',
    id:
      typeof order.realnameTemplate === 'object'
        ? order.realnameTemplate.id
        : order.realnameTemplate,
    overrideAccess: true,
  })
  await payload.db.pool.query(
    `UPDATE realname_templates
     SET status = 'approved', provider_review_state = 'approved', updated_at = NOW()
     WHERE id = $1`,
    [source.id],
  )
  const inviterTemplate = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({
        displayName: `same-subject-${suffix}`.slice(0, 64),
        identityDocumentNumber: source.identityDocumentNumber,
        identityDocumentType: source.identityDocumentType,
      }),
      customer: inviter.id,
    },
    overrideAccess: true,
  })
  await payload.db.pool.query(
    `UPDATE realname_templates
     SET status = 'approved', provider_review_state = 'approved', updated_at = NOW()
     WHERE id = $1`,
    [inviterTemplate.id],
  )
}

async function addPaymentSignal(
  inviter: Customer,
  invitee: Customer,
  order: Order,
  suffix: string,
) {
  const inviterOrder = await createOrder(inviter, `${suffix}-inviter-payment`, 'succeeded')
  const inviteeHistoricalOrder = await createOrder(
    invitee,
    `${suffix}-invitee-historical-payment`,
    'succeeded',
  )
  const payerIdentifierHash = hmac(`${fixturePrefix}-${suffix}-payer`, getEnv().SESSION_PEPPER)
  for (const [paymentOrder, customerSuffix] of [
    [inviterOrder, 'inviter'],
    [inviteeHistoricalOrder, 'invitee'],
  ] as const) {
    const timestamp = new Date().toISOString()
    await payload.create({
      collection: 'paymentNotifications',
      data: {
        amountMinor: 1_200,
        confirmationStatus: 'confirmed',
        currency: 'CNY',
        merchantOrderNumber: `${fixturePrefix}-${suffix}-${customerSuffix}-merchant`,
        notificationId: `${fixturePrefix}-${suffix}-${customerSuffix}-notification`,
        order: paymentOrder.id,
        paidAt: timestamp,
        payerIdentifierHash,
        payloadDigest: hmac(`${suffix}-${customerSuffix}`, getEnv().SESSION_PEPPER),
        receivedAt: timestamp,
        signatureVerified: true,
        source: 'query',
        wechatTransactionId: `${fixturePrefix}-${suffix}-${customerSuffix}-transaction`,
      },
      overrideAccess: true,
    })
  }
  expect(JSON.stringify(payerIdentifierHash)).not.toContain(`${fixturePrefix}-${suffix}-payer`)
  expect(invitee.id).not.toBe(inviter.id)
  expect(inviteeHistoricalOrder.id).not.toBe(order.id)
}

async function addDeviceSignal(inviter: Customer, deviceHash: string, suffix: string) {
  await payload.create({
    collection: 'customerSessions',
    data: {
      customer: inviter.id,
      deviceHash,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ipHash: hmac(`${suffix}-ip`, getEnv().SESSION_PEPPER),
      lastSeenAt: new Date().toISOString(),
      tokenHash: hmac(`${fixturePrefix}-${suffix}-token`, getEnv().SESSION_PEPPER),
    },
    overrideAccess: true,
  })
}

async function claimIdForInvitee(invitee: Customer): Promise<number> {
  const found = await payload.find({
    collection: 'invitationRewardClaims',
    limit: 1,
    overrideAccess: true,
    where: { inviteeCustomer: { equals: invitee.id } },
  })
  if (!found.docs[0]) throw new Error('Expected invitation reward claim')
  return found.docs[0].id
}

beforeAll(async () => {
  payload = await getPayload({ config })
  admin = await ensureAnchorSystemAdmin(payload)
  const configured = await createInvitationRewardRuleVersion(await request('rule', admin), {
    bindingWindowHours: 72,
    changeNote: 'D9-E-1 integration fixture rule',
    effectiveAt: new Date(Date.now() - 60_000).toISOString(),
    enabled: true,
    rewardExpiryDays: 365,
    rewardPoints: 88,
  })
  ruleIds.push(configured.id)
})

afterEach(async () => {
  if (customerIds.length === 0) return
  const ids = [...customerIds]
  await payload.db.pool.query(
    `DELETE FROM notification_deliveries WHERE customer_id = ANY($1::int[])`,
    [ids],
  )
  await payload.db.pool.query(
    `DELETE FROM notification_outbox_events WHERE customer_id = ANY($1::int[])`,
    [ids],
  )
  await payload.db.pool.query(`DELETE FROM manual_reviews WHERE customer_id = ANY($1::int[])`, [
    ids,
  ])
  await payload.db.pool.query(
    `DELETE FROM payment_notifications
     WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))`,
    [ids],
  )
  await payload.db.pool.query(
    `DELETE FROM invitation_reward_events_signals
     WHERE parent_id IN (SELECT id FROM invitation_reward_events WHERE inviter_customer_id = ANY($1::int[]))`,
    [ids],
  )
  for (const table of [
    'invitation_reward_events',
    'points_ledger',
    'points_batches',
    'points_accounts',
    'invitation_reward_claims',
    'invitation_relationships',
    'customer_sessions',
    'customer_identities',
    'order_events',
    'orders',
    'quotes',
    'realname_templates',
  ]) {
    const customerColumn =
      table.startsWith('invitation_reward') || table === 'invitation_relationships'
        ? table === 'invitation_relationships'
          ? 'inviter_customer_id'
          : 'inviter_customer_id'
        : 'customer_id'
    await payload.db.pool.query(`DELETE FROM ${table} WHERE ${customerColumn} = ANY($1::int[])`, [
      ids,
    ])
  }
  await payload.db.pool.query(
    `DELETE FROM audit_logs WHERE trace_id LIKE $1 OR actor_id = ANY($2::text[])`,
    [`${fixturePrefix}-%`, ids.map(String)],
  )
  await payload.db.pool.query(`DELETE FROM customers WHERE id = ANY($1::int[])`, [ids])
  customerIds.length = 0
})

afterAll(async () => {
  if (ruleIds.length > 0) {
    await payload.db.pool.query(
      `DELETE FROM invitation_reward_rule_versions WHERE id = ANY($1::int[])`,
      [ruleIds.map(Number)],
    )
  }
  await payload.db.destroy?.()
})

describe('D9-E-1 invitation binding and reward lifecycle', () => {
  it('enforces customer authentication, A3 login capability, and system-admin rule ownership', async () => {
    const inviter = await createCustomer('authorization-inviter')
    const invitee = await createCustomer('authorization-invitee')
    const anonymous = await request('authorization-anonymous')
    await expect(
      bindCustomerInvitation(anonymous, {
        code: inviter.inviteCode!,
        deviceId: `${fixturePrefix}-authorization-anonymous-device`,
        headers: headers('authorization-anonymous'),
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
    await expect(disableCustomerInvitationCode(anonymous)).rejects.toMatchObject({
      code: 'CUSTOMER_AUTH_REQUIRED',
    })

    await payload.db.pool.query(`UPDATE customers SET status = 'suspended' WHERE id = $1`, [
      invitee.id,
    ])
    await expect(bind(inviter, invitee, 'authorization-suspended')).rejects.toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
    })
    await payload.db.pool.query(`UPDATE customers SET status = 'suspended' WHERE id = $1`, [
      inviter.id,
    ])
    await expect(
      disableCustomerInvitationCode(await request('authorization-disable-suspended', inviter)),
    ).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' })
    await expect(
      createInvitationRewardRuleVersion(await request('authorization-rule', inviter), {
        bindingWindowHours: 24,
        changeNote: 'must not be created by customer',
        effectiveAt: new Date().toISOString(),
        enabled: true,
        rewardExpiryDays: 365,
        rewardPoints: 1,
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_ROLE_REQUIRED' })
    await expect(
      createInvitationRewardRuleVersion(await request('authorization-invalid-rule', admin), {
        bindingWindowHours: 0,
        changeNote: 'invalid zero window',
        effectiveAt: new Date().toISOString(),
        enabled: true,
        rewardExpiryDays: 365,
        rewardPoints: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_RULE_INVALID' })
    await expect(
      count('invitationRelationships', { inviteeCustomer: { equals: invitee.id } }),
    ).resolves.toBe(0)
  })

  it('does not bind a disabled invitation code', async () => {
    const inviter = await createCustomer('disabled-inviter')
    const invitee = await createCustomer('disabled-invitee')
    const customerWithoutCode = await createCustomer('disabled-no-code')
    await payload.db.pool.query(`UPDATE customers SET invite_code = NULL WHERE id = $1`, [
      customerWithoutCode.id,
    ])
    await expect(
      disableCustomerInvitationCode(await request('disable-no-code', customerWithoutCode)),
    ).rejects.toMatchObject({ code: 'INVITATION_CODE_UNAVAILABLE' })
    await disableCustomerInvitationCode(await request('disable-code', inviter))
    await expect(bind(inviter, invitee, 'disabled')).rejects.toMatchObject({
      code: 'INVITATION_CODE_DISABLED',
    })
    await expect(
      count('invitationRelationships', { inviteeCustomer: { equals: invitee.id } }),
    ).resolves.toBe(0)
    await expect(
      count('auditLogs', {
        and: [
          { action: { equals: 'invitation.code.disabled' } },
          { actorId: { equals: String(inviter.id) } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('rejects self-invitation and an otherwise valid but unknown code independently', async () => {
    const customer = await createCustomer('invalid-code-customer')
    await expect(bind(customer, customer, 'self')).rejects.toMatchObject({
      code: 'INVITATION_SELF_BIND_FORBIDDEN',
    })
    await expect(
      bindCustomerInvitation(await request('unknown-code', customer), {
        code: generateInvitationCode(),
        deviceId: `${fixturePrefix}-unknown-code-device`,
        headers: headers('unknown-code'),
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_CODE_INVALID' })
    await expect(
      count('invitationRelationships', { inviteeCustomer: { equals: customer.id } }),
    ).resolves.toBe(0)
  })

  it('rejects a second binding and preserves the first immutable relationship', async () => {
    const firstInviter = await createCustomer('first-inviter')
    const secondInviter = await createCustomer('second-inviter')
    const invitee = await createCustomer('twice-invitee')
    const firstBindingPromise = bind(firstInviter, invitee, 'first')
    await expect(firstBindingPromise).resolves.toMatchObject({
      relationship: { inviterCustomerId: firstInviter.id },
    })
    const firstBinding = await firstBindingPromise
    await expect(bind(secondInviter, invitee, 'second')).rejects.toMatchObject({
      code: 'INVITATION_ALREADY_BOUND',
    })
    const relationships = await payload.find({
      collection: 'invitationRelationships',
      overrideAccess: true,
      where: { inviteeCustomer: { equals: invitee.id } },
    })
    expect(relationships.totalDocs).toBe(1)
    expect(
      typeof relationships.docs[0]?.inviterCustomer === 'object'
        ? relationships.docs[0].inviterCustomer.id
        : relationships.docs[0]?.inviterCustomer,
    ).toBe(firstInviter.id)
    expect(relationships.docs[0]?.bindingDeviceHash).toBe(firstBinding.deviceHash)
    expect(JSON.stringify(relationships.docs[0])).not.toContain(`${fixturePrefix}-device-first`)
    await expect(
      count('auditLogs', {
        and: [
          { action: { equals: 'invitation.relationship.bound' } },
          { actorId: { equals: String(invitee.id) } },
        ],
      }),
    ).resolves.toBe(1)
    const rejectedAudits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'invitation.relationship.binding_rejected' } },
          { actorId: { equals: String(invitee.id) } },
        ],
      },
    })
    expect(rejectedAudits.totalDocs).toBe(1)
    expect(rejectedAudits.docs[0]?.metadata).toMatchObject({ reason: 'already_bound' })
  })

  it('fails closed when the legacy customer projection disagrees with the append-only relation', async () => {
    const projectedInviter = await createCustomer('projection-existing-inviter')
    const requestedInviter = await createCustomer('projection-requested-inviter')
    const invitee = await createCustomer('projection-invitee')
    await payload.db.pool.query(`UPDATE customers SET invited_by_customer_id = $1 WHERE id = $2`, [
      projectedInviter.id,
      invitee.id,
    ])
    await expect(bind(requestedInviter, invitee, 'projection-conflict')).rejects.toMatchObject({
      code: 'INVITATION_BINDING_CONFLICT',
    })
    await expect(
      count('invitationRelationships', { inviteeCustomer: { equals: invitee.id } }),
    ).resolves.toBe(0)
  })

  it('rejects binding outside the server-computed window', async () => {
    const inviter = await createCustomer('expired-inviter')
    const invitee = await createCustomer('expired-invitee')
    await payload.db.pool.query(
      `UPDATE customers SET created_at = NOW() - INTERVAL '73 hours' WHERE id = $1`,
      [invitee.id],
    )
    await expect(bind(inviter, invitee, 'expired')).rejects.toMatchObject({
      code: 'INVITATION_BINDING_WINDOW_EXPIRED',
    })
    await expect(
      count('invitationRelationships', { inviteeCustomer: { equals: invitee.id } }),
    ).resolves.toBe(0)
    const rejectedAudits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'invitation.relationship.binding_rejected' } },
          { actorId: { equals: String(invitee.id) } },
        ],
      },
    })
    expect(rejectedAudits.totalDocs).toBe(1)
    expect(rejectedAudits.docs[0]?.metadata).toMatchObject({ reason: 'window_expired' })
  })

  it('lets exactly one concurrent binding take effect', async () => {
    const inviterA = await createCustomer('concurrent-inviter-a')
    const inviterB = await createCustomer('concurrent-inviter-b')
    const invitee = await createCustomer('concurrent-invitee')
    const attempts = await Promise.allSettled([
      bind(inviterA, invitee, 'concurrent-a'),
      bind(inviterB, invitee, 'concurrent-b'),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    await expect(
      count('invitationRelationships', { inviteeCustomer: { equals: invitee.id } }),
    ).resolves.toBe(1)
  })

  it('does not create a reward claim while the latest versioned rule is disabled', async () => {
    const disabledRule = await createInvitationRewardRuleVersion(
      await request('disabled-rule', admin),
      {
        bindingWindowHours: 48,
        changeNote: 'D9-E-1 disabled rule fixture',
        effectiveAt: new Date(Date.now() - 500).toISOString(),
        enabled: false,
        rewardExpiryDays: 365,
        rewardPoints: 777,
      },
    )
    ruleIds.push(disabledRule.id)
    try {
      const inviter = await createCustomer('disabled-rule-inviter')
      const invitee = await createCustomer('disabled-rule-invitee')
      await bind(inviter, invitee, 'disabled-rule')
      const order = await createOrder(invitee, 'disabled-rule')
      await moveToFulfilling(order, 'disabled-rule')
      await moveToSucceeded(order, 'disabled-rule')
      await expect(
        count('invitationRewardClaims', { inviteeCustomer: { equals: invitee.id } }),
      ).resolves.toBe(0)
      await expect(
        count('pointsBatches', { sourceCustomer: { equals: invitee.id } }),
      ).resolves.toBe(0)
    } finally {
      const restoredRule = await createInvitationRewardRuleVersion(
        await request('disabled-rule-restore', admin),
        {
          bindingWindowHours: 72,
          changeNote: 'restore D9-E-1 integration fixture rule',
          effectiveAt: new Date().toISOString(),
          enabled: true,
          rewardExpiryDays: 365,
          rewardPoints: 88,
        },
      )
      ruleIds.push(restoredRule.id)
    }
  })

  it('keeps a paid but not succeeded order pending and does not expose available points', async () => {
    const inviter = await createCustomer('pending-inviter')
    const invitee = await createCustomer('pending-invitee')
    const binding = await bind(inviter, invitee, 'pending')
    const order = await createOrder(invitee, 'pending', 'pending_payment')
    const paidTransitionPromise = moveToPaid(order, 'pending')
    await expect(paidTransitionPromise).resolves.toMatchObject({ order: { status: 'paid' } })
    const paidTransition = await paidTransitionPromise
    await expect(
      count('pointsLedger', {
        and: [{ customer: { equals: inviter.id } }, { entryType: { equals: 'pending' } }],
      }),
    ).resolves.toBe(1)
    await expect(
      count('pointsLedger', {
        and: [{ customer: { equals: inviter.id } }, { entryType: { equals: 'available' } }],
      }),
    ).resolves.toBe(0)
    await expect(
      confirmPendingInvitationReward(await request('pending-confirm-rejected'), {
        earningKey: `invitation-reward:invitee:${invitee.id}`,
        orderTransitionEventId: paidTransition.event.id,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_ORDER_TRANSITION_EVIDENCE_INVALID' })
    const claimId = await claimIdForInvitee(invitee)
    await addDeviceSignal(inviter, binding.deviceHash, 'pending')
    await expect(
      recheckInvitationRewardClaim(await request('pending-recheck'), {
        claimId,
        traceId: `${fixturePrefix}-pending-recheck`,
      }),
    ).resolves.toEqual({ flagged: false })
    await expect(
      count('invitationRewardEvents', {
        and: [{ claim: { equals: claimId } }, { eventType: { equals: 'flagged_after_release' } }],
      }),
    ).resolves.toBe(0)
  })

  it('rewards one invitee only once across multiple succeeded orders', async () => {
    const inviter = await createCustomer('once-inviter')
    const invitee = await createCustomer('once-invitee')
    await bind(inviter, invitee, 'once')
    let firstOrderId: number | string | undefined
    for (const suffix of ['once-first', 'once-second']) {
      const order = await createOrder(invitee, suffix)
      firstOrderId ??= order.id
      await expect(moveToFulfilling(order, suffix)).resolves.toMatchObject({
        order: { status: 'fulfilling' },
      })
      if (suffix === 'once-first') {
        await expect(
          count('pointsLedger', {
            and: [{ customer: { equals: inviter.id } }, { entryType: { equals: 'pending' } }],
          }),
        ).resolves.toBe(1)
      }
      await expect(moveToSucceeded(order, suffix)).resolves.toMatchObject({
        order: { status: 'succeeded' },
      })
    }
    await expect(
      count('invitationRewardClaims', { inviteeCustomer: { equals: invitee.id } }),
    ).resolves.toBe(1)
    await expect(
      count('pointsBatches', {
        and: [
          { customer: { equals: inviter.id } },
          { sourceType: { equals: 'invitation_reward' } },
        ],
      }),
    ).resolves.toBe(1)
    const invitationBatches = await payload.find({
      collection: 'pointsBatches',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: inviter.id } },
          { sourceType: { equals: 'invitation_reward' } },
        ],
      },
    })
    expect(invitationBatches.docs[0]).toMatchObject({
      points: 88,
      sourceCustomer: invitee.id,
      sourceOrder: firstOrderId,
      sourceType: 'invitation_reward',
    })
    await expect(
      count('pointsLedger', {
        and: [{ customer: { equals: inviter.id } }, { entryType: { equals: 'available' } }],
      }),
    ).resolves.toBe(1)
    const claimId = await claimIdForInvitee(invitee)
    await expect(
      count('invitationRewardEvents', {
        and: [{ claim: { equals: claimId } }, { eventType: { in: ['pending', 'available'] } }],
      }),
    ).resolves.toBe(2)
    const rewardAudits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      sort: 'createdAt',
      where: {
        and: [
          { action: { in: ['invitation.reward.pending', 'invitation.reward.available'] } },
          { targetId: { equals: String(claimId) } },
        ],
      },
    })
    expect(rewardAudits.totalDocs).toBe(2)
    expect(rewardAudits.docs.map((audit) => audit.action).sort()).toEqual([
      'invitation.reward.available',
      'invitation.reward.pending',
    ])
    for (const audit of rewardAudits.docs) {
      expect(audit.metadata).toMatchObject({
        expiresAt: expect.any(String),
        inviteeCustomerId: String(invitee.id),
        relationshipId: expect.any(String),
        ruleVersionNumber: expect.any(Number),
      })
    }
    await expect(
      recheckInvitationRewardClaim(await request('once-no-signal-recheck'), {
        claimId,
        traceId: `${fixturePrefix}-once-no-signal-recheck`,
      }),
    ).resolves.toEqual({ flagged: false })
  })

  it('concurrently triggering one invitee creates exactly one pending reward', async () => {
    const inviter = await createCustomer('reward-concurrent-inviter')
    const invitee = await createCustomer('reward-concurrent-invitee')
    await bind(inviter, invitee, 'reward-concurrent')
    const order = await createOrder(invitee, 'reward-concurrent', 'fulfilling')
    const event = await payload.create({
      collection: 'orderEvents',
      data: {
        actorType: 'system',
        customer: invitee.id,
        fromStatus: 'paid',
        order: order.id,
        reasonCode: 'fixture.concurrent_trigger',
        toStatus: 'fulfilling',
      },
      overrideAccess: true,
    })
    const attempts = await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        processInvitationRewardForOrderTransition(await request(`reward-concurrent-${index}`), {
          eventId: event.id,
          orderId: order.id,
          status: 'fulfilling',
          traceId: `${fixturePrefix}-reward-concurrent-${index}`,
        }),
      ),
    )
    expect(attempts.filter(({ outcome }) => outcome === 'pending').length).toBeGreaterThan(0)
    await expect(
      count('invitationRewardClaims', { inviteeCustomer: { equals: invitee.id } }),
    ).resolves.toBe(1)
    await expect(
      count('pointsLedger', {
        and: [{ customer: { equals: inviter.id } }, { entryType: { equals: 'pending' } }],
      }),
    ).resolves.toBe(1)
  })

  it('rejects a transition event sourced from another customer and order', async () => {
    const inviter = await createCustomer('event-source-inviter')
    const invitee = await createCustomer('event-source-invitee')
    const unrelated = await createCustomer('event-source-unrelated')
    await bind(inviter, invitee, 'event-source')
    const order = await createOrder(invitee, 'event-source-order', 'fulfilling')
    const unrelatedOrder = await createOrder(
      unrelated,
      'event-source-unrelated-order',
      'fulfilling',
    )
    const sameCustomerOtherOrder = await createOrder(
      invitee,
      'event-source-same-customer-other-order',
      'fulfilling',
    )
    const unrelatedEvent = await payload.create({
      collection: 'orderEvents',
      data: {
        actorType: 'system',
        customer: unrelated.id,
        fromStatus: 'paid',
        order: unrelatedOrder.id,
        reasonCode: 'fixture.replaced_source',
        toStatus: 'fulfilling',
      },
      overrideAccess: true,
    })
    const wrongCustomerEvent = await payload.create({
      collection: 'orderEvents',
      data: {
        actorType: 'system',
        customer: unrelated.id,
        fromStatus: 'paid',
        order: order.id,
        reasonCode: 'fixture.replaced_customer_source',
        toStatus: 'fulfilling',
      },
      overrideAccess: true,
    })
    const wrongOrderOnlyEvent = await payload.create({
      collection: 'orderEvents',
      data: {
        actorType: 'system',
        customer: invitee.id,
        fromStatus: 'paid',
        order: sameCustomerOtherOrder.id,
        reasonCode: 'fixture.replaced_order_only_source',
        toStatus: 'fulfilling',
      },
      overrideAccess: true,
    })
    const wrongStatusEvent = await payload.create({
      collection: 'orderEvents',
      data: {
        actorType: 'system',
        customer: invitee.id,
        fromStatus: 'fulfilling',
        order: order.id,
        reasonCode: 'fixture.replaced_status_source',
        toStatus: 'succeeded',
      },
      overrideAccess: true,
    })
    const correctEvent = await payload.create({
      collection: 'orderEvents',
      data: {
        actorType: 'system',
        customer: invitee.id,
        fromStatus: 'paid',
        order: order.id,
        reasonCode: 'fixture.authoritative_transition',
        toStatus: 'fulfilling',
      },
      overrideAccess: true,
    })
    for (const [suffix, eventId] of [
      ['order', unrelatedEvent.id],
      ['order-only', wrongOrderOnlyEvent.id],
      ['customer', wrongCustomerEvent.id],
      ['status', wrongStatusEvent.id],
    ] as const) {
      await expect(
        processInvitationRewardForOrderTransition(await request(`event-source-${suffix}`), {
          eventId,
          orderId: order.id,
          status: 'fulfilling',
          traceId: `${fixturePrefix}-event-source-${suffix}`,
        }),
      ).rejects.toMatchObject({ code: 'POINTS_ORDER_TRANSITION_EVIDENCE_INVALID' })
    }
    await expect(
      processInvitationRewardForOrderTransition(await request('event-source-event-id'), {
        eventId: unrelatedEvent.id,
        orderId: order.id,
        status: 'fulfilling',
        traceId: `${fixturePrefix}-event-source-event-id`,
      }),
    ).rejects.toMatchObject({ code: 'POINTS_ORDER_TRANSITION_EVIDENCE_INVALID' })
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    await expect(
      earnPendingInvitationReward(await request('event-source-order-customer'), {
        customerId: inviter.id,
        earningKey: `${fixturePrefix}-wrong-order-customer`,
        expiresAt,
        orderId: order.id,
        orderTransitionEventId: wrongCustomerEvent.id,
        points: 9,
        sourceCustomerId: unrelated.id,
        transitionStatus: 'fulfilling',
      }),
    ).rejects.toMatchObject({ code: 'POINTS_ORDER_TRANSITION_EVIDENCE_INVALID' })
    await expect(
      earnPendingInvitationReward(await request('event-source-order-status'), {
        customerId: inviter.id,
        earningKey: `${fixturePrefix}-wrong-order-status`,
        expiresAt,
        orderId: order.id,
        orderTransitionEventId: wrongStatusEvent.id,
        points: 11,
        sourceCustomerId: invitee.id,
        transitionStatus: 'succeeded',
      }),
    ).rejects.toMatchObject({ code: 'POINTS_ORDER_TRANSITION_EVIDENCE_INVALID' })
    expect(correctEvent.id).not.toBe(unrelatedEvent.id)
    await expect(
      count('invitationRewardClaims', { inviteeCustomer: { equals: invitee.id } }),
    ).resolves.toBe(0)
    await expect(count('pointsBatches', { sourceCustomer: { equals: invitee.id } })).resolves.toBe(
      0,
    )
  })

  it.each([
    'same_device_hash',
    'same_realname_subject',
    'same_phone_hash',
    'same_payment_account_hash',
  ] as const)('independently withholds pending reward for %s', async (signal) => {
    const inviter = await createCustomer(`${signal}-inviter`)
    const invitee = await createCustomer(`${signal}-invitee`)
    const binding = await bind(inviter, invitee, signal)
    const order = await createOrder(invitee, signal)
    await moveToFulfilling(order, signal)
    if (signal === 'same_device_hash') {
      await addDeviceSignal(inviter, binding.deviceHash, signal)
    } else if (signal === 'same_realname_subject') {
      await addRealnameSignal(inviter, order, signal)
    } else if (signal === 'same_phone_hash') {
      await addPhoneSignal(inviter, invitee, signal)
    } else {
      await addPaymentSignal(inviter, invitee, order, signal)
    }
    await moveToSucceeded(order, signal)
    const claimId = await claimIdForInvitee(invitee)
    const events = await payload.find({
      collection: 'invitationRewardEvents',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ claim: { equals: claimId } }, { eventType: { equals: 'withheld' } }],
      },
    })
    expect(events.docs[0]?.signals).toEqual([signal])
    await expect(
      count('pointsLedger', {
        and: [{ customer: { equals: inviter.id } }, { entryType: { equals: 'available' } }],
      }),
    ).resolves.toBe(0)
    await expect(
      count('manualReviews', { invitationRewardClaim: { equals: claimId } }),
    ).resolves.toBe(1)
    await expect(
      count('notificationOutboxEvents', {
        and: [
          { customer: { equals: inviter.id } },
          { notificationType: { equals: 'invitation_reward_withheld' } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('persists multiple abuse signals in the canonical deterministic order', async () => {
    const inviter = await createCustomer('signal-order-inviter')
    const invitee = await createCustomer('signal-order-invitee')
    const binding = await bind(inviter, invitee, 'signal-order')
    const order = await createOrder(invitee, 'signal-order')
    await moveToFulfilling(order, 'signal-order')
    await addDeviceSignal(inviter, binding.deviceHash, 'signal-order')
    await addPhoneSignal(inviter, invitee, 'signal-order')
    await moveToSucceeded(order, 'signal-order')
    const claimId = await claimIdForInvitee(invitee)
    const events = await payload.find({
      collection: 'invitationRewardEvents',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ claim: { equals: claimId } }, { eventType: { equals: 'withheld' } }],
      },
    })
    expect(events.docs[0]?.signals).toEqual(['same_device_hash', 'same_phone_hash'])
  })

  it('withholds abnormal invitation growth at the configured aggregate boundary', async () => {
    const inviter = await createCustomer('growth-inviter')
    const invitees = await Promise.all(
      Array.from({ length: 20 }, async (_, index) => createCustomer(`growth-invitee-${index}`)),
    )
    await Promise.all(invitees.map((invitee, index) => bind(inviter, invitee, `growth-${index}`)))
    const rewardedInvitee = invitees[0]!
    const order = await createOrder(rewardedInvitee, 'growth-source')
    await moveToFulfilling(order, 'growth-source')
    await moveToSucceeded(order, 'growth-source')
    const claimId = await claimIdForInvitee(rewardedInvitee)
    const events = await payload.find({
      collection: 'invitationRewardEvents',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ claim: { equals: claimId } }, { eventType: { equals: 'withheld' } }],
      },
    })
    expect(events.docs[0]?.signals).toEqual(['abnormal_invitation_growth'])
    await expect(
      count('notificationOutboxEvents', {
        and: [
          { customer: { equals: inviter.id } },
          { notificationType: { equals: 'invitation_reward_withheld' } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('flags newly detected abuse after release without changing ledger or account state', async () => {
    const inviter = await createCustomer('released-inviter')
    const invitee = await createCustomer('released-invitee')
    const binding = await bind(inviter, invitee, 'released')
    const order = await createOrder(invitee, 'released')
    await moveToFulfilling(order, 'released')
    await moveToSucceeded(order, 'released')
    const claimId = await claimIdForInvitee(invitee)
    const beforeLedgerCount = await count('pointsLedger', { customer: { equals: inviter.id } })
    const beforeBalance = await readPointsBalance(await request('released-before'), inviter.id)
    const beforeCustomer = await payload.findByID({
      collection: 'customers',
      id: inviter.id,
      overrideAccess: true,
    })

    await addDeviceSignal(inviter, binding.deviceHash, 'released')
    await expect(
      recheckInvitationRewardClaim(await request('released-recheck'), {
        claimId,
        traceId: `${fixturePrefix}-released-recheck`,
      }),
    ).resolves.toEqual({ flagged: true })

    await expect(count('pointsLedger', { customer: { equals: inviter.id } })).resolves.toBe(
      beforeLedgerCount,
    )
    await expect(readPointsBalance(await request('released-after'), inviter.id)).resolves.toEqual(
      beforeBalance,
    )
    const afterCustomer = await payload.findByID({
      collection: 'customers',
      id: inviter.id,
      overrideAccess: true,
    })
    expect(afterCustomer.status).toBe(beforeCustomer.status)
    expect(afterCustomer.capabilityRestrictions).toEqual(beforeCustomer.capabilityRestrictions)
    await expect(
      count('invitationRewardEvents', {
        and: [{ claim: { equals: claimId } }, { eventType: { equals: 'flagged_after_release' } }],
      }),
    ).resolves.toBe(1)
    await expect(
      count('notificationOutboxEvents', {
        and: [
          { customer: { equals: inviter.id } },
          { notificationType: { equals: 'invitation_reward_withheld' } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('scans released rewards by ascending claim id with an exact deterministic limit', async () => {
    const fixtures = []
    for (const suffix of ['scan-first', 'scan-second']) {
      const inviter = await createCustomer(`${suffix}-inviter`)
      const invitee = await createCustomer(`${suffix}-invitee`)
      const binding = await bind(inviter, invitee, suffix)
      const order = await createOrder(invitee, suffix)
      await moveToFulfilling(order, suffix)
      await moveToSucceeded(order, suffix)
      const claimId = await claimIdForInvitee(invitee)
      await addDeviceSignal(inviter, binding.deviceHash, suffix)
      fixtures.push({ claimId, inviter })
    }
    fixtures.sort((left, right) => left.claimId - right.claimId)

    await expect(
      scanReleasedInvitationRewardsForAbuse(await request('scan-order'), {
        limit: 1,
        traceId: `${fixturePrefix}-scan-order`,
      }),
    ).resolves.toEqual({ flaggedCount: 1, scannedCount: 1 })
    await expect(
      count('invitationRewardEvents', {
        and: [
          { claim: { equals: fixtures[0]!.claimId } },
          { eventType: { equals: 'flagged_after_release' } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('invitationRewardEvents', {
        and: [
          { claim: { equals: fixtures[1]!.claimId } },
          { eventType: { equals: 'flagged_after_release' } },
        ],
      }),
    ).resolves.toBe(0)
  })

  it('deterministically selects the highest version when effective times tie', async () => {
    const effectiveAt = new Date(Date.now() - 1_000).toISOString()
    const configuredVersions: number[] = []
    for (const [bindingWindowHours, rewardPoints, suffix] of [
      [24, 111, 'tie-lower'],
      [48, 123, 'tie-higher'],
    ] as const) {
      const configured = await createInvitationRewardRuleVersion(await request(suffix, admin), {
        bindingWindowHours,
        changeNote: `D9-E-1 deterministic ${suffix}`,
        effectiveAt,
        enabled: true,
        rewardExpiryDays: 365,
        rewardPoints,
      })
      ruleIds.push(configured.id)
      configuredVersions.push(configured.version)
    }
    expect(configuredVersions[1]).toBe(configuredVersions[0]! + 1)
    await expect(
      count('auditLogs', {
        and: [
          { action: { equals: 'invitation.reward_rule.created' } },
          { targetId: { in: ruleIds.slice(-2).map(String) } },
        ],
      }),
    ).resolves.toBe(2)
    const inviter = await createCustomer('tie-inviter')
    const invitee = await createCustomer('tie-invitee')
    const binding = await bind(inviter, invitee, 'tie')
    const windowHours =
      (Date.parse(binding.relationship.bindingWindowEndsAt) - Date.parse(invitee.createdAt)) /
      3_600_000
    expect(windowHours).toBeCloseTo(48, 5)
    const order = await createOrder(invitee, 'tie-order')
    await moveToFulfilling(order, 'tie-order')
    const batches = await payload.find({
      collection: 'pointsBatches',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: inviter.id } },
          { sourceType: { equals: 'invitation_reward' } },
        ],
      },
    })
    expect(batches.docs[0]?.points).toBe(123)
  })
})
