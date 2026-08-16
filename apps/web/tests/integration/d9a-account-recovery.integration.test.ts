import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import {
  createLocalReq,
  getPayload,
  initTransaction,
  killTransaction,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hmac, randomOpaqueToken } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import type { Admin, Customer } from '@/payload-types'
import type { AccountRecoveryRequestInput } from '@/schemas/auth'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import {
  decideAccountRecovery,
  loadRecoveryAccountState,
  startRecoveryCooldown,
  submitAccountRecoveryRequest,
  verifyAccountRecoveryEvidence,
} from '@/services/auth/account-recovery'
import { identityProviderInstance, protectedIdentifier } from '@/services/auth/customer-identities'
import { authorizeStepUpGrant } from '@/services/auth/step-up'

import { issueStepUpGrantFixture } from '../fixtures/step-up'
import { realnameTemplateFixture } from '../fixtures/realname'

let payload: Payload
let reviewer: Admin

function headers(suffix: string = randomUUID()): Headers {
  return new Headers({
    'user-agent': `Wanmi-D9A-A5/${suffix}`,
    'x-forwarded-for': `198.51.100.${randomInt(1, 250)}`,
    'x-request-id': `d9a-a5-${suffix}`,
  })
}

async function requestFor(user?: unknown, suffix: string = randomUUID()): Promise<PayloadRequest> {
  const req = await createLocalReq({ req: { headers: headers(suffix) } }, payload)
  if (user) req.user = user as never
  return req
}

function reviewerUser(overrides: Partial<Admin> = {}) {
  return { ...reviewer, ...overrides, collection: 'admins' as const }
}

function databaseRequest(
  rows?: Array<Record<string, unknown>>,
  failure?: Error,
  onExecute?: () => void,
): PayloadRequest {
  const transactionId = randomUUID()
  return {
    payload: {
      db: {
        sessions: {
          [transactionId]: {
            db: {
              execute: async () => {
                onExecute?.()
                if (failure) throw failure
                return { rows }
              },
            },
          },
        },
      },
    },
    transactionID: Promise.resolve(transactionId),
  } as never
}

async function createSession(customerId: number) {
  const token = randomOpaqueToken()
  return payload.create({
    collection: 'customerSessions',
    data: {
      customer: customerId,
      deviceHash: hmac(`device:${token}`, getEnv().SESSION_PEPPER),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ipHash: hmac(`ip:${token}`, getEnv().SESSION_PEPPER),
      lastSeenAt: new Date().toISOString(),
      tokenHash: hmac(token, getEnv().SESSION_PEPPER),
    },
    overrideAccess: true,
  })
}

type RecoveryFixture = {
  customer: Customer
  input: AccountRecoveryRequestInput
  orderId: number
  paymentNotificationId: number
  realnameTemplateId: number
}

