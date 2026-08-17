import { randomInt, randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hmac } from '@/lib/crypto'
import type { AccountClosureBlocker } from '@/lib/domain'
import { getEnv } from '@/lib/env'
import type { Admin, Customer } from '@/payload-types'
import { validateAccountClosureBlockers } from '@/collections/identity'
import {
  collectAccountClosureBlockers,
  executeAccountClosure,
  requestAccountClosure,
  revokeAccountClosure,
} from '@/services/auth/account-closure'
import { inAuthTransaction } from '@/services/auth/atomic'
import { clientHashes, maskPhone } from '@/services/auth/client-facts'
import {
  assertReleasedIdentityRebindAllowed,
  authenticateVerifiedPhone,
  authenticateVerifiedWechat,
  bindVerifiedIdentity,
  createRegistrationIntent,
  identityProviderInstance,
  protectedIdentifier,
  registerCustomer,
} from '@/services/auth/customer-identities'

import { issueStepUpGrantFixture } from '../fixtures/step-up'
import { realnameTemplateFixture } from '../fixtures/realname'

const prefix = `d9a-a6-${randomUUID()}`
let payload: Payload
let administrator: Admin
let supportCustomer: Customer
let supportTemplateId: number

function headers(suffix: string = randomUUID()): Headers {
  return new Headers({
    'user-agent': `Wanmi-D9A-A6/${suffix}`,
    'x-forwarded-for': `198.51.100.${randomInt(1, 250)}`,
    'x-request-id': `${prefix}-${suffix}`,
  })
}

async function requestFor(user?: unknown, suffix: string = randomUUID()): Promise<PayloadRequest> {
  const req = await createLocalReq({ req: { headers: headers(suffix) } }, payload)
  if (user) req.user = user as never
  return req
}

function customerUser(customer: Customer) {
  return { ...customer, collection: 'customers' as const }
}

function adminUser() {
  return { ...administrator, collection: 'admins' as const }
}

async function createCustomer(label: string, status: Customer['status'] = 'active') {
  const suffix = randomUUID()
  return payload.create({
    collection: 'customers',
    data: {
      accountType: 'registered',
      capabilityRestrictions: status === 'restricted' ? ['purchase_disabled'] : [],
      defaultCustomerProfileType: 'individual',
      phone: `${prefix}-${label}-${suffix}`,
      phoneMasked: `***${suffix.slice(-4)}`,
      registrationSource: 'phone',
      status,
    },
    overrideAccess: true,
  })
}

async function createQuote(label: string) {
  const suffix = randomUUID()
  const now = new Date().toISOString()
  return payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: now,
      availabilityRequestId: `${prefix}-availability-${suffix}`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `${prefix}-quote-${suffix}`,
      currency: 'CNY',
      customer: supportCustomer.id,
      domainAscii: `${label}-${suffix}.example`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: now,
      providerProductId: `${prefix}-product`,
      providerRequestId: `${prefix}-provider-${suffix}`,
      quotedAt: now,
      quoteIntegrityHash: 'a'.repeat(64),
      quoteRef: randomUUID(),
      registrationPriceMinor: 100,
      renewalPriceMinor: 100,
      ruleFixedAmountMinor: 0,
      ruleKey: `${prefix}-rule`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
      roundingMode: 'half_up_to_fen',
      schemaVersion: 1,
      sourceCalculationHash: 'b'.repeat(64),
      sourcePriceSnapshotRef: randomUUID(),
      tld: 'example',
      upstreamCostMinor: 100,
      upstreamRegistrationPriceMinor: 100,
      upstreamRenewalPriceMinor: 100,
      userPriceMinor: 100,
      years: 1,
    },
    overrideAccess: true,
  })
}

async function createOrder(
  ownerId: number,
  label: string,
  status: 'pending_payment' | 'succeeded',
) {
  const quote = await createQuote(label)
  const suffix = randomUUID()
  return payload.create({
    collection: 'orders',
    data: {
      amountMinor: 100,
      currency: 'CNY',
      customer: ownerId,
      domainAscii: `${label}-${suffix}.example`,
      orderNumber: `${prefix}-${label}-${suffix}`,
      quote: quote.id,
      quoteSnapshot: { fixture: true },
      realnameTemplate: supportTemplateId,
      status,
    },
    overrideAccess: true,
  })
}

async function createAsset(ownerId: number, label: string) {
  const suffix = randomUUID()
  return payload.create({
    collection: 'domainAssets',
    data: {
      customer: ownerId,
      domainAscii: `${label}-${suffix}.example`,
      expiresAt: '2027-08-16T00:00:00.000Z',
      lastSyncedAt: '2026-08-16T00:00:00.000Z',
      nameservers: ['ns1.example.test', 'ns2.example.test'],
      realnameTemplate: supportTemplateId,
      registeredAt: '2026-08-16T00:00:00.000Z',
      registrar: 'westdigital',
      status: 'active',
    },
    overrideAccess: true,
  })
}

async function createReconciliation(
  orderNumber: string,
  label: string,
  input: { recordKey: string; status: 'difference' | 'matched'; summary: Record<string, unknown> },
) {
  return payload.create({
    collection: 'reconciliations',
    data: {
      currency: 'CNY',
      differenceMinor: input.status === 'difference' ? 1 : 0,
      kind: 'three_way',
      ledger: 'internal_orders',
      periodEnd: '2026-08-17T00:00:00.000Z',
      periodStart: '2026-08-16T00:00:00.000Z',
      reconciliationKey: `${prefix}-${label}-${randomUUID()}`,
      recordKey: input.recordKey,
      status: input.status,
      summary: input.summary,
      traceId: `${prefix}-${label}-${orderNumber}`,
    },
    overrideAccess: true,
  })
}

async function blockersFor(customer: Customer): Promise<AccountClosureBlocker[]> {
  const req = await requestFor(customerUser(customer), 'blockers')
  return inAuthTransaction(req, () => collectAccountClosureBlockers(req, Number(customer.id)))
}

async function closureRequest(customer: Customer, label: string) {
  const req = await requestFor(customerUser(customer), label)
  const grant = await issueStepUpGrantFixture(payload, req, customer.id, 'account_deletion')
  return requestAccountClosure(req, customer, {
    ...grant,
    reason: `关闭测试账号：${label}`,
  })
}

async function expireClosureCooldown(requestId: string): Promise<void> {
  await payload.db.pool.query(
    `UPDATE account_closure_requests
     SET cooldown_ends_at = NOW() - INTERVAL '1 second'
     WHERE request_key = $1 AND event_type = 'requested'`,
    [requestId],
  )
}

async function createReleasedWechatRegistrationFixture(label: string) {
  const originalPhone = `+86137${randomInt(10_000_000, 100_000_000)}`
  const openid = `${prefix}-${label}-openid-${randomUUID()}`
  const originalCustomer = await payload.create({
    collection: 'customers',
    data: {
      accountType: 'registered',
      capabilityRestrictions: [],
      defaultCustomerProfileType: 'individual',
      phone: originalPhone,
      phoneMasked: maskPhone(originalPhone),
      registrationSource: 'phone',
      status: 'active',
    },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'customerIdentities',
    data: {
      ...protectedIdentifier(originalPhone),
      boundAt: new Date().toISOString(),
      customer: originalCustomer.id,
      provider: 'phone',
      providerInstanceId: identityProviderInstance('phone'),
      status: 'active',
      verifiedAt: new Date().toISOString(),
    },
    overrideAccess: true,
  })
  const wechatIdentity = await payload.create({
    collection: 'customerIdentities',
    data: {
      ...protectedIdentifier(openid),
      boundAt: new Date().toISOString(),
      customer: originalCustomer.id,
      provider: 'wechat',
      providerInstanceId: identityProviderInstance('wechat'),
      status: 'active',
      verifiedAt: new Date().toISOString(),
    },
    overrideAccess: true,
  })

  const requested = await closureRequest(originalCustomer, `${label}-closure`)
  await expireClosureCooldown(requested.requestId)
  const completed = await executeAccountClosure(await requestFor(adminUser(), `${label}-execute`), {
    actorId: administrator.id,
    note: '释放微信身份以验证注册重绑定冷却',
    requestId: requested.requestId,
  })
  if (completed.status !== 'closed') throw new Error('fixture account closure was blocked')
  await expect(
    payload.findByID({
      collection: 'customerIdentities',
      id: wechatIdentity.id,
      overrideAccess: true,
    }),
  ).resolves.toMatchObject({
    rebindAllowedAt: completed.identityRebindAllowedAt,
    releasedIdentifierHash: hmac(openid, getEnv().SESSION_PEPPER),
    status: 'unbound',
  })

  const registrationPhone = `+86136${randomInt(10_000_000, 100_000_000)}`
  const deviceId = `${prefix}-${label}-device-${randomUUID()}`
  const authFlowToken = `${prefix}-${label}-flow-${randomUUID()}`
  const requestHeaders = headers(`${label}-registration`)
  const hashes = clientHashes(requestHeaders, deviceId)
  const registrationReq = await createLocalReq({ req: { headers: requestHeaders } }, payload)
  const phoneIntent = await createRegistrationIntent(registrationReq, {
    ...hashes,
    identifier: registrationPhone,
    phoneMasked: maskPhone(registrationPhone),
    provider: 'phone',
    source: 'phone',
  })
  const wechatIntent = await createRegistrationIntent(registrationReq, {
    deviceHash: hmac(authFlowToken, getEnv().SESSION_PEPPER),
    identifier: openid,
    ipHash: hashes.ipHash,
    provider: 'wechat',
    source: 'wechat_qrcode',
  })

  return {
    authFlowToken,
    deviceId,
    openid,
    phoneRegistrationToken: phoneIntent.registrationToken,
    rebindAllowedAt: completed.identityRebindAllowedAt,
    registrationHeaders: requestHeaders,
    registrationPhone,
    registrationToken: wechatIntent.registrationToken,
    releasedIdentityId: wechatIdentity.id,
  }
}