async function createRecoveryFixture(
  input: { identities?: boolean; sessions?: number; status?: Customer['status'] } = {},
): Promise<RecoveryFixture> {
  const suffix = randomUUID()
  const now = new Date()
  const phone = `+86139${randomInt(10_000_000, 100_000_000)}`
  const fullNameChinese = `李测试${suffix.slice(0, 4)}`
  const identityDocumentNumber = `A5${suffix.replaceAll('-', '').slice(0, 16)}`
  const orderNumber = `A5-ORDER-${suffix}`
  const paymentTransactionId = `A5-WX-${suffix}`
  const customer = await payload.create({
    collection: 'customers',
    data: {
      accountType: 'registered',
      capabilityRestrictions: [],
      defaultCustomerProfileType: 'individual',
      phone,
      phoneMasked: `+86139****${phone.slice(-4)}`,
      registrationSource: 'phone',
      status: input.status ?? 'active',
    },
    overrideAccess: true,
  })
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({
        displayName: `A5-${suffix}`,
        fullNameChinese,
        identityDocumentNumber,
      }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  const quote = await payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: now.toISOString(),
      availabilityRequestId: `a5-availability-${suffix}`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `a5-quote-${suffix}`,
      currency: 'CNY',
      customer: customer.id,
      domainAscii: `${suffix}.example`,
      expiresAt: new Date(now.getTime() + 240_000).toISOString(),
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: now.toISOString(),
      providerProductId: `a5-product-${suffix}`,
      providerRequestId: `a5-price-${suffix}`,
      quotedAt: now.toISOString(),
      quoteIntegrityHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      quoteRef: randomUUID(),
      registrationPriceMinor: 2_500,
      renewalPriceMinor: 2_500,
      ruleFixedAmountMinor: 0,
      ruleKey: `a5-rule-${suffix}`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
      roundingMode: 'half_up_to_fen',
      schemaVersion: 1,
      sourceCalculationHash: randomUUID().replaceAll('-', '').padEnd(64, '1'),
      sourcePriceSnapshotRef: randomUUID(),
      tld: 'example',
      upstreamCostMinor: 2_500,
      upstreamRegistrationPriceMinor: 2_500,
      upstreamRenewalPriceMinor: 2_500,
      userPriceMinor: 2_500,
      years: 1,
    },
    overrideAccess: true,
  })
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor: 2_500,
      currency: 'CNY',
      customer: customer.id,
      domainAscii: `${suffix}.example`,
      orderNumber,
      paidAt: now.toISOString(),
      quote: quote.id,
      quoteSnapshot: { expiresAt: new Date(now.getTime() + 240_000).toISOString() },
      realnameTemplate: template.id,
      status: 'succeeded',
    },
    overrideAccess: true,
  })
  const notification = await payload.create({
    collection: 'paymentNotifications',
    data: {
      amountMinor: 2_500,
      confirmationStatus: 'confirmed',
      currency: 'CNY',
      notificationId: `a5-notification-${suffix}`,
      order: order.id,
      paidAt: now.toISOString(),
      payloadDigest: randomUUID().replaceAll('-', '').padEnd(64, '2'),
      receivedAt: now.toISOString(),
      signatureVerified: true,
      source: 'notification',
      wechatTransactionId: paymentTransactionId,
    },
    overrideAccess: true,
  })
  if (input.identities) {
    const phoneIdentity = protectedIdentifier(phone)
    const wechatIdentity = protectedIdentifier(`a5-openid-${suffix}`)
    for (const identity of [
      {
        ...phoneIdentity,
        provider: 'phone' as const,
        providerInstanceId: identityProviderInstance('phone'),
      },
      {
        ...wechatIdentity,
        provider: 'wechat' as const,
        providerInstanceId: identityProviderInstance('wechat'),
      },
    ]) {
      await payload.create({
        collection: 'customerIdentities',
        data: {
          boundAt: now.toISOString(),
          customer: customer.id,
          status: 'active',
          verifiedAt: now.toISOString(),
          ...identity,
        },
        overrideAccess: true,
      })
    }
  }
  for (let index = 0; index < (input.sessions ?? 0); index += 1) {
    await createSession(Number(customer.id))
  }
  return {
    customer,
    input: {
      fullNameChinese,
      historicalOrderNumber: orderNumber,
      identityDocumentNumber,
      paymentTransactionId,
      phone,
      phoneUnavailable: true,
      wechatUnavailable: true,
    },
    orderId: Number(order.id),
    paymentNotificationId: Number(notification.id),
    realnameTemplateId: Number(template.id),
  }
}

async function recoveryReview(customerId: number) {
  const reviews = await payload.find({
    collection: 'manualReviews',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    sort: '-id',
    where: {
      and: [
        { customer: { equals: customerId } },
        { reasonCode: { equals: 'customer_account_recovery' } },
      ],
    },
  })
  const review = reviews.docs[0]
  if (!review) throw new Error('Expected account recovery review')
  return review
}

async function recoveryCount(customerId: number) {
  return payload.count({
    collection: 'manualReviews',
    overrideAccess: true,
    where: {
      and: [
        { customer: { equals: customerId } },
        { reasonCode: { equals: 'customer_account_recovery' } },
      ],
    },
  })
}

async function submit(fixture: RecoveryFixture, suffix: string = randomUUID()) {
  return submitAccountRecoveryRequest(await requestFor(undefined, suffix), fixture.input)
}

async function decide(
  reviewId: number,
  conclusion: 'approved' | 'rejected',
  suffix: string = randomUUID(),
) {
  return decideAccountRecovery(await requestFor(reviewerUser(), suffix), {
    decision: { conclusion, note: `A5 manual review ${suffix}` },
    reviewId,
    reviewerId: reviewer.id,
    traceId: `d9a-a5-decision-${suffix}`,
  })
}