async function completeReleasedWechatRegistration(
  fixture: Awaited<ReturnType<typeof createReleasedWechatRegistrationFixture>>,
) {
  return registerCustomer(
    await createLocalReq({ req: { headers: fixture.registrationHeaders } }, payload),
    {
      acceptedDeviceIdentifierNotice: true,
      acceptedPrivacyPolicy: true,
      acceptedServiceTerms: true,
      commercialSmsOptIn: false,
      confirmsAdultOrAuthorizedRepresentative: true,
      defaultCustomerProfileType: 'individual',
      deviceId: fixture.deviceId,
      phoneRegistrationToken: fixture.phoneRegistrationToken,
      registrationToken: fixture.registrationToken,
    },
    fixture.registrationHeaders,
    fixture.authFlowToken,
  )
}

type PersistentBlocker = Exclude<
  AccountClosureBlocker,
  `${string}_check_unavailable` | 'closure_cooldown_active' | 'positive_balance'
>

async function addPersistentBlocker(customer: Customer, blocker: PersistentBlocker): Promise<void> {
  if (blocker === 'domains_held') {
    await createAsset(Number(customer.id), blocker)
    return
  }
  if (blocker === 'unfinished_orders') {
    await createOrder(Number(customer.id), blocker, 'pending_payment')
    return
  }
  if (blocker === 'pending_automatic_renewals') {
    const order = await createOrder(Number(supportCustomer.id), blocker, 'succeeded')
    const asset = await createAsset(Number(supportCustomer.id), blocker)
    await payload.create({
      collection: 'renewals',
      data: {
        asset: asset.id,
        customer: customer.id,
        order: order.id,
        previousExpiresAt: '2027-08-16T00:00:00.000Z',
        status: 'pending',
        years: 1,
      },
      overrideAccess: true,
    })
    return
  }
  if (blocker === 'refund_or_reconciliation_issue') {
    const order = await createOrder(Number(customer.id), blocker, 'succeeded')
    await payload.create({
      collection: 'refunds',
      data: {
        amountMinor: 100,
        createdTraceId: `${prefix}-refund`,
        currency: 'CNY',
        order: order.id,
        refundNumber: `${prefix}-refund-${randomUUID()}`,
        status: 'pending',
      },
      overrideAccess: true,
    })
    return
  }
  if (blocker === 'invoice_processing') {
    const order = await createOrder(Number(customer.id), blocker, 'succeeded')
    await payload.create({
      collection: 'orderManualActions',
      data: {
        actionKey: randomUUID(),
        actionType: 'invoice_note',
        evidence: { fixture: true },
        invoiceStatus: 'processing',
        operator: administrator.id,
        order: order.id,
        reason: '发票处理中',
        recordedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    return
  }
  await payload.create({
    collection: 'manualReviews',
    data: {
      customer: customer.id,
      reasonCode: 'account_security_dispute',
      status: 'open',
    },
    overrideAccess: true,
  })
}

beforeAll(async () => {
  payload = await getPayload({ config })
  supportCustomer = await createCustomer('support')
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `${prefix}-support-template` }),
      customer: supportCustomer.id,
    },
    overrideAccess: true,
  })
  supportTemplateId = Number(template.id)
  administrator = await payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap' },
    data: {
      email: `${prefix}@example.test`,
      password: 'D9A-A6-Test-Administrator-Password!',
      roles: ['system_admin'],
      status: 'active',
    },
    overrideAccess: true,
  })
})

afterAll(async () => {
  vi.useRealTimers()
  await payload.db.destroy?.()
})

describe('D9-A A6 account closure', () => {
  it('returns no blockers for a clean active account', async () => {
    const customer = await createCustomer('clean')
    await expect(blockersFor(customer)).resolves.toEqual([])
  })

  it('keeps every precondition query scoped to the target customer', async () => {
    const target = await createCustomer('scope-target')
    const unrelated = await createCustomer('scope-unrelated')
    await createOrder(Number(target.id), 'scope-target-terminal-order', 'succeeded')
    for (const blocker of [
      'domains_held',
      'unfinished_orders',
      'pending_automatic_renewals',
      'refund_or_reconciliation_issue',
      'invoice_processing',
      'security_freeze_or_dispute',
    ] as const) {
      await addPersistentBlocker(unrelated, blocker)
    }
    const disputedOrder = await createOrder(
      Number(unrelated.id),
      'scope-unrelated-disputed-refund',
      'succeeded',
    )
    await payload.create({
      collection: 'refunds',
      data: {
        amountMinor: 100,
        createdTraceId: `${prefix}-scope-disputed-refund`,
        currency: 'CNY',
        failureCategory: 'disputed',
        order: disputedOrder.id,
        refundNumber: `${prefix}-scope-disputed-refund-${randomUUID()}`,
        status: 'pending',
      },
      overrideAccess: true,
    })
    const reconciliationOrder = await createOrder(
      Number(unrelated.id),
      'scope-unrelated-reconciliation',
      'succeeded',
    )
    await createReconciliation(reconciliationOrder.orderNumber, 'scope-unrelated-reconciliation', {
      recordKey: `order:${reconciliationOrder.orderNumber}`,
      status: 'difference',
      summary: {},
    })
    const req = await requestFor(customerUser(target), 'scope-target')
    await expect(
      inAuthTransaction(req, async () => {
        const transactionId = await req.transactionID
        const database = req.payload.db.sessions?.[transactionId!]?.db as {
          execute: (statement: ReturnType<typeof sql>) => Promise<unknown>
        }
        await database.execute(sql`
          CREATE TEMP TABLE wallet_accounts (
            customer_id integer NOT NULL,
            posted_balance numeric NOT NULL,
            held_balance numeric NOT NULL
          ) ON COMMIT DROP
        `)
        await database.execute(sql`
          INSERT INTO wallet_accounts (customer_id, posted_balance, held_balance)
          VALUES (${unrelated.id}, 101, 1)
        `)
        return collectAccountClosureBlockers(req, Number(target.id))
      }),
    ).resolves.toEqual([])
  })

  it.each([
    ['domains_held'] as const,
    ['unfinished_orders'] as const,
    ['pending_automatic_renewals'] as const,
    ['refund_or_reconciliation_issue'] as const,
    ['invoice_processing'] as const,
    ['security_freeze_or_dispute'] as const,
  ])('blocks with only %s when only that precondition is present', async (expectedBlocker) => {
    const customer = await createCustomer(expectedBlocker)
    await addPersistentBlocker(customer, expectedBlocker)
    await expect(blockersFor(customer)).resolves.toEqual([expectedBlocker])
  })

  it('blocks with only positive_balance when the future wallet ledger exists and is positive', async () => {
    const customer = await createCustomer('positive-balance')
    const req = await requestFor(customerUser(customer), 'positive-balance')
    await expect(
      inAuthTransaction(req, async () => {
        const transactionId = await req.transactionID
        const database = req.payload.db.sessions?.[transactionId!]?.db as {
          execute: (statement: ReturnType<typeof sql>) => Promise<unknown>
        }
        await database.execute(sql`
          CREATE TEMP TABLE wallet_accounts (
            customer_id integer NOT NULL,
            posted_balance numeric NOT NULL,
            held_balance numeric NOT NULL
          ) ON COMMIT DROP
        `)
        await database.execute(sql`
          INSERT INTO wallet_accounts (customer_id, posted_balance, held_balance)
          VALUES (${customer.id}, 101, 1)
        `)
        return collectAccountClosureBlockers(req, Number(customer.id))
      }),
    ).resolves.toEqual(['positive_balance'])
  })

  it.each(['record-key', 'summary'] as const)(
    'detects an unmatched reconciliation through the %s relationship independently',
    async (relationship) => {
      const customer = await createCustomer(`reconciliation-${relationship}`)
      const order = await createOrder(
        Number(customer.id),
        `reconciliation-${relationship}`,
        'succeeded',
      )
      await createReconciliation(order.orderNumber, `reconciliation-${relationship}`, {
        recordKey: relationship === 'record-key' ? `order:${order.orderNumber}` : 'unrelated',
        status: 'difference',
        summary: relationship === 'summary' ? { orderNumber: order.orderNumber } : {},
      })
      await expect(blockersFor(customer)).resolves.toEqual(['refund_or_reconciliation_issue'])
    },
  )

  it.each(['suspended', 'refund-review'] as const)(
    'detects the customer %s security state independently',
    async (variant) => {
      const customer = await createCustomer(
        `security-${variant}`,
        variant === 'suspended' ? 'suspended' : 'restricted',
      )
      if (variant === 'refund-review') {
        await payload.update({
          collection: 'customers',
          data: { capabilityRestrictions: ['refund_review'] },
          id: customer.id,
          overrideAccess: true,
        })
      }
      await expect(blockersFor(customer)).resolves.toEqual(['security_freeze_or_dispute'])
    },
  )

  it('ignores terminal orders and renewals, settled refunds and reconciliations, completed invoices, resolved reviews, and nonpositive balances', async () => {
    const customer = await createCustomer('terminal-preconditions')
    await createOrder(Number(customer.id), 'terminal-order', 'succeeded')

    const renewalOrder = await createOrder(
      Number(supportCustomer.id),
      'terminal-renewal',
      'succeeded',
    )
    const renewalAsset = await createAsset(Number(supportCustomer.id), 'terminal-renewal')
    await payload.create({
      collection: 'renewals',
      data: {
        asset: renewalAsset.id,
        customer: customer.id,
        order: renewalOrder.id,
        previousExpiresAt: '2027-08-16T00:00:00.000Z',
        status: 'succeeded',
        years: 1,
      },
      overrideAccess: true,
    })

    const refundOrder = await createOrder(Number(customer.id), 'terminal-refund', 'succeeded')
    await payload.create({
      collection: 'refunds',
      data: {
        amountMinor: 100,
        createdTraceId: `${prefix}-terminal-refund`,
        currency: 'CNY',
        failureCategory: 'disputed',
        order: refundOrder.id,
        refundNumber: `${prefix}-terminal-refund-${randomUUID()}`,
        status: 'succeeded',
      },
      overrideAccess: true,
    })
    const reconciliationOrder = await createOrder(
      Number(customer.id),
      'terminal-reconciliation',
      'succeeded',
    )
    await createReconciliation(reconciliationOrder.orderNumber, 'terminal-reconciliation', {
      recordKey: `order:${reconciliationOrder.orderNumber}`,
      status: 'matched',
      summary: { orderNumber: reconciliationOrder.orderNumber },
    })

    const invoiceOrder = await createOrder(Number(customer.id), 'terminal-invoice', 'succeeded')
    await payload.create({
      collection: 'orderManualActions',
      data: {
        actionKey: randomUUID(),
        actionType: 'invoice_note',
        evidence: { fixture: true },
        invoiceStatus: 'completed',
        operator: administrator.id,
        order: invoiceOrder.id,
        reason: '时间较晚的已完成记录',
        recordedAt: '2026-08-16T11:00:00.000Z',
      },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'orderManualActions',
      data: {
        actionKey: randomUUID(),
        actionType: 'invoice_note',
        evidence: { fixture: true },
        invoiceStatus: 'processing',
        operator: administrator.id,
        order: invoiceOrder.id,
        reason: '后插入但时间较早的处理中记录',
        recordedAt: '2026-08-16T10:00:00.000Z',
      },
      overrideAccess: true,
    })
    const tiedInvoiceOrder = await createOrder(
      Number(customer.id),
      'terminal-tied-invoice',
      'succeeded',
    )
    for (const invoiceStatus of ['processing', 'completed'] as const) {
      await payload.create({
        collection: 'orderManualActions',
        data: {
          actionKey: randomUUID(),
          actionType: 'invoice_note',
          evidence: { fixture: true },
          invoiceStatus,
          operator: administrator.id,
          order: tiedInvoiceOrder.id,
          reason: `同时间戳 ${invoiceStatus}`,
          recordedAt: '2026-08-16T13:00:00.000Z',
        },
        overrideAccess: true,
      })
    }
    const unrelatedManualOrder = await createOrder(
      Number(customer.id),
      'terminal-non-invoice-action',
      'succeeded',
    )
    await payload.create({
      collection: 'orderManualActions',
      data: {
        actionKey: randomUUID(),
        actionType: 'special_refund',
        amountMinor: 1,
        currency: 'CNY',
        evidence: { fixture: true },
        invoiceStatus: 'processing',
        operator: administrator.id,
        order: unrelatedManualOrder.id,
        reason: '非发票人工动作',
        recordedAt: '2026-08-16T12:00:00.000Z',
      },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'manualReviews',
      data: {
        customer: customer.id,
        reasonCode: 'resolved-security-review',
        status: 'resolved',
      },
      overrideAccess: true,
    })

    const req = await requestFor(customerUser(customer), 'terminal-preconditions')
    await expect(
      inAuthTransaction(req, async () => {
        const transactionId = await req.transactionID
        const database = req.payload.db.sessions?.[transactionId!]?.db as {
          execute: (statement: ReturnType<typeof sql>) => Promise<unknown>
        }
        await database.execute(sql`
          CREATE TEMP TABLE wallet_accounts (
            customer_id integer NOT NULL,
            posted_balance numeric NOT NULL,
            held_balance numeric NOT NULL
          ) ON COMMIT DROP
        `)
        await database.execute(sql`
          INSERT INTO wallet_accounts (customer_id, posted_balance, held_balance)
          VALUES (${customer.id}, 100, 100), (${supportCustomer.id}, 101, 1)
        `)
        return collectAccountClosureBlockers(req, Number(customer.id))
      }),
    ).resolves.toEqual([])
  })

  it.each([
    'domains_held',
    'unfinished_orders',
    'pending_automatic_renewals',
    'refund_or_reconciliation_issue',
    'invoice_processing',
    'security_freeze_or_dispute',
    'positive_balance',
  ] as const)('fails closed as %s_check_unavailable when that query fails', async (blocker) => {
    let call = 0
    const failingCall = [
      'domains_held',
      'unfinished_orders',
      'pending_automatic_renewals',
      'refund_or_reconciliation_issue',
      'invoice_processing',
      'security_freeze_or_dispute',
      'positive_balance',
    ].indexOf(blocker)
    const transactionId = randomUUID()
    const req = {
      payload: {
        db: {
          sessions: {
            [transactionId]: {
              db: {
                execute: async () => {
                  const current = call
                  call += 1
                  if (current === failingCall) throw new Error('fixture query failure')
                  if (current === 6) return { rows: [{ relation_name: null }] }
                  return { rows: [{ blocked: false }] }
                },
              },
            },
          },
        },
      },
      transactionID: Promise.resolve(transactionId),
    } as never
    await expect(collectAccountClosureBlockers(req, 42)).resolves.toEqual([
      `${blocker}_check_unavailable`,
    ])
  })

  it.each([
    'domains_held',
    'unfinished_orders',
    'pending_automatic_renewals',
    'refund_or_reconciliation_issue',
    'invoice_processing',
    'security_freeze_or_dispute',
    'positive_balance',
  ] as const)('fails closed when %s returns a non-boolean database value', async (blocker) => {
    let call = 0
    const malformedCall = [
      'domains_held',
      'unfinished_orders',
      'pending_automatic_renewals',
      'refund_or_reconciliation_issue',
      'invoice_processing',
      'security_freeze_or_dispute',
    ].indexOf(blocker)
    const targetCall = blocker === 'positive_balance' ? 7 : malformedCall
    const transactionId = randomUUID()
    const req = {
      payload: {
        db: {
          sessions: {
            [transactionId]: {
              db: {
                execute: async () => {
                  const current = call
                  call += 1
                  if (current === targetCall) return { rows: [{ blocked: 'yes' }] }
                  if (current === 6) {
                    return {
                      rows: [
                        {
                          relation_name: blocker === 'positive_balance' ? 'wallet_accounts' : null,
                        },
                      ],
                    }
                  }
                  return { rows: [{ blocked: false }] }
                },
              },
            },
          },
        },
      },
      transactionID: Promise.resolve(transactionId),
    } as never
    await expect(collectAccountClosureBlockers(req, 42)).resolves.toEqual([
      `${blocker}_check_unavailable`,
    ])
  })

  it.each([
    'domains_held',
    'unfinished_orders',
    'pending_automatic_renewals',
    'refund_or_reconciliation_issue',
    'invoice_processing',
    'security_freeze_or_dispute',
    'positive_balance',
  ] as const)('refuses final execution with only the fresh %s blocker', async (blocker) => {
    const customer = await createCustomer(`execute-${blocker}`)
    const requested = await closureRequest(customer, `execute-${blocker}`)
    await expireClosureCooldown(requested.requestId)

    let result
    if (blocker === 'positive_balance') {
      const req = await requestFor(adminUser(), `execute-${blocker}`)
      result = await inAuthTransaction(req, async () => {
        const transactionId = await req.transactionID
        const database = req.payload.db.sessions?.[transactionId!]?.db as {
          execute: (statement: ReturnType<typeof sql>) => Promise<unknown>
        }
        await database.execute(sql`
          CREATE TEMP TABLE wallet_accounts (
            customer_id integer NOT NULL,
            posted_balance numeric NOT NULL,
            held_balance numeric NOT NULL
          ) ON COMMIT DROP
        `)
        await database.execute(sql`
          INSERT INTO wallet_accounts (customer_id, posted_balance, held_balance)
          VALUES (${customer.id}, 101, 1)
        `)
        return executeAccountClosure(req, {
          actorId: administrator.id,
          note: '仅命中余额前置项',
          requestId: requested.requestId,
        })
      })
    } else {
      await addPersistentBlocker(customer, blocker)
      result = await executeAccountClosure(await requestFor(adminUser(), `execute-${blocker}`), {
        actorId: administrator.id,
        note: `仅命中 ${blocker} 前置项`,
        requestId: requested.requestId,
      })
    }
    expect(result).toEqual({
      blockers: [blocker],
      requestId: requested.requestId,
      status: 'blocked',
    })
    await expect(
      payload.findByID({ collection: 'customers', id: customer.id, overrideAccess: true }),
    ).resolves.toMatchObject({
      accountClosureExecutionClaimedAt: null,
      activeAccountClosureRequestKey: requested.requestId,
      status: 'active',
    })
    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: {
          and: [
            { requestKey: { equals: requested.requestId } },
            { eventType: { equals: 'blockers_refreshed' } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 1 })
  })

  it('refuses final execution during the persisted closure cooldown and releases its claim', async () => {
    const customer = await createCustomer('execute-cooldown')
    const unrelated = await createCustomer('execute-cooldown-unrelated')
    const unrelatedClaim = '2026-08-16T20:00:00.000Z'
    await payload.db.pool.query(
      `UPDATE customers SET account_closure_execution_claimed_at = $1 WHERE id = $2`,
      [unrelatedClaim, unrelated.id],
    )
    const requested = await closureRequest(customer, 'execute-cooldown')
    await expect(
      executeAccountClosure(await requestFor(adminUser(), 'execute-cooldown'), {
        actorId: administrator.id,
        note: '注销冷静期尚未结束',
        requestId: requested.requestId,
      }),
    ).resolves.toEqual({
      blockers: ['closure_cooldown_active'],
      requestId: requested.requestId,
      status: 'blocked',
    })
    await expect(
      payload.findByID({ collection: 'customers', id: customer.id, overrideAccess: true }),
    ).resolves.toMatchObject({ accountClosureExecutionClaimedAt: null, status: 'active' })
    await expect(
      payload.findByID({ collection: 'customers', id: unrelated.id, overrideAccess: true }),
    ).resolves.toMatchObject({ accountClosureExecutionClaimedAt: unrelatedClaim })
  })

  it('appends a distinct immutable blocker refresh on every blocked retry', async () => {
    const customer = await createCustomer('repeated-blocker-refresh')
    const requested = await closureRequest(customer, 'repeated-blocker-refresh')
    await expireClosureCooldown(requested.requestId)
    await addPersistentBlocker(customer, 'domains_held')
    for (const attempt of [1, 2]) {
      await expect(
        executeAccountClosure(await requestFor(adminUser(), `blocker-refresh-${attempt}`), {
          actorId: administrator.id,
          note: `第 ${attempt} 次复核仍持有域名`,
          requestId: requested.requestId,
        }),
      ).resolves.toEqual({
        blockers: ['domains_held'],
        requestId: requested.requestId,
        status: 'blocked',
      })
    }
    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: {
          and: [
            { requestKey: { equals: requested.requestId } },
            { eventType: { equals: 'blockers_refreshed' } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 2 })
  })

  it('requires a fresh one-time deletion grant for every new closure request', async () => {
    const customer = await createCustomer('fresh-grant')
    const user = customerUser(customer)
    const firstReq = await requestFor(user, 'fresh-grant-first')
    const firstGrant = await issueStepUpGrantFixture(
      payload,
      firstReq,
      customer.id,
      'account_deletion',
    )
    const firstPromise = requestAccountClosure(firstReq, customer, {
      ...firstGrant,
      reason: '第一次账户关闭申请',
    })
    await expect(firstPromise).resolves.toMatchObject({ status: 'pending' })
    const first = await firstPromise
    await revokeAccountClosure(await requestFor(user, 'fresh-grant-revoke'), customer, {
      reason: '暂时保留账号',
      requestId: first.requestId,
    })
    await expect(
      requestAccountClosure(await requestFor(user, 'fresh-grant-reuse'), customer, {
        ...firstGrant,
        reason: '不得复用旧授权',
      }),
    ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID', status: 403 })

    const secondReq = await requestFor(user, 'fresh-grant-second')
    const secondGrant = await issueStepUpGrantFixture(
      payload,
      secondReq,
      customer.id,
      'account_deletion',
    )
    await expect(
      requestAccountClosure(secondReq, customer, {
        ...secondGrant,
        reason: '使用全新授权再次申请',
      }),
    ).resolves.toMatchObject({ status: 'pending' })
  })

  it('keeps every one-time deletion grant SQL predicate necessary', async () => {
    const otherCustomer = await createCustomer('grant-sql-other-customer')
    const cases: Array<{
      label: string
      mutate: (tokenHash: string) => Promise<void>
      token?: string
    }> = [
      {
        label: 'token-hash',
        mutate: async () => undefined,
        token: 'not-the-issued-token',
      },
      {
        label: 'customer-id',
        mutate: async (tokenHash: string) => {
          await payload.db.pool.query(
            `UPDATE step_up_grants SET customer_id = $1 WHERE token_hash = $2`,
            [otherCustomer.id, tokenHash],
          )
        },
      },
      {
        label: 'purpose',
        mutate: async (tokenHash: string) => {
          await payload.db.pool.query(
            `UPDATE step_up_grants SET purpose = 'balance_spend' WHERE token_hash = $1`,
            [tokenHash],
          )
        },
      },
      {
        label: 'device-hash',
        mutate: async (tokenHash: string) => {
          await payload.db.pool.query(
            `UPDATE step_up_grants SET device_hash = 'mismatched-device' WHERE token_hash = $1`,
            [tokenHash],
          )
        },
      },
      {
        label: 'unconsumed',
        mutate: async (tokenHash: string) => {
          await payload.db.pool.query(
            `UPDATE step_up_grants SET consumed_at = NOW() WHERE token_hash = $1`,
            [tokenHash],
          )
        },
      },
      {
        label: 'unexpired',
        mutate: async (tokenHash: string) => {
          await payload.db.pool.query(
            `UPDATE step_up_grants SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash = $1`,
            [tokenHash],
          )
        },
      },
    ]

    const customerIds: Array<number | string> = []
    for (const candidate of cases) {
      const customer = await createCustomer(`grant-sql-${candidate.label}`)
      customerIds.push(customer.id)
      const req = await requestFor(customerUser(customer), `grant-sql-${candidate.label}`)
      const grant = await issueStepUpGrantFixture(payload, req, customer.id, 'account_deletion')
      const tokenHash = hmac(grant.stepUpToken, getEnv().SESSION_PEPPER)
      await candidate.mutate(tokenHash)
      await expect(
        requestAccountClosure(req, customer, {
          deviceId: grant.deviceId,
          reason: `不得忽略 ${candidate.label} 谓词`,
          stepUpToken: candidate.token ?? grant.stepUpToken,
        }),
        candidate.label,
      ).rejects.toMatchObject({ code: 'STEP_UP_GRANT_INVALID', status: 403 })
    }
    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: { customer: { in: customerIds } },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('keeps every request-claim id, allowed-status, no-active-request, and no-execution-claim predicate necessary', async () => {
    const target = await createCustomer('request-cas-target')
    const untouched = await createCustomer('request-cas-untouched')
    await expect(closureRequest(target, 'request-cas-target')).resolves.toMatchObject({
      status: 'pending',
    })
    await expect(
      payload.findByID({ collection: 'customers', id: untouched.id, overrideAccess: true }),
    ).resolves.toMatchObject({ activeAccountClosureRequestKey: null })

    const staleStatus = await createCustomer('request-cas-status')
    const staleStatusReq = await requestFor(customerUser(staleStatus), 'request-cas-status')
    const staleStatusGrant = await issueStepUpGrantFixture(
      payload,
      staleStatusReq,
      staleStatus.id,
      'account_deletion',
    )
    await payload.db.pool.query(`UPDATE customers SET status = 'suspended' WHERE id = $1`, [
      staleStatus.id,
    ])
    await expect(
      requestAccountClosure(staleStatusReq, staleStatus, {
        ...staleStatusGrant,
        reason: '状态快照已经过期',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REQUEST_CONFLICT' })

    const activeRequest = await createCustomer('request-cas-active-request')
    const existingRequestKey = randomUUID()
    await payload.db.pool.query(
      `UPDATE customers SET active_account_closure_request_key = $1 WHERE id = $2`,
      [existingRequestKey, activeRequest.id],
    )
    const activeReq = await requestFor(customerUser(activeRequest), 'request-cas-active-request')
    const activeGrant = await issueStepUpGrantFixture(
      payload,
      activeReq,
      activeRequest.id,
      'account_deletion',
    )
    await expect(
      requestAccountClosure(activeReq, activeRequest, {
        ...activeGrant,
        reason: '已有申请不得覆盖',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REQUEST_CONFLICT' })
    await expect(
      payload.findByID({ collection: 'customers', id: activeRequest.id, overrideAccess: true }),
    ).resolves.toMatchObject({ activeAccountClosureRequestKey: existingRequestKey })

    const executing = await createCustomer('request-cas-executing')
    const claimedAt = new Date().toISOString()
    await payload.db.pool.query(
      `UPDATE customers SET account_closure_execution_claimed_at = $1 WHERE id = $2`,
      [claimedAt, executing.id],
    )
    const executingReq = await requestFor(customerUser(executing), 'request-cas-executing')
    const executingGrant = await issueStepUpGrantFixture(
      payload,
      executingReq,
      executing.id,
      'account_deletion',
    )
    await expect(
      requestAccountClosure(executingReq, executing, {
        ...executingGrant,
        reason: '执行占用期间不得重复申请',
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REQUEST_CONFLICT' })
    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: {
          customer: { in: [staleStatus.id, activeRequest.id, executing.id] },
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('rejects a closure request during the shared identity-risk cooldown', async () => {
    const customer = await createCustomer('risk-cooldown')
    const cooled = await payload.update({
      collection: 'customers',
      data: { identityRiskCooldownStartedAt: new Date().toISOString() },
      id: customer.id,
      overrideAccess: true,
    })
    const req = await requestFor(customerUser(cooled), 'risk-cooldown')
    const grant = await issueStepUpGrantFixture(payload, req, customer.id, 'account_deletion')
    await expect(
      requestAccountClosure(req, cooled, { ...grant, reason: '冷静期内不得申请关闭' }),
    ).rejects.toMatchObject({ code: 'STEP_UP_IDENTITY_RISK_COOLDOWN_ACTIVE', status: 403 })
    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: { customer: { equals: customer.id } },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('enforces customer ownership and an active matching system-admin identity before any closure write', async () => {
    const owner = await createCustomer('actor-owner')
    const other = await createCustomer('actor-other')
    await expect(
      requestAccountClosure(await requestFor(customerUser(other), 'actor-request'), owner, {
        deviceId: 'actor-device-123456',
        reason: '其他客户不得代为申请',
        stepUpToken: 'A'.repeat(43),
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_FORBIDDEN', status: 403 })
    await expect(
      requestAccountClosure(
        await requestFor(
          {
            ...administrator,
            collection: 'admins' as const,
            id: owner.id,
          },
          'actor-request-admin-kind',
        ),
        owner,
        {
          deviceId: 'actor-device-123456',
          reason: '同 ID 的非客户身份不得申请',
          stepUpToken: 'A'.repeat(43),
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_FORBIDDEN', status: 403 })

    const requested = await closureRequest(owner, 'actor-owner')
    await expect(
      revokeAccountClosure(await requestFor(customerUser(other), 'actor-revoke-principal'), owner, {
        reason: '请求主体与目标客户不一致不得撤销',
        requestId: requested.requestId,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_FORBIDDEN', status: 403 })
    await expect(
      revokeAccountClosure(await requestFor(customerUser(other), 'actor-revoke'), other, {
        reason: '其他客户不得代为撤销',
        requestId: requested.requestId,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_FORBIDDEN', status: 403 })

    for (const [label, user, actorId] of [
      ['customer', customerUser(owner), owner.id],
      [
        'wrong-admin-id',
        { ...administrator, collection: 'admins' as const },
        Number(administrator.id) + 1,
      ],
      [
        'inactive-admin',
        { ...administrator, collection: 'admins' as const, status: 'disabled' as const },
        administrator.id,
      ],
      [
        'wrong-role',
        { ...administrator, collection: 'admins' as const, roles: ['analyst' as const] },
        administrator.id,
      ],
      ['invalid-actor-id', adminUser(), 0],
      ['fractional-actor-id', { ...administrator, collection: 'admins' as const, id: 1.5 }, 1.5],
      ['zero-actor-id', { ...administrator, collection: 'admins' as const, id: 0 }, 0],
    ] as const) {
      await expect(
        executeAccountClosure(await requestFor(user, `actor-execute-${label}`), {
          actorId,
          note: '权限不符不得执行',
          requestId: requested.requestId,
        }),
        label,
      ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_EXECUTION_FORBIDDEN', status: 403 })
    }
    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: {
          and: [
            { requestKey: { equals: requested.requestId } },
            { eventType: { in: ['revoked', 'executed'] } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('allows exactly one of eight concurrent revocations and appends one revocation record', async () => {
    const customer = await createCustomer('revoke-race')
    const requested = await closureRequest(customer, 'revoke-race')
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        revokeAccountClosure(
          await requestFor(customerUser(customer), `revoke-race-${index}`),
          customer,
          { reason: '并发撤销关闭申请', requestId: requested.requestId },
        ),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(
      results.filter(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: unknown }).code ===
            'ACCOUNT_CLOSURE_REVOCATION_ALREADY_CONSUMED',
      ),
    ).toHaveLength(7)
    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: {
          and: [
            { requestKey: { equals: requested.requestId } },
            { eventType: { equals: 'revoked' } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 1 })
  })

  it('keeps every revocation id, request-key, no-execution-claim, allowed-status, and returned-row predicate necessary', async () => {
    const wrongKeyCustomer = await createCustomer('revoke-cas-key')
    const wrongKeyRequest = await closureRequest(wrongKeyCustomer, 'revoke-cas-key')
    const replacementKey = randomUUID()
    await payload.db.pool.query(
      `UPDATE customers SET active_account_closure_request_key = $1 WHERE id = $2`,
      [replacementKey, wrongKeyCustomer.id],
    )
    await expect(
      revokeAccountClosure(
        await requestFor(customerUser(wrongKeyCustomer), 'revoke-cas-key'),
        wrongKeyCustomer,
        { reason: '过期申请不得撤销', requestId: wrongKeyRequest.requestId },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REVOCATION_ALREADY_CONSUMED' })

    const claimedCustomer = await createCustomer('revoke-cas-claimed')
    const claimedRequest = await closureRequest(claimedCustomer, 'revoke-cas-claimed')
    await payload.db.pool.query(
      `UPDATE customers SET account_closure_execution_claimed_at = NOW() WHERE id = $1`,
      [claimedCustomer.id],
    )
    await expect(
      revokeAccountClosure(
        await requestFor(customerUser(claimedCustomer), 'revoke-cas-claimed'),
        claimedCustomer,
        { reason: '执行占用申请不得撤销', requestId: claimedRequest.requestId },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REVOCATION_ALREADY_CONSUMED' })

    const staleStatusCustomer = await createCustomer('revoke-cas-status')
    const staleStatusRequest = await closureRequest(staleStatusCustomer, 'revoke-cas-status')
    await payload.db.pool.query(`UPDATE customers SET status = 'suspended' WHERE id = $1`, [
      staleStatusCustomer.id,
    ])
    await expect(
      revokeAccountClosure(
        await requestFor(customerUser(staleStatusCustomer), 'revoke-cas-status'),
        staleStatusCustomer,
        { reason: '非允许状态不得撤销', requestId: staleStatusRequest.requestId },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REVOCATION_ALREADY_CONSUMED' })

    const movedCustomer = await createCustomer('revoke-cas-id')
    const movedRequest = await closureRequest(movedCustomer, 'revoke-cas-id')
    const unrelated = await createCustomer('revoke-cas-unrelated')
    await payload.db.pool.query(
      `UPDATE customers SET active_account_closure_request_key = NULL WHERE id = $1`,
      [movedCustomer.id],
    )
    await payload.db.pool.query(
      `UPDATE customers SET active_account_closure_request_key = $1 WHERE id = $2`,
      [movedRequest.requestId, unrelated.id],
    )
    await expect(
      revokeAccountClosure(
        await requestFor(customerUser(movedCustomer), 'revoke-cas-id'),
        movedCustomer,
        { reason: '申请标记不得作用于其他账号', requestId: movedRequest.requestId },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REVOCATION_ALREADY_CONSUMED' })
    await expect(
      payload.findByID({ collection: 'customers', id: unrelated.id, overrideAccess: true }),
    ).resolves.toMatchObject({ activeAccountClosureRequestKey: movedRequest.requestId })

    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: {
          and: [
            {
              requestKey: {
                in: [
                  wrongKeyRequest.requestId,
                  claimedRequest.requestId,
                  staleStatusRequest.requestId,
                  movedRequest.requestId,
                ],
              },
            },
            { eventType: { equals: 'revoked' } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('allows exactly one final execution, closes through A3, and enforces persisted rebind time', async () => {
    const phone = `+86139${randomInt(10_000_000, 100_000_000)}`
    const customer = await payload.create({
      collection: 'customers',
      data: {
        accountType: 'registered',
        capabilityRestrictions: [],
        defaultCustomerProfileType: 'individual',
        phone,
        phoneMasked: `${phone.slice(0, 6)}****${phone.slice(-4)}`,
        registrationSource: 'phone',
        status: 'active',
      },
      overrideAccess: true,
    })
    const identity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(phone),
        boundAt: new Date().toISOString(),
        customer: customer.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const unboundIdentity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(`${phone}-unbound`),
        boundAt: new Date().toISOString(),
        customer: customer.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        status: 'unbound',
        unboundAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const alreadyReleasedIdentity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(`${phone}-already-released`),
        boundAt: new Date().toISOString(),
        customer: customer.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        releasedIdentifierHash: hmac(`${phone}-historical`, getEnv().SESSION_PEPPER),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const reservedIdentity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(`${phone}-reserved`),
        boundAt: new Date().toISOString(),
        customer: customer.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        rebindAllowedAt: '2099-08-16T00:00:00.000Z',
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const template = await payload.create({
      collection: 'realnameTemplates',
      data: {
        ...realnameTemplateFixture({ displayName: `A6执行模板-${randomUUID()}` }),
        customer: customer.id,
      },
      overrideAccess: true,
    })
    const secondary = await createCustomer('rebind-target')
    const unrelatedIdentity = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(`${phone}-unrelated`),
        boundAt: new Date().toISOString(),
        customer: secondary.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const secondaryReq = await requestFor(customerUser(secondary), 'rebind-intent')
    const intent = await createRegistrationIntent(secondaryReq, {
      deviceHash: 'device-hash-for-rebind',
      identifier: phone,
      ipHash: 'ip-hash-for-rebind',
      phoneMasked: `${phone.slice(0, 6)}****${phone.slice(-4)}`,
      provider: 'phone',
      source: 'phone',
    })
    const registrationPhone = `+86138${randomInt(10_000_000, 100_000_000)}`
    await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(registrationPhone),
        boundAt: new Date().toISOString(),
        customer: customer.id,
        provider: 'phone',
        providerInstanceId: identityProviderInstance('phone'),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const wechatOpenid = `${prefix}-closure-wechat-${randomUUID()}`
    await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(wechatOpenid),
        boundAt: new Date().toISOString(),
        customer: customer.id,
        provider: 'wechat',
        providerInstanceId: identityProviderInstance('wechat'),
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const registrationDeviceId = `d9a-a6-registration-${randomUUID()}`
    const registrationHeaders = headers('rebind-registration')
    const registrationHashes = clientHashes(registrationHeaders, registrationDeviceId)
    const registrationReq = await createLocalReq({ req: { headers: registrationHeaders } }, payload)
    const registrationIntent = await createRegistrationIntent(registrationReq, {
      ...registrationHashes,
      identifier: registrationPhone,
      phoneMasked: maskPhone(registrationPhone),
      provider: 'phone',
      source: 'phone',
    })

    const requested = await closureRequest(customer, 'execution-race')
    expect(
      new Date(requested.cooldownEndsAt).getTime() -
        new Date(requested.deletionRequestedAt).getTime(),
    ).toBe(getEnv().ACCOUNT_CLOSURE_COOLDOWN_SECONDS * 1_000)
    await expireClosureCooldown(requested.requestId)
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        executeAccountClosure(await requestFor(adminUser(), `execute-race-${index}`), {
          actorId: administrator.id,
          note: '全部前置项与冷静期已经核验',
          requestId: requested.requestId,
        }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(
      results.filter(
        (result) =>
          result.status === 'rejected' &&
          (result.reason as { code?: unknown }).code ===
            'ACCOUNT_CLOSURE_EXECUTION_ALREADY_CONSUMED',
      ),
    ).toHaveLength(7)
    const completed = results.find((result) => result.status === 'fulfilled')
    expect(completed).toBeDefined()
    if (!completed || completed.status !== 'fulfilled') throw new Error('closure did not execute')
    expect(completed.value).toMatchObject({ status: 'closed' })
    if (completed.value.status !== 'closed') throw new Error('closure was unexpectedly blocked')
    expect(
      new Date(completed.value.identityRebindAllowedAt).getTime() -
        new Date(completed.value.executedAt).getTime(),
    ).toBe(getEnv().IDENTITY_REBIND_COOLDOWN_SECONDS * 1_000)

    await expect(
      payload.findByID({ collection: 'customers', id: customer.id, overrideAccess: true }),
    ).resolves.toMatchObject({
      activeAccountClosureRequestKey: null,
      defaultCustomerProfileType: null,
      phone: expect.stringMatching(/^closed:/u),
      phoneMasked: '已匿名化',
      status: 'closed',
    })
    await expect(
      payload.findByID({ collection: 'realnameTemplates', id: template.id, overrideAccess: true }),
    ).resolves.toMatchObject({ status: 'disabled' })
    await expect(
      payload.findByID({ collection: 'customerIdentities', id: identity.id, overrideAccess: true }),
    ).resolves.toMatchObject({
      identifierEncrypted: 'released',
      identifierHash: expect.stringMatching(/^released:/u),
      rebindAllowedAt: completed.value.identityRebindAllowedAt,
      releasedIdentifierHash: hmac(phone, getEnv().SESSION_PEPPER),
      status: 'unbound',
    })
    for (const untouchedIdentity of [
      unboundIdentity,
      alreadyReleasedIdentity,
      reservedIdentity,
      unrelatedIdentity,
    ]) {
      await expect(
        payload.findByID({
          collection: 'customerIdentities',
          id: untouchedIdentity.id,
          overrideAccess: true,
        }),
        String(untouchedIdentity.id),
      ).resolves.toMatchObject({
        identifierHash: untouchedIdentity.identifierHash,
        status: untouchedIdentity.status,
      })
    }
    await expect(
      payload.findByID({ collection: 'customers', id: secondary.id, overrideAccess: true }),
    ).resolves.toMatchObject({
      phone: secondary.phone,
      status: 'active',
    })
    await expect(
      bindVerifiedIdentity(
        await requestFor(customerUser(secondary), 'rebind-before-cooldown'),
        secondary,
        intent.registrationToken,
        `${prefix}-rebind-before`,
      ),
    ).rejects.toMatchObject({ code: 'IDENTITY_REBIND_COOLDOWN_ACTIVE', status: 409 })
    await expect(
      authenticateVerifiedPhone(await requestFor(undefined, 'rebind-authentication'), {
        deviceHash: 'authentication-device-hash',
        ipHash: 'authentication-ip-hash',
        phone,
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_REBIND_COOLDOWN_ACTIVE', status: 409 })
    await expect(
      authenticateVerifiedWechat(await requestFor(undefined, 'rebind-wechat-authentication'), {
        deviceHash: 'wechat-authentication-device-hash',
        ipHash: 'wechat-authentication-ip-hash',
        openid: wechatOpenid,
        source: 'wechat_oauth',
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_REBIND_COOLDOWN_ACTIVE', status: 409 })
    const registrationAttemptReq = await createLocalReq(
      { req: { headers: registrationHeaders } },
      payload,
    )
    await expect(
      registerCustomer(
        registrationAttemptReq,
        {
          acceptedDeviceIdentifierNotice: true,
          acceptedPrivacyPolicy: true,
          acceptedServiceTerms: true,
          commercialSmsOptIn: false,
          confirmsAdultOrAuthorizedRepresentative: true,
          defaultCustomerProfileType: 'individual',
          deviceId: registrationDeviceId,
          registrationToken: registrationIntent.registrationToken,
        },
        registrationHeaders,
        null,
      ),
    ).rejects.toMatchObject({ code: 'IDENTITY_REBIND_COOLDOWN_ACTIVE', status: 409 })
    await expect(
      payload.count({
        collection: 'customers',
        overrideAccess: true,
        where: { phone: { equals: registrationPhone } },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })

    vi.useFakeTimers()
    vi.setSystemTime(new Date(new Date(completed.value.identityRebindAllowedAt).getTime() + 1_000))
    await expect(
      bindVerifiedIdentity(
        await requestFor(customerUser(secondary), 'rebind-after-cooldown'),
        secondary,
        intent.registrationToken,
        `${prefix}-rebind-after`,
      ),
    ).resolves.toMatchObject({ status: 'bound' })
    vi.useRealTimers()

    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: {
          and: [
            { requestKey: { equals: requested.requestId } },
            { eventType: { equals: 'executed' } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 1 })
    const executedRecord = (
      await payload.find({
        collection: 'accountClosureRequests',
        limit: 1,
        overrideAccess: true,
        where: {
          and: [
            { requestKey: { equals: requested.requestId } },
            { eventType: { equals: 'executed' } },
          ],
        },
      })
    ).docs[0]
    expect(executedRecord).toMatchObject({
      anonymizationResult: {
        customerProfile: 'anonymized',
        sessions: 'revoked_by_closing_transition',
      },
      currentBlockers: [],
      dataRetentionResult: {
        consentHistory: 'retained_append_only',
        identityRebindReservationUntil: completed.value.identityRebindAllowedAt,
        realnamePrimaryAndBackupDeletionDeadlineDays: 30,
      },
      executedAt: completed.value.executedAt,
      identityRebindAllowedAt: completed.value.identityRebindAllowedAt,
    })
  })

  it('rejects full Wechat registration with a released openid before its rebind cooldown', async () => {
    const fixture = await createReleasedWechatRegistrationFixture('wechat-registration-cooldown')
    expect(new Date(fixture.rebindAllowedAt).getTime()).toBeGreaterThan(Date.now())
    await expect(
      payload.count({
        collection: 'customers',
        overrideAccess: true,
        where: {
          and: [
            { phone: { equals: fixture.registrationPhone } },
            { registrationSource: { equals: 'wechat_qrcode' } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })

    await expect(completeReleasedWechatRegistration(fixture)).rejects.toMatchObject({
      code: 'IDENTITY_REBIND_COOLDOWN_ACTIVE',
      status: 409,
    })
    await expect(
      payload.count({
        collection: 'customers',
        overrideAccess: true,
        where: {
          and: [
            { phone: { equals: fixture.registrationPhone } },
            { registrationSource: { equals: 'wechat_qrcode' } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('allows full Wechat registration with the same released openid after its persisted cooldown', async () => {
    const fixture = await createReleasedWechatRegistrationFixture(
      'wechat-registration-after-cooldown',
    )
    expect(new Date(fixture.rebindAllowedAt).getTime()).toBeGreaterThan(Date.now())
    const releasedIdentifierHash = hmac(fixture.openid, getEnv().SESSION_PEPPER)
    const updateResult = await payload.db.pool.query<{ rebind_allowed_at: Date }>(
      `UPDATE customer_identities
       SET rebind_allowed_at = NOW() - INTERVAL '1 second'
       WHERE id = $1
         AND provider = 'wechat'
         AND status = 'unbound'
         AND released_identifier_hash = $2
       RETURNING rebind_allowed_at`,
      [fixture.releasedIdentityId, releasedIdentifierHash],
    )
    expect(updateResult.rowCount).toBe(1)
    expect(updateResult.rows[0]!.rebind_allowed_at.getTime()).toBeLessThan(Date.now())
    await expect(
      payload.count({
        collection: 'customers',
        overrideAccess: true,
        where: {
          and: [
            { phone: { equals: fixture.registrationPhone } },
            { registrationSource: { equals: 'wechat_qrcode' } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })

    const result = await completeReleasedWechatRegistration(fixture)
    expect(result).toMatchObject({
      customer: { id: expect.any(Number) },
      kind: 'authenticated',
    })
    await expect(
      payload.findByID({
        collection: 'customers',
        id: result.customer.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({
      phone: fixture.registrationPhone,
      registrationSource: 'wechat_qrcode',
      status: 'active',
    })
    await expect(
      payload.count({
        collection: 'customers',
        overrideAccess: true,
        where: {
          and: [
            { phone: { equals: fixture.registrationPhone } },
            { registrationSource: { equals: 'wechat_qrcode' } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 1 })
    await expect(
      payload.count({
        collection: 'customerIdentities',
        overrideAccess: true,
        where: {
          and: [
            { customer: { equals: result.customer.id } },
            { provider: { equals: 'wechat' } },
            { status: { equals: 'active' } },
            { identifierHash: { equals: releasedIdentifierHash } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 1 })
  })

  it('keeps every execution-claim id, request-key, unclaimed, allowed-status, and returned-row predicate necessary', async () => {
    async function expectConsumed(requestId: string, label: string) {
      await expireClosureCooldown(requestId)
      await expect(
        executeAccountClosure(await requestFor(adminUser(), label), {
          actorId: administrator.id,
          note: '陈旧状态不得取得最终执行权',
          requestId,
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_EXECUTION_ALREADY_CONSUMED' })
    }

    const wrongKeyCustomer = await createCustomer('execute-cas-key')
    const wrongKeyRequest = await closureRequest(wrongKeyCustomer, 'execute-cas-key')
    await payload.db.pool.query(
      `UPDATE customers SET active_account_closure_request_key = $1 WHERE id = $2`,
      [randomUUID(), wrongKeyCustomer.id],
    )
    await expectConsumed(wrongKeyRequest.requestId, 'execute-cas-key')

    const claimedCustomer = await createCustomer('execute-cas-claimed')
    const claimedRequest = await closureRequest(claimedCustomer, 'execute-cas-claimed')
    await payload.db.pool.query(
      `UPDATE customers SET account_closure_execution_claimed_at = NOW() WHERE id = $1`,
      [claimedCustomer.id],
    )
    await expectConsumed(claimedRequest.requestId, 'execute-cas-claimed')

    const staleStatusCustomer = await createCustomer('execute-cas-status')
    const staleStatusRequest = await closureRequest(staleStatusCustomer, 'execute-cas-status')
    await payload.db.pool.query(`UPDATE customers SET status = 'suspended' WHERE id = $1`, [
      staleStatusCustomer.id,
    ])
    await expectConsumed(staleStatusRequest.requestId, 'execute-cas-status')

    const movedCustomer = await createCustomer('execute-cas-id')
    const movedRequest = await closureRequest(movedCustomer, 'execute-cas-id')
    const unrelated = await createCustomer('execute-cas-unrelated')
    await payload.db.pool.query(
      `UPDATE customers SET active_account_closure_request_key = NULL WHERE id = $1`,
      [movedCustomer.id],
    )
    await payload.db.pool.query(
      `UPDATE customers SET active_account_closure_request_key = $1 WHERE id = $2`,
      [movedRequest.requestId, unrelated.id],
    )
    await expectConsumed(movedRequest.requestId, 'execute-cas-id')
    await expect(
      payload.findByID({ collection: 'customers', id: unrelated.id, overrideAccess: true }),
    ).resolves.toMatchObject({
      accountClosureExecutionClaimedAt: null,
      activeAccountClosureRequestKey: movedRequest.requestId,
      status: 'active',
    })
  })

  it('requires the immutable requested event for revocation and execution lookups', async () => {
    const decoy = await createCustomer('requested-lookup-decoy')
    await closureRequest(decoy, 'requested-lookup-decoy')
    const missing = randomUUID()
    await expect(
      executeAccountClosure(await requestFor(adminUser(), 'missing-request'), {
        actorId: administrator.id,
        note: '不存在的申请不得执行',
        requestId: missing,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REQUEST_NOT_FOUND' })

    const customer = await createCustomer('missing-requested-event')
    const requested = await closureRequest(customer, 'missing-requested-event')
    const revokedAt = new Date().toISOString()
    await payload.db.pool.query(
      `UPDATE customers SET active_account_closure_request_key = NULL WHERE id = $1`,
      [customer.id],
    )
    await payload.create({
      collection: 'accountClosureRequests',
      data: {
        actorId: String(customer.id),
        actorType: 'customer',
        cooldownEndsAt: requested.cooldownEndsAt,
        cooldownStartedAt: requested.deletionRequestedAt,
        currentBlockers: requested.blockers,
        customer: customer.id,
        eventType: 'revoked',
        reason: '生成一条撤销历史记录',
        recordKey: randomUUID(),
        requestKey: requested.requestId,
        requestedAt: requested.deletionRequestedAt,
        revokedAt,
      },
      overrideAccess: true,
    })
    await payload.db.pool.query(
      `DELETE FROM account_closure_requests WHERE request_key = $1 AND event_type = 'requested'`,
      [requested.requestId],
    )
    await expect(
      executeAccountClosure(await requestFor(adminUser(), 'missing-requested-event-execute'), {
        actorId: administrator.id,
        note: '撤销事件不能冒充原始申请',
        requestId: requested.requestId,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REQUEST_NOT_FOUND' })
  })

  it('keeps every released-identity provider, instance, hash, precedence, timestamp, and cooldown decision necessary', async () => {
    const customer = await createCustomer('rebind-predicates')
    const providerInstanceId = identityProviderInstance('phone')
    const identifierHash = hmac(`${prefix}-rebind-shared`, getEnv().SESSION_PEPPER)
    const current = await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(`${prefix}-rebind-shared`),
        boundAt: new Date().toISOString(),
        customer: customer.id,
        provider: 'phone',
        providerInstanceId,
        status: 'active',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    await payload.create({
      collection: 'customerIdentities',
      data: {
        ...protectedIdentifier(`${prefix}-rebind-released-row`),
        boundAt: new Date().toISOString(),
        customer: customer.id,
        provider: 'phone',
        providerInstanceId,
        rebindAllowedAt: '2099-08-16T00:00:00.000Z',
        releasedIdentifierHash: identifierHash,
        status: 'unbound',
        unboundAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const req = await requestFor(customerUser(customer), 'rebind-predicates')
    await expect(
      assertReleasedIdentityRebindAllowed(req, {
        identifierHash,
        provider: 'phone',
        providerInstanceId,
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_ALREADY_BOUND' })

    await payload.db.pool.query(
      `UPDATE customer_identities SET identifier_hash = $1 WHERE id = $2`,
      [`released-current:${randomUUID()}`, current.id],
    )
    await expect(
      assertReleasedIdentityRebindAllowed(
        await requestFor(customerUser(customer), 'rebind-cooldown'),
        { identifierHash, provider: 'phone', providerInstanceId },
      ),
    ).rejects.toMatchObject({
      code: 'IDENTITY_REBIND_COOLDOWN_ACTIVE',
      options: { retryAfterSeconds: expect.any(Number) },
    })
    await expect(
      assertReleasedIdentityRebindAllowed(
        await requestFor(customerUser(customer), 'rebind-provider-scope'),
        { identifierHash, provider: 'wechat', providerInstanceId },
      ),
    ).resolves.toBeUndefined()
    await expect(
      assertReleasedIdentityRebindAllowed(
        await requestFor(customerUser(customer), 'rebind-instance-scope'),
        { identifierHash, provider: 'phone', providerInstanceId: `${providerInstanceId}-other` },
      ),
    ).resolves.toBeUndefined()
    await expect(
      assertReleasedIdentityRebindAllowed(
        await requestFor(customerUser(customer), 'rebind-hash-scope'),
        {
          identifierHash: hmac('unrelated', getEnv().SESSION_PEPPER),
          provider: 'phone',
          providerInstanceId,
        },
      ),
    ).resolves.toBeUndefined()

    async function withMockedRebindQuery(
      label: string,
      execute: () => Promise<{ rows: Array<Record<string, unknown>> }>,
      assertion: (operation: Promise<void>) => Promise<unknown>,
    ) {
      const mockedReq = await requestFor(customerUser(customer), label)
      await inAuthTransaction(mockedReq, async () => {
        const transactionId = await mockedReq.transactionID
        const database = mockedReq.payload.db.sessions?.[transactionId!]?.db as {
          execute: () => Promise<{ rows: Array<Record<string, unknown>> }>
        }
        const query = vi.spyOn(database, 'execute').mockImplementationOnce(execute)
        try {
          await assertion(
            assertReleasedIdentityRebindAllowed(mockedReq, {
              identifierHash,
              provider: 'phone',
              providerInstanceId,
            }),
          )
        } finally {
          query.mockRestore()
        }
      })
    }

    await withMockedRebindQuery(
      'rebind-query-unavailable',
      async () => {
        throw new Error('database unavailable')
      },
      async (operation) => {
        await expect(operation).rejects.toMatchObject({ code: 'IDENTITY_REBIND_STATE_UNAVAILABLE' })
      },
    )

    for (const [label, row] of [
      ['mismatched-hash', { released_identifier_hash: 'different', rebind_allowed_at: new Date() }],
      ['missing-time', { released_identifier_hash: identifierHash, rebind_allowed_at: null }],
    ] as const) {
      await withMockedRebindQuery(
        `rebind-${label}`,
        async () => ({ rows: [row] }),
        async (operation) => {
          await expect(operation, label).rejects.toMatchObject({
            code: 'IDENTITY_REBIND_STATE_UNAVAILABLE',
          })
        },
      )
    }
    await withMockedRebindQuery(
      'rebind-expired',
      async () => ({
        rows: [
          {
            identifier_hash: 'released-row',
            rebind_allowed_at: '2020-08-16T00:00:00.000Z',
            released_identifier_hash: identifierHash,
          },
        ],
      }),
      async (operation) => {
        await expect(operation).resolves.toBeUndefined()
      },
    )
  })

  it('keeps closure records append-only and customer reads owner-scoped', async () => {
    const customer = await createCustomer('append-only-owner')
    const requested = await closureRequest(customer, 'append-only-owner')
    const requestedRecords = await payload.find({
      collection: 'accountClosureRequests',
      limit: 1,
      overrideAccess: true,
      where: { recordKey: { equals: `${requested.requestId}:requested` } },
    })
    expect(requestedRecords.totalDocs).toBe(1)
    const record = requestedRecords.docs[0]!
    await expect(
      payload.update({
        collection: 'accountClosureRequests',
        data: { reason: '禁止修改历史记录' },
        id: record.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_RECORD_APPEND_ONLY' })
    await expect(
      payload.delete({
        collection: 'accountClosureRequests',
        id: record.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_RECORD_APPEND_ONLY' })

    const ownerReq = await requestFor(customerUser(customer), 'append-owner-read')
    const ownerRead = await payload.find({
      collection: 'accountClosureRequests',
      overrideAccess: false,
      req: ownerReq,
      user: ownerReq.user,
      where: { requestKey: { equals: requested.requestId } },
    })
    expect(ownerRead.totalDocs).toBe(1)
    expect(ownerRead.docs[0]).not.toHaveProperty('reason')
    const other = await createCustomer('append-only-other')
    const otherReq = await requestFor(customerUser(other), 'append-other-read')
    const otherRead = await payload.find({
      collection: 'accountClosureRequests',
      overrideAccess: false,
      req: otherReq,
      user: otherReq.user,
      where: { requestKey: { equals: requested.requestId } },
    })
    expect(otherRead.totalDocs).toBe(0)

    const anonymousReq = await requestFor(undefined, 'append-anonymous-read')
    await expect(
      payload.find({
        collection: 'accountClosureRequests',
        overrideAccess: false,
        req: anonymousReq,
        where: { requestKey: { equals: requested.requestId } },
      }),
    ).rejects.toBeDefined()
    const analystReq = await requestFor(
      {
        collection: 'admins' as const,
        id: administrator.id,
        roles: ['analyst' as const],
        status: 'active' as const,
      },
      'append-analyst-read',
    )
    await expect(
      payload.find({
        collection: 'accountClosureRequests',
        overrideAccess: false,
        req: analystReq,
        user: analystReq.user,
        where: { requestKey: { equals: requested.requestId } },
      }),
    ).rejects.toBeDefined()
    const adminReq = await requestFor(adminUser(), 'append-admin-read')
    const adminRead = await payload.find({
      collection: 'accountClosureRequests',
      overrideAccess: false,
      req: adminReq,
      user: adminReq.user,
      where: { requestKey: { equals: requested.requestId } },
    })
    expect(adminRead.totalDocs).toBe(1)
    expect(adminRead.docs[0]).toMatchObject({ reason: '关闭测试账号：append-only-owner' })
    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: {
          and: [
            { requestKey: { equals: requested.requestId } },
            { recordKey: { equals: `${requested.requestId}:requested` } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 1 })

    await expect(
      payload.create({
        collection: 'accountClosureRequests',
        data: {
          actorId: String(customer.id),
          actorType: 'customer',
          cooldownEndsAt: requested.cooldownEndsAt,
          cooldownStartedAt: requested.deletionRequestedAt,
          currentBlockers: [],
          customer: customer.id,
          eventType: 'requested',
          reason: '浏览器不得直接追加',
          recordKey: randomUUID(),
          requestKey: randomUUID(),
          requestedAt: requested.deletionRequestedAt,
        },
        overrideAccess: false,
        req: ownerReq,
        user: ownerReq.user,
      }),
    ).rejects.toBeDefined()
  })

  it('rejects non-array, duplicate, unknown, and non-string persisted blocker lists', async () => {
    const customer = await createCustomer('invalid-blocker-record')
    const now = new Date().toISOString()
    const arrayLikeObject = {
      every: () => true,
      length: 0,
      [Symbol.iterator]: () => [][Symbol.iterator](),
    }
    expect(validateAccountClosureBlockers(arrayLikeObject)).toBe('账户关闭阻塞项无效')
    expect(validateAccountClosureBlockers([])).toBe(true)
    for (const [label, currentBlockers] of [
      ['non-array', { not: 'an array' }],
      ['duplicate', ['domains_held', 'domains_held']],
      ['unknown', ['not_a_blocker']],
      ['non-string', [42]],
    ] as const) {
      await expect(
        payload.create({
          collection: 'accountClosureRequests',
          data: {
            actorId: String(customer.id),
            actorType: 'customer',
            cooldownEndsAt: new Date(Date.now() + 60_000).toISOString(),
            cooldownStartedAt: now,
            currentBlockers: currentBlockers as never,
            customer: customer.id,
            eventType: 'requested',
            reason: '无效阻塞项不得落库',
            recordKey: `${prefix}-invalid-blockers-${label}-${randomUUID()}`,
            requestKey: randomUUID(),
            requestedAt: now,
          },
          overrideAccess: true,
        }),
        label,
      ).rejects.toBeDefined()
    }
    await expect(
      payload.count({
        collection: 'accountClosureRequests',
        overrideAccess: true,
        where: {
          and: [
            { customer: { equals: customer.id } },
            { reason: { equals: '无效阻塞项不得落库' } },
          ],
        },
      }),
    ).resolves.toMatchObject({ totalDocs: 0 })
  })

  it('records request, revocation, execution, and blocked-review audit and security events', async () => {
    const customer = await createCustomer('audit-events')
    const blockedCustomer = await createCustomer('audit-events-blocked')
    const blocked = await closureRequest(blockedCustomer, 'audit-events-blocked')
    await expireClosureCooldown(blocked.requestId)
    await addPersistentBlocker(blockedCustomer, 'domains_held')
    await expect(
      executeAccountClosure(await requestFor(adminUser(), 'audit-events-blocked'), {
        actorId: administrator.id,
        note: '审计阻塞项刷新事件',
        requestId: blocked.requestId,
      }),
    ).resolves.toMatchObject({ status: 'blocked' })
    const first = await closureRequest(customer, 'audit-events-first')
    await revokeAccountClosure(
      await requestFor(customerUser(customer), 'audit-events-revoke'),
      customer,
      {
        reason: '审计撤销事件',
        requestId: first.requestId,
      },
    )
    const second = await closureRequest(customer, 'audit-events-second')
    await expireClosureCooldown(second.requestId)
    await expect(
      executeAccountClosure(await requestFor(adminUser(), 'audit-events-execute'), {
        actorId: administrator.id,
        note: '审计最终执行事件',
        requestId: second.requestId,
      }),
    ).resolves.toMatchObject({ status: 'closed' })

    for (const [targetId, action] of [
      [first.requestId, 'customer.account_closure.requested'],
      [first.requestId, 'customer.account_closure.revoked'],
      [second.requestId, 'customer.account_closure.requested'],
      [second.requestId, 'customer.account_closure.executed'],
      [blocked.requestId, 'customer.account_closure.blockers_refreshed'],
    ] as const) {
      await expect(
        payload.count({
          collection: 'auditLogs',
          overrideAccess: true,
          where: {
            and: [{ targetId: { equals: targetId } }, { action: { equals: action } }],
          },
        }),
        action,
      ).resolves.toMatchObject({ totalDocs: 1 })
    }
    for (const [event, totalDocs] of [
      ['account_closure_requested', 2],
      ['account_closure_revoked', 1],
      ['account_closure_executed', 1],
    ] as const) {
      await expect(
        payload.count({
          collection: 'customerSecurityEvents',
          overrideAccess: true,
          where: {
            and: [{ customer: { equals: customer.id } }, { event: { equals: event } }],
          },
        }),
        event,
      ).resolves.toMatchObject({ totalDocs })
    }
  })
})