beforeAll(async () => {
  payload = await getPayload({ config })
  reviewer = await payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap' },
    data: {
      email: `d9a-a5-${randomUUID()}@example.test`,
      password: `D9A-A5-reviewer-${randomUUID()}`,
      roles: ['system_admin'],
      status: 'active',
    },
    overrideAccess: true,
  })
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9-A A5 account recovery', () => {
  it('submits verified real-name, historical-order, and confirmed-payment evidence to manualReviews', async () => {
    const fixture = await createRecoveryFixture()
    const result = await submit(fixture, 'submit-valid')
    expect(result).toMatchObject({ status: 'manual_review' })
    expect((await recoveryCount(Number(fixture.customer.id))).totalDocs).toBe(1)
    const review = await recoveryReview(Number(fixture.customer.id))
    expect(review).toMatchObject({
      order: fixture.orderId,
      paymentNotification: fixture.paymentNotificationId,
      realnameTemplate: fixture.realnameTemplateId,
      status: 'open',
    })
    const records = await payload.find({
      collection: 'accountRecoveryRecords',
      depth: 0,
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: fixture.customer.id } },
          { eventType: { equals: 'request_submitted' } },
          { requestKey: { equals: result.recoveryRequestId } },
        ],
      },
    })
    expect(records.totalDocs).toBe(1)
    expect(records.docs[0]).toMatchObject({
      occurredAt: result.submittedAt,
      order: fixture.orderId,
      paymentNotification: fixture.paymentNotificationId,
      realnameTemplate: fixture.realnameTemplateId,
      unavailableProviders: ['phone', 'wechat'],
    })
    const requestAudit = await payload.find({
      collection: 'auditLogs',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'customer.account_recovery.requested' } },
          { targetId: { equals: String(fixture.customer.id) } },
        ],
      },
    })
    expect(requestAudit.totalDocs).toBe(1)
    expect(requestAudit.docs[0]).toMatchObject({
      targetId: String(fixture.customer.id),
      targetType: 'customer',
    })
    const requestSecurityEvent = await payload.count({
      collection: 'customerSecurityEvents',
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: fixture.customer.id } },
          { event: { equals: 'account_recovery_requested' } },
        ],
      },
    })
    expect(requestSecurityEvent.totalDocs).toBe(1)
  })

  it('rejects the request independently when phone is not declared unavailable', async () => {
    const fixture = await createRecoveryFixture()
    await expect(
      submitAccountRecoveryRequest(await requestFor(), {
        ...fixture.input,
        phoneUnavailable: false,
      } as never),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_CHANNEL_STILL_AVAILABLE' })
    expect((await recoveryCount(Number(fixture.customer.id))).totalDocs).toBe(0)
  })

  it('rejects the request independently when Wechat is not declared unavailable', async () => {
    const fixture = await createRecoveryFixture()
    await expect(
      submitAccountRecoveryRequest(await requestFor(), {
        ...fixture.input,
        wechatUnavailable: false,
      } as never),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_CHANNEL_STILL_AVAILABLE' })
    expect((await recoveryCount(Number(fixture.customer.id))).totalDocs).toBe(0)
  })

  it('keeps every evidence ownership and proof predicate behaviorally necessary', async () => {
    const target = await createRecoveryFixture()
    const foreign = await createRecoveryFixture()
    const now = new Date().toISOString()
    const unsigned = await payload.create({
      collection: 'paymentNotifications',
      data: {
        confirmationStatus: 'confirmed',
        notificationId: `a5-unsigned-${randomUUID()}`,
        order: target.orderId,
        payloadDigest: '3'.repeat(64),
        receivedAt: now,
        signatureVerified: false,
        source: 'notification',
        wechatTransactionId: `a5-unsigned-transaction-${randomUUID()}`,
      },
      overrideAccess: true,
    })
    const unconfirmed = await payload.create({
      collection: 'paymentNotifications',
      data: {
        confirmationStatus: 'not_paid',
        notificationId: `a5-unconfirmed-${randomUUID()}`,
        order: target.orderId,
        payloadDigest: '4'.repeat(64),
        receivedAt: now,
        signatureVerified: true,
        source: 'query',
        wechatTransactionId: `a5-unconfirmed-transaction-${randomUUID()}`,
      },
      overrideAccess: true,
    })
    const cases: Array<[string, AccountRecoveryRequestInput]> = [
      ['phone normalization', { ...target.input, phone: 'not-a-phone' }],
      ['customer phone', { ...target.input, phone: foreign.input.phone }],
      [
        'real-name owner',
        {
          ...target.input,
          fullNameChinese: foreign.input.fullNameChinese,
          identityDocumentNumber: foreign.input.identityDocumentNumber,
        },
      ],
      ['real-name full name', { ...target.input, fullNameChinese: '不存在的姓名' }],
      ['real-name document number', { ...target.input, identityDocumentNumber: 'INVALID-A5' }],
      [
        'order owner',
        {
          ...target.input,
          historicalOrderNumber: foreign.input.historicalOrderNumber,
          paymentTransactionId: foreign.input.paymentTransactionId,
        },
      ],
      ['historical order number', { ...target.input, historicalOrderNumber: 'A5-ORDER-MISSING' }],
      [
        'payment order',
        { ...target.input, paymentTransactionId: foreign.input.paymentTransactionId },
      ],
      ['payment transaction', { ...target.input, paymentTransactionId: 'A5-WX-MISSING' }],
      [
        'verified payment signature',
        { ...target.input, paymentTransactionId: String(unsigned.wechatTransactionId) },
      ],
      [
        'confirmed payment state',
        { ...target.input, paymentTransactionId: String(unconfirmed.wechatTransactionId) },
      ],
    ]
    for (const [name, evidence] of cases) {
      await expect(
        submitAccountRecoveryRequest(await requestFor(undefined, `predicate-${name}`), evidence),
        name,
      ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_EVIDENCE_INVALID' })
    }
    const count = await payload.count({
      collection: 'manualReviews',
      overrideAccess: true,
      where: {
        and: [
          { customer: { in: [target.customer.id, foreign.customer.id] } },
          { reasonCode: { equals: 'customer_account_recovery' } },
        ],
      },
    })
    expect(count.totalDocs).toBe(0)
  })

  it('rejects an invalid phone before attempting any evidence query', async () => {
    const fixture = await createRecoveryFixture()
    let queryCount = 0
    await expect(
      verifyAccountRecoveryEvidence(
        databaseRequest([], undefined, () => {
          queryCount += 1
        }),
        { ...fixture.input, phone: 'not-a-phone' },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_EVIDENCE_INVALID' })
    expect(queryCount).toBe(0)
  })

  it('fails closed when evidence or account-state storage cannot be queried', async () => {
    const fixture = await createRecoveryFixture()
    const unavailableReq = { payload: {}, transactionID: Promise.resolve(undefined) } as never
    await expect(
      verifyAccountRecoveryEvidence(unavailableReq, fixture.input),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_EVIDENCE_UNAVAILABLE' })
    await expect(
      loadRecoveryAccountState(unavailableReq, Number(fixture.customer.id)),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_STATE_UNAVAILABLE' })
    expect((await recoveryCount(Number(fixture.customer.id))).totalDocs).toBe(0)
  })

  it('fails closed on invalid evidence identifiers and invalid or missing account-state rows', async () => {
    const fixture = await createRecoveryFixture()
    for (const invalidId of [0, 1.5]) {
      await expect(
        verifyAccountRecoveryEvidence(
          databaseRequest([
            {
              customer_id: invalidId,
              order_id: 1,
              payment_notification_id: 1,
              realname_template_id: 1,
            },
          ]),
          fixture.input,
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_EVIDENCE_INVALID' })
    }
    await expect(
      loadRecoveryAccountState(databaseRequest([]), Number(fixture.customer.id)),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_STATE_UNAVAILABLE' })
    await expect(
      loadRecoveryAccountState(
        databaseRequest([
          { capability_restrictions: [], id: fixture.customer.id, status: 'future_state' },
        ]),
        Number(fixture.customer.id),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_STATE_UNAVAILABLE' })
    await expect(
      loadRecoveryAccountState(
        databaseRequest([
          { capability_restrictions: {}, id: fixture.customer.id, status: 'active' },
        ]),
        Number(fixture.customer.id),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_STATE_UNAVAILABLE' })
    await expect(
      loadRecoveryAccountState(
        databaseRequest([
          {
            capability_restrictions: [],
            id: fixture.customer.id,
            identity_risk_cooldown_started_at: 'not-a-date',
            status: 'active',
          },
        ]),
        Number(fixture.customer.id),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_STATE_UNAVAILABLE' })
  })

  it('requires the locked account-state row to belong to the claimed customer', async () => {
    const fixture = await createRecoveryFixture()
    await expect(
      loadRecoveryAccountState(
        databaseRequest([
          { capability_restrictions: [], id: Number(fixture.customer.id) + 1, status: 'active' },
        ]),
        Number(fixture.customer.id),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_STATE_UNAVAILABLE' })
  })

  it('rejects non-system-admin and mismatched reviewer identities before consuming a conclusion', async () => {
    const fixture = await createRecoveryFixture()
    await submit(fixture)
    const review = await recoveryReview(Number(fixture.customer.id))
    for (const user of [
      reviewerUser({ roles: ['analyst'] }),
      reviewerUser({ id: reviewer.id + 1 }),
      reviewerUser({ status: 'disabled' }),
    ]) {
      await expect(
        decideAccountRecovery(await requestFor(user), {
          decision: { conclusion: 'approved', note: 'unauthorized A5 review' },
          reviewId: Number(review.id),
          reviewerId: reviewer.id,
          traceId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_REVIEW_FORBIDDEN' })
    }
    for (const invalidReviewerId of ['not-a-number', 0, 1.5]) {
      await expect(
        decideAccountRecovery(
          await requestFor({
            collection: 'admins',
            id: invalidReviewerId,
            roles: ['system_admin'],
            status: 'active',
          }),
          {
            decision: { conclusion: 'approved', note: 'invalid reviewer identifier' },
            reviewId: Number(review.id),
            reviewerId: invalidReviewerId,
            traceId: randomUUID(),
          },
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_REVIEW_FORBIDDEN' })
    }
    const stored = await payload.findByID({
      collection: 'manualReviews',
      id: review.id,
      overrideAccess: true,
    })
    expect(stored.status).toBe('open')
  })

  it('fails closed on inconsistent persisted status/restriction state before approving recovery', async () => {
    for (const [status, restrictions] of [
      ['active', ['purchase_disabled']],
      ['restricted', []],
    ] as const) {
      const fixture = await createRecoveryFixture({ identities: true })
      await payload.db.pool.query(
        'UPDATE customers SET status = $1, capability_restrictions = $2::jsonb WHERE id = $3',
        [status, JSON.stringify(restrictions), fixture.customer.id],
      )
      await submit(fixture)
      const review = await recoveryReview(Number(fixture.customer.id))
      await expect(
        decide(Number(review.id), 'approved', `inconsistent-${status}`),
      ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_STATE_UNAVAILABLE' })
      const conclusions = await payload.count({
        collection: 'accountRecoveryRecords',
        overrideAccess: true,
        where: {
          and: [
            { manualReview: { equals: review.id } },
            { eventType: { equals: 'review_concluded' } },
          ],
        },
      })
      expect(conclusions.totalDocs).toBe(0)
    }
  })

  it('rejects every non-recoverable account status without consuming the review', async () => {
    for (const status of ['pending_registration', 'closing', 'closed'] as const) {
      const fixture = await createRecoveryFixture({ identities: true, status })
      await submit(fixture)
      const review = await recoveryReview(Number(fixture.customer.id))
      await expect(
        decide(Number(review.id), 'approved', `invalid-state-${status}`),
      ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_STATE_INVALID' })
      const stored = await payload.findByID({
        collection: 'manualReviews',
        id: review.id,
        overrideAccess: true,
      })
      expect(stored.status).toBe('open')
    }
  })

  it('keeps the review id, recovery reason, and open-status claim predicates behaviorally necessary', async () => {
    const resolvedTarget = await createRecoveryFixture({ identities: true })
    await submit(resolvedTarget)
    const resolvedReview = await recoveryReview(Number(resolvedTarget.customer.id))
    await payload.db.pool.query(
      "UPDATE manual_reviews SET status = 'resolved', resolved_at = NOW() WHERE id = $1",
      [resolvedReview.id],
    )
    const decoy = await createRecoveryFixture({ identities: true })
    await submit(decoy)
    await expect(
      decide(Number(resolvedReview.id), 'approved', 'claim-review-id'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_DECISION_ALREADY_CONSUMED' })

    const wrongReason = await createRecoveryFixture({ identities: true })
    await submit(wrongReason)
    const wrongReasonReview = await recoveryReview(Number(wrongReason.customer.id))
    await payload.db.pool.query('UPDATE manual_reviews SET reason_code = $1 WHERE id = $2', [
      'not_account_recovery',
      wrongReasonReview.id,
    ])
    await expect(
      decide(Number(wrongReasonReview.id), 'approved', 'claim-reason'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_DECISION_ALREADY_CONSUMED' })

    const consumed = await createRecoveryFixture({ identities: true })
    await submit(consumed)
    const consumedReview = await recoveryReview(Number(consumed.customer.id))
    await decide(Number(consumedReview.id), 'rejected', 'claim-first')
    await expect(
      decide(Number(consumedReview.id), 'rejected', 'claim-second'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_DECISION_ALREADY_CONSUMED' })
  })

  it('atomically consumes one approval, restores through A3, revokes every session, records cooldown, and notifies every old channel', async () => {
    const fixture = await createRecoveryFixture({
      identities: true,
      sessions: 3,
      status: 'suspended',
    })
    const alreadyRevoked = await createSession(Number(fixture.customer.id))
    await payload.update({
      collection: 'customerSessions',
      data: { revokedAt: new Date().toISOString() },
      id: alreadyRevoked.id,
      overrideAccess: true,
    })
    const sessionDecoy = await createRecoveryFixture({ sessions: 1 })
    const unbound = protectedIdentifier(`a5-unbound-${randomUUID()}`)
    await payload.create({
      collection: 'customerIdentities',
      data: {
        ...unbound,
        boundAt: new Date().toISOString(),
        customer: fixture.customer.id,
        provider: 'wechat',
        providerInstanceId: `${identityProviderInstance('wechat')}-unbound-${randomUUID()}`,
        status: 'unbound',
        unboundAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    await submit(fixture)
    const review = await recoveryReview(Number(fixture.customer.id))
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_value, index) =>
        decide(Number(review.id), 'approved', `approval-race-${index}`),
      ),
    )
    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof decide>>> =>
        attempt.status === 'fulfilled',
    )
    expect(fulfilled).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(7)
    expect(fulfilled[0]!.value).toMatchObject({
      conclusion: 'approved',
      customerId: fixture.customer.id,
      reviewId: review.id,
      revokedSessionCount: 3,
    })

    const account = await payload.findByID({
      collection: 'customers',
      id: fixture.customer.id,
      overrideAccess: true,
    })
    expect(account.status).toBe('active')
    expect(account.identityRiskCooldownStartedAt).toBe(fulfilled[0]!.value.cooldownStartedAt)
    expect(
      new Date(fulfilled[0]!.value.cooldownEndsAt!).getTime() -
        new Date(fulfilled[0]!.value.cooldownStartedAt!).getTime(),
    ).toBe(getEnv().IDENTITY_RISK_COOLDOWN_SECONDS * 1_000)
    const activeSessions = await payload.count({
      collection: 'customerSessions',
      overrideAccess: true,
      where: {
        and: [{ customer: { equals: fixture.customer.id } }, { revokedAt: { exists: false } }],
      },
    })
    expect(activeSessions.totalDocs).toBe(0)
    const conclusions = await payload.find({
      collection: 'accountRecoveryRecords',
      depth: 0,
      overrideAccess: true,
      where: {
        and: [
          { manualReview: { equals: review.id } },
          { eventType: { equals: 'review_concluded' } },
        ],
      },
    })
    expect(conclusions.totalDocs).toBe(1)
    expect(conclusions.docs[0]).toMatchObject({
      conclusion: 'approved',
      cooldownEndsAt: fulfilled[0]!.value.cooldownEndsAt,
      cooldownStartedAt: fulfilled[0]!.value.cooldownStartedAt,
      occurredAt: fulfilled[0]!.value.decidedAt,
      reviewer: reviewer.id,
      revokedSessionCount: 3,
    })
    const storedReview = await payload.findByID({
      collection: 'manualReviews',
      depth: 0,
      id: review.id,
      overrideAccess: true,
    })
    expect(storedReview).toMatchObject({
      resolvedAt: fulfilled[0]!.value.decidedAt,
      resolvedBy: reviewer.id,
      resolutionNote: conclusions.docs[0]!.decisionNote,
      status: 'resolved',
    })
    expect(conclusions.docs[0]!.decisionNote).toBe(storedReview.resolutionNote)
    const requestRecord = await payload.find({
      collection: 'accountRecoveryRecords',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { manualReview: { equals: review.id } },
          { eventType: { equals: 'request_submitted' } },
        ],
      },
    })
    expect(requestRecord.totalDocs).toBe(1)
    expect(conclusions.docs[0]!.requestKey).toBe(requestRecord.docs[0]!.requestKey)
    const decisionAudit = await payload.find({
      collection: 'auditLogs',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'customer.account_recovery.decided' } },
          { targetId: { equals: String(fixture.customer.id) } },
        ],
      },
    })
    expect(decisionAudit.totalDocs).toBe(1)
    expect(decisionAudit.docs[0]).toMatchObject({
      targetId: String(fixture.customer.id),
      targetType: 'customer',
    })
    const decisionSecurityEvent = await payload.count({
      collection: 'customerSecurityEvents',
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: fixture.customer.id } },
          { event: { equals: 'account_recovery_decided' } },
        ],
      },
    })
    expect(decisionSecurityEvent.totalDocs).toBe(1)
    const transitionSecurityEvent = await payload.count({
      collection: 'customerSecurityEvents',
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: fixture.customer.id } },
          { event: { equals: 'account_state_changed' } },
        ],
      },
    })
    expect(transitionSecurityEvent.totalDocs).toBe(1)
    const decoySessions = await payload.count({
      collection: 'customerSessions',
      overrideAccess: true,
      where: {
        and: [{ customer: { equals: sessionDecoy.customer.id } }, { revokedAt: { exists: false } }],
      },
    })
    expect(decoySessions.totalDocs).toBe(1)
    const notifications = await payload.find({
      collection: 'customerSecurityEvents',
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: fixture.customer.id } },
          { event: { equals: 'identity_change_notification' } },
        ],
      },
    })
    expect(notifications.totalDocs).toBe(2)
    expect(
      notifications.docs
        .map((event) => event.safeMetadata as { outcome: string; provider: string })
        .sort((left, right) => left.provider.localeCompare(right.provider)),
    ).toEqual([
      expect.objectContaining({ outcome: 'sent', provider: 'phone' }),
      expect.objectContaining({ outcome: 'sent', provider: 'wechat' }),
    ])
  })

  it('records a rejected conclusion once without revoking sessions, notifying channels, or starting cooldown', async () => {
    const fixture = await createRecoveryFixture({ identities: true, sessions: 1 })
    await submit(fixture)
    const review = await recoveryReview(Number(fixture.customer.id))
    const result = await decide(Number(review.id), 'rejected', 'rejected')
    expect(result).toMatchObject({ conclusion: 'rejected', revokedSessionCount: 0 })
    expect(result).not.toHaveProperty('cooldownStartedAt')
    const account = await payload.findByID({
      collection: 'customers',
      id: fixture.customer.id,
      overrideAccess: true,
    })
    expect(account.identityRiskCooldownStartedAt).toBeNull()
    const activeSessions = await payload.count({
      collection: 'customerSessions',
      overrideAccess: true,
      where: {
        and: [{ customer: { equals: fixture.customer.id } }, { revokedAt: { exists: false } }],
      },
    })
    expect(activeSessions.totalDocs).toBe(1)
    const notifications = await payload.count({
      collection: 'customerSecurityEvents',
      overrideAccess: true,
      where: {
        and: [
          { customer: { equals: fixture.customer.id } },
          { event: { equals: 'identity_change_notification' } },
        ],
      },
    })
    expect(notifications.totalDocs).toBe(0)
  })

  it('rolls back an approval when there is no old bound channel to notify', async () => {
    const fixture = await createRecoveryFixture({ sessions: 1 })
    await submit(fixture)
    const review = await recoveryReview(Number(fixture.customer.id))
    await expect(decide(Number(review.id), 'approved', 'no-identities')).rejects.toMatchObject({
      code: 'ACCOUNT_RECOVERY_IDENTITIES_MISSING',
    })
    const account = await payload.findByID({
      collection: 'customers',
      id: fixture.customer.id,
      overrideAccess: true,
    })
    expect(account.identityRiskCooldownStartedAt).toBeNull()
    const activeSessions = await payload.count({
      collection: 'customerSessions',
      overrideAccess: true,
      where: {
        and: [{ customer: { equals: fixture.customer.id } }, { revokedAt: { exists: false } }],
      },
    })
    expect(activeSessions.totalDocs).toBe(1)
  })

  for (const missing of ['realname_template_id', 'order_id', 'payment_notification_id'] as const) {
    it(`fails closed when the immutable request record is missing ${missing}`, async () => {
      const decoy = await createRecoveryFixture()
      await submit(decoy)
      const fixture = await createRecoveryFixture({ identities: true })
      await submit(fixture)
      const review = await recoveryReview(Number(fixture.customer.id))
      await payload.db.pool.query(
        `UPDATE account_recovery_records SET ${missing} = NULL WHERE manual_review_id = $1 AND event_type = 'request_submitted'`,
        [review.id],
      )
      await expect(
        decide(Number(review.id), 'approved', `missing-${missing}`),
      ).rejects.toMatchObject({
        code: 'ACCOUNT_RECOVERY_EVIDENCE_INVALID',
      })
      const stored = await payload.findByID({
        collection: 'manualReviews',
        id: review.id,
        overrideAccess: true,
      })
      expect(stored.status).toBe('open')
    })
  }

  it('requires a submitted event with a nonempty request key before consuming the conclusion', async () => {
    for (const corruption of ['event_type', 'request_key'] as const) {
      const fixture = await createRecoveryFixture({ identities: true })
      await submit(fixture)
      const review = await recoveryReview(Number(fixture.customer.id))
      if (corruption === 'event_type') {
        await payload.db.pool.query(
          "UPDATE account_recovery_records SET event_type = 'review_concluded' WHERE manual_review_id = $1",
          [review.id],
        )
      } else {
        await payload.db.pool.query(
          "UPDATE account_recovery_records SET request_key = '' WHERE manual_review_id = $1",
          [review.id],
        )
      }
      await expect(
        decide(Number(review.id), 'approved', `request-${corruption}`),
      ).rejects.toMatchObject({
        code: 'ACCOUNT_RECOVERY_EVIDENCE_INVALID',
      })
      const stored = await payload.findByID({
        collection: 'manualReviews',
        id: review.id,
        overrideAccess: true,
      })
      expect(stored.status).toBe('open')
    }
  })

  it('keeps every cooldown UPDATE CAS predicate behaviorally necessary', async () => {
    const fixture = await createRecoveryFixture()
    const cases = [
      {
        customerId: 2_147_000_000,
        expectedRestrictions: [] as const,
        expectedStatus: 'active' as const,
      },
      {
        customerId: Number(fixture.customer.id),
        expectedRestrictions: [] as const,
        expectedStatus: 'suspended' as const,
      },
      {
        customerId: Number(fixture.customer.id),
        expectedRestrictions: ['purchase_disabled'] as const,
        expectedStatus: 'active' as const,
      },
      {
        customerId: Number(fixture.customer.id),
        expectedCooldownStartedAt: '2026-08-15T00:00:00.000Z',
        expectedRestrictions: [] as const,
        expectedStatus: 'active' as const,
      },
    ]
    for (const [index, candidate] of cases.entries()) {
      const req = await requestFor(undefined, `cooldown-cas-${index}`)
      await initTransaction(req)
      try {
        await expect(
          startRecoveryCooldown(req, {
            ...candidate,
            expectedRestrictions: [...candidate.expectedRestrictions],
            startedAt: new Date().toISOString(),
          }),
        ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_STATE_CONFLICT' })
      } finally {
        await killTransaction(req)
      }
    }
  })

  it('keeps request and conclusion records append-only even for overrideAccess system calls', async () => {
    const fixture = await createRecoveryFixture({ identities: true })
    const submitted = await submit(fixture)
    const review = await recoveryReview(Number(fixture.customer.id))
    await decide(Number(review.id), 'rejected', 'append-only')
    const records = await payload.find({
      collection: 'accountRecoveryRecords',
      overrideAccess: true,
      where: { requestKey: { equals: submitted.recoveryRequestId } },
    })
    expect(records.totalDocs).toBe(2)
    for (const record of records.docs) {
      await expect(
        payload.update({
          collection: 'accountRecoveryRecords',
          data: { decisionNote: 'attempted rewrite' },
          id: record.id,
          overrideAccess: true,
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_RECORD_APPEND_ONLY' })
      await expect(
        payload.delete({
          collection: 'accountRecoveryRecords',
          id: record.id,
          overrideAccess: true,
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_RECOVERY_RECORD_APPEND_ONLY' })
    }
    const unchanged = await payload.count({
      collection: 'accountRecoveryRecords',
      overrideAccess: true,
      where: { requestKey: { equals: submitted.recoveryRequestId } },
    })
    expect(unchanged.totalDocs).toBe(2)
  })

  it('keeps recovery records hidden from anonymous, customer, and non-system administrators', async () => {
    const fixture = await createRecoveryFixture()
    const submitted = await submit(fixture)
    const users = [
      undefined,
      { ...fixture.customer, collection: 'customers' as const },
      reviewerUser({ roles: ['analyst'] }),
    ]
    for (const user of users) {
      const req = await requestFor(user)
      await expect(
        req.payload.find({
          collection: 'accountRecoveryRecords',
          overrideAccess: false,
          req,
          user: req.user,
          where: { requestKey: { equals: submitted.recoveryRequestId } },
        }),
      ).rejects.toMatchObject({ status: 403 })
    }
    const systemReq = await requestFor(reviewerUser())
    const allowed = await systemReq.payload.find({
      collection: 'accountRecoveryRecords',
      overrideAccess: false,
      req: systemReq,
      user: systemReq.user,
      where: { requestKey: { equals: submitted.recoveryRequestId } },
    })
    expect(allowed.totalDocs).toBe(1)
  })

  it('keeps recovery-record create, update, and delete closed through collection access', async () => {
    const fixture = await createRecoveryFixture()
    const submitted = await submit(fixture)
    const record = await payload.find({
      collection: 'accountRecoveryRecords',
      limit: 1,
      overrideAccess: true,
      where: { requestKey: { equals: submitted.recoveryRequestId } },
    })
    const req = await requestFor({ ...fixture.customer, collection: 'customers' as const })
    await expect(
      req.payload.create({
        collection: 'accountRecoveryRecords',
        data: {
          customer: fixture.customer.id,
          eventType: 'request_submitted',
          manualReview: record.docs[0]!.manualReview,
          occurredAt: new Date().toISOString(),
          recordKey: randomUUID(),
          requestKey: randomUUID(),
        },
        overrideAccess: false,
        req,
        user: req.user,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      req.payload.update({
        collection: 'accountRecoveryRecords',
        data: { decisionNote: 'forbidden rewrite' },
        id: record.docs[0]!.id,
        overrideAccess: false,
        req,
        user: req.user,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      req.payload.delete({
        collection: 'accountRecoveryRecords',
        id: record.docs[0]!.id,
        overrideAccess: false,
        req,
        user: req.user,
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('restricts recovery audit actions to their intended actor types', async () => {
    const req = await requestFor(reviewerUser())
    await expect(
      recordAuditEvent(req, {
        action: 'customer.account_recovery.requested',
        actor: { id: reviewer.id, type: 'admin' },
        targetId: 1,
      }),
    ).rejects.toThrow('does not allow actor type admin')
    await expect(
      recordAuditEvent(req, {
        action: 'customer.account_recovery.decided',
        actor: { type: 'anonymous' },
        targetId: 1,
      }),
    ).rejects.toThrow('does not allow actor type anonymous')
  })

  const cooldownCases = [
    ['domain management password', 'domain_management_password'],
    ['domain lock disable', 'domain_lock_change'],
    ['Name Server change', 'nameserver_change'],
    ['real-name information change', 'realname_change'],
  ] as const

  for (const [label, purpose] of cooldownCases) {
    it(`rejects only the ${label} action when that recovery cooldown case is exercised`, async () => {
      const fixture = await createRecoveryFixture()
      await payload.update({
        collection: 'customers',
        data: { identityRiskCooldownStartedAt: new Date().toISOString() },
        id: fixture.customer.id,
        overrideAccess: true,
      })
      const req = await requestFor(
        { ...fixture.customer, collection: 'customers' as const },
        `cooldown-${purpose}`,
      )
      const grant = await issueStepUpGrantFixture(
        payload,
        req,
        Number(fixture.customer.id),
        purpose,
      )
      await expect(
        authorizeStepUpGrant(req, {
          customerId: fixture.customer.id,
          deviceId: grant.deviceId,
          headers: req.headers,
          purpose,
          stepUpToken: grant.stepUpToken,
        }),
      ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE' })
      const storedGrant = await payload.find({
        collection: 'stepUpGrants',
        overrideAccess: true,
        where: {
          and: [
            { customer: { equals: fixture.customer.id } },
            { purpose: { equals: purpose } },
            { consumedAt: { exists: false } },
          ],
        },
      })
      expect(storedGrant.totalDocs).toBe(1)
    })
  }
})
