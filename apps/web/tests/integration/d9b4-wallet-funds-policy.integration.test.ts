import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { sql } from '@payloadcms/db-postgres'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { RefundProvider } from '@/providers/types'
import { createWechatPayFixture } from '@/providers/wechatpay'
import { createBalancePayment } from '@/services/commerce/balance-payments'
import { requestWalletTopUpOriginalRefund, runWechatRefund } from '@/services/commerce/refunds'
import {
  recoverWalletTopUpPaymentReversal,
  refundDuplicateWalletTopUp,
  refundOrderWhenServiceNotProvided,
  requestAccountClosureBalanceRefunds,
} from '@/services/wallet/fund-scenarios'
import {
  captureWalletHold,
  createWalletAccount,
  holdWalletBalance,
  postWalletCredit,
  readWalletBalance,
} from '@/services/wallet/ledger'
import * as walletLedgerService from '@/services/wallet/ledger'
import { loadWalletFundsPolicy, updateWalletFundsPolicy } from '@/services/wallet/policy'
import * as walletPolicyService from '@/services/wallet/policy'
import { exportWalletStatement } from '@/services/wallet/statements'
import {
  createWalletTopUpOrder,
  createWalletTopUpPayment,
  queryAndConfirmWalletTopUpPayment,
} from '@/services/wallet/top-ups'
import { collectAccountClosureBlockers } from '@/services/auth/account-closure'
import { inAuthTransaction } from '@/services/auth/atomic'

import { fulfillmentQuoteSnapshotFixture } from '../fixtures/commerce'
import { realnameTemplateFixture } from '../fixtures/realname'
import { issueStepUpGrantFixture } from '../fixtures/step-up'

const prefix = `d9b4-${randomUUID().slice(0, 8)}`
const now = new Date('2026-08-18T03:30:00.000Z')
let payload: Payload
let customerIds: number[] = []
let orderIds: number[] = []

type CustomerIdentity = {
  collection: 'customers'
  id: number
  status: string
}

type CreditedTopUp = {
  accountId: number
  amountFen: number
  customer: CustomerIdentity
  id: number
  orderNumber: string
  transactionKey: string
}

async function systemRequest(suffix: string): Promise<PayloadRequest> {
  return createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${prefix}-${suffix}` }) } },
    payload,
  )
}

async function customerRequest(
  customer: CustomerIdentity,
  suffix: string,
): Promise<PayloadRequest> {
  const req = await systemRequest(suffix)
  req.user = customer as never
  return req
}

async function adminRequest(suffix: string): Promise<PayloadRequest> {
  const req = await systemRequest(suffix)
  req.user = {
    collection: 'admins',
    id: `${prefix}-administrator`,
    roles: ['system_admin'],
    status: 'active',
  } as never
  return req
}

async function createCustomer(): Promise<CustomerIdentity> {
  const random = randomUUID()
  const customer = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: [],
      phone: `+86196${randomInt(10_000_000, 100_000_000)}`,
      phoneMasked: `***${random.slice(-4)}`,
      status: 'active',
    },
    overrideAccess: true,
  })
  customerIds.push(Number(customer.id))
  return { ...customer, collection: 'customers' as const, id: Number(customer.id) }
}

function topUpNumber(): string {
  return `WT${randomUUID().replaceAll('-', '').slice(0, 30)}`
}

function providerRefundId(): string {
  const digits = [...randomUUID().replaceAll('-', '')]
    .map((character) => String(Number.parseInt(character, 16) % 10))
    .join('')
  return `503${digits.slice(0, 29)}`
}

async function creditedTopUp(
  suffix: string,
  amountFen: number,
  owner?: { accountId: number; customer: CustomerIdentity },
): Promise<CreditedTopUp> {
  const customer = owner?.customer ?? (await createCustomer())
  const accountId =
    owner?.accountId ??
    Number(
      (await createWalletAccount(await systemRequest(`${suffix}-account`), customer.id)).accountId,
    )
  const orderNumber = topUpNumber()
  const transactionKey = `${prefix}:${suffix}:credit`
  await postWalletCredit(await systemRequest(`${suffix}-credit`), {
    accountId,
    amountFen,
    transactionKey,
  })
  const paidAt = now.toISOString()
  const topUp = await payload.create({
    collection: 'walletTopUpOrders',
    data: {
      account: accountId,
      amountFen,
      creditedAt: paidAt,
      currency: 'CNY',
      fundingSource: 'wechat',
      ledgerTransactionKey: transactionKey,
      paymentChannel: 'native',
      paymentExpiresAt: new Date(now.getTime() + 1_800_000).toISOString(),
      providerConfirmedAt: paidAt,
      providerPaidAt: paidAt,
      status: 'credited',
      topUpOrderNumber: orderNumber,
      customer: customer.id,
      wechatTransactionId: randomUUID().replaceAll('-', ''),
    },
    overrideAccess: true,
  })
  return { accountId, amountFen, customer, id: Number(topUp.id), orderNumber, transactionKey }
}

async function createCommerceRelations(
  customer: CustomerIdentity,
  suffix: string,
  amountMinor: number,
) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString()
  const domainAscii = `${suffix}-${randomUUID()}.example`
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `${prefix}-${suffix}` }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  const quote = await payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: now.toISOString(),
      availabilityRequestId: `${prefix}-${suffix}-availability`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `${prefix}-${suffix}-quote`,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      expiresAt,
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: now.toISOString(),
      providerProductId: `${prefix}-${suffix}-product`,
      providerRequestId: `${prefix}-${suffix}-price`,
      quotedAt: now.toISOString(),
      quoteIntegrityHash: 'a'.repeat(64),
      quoteRef: randomUUID(),
      registrationPriceMinor: amountMinor,
      renewalPriceMinor: amountMinor,
      ruleFixedAmountMinor: 0,
      ruleKey: `${prefix}-${suffix}-rule`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
      roundingMode: 'half_up_to_fen',
      schemaVersion: 1,
      sourceCalculationHash: 'b'.repeat(64),
      sourcePriceSnapshotRef: randomUUID(),
      tld: 'example',
      upstreamCostMinor: amountMinor,
      upstreamRegistrationPriceMinor: amountMinor,
      upstreamRenewalPriceMinor: amountMinor,
      userPriceMinor: amountMinor,
      years: 1,
    },
    overrideAccess: true,
  })
  return { domainAscii, expiresAt, quote, template }
}

async function createPendingOrder(customer: CustomerIdentity, suffix: string, amountMinor: number) {
  const relation = await createCommerceRelations(customer, suffix, amountMinor)
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor,
      currency: 'CNY',
      customer: customer.id,
      domainAscii: relation.domainAscii,
      orderNumber: `${prefix}-${suffix}-${randomUUID()}`,
      quote: relation.quote.id,
      quoteSnapshot: fulfillmentQuoteSnapshotFixture({
        amountMinor,
        customerId: customer.id,
        domainAscii: relation.domainAscii,
        expiresAt: relation.expiresAt,
        quoteId: relation.quote.id,
      }),
      realnameTemplate: relation.template.id,
      status: 'pending_payment',
    },
    overrideAccess: true,
  })
  orderIds.push(Number(order.id))
  return order
}

async function createPaidRefundOrder(
  customer: CustomerIdentity,
  accountId: number,
  suffix: string,
  amountMinor: number,
  paymentChannel: 'balance' | 'native',
) {
  const relation = await createCommerceRelations(customer, suffix, amountMinor)
  const merchantOrderNumber = `WM${randomUUID().replaceAll('-', '').slice(0, 30)}`
  const holdKey = `${prefix}:${suffix}:balance-hold`
  if (paymentChannel === 'balance') {
    await holdWalletBalance(await systemRequest(`${suffix}-hold`), {
      accountId,
      amountFen: amountMinor,
      transactionKey: holdKey,
    })
  }
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor,
      balanceHoldTransactionKey: paymentChannel === 'balance' ? holdKey : undefined,
      currency: 'CNY',
      customer: customer.id,
      domainAscii: relation.domainAscii,
      merchantOrderNumber,
      orderNumber: `${prefix}-${suffix}-${randomUUID()}`,
      paidAt: now.toISOString(),
      paymentChannel,
      quote: relation.quote.id,
      quoteSnapshot: fulfillmentQuoteSnapshotFixture({
        amountMinor,
        customerId: customer.id,
        domainAscii: relation.domainAscii,
        expiresAt: relation.expiresAt,
        quoteId: relation.quote.id,
      }),
      realnameTemplate: relation.template.id,
      status: 'paid',
    },
    overrideAccess: true,
  })
  orderIds.push(Number(order.id))
  await payload.create({
    collection: 'paymentNotifications',
    data: {
      amountMinor,
      confirmationStatus: 'confirmed',
      currency: 'CNY',
      merchantOrderNumber,
      notificationId: `${prefix}-${suffix}-${randomUUID()}`,
      order: order.id,
      paidAt: now.toISOString(),
      payloadDigest: randomUUID().replaceAll('-', '').repeat(2),
      receivedAt: now.toISOString(),
      signatureVerified: true,
      source: 'query',
      wechatTransactionId: randomUUID().replaceAll('-', ''),
    },
    overrideAccess: true,
  })
  return order
}

async function blockers(customerId: number) {
  const req = await systemRequest(`closure-blockers-${customerId}`)
  return inAuthTransaction(req, () => collectAccountClosureBlockers(req, customerId))
}

function observedRefundProvider(): {
  calls: { create: number; query: number }
  fixture: ReturnType<typeof createWechatPayFixture>
  provider: RefundProvider
} {
  const fixture = createWechatPayFixture({ now: () => now })
  const calls = { create: 0, query: 0 }
  return {
    calls,
    fixture,
    provider: {
      createRefund: async (input) => {
        calls.create += 1
        return fixture.provider.createRefund(input)
      },
      health: () => fixture.provider.health(),
      queryRefund: async (input) => {
        calls.query += 1
        return fixture.provider.queryRefund(input)
      },
      verifyRefundNotification: (input) => fixture.provider.verifyRefundNotification(input),
    },
  }
}

async function withTopUpSourceOverride<T>(
  orderNumber: string,
  override: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  const originalFind = payload.find.bind(payload)
  const find = vi.spyOn(payload, 'find')
  find.mockImplementation((async (args) => {
    const result = await originalFind(args)
    const sourceOrderNumber = (
      args.where as { topUpOrderNumber?: { equals?: unknown } } | undefined
    )?.topUpOrderNumber?.equals
    if (
      args.collection !== 'walletTopUpOrders' ||
      sourceOrderNumber !== orderNumber ||
      !result.docs[0]
    ) {
      return result
    }
    return { ...result, docs: [{ ...result.docs[0], ...override }, ...result.docs.slice(1)] }
  }) as typeof payload.find)
  try {
    return await work()
  } finally {
    find.mockRestore()
  }
}

async function withWalletCreditSourceOverride<T>(
  transactionKey: string,
  override: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  const originalFind = payload.find.bind(payload)
  const find = vi.spyOn(payload, 'find')
  find.mockImplementation((async (args) => {
    const result = await originalFind(args)
    const sourceKey = (args.where as { transactionKey?: { equals?: unknown } } | undefined)
      ?.transactionKey?.equals
    if (
      args.collection !== 'walletTransactions' ||
      sourceKey !== transactionKey ||
      !result.docs[0]
    ) {
      return result
    }
    return { ...result, docs: [{ ...result.docs[0], ...override }, ...result.docs.slice(1)] }
  }) as typeof payload.find)
  try {
    return await work()
  } finally {
    find.mockRestore()
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  if (customerIds.length > 0) {
    await payload.db.pool.query(
      `DELETE FROM payload_jobs
       WHERE (workflow_slug = 'wechatRefund' AND (input->>'refundId')::int IN (
         SELECT id FROM refunds
         WHERE order_id = ANY($1::int[])
            OR wallet_top_up_order_id IN (
              SELECT id FROM wallet_top_up_orders WHERE customer_id = ANY($2::int[])
            )
       )) OR (workflow_slug = 'commerceFulfillment' AND (input->>'orderId')::int = ANY($1::int[]))`,
      [orderIds.length ? orderIds : [-1], customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM refund_notifications
       WHERE refund_id IN (
         SELECT id FROM refunds
         WHERE order_id = ANY($1::int[])
            OR wallet_top_up_order_id IN (
              SELECT id FROM wallet_top_up_orders WHERE customer_id = ANY($2::int[])
            )
       )`,
      [orderIds.length ? orderIds : [-1], customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM provider_operations
       WHERE order_id = ANY($1::int[])
          OR (target_type::text = 'wallet_top_up' AND target_id IN (
            SELECT id::text FROM wallet_top_up_orders WHERE customer_id = ANY($2::int[])
          ))`,
      [orderIds.length ? orderIds : [-1], customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM manual_reviews
       WHERE customer_id = ANY($1::int[])
          OR order_id = ANY($2::int[])
          OR wallet_top_up_order_id IN (
            SELECT id FROM wallet_top_up_orders WHERE customer_id = ANY($1::int[])
          )`,
      [customerIds, orderIds.length ? orderIds : [-1]],
    )
    await payload.db.pool.query(
      `DELETE FROM refunds
       WHERE order_id = ANY($1::int[])
          OR wallet_top_up_order_id IN (
            SELECT id FROM wallet_top_up_orders WHERE customer_id = ANY($2::int[])
          )`,
      [orderIds.length ? orderIds : [-1], customerIds],
    )
    await payload.db.pool.query('DELETE FROM order_events WHERE order_id = ANY($1::int[])', [
      orderIds.length ? orderIds : [-1],
    ])
    await payload.db.pool.query(
      'DELETE FROM payment_notifications WHERE order_id = ANY($1::int[])',
      [orderIds.length ? orderIds : [-1]],
    )
    await payload.db.pool.query('DELETE FROM orders WHERE id = ANY($1::int[])', [
      orderIds.length ? orderIds : [-1],
    ])
    await payload.db.pool.query(
      'DELETE FROM wallet_top_up_orders WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM wallet_entries
       WHERE account_id IN (SELECT id FROM wallet_accounts WHERE customer_id = ANY($1::int[]))`,
      [customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM wallet_transactions
       WHERE account_id IN (SELECT id FROM wallet_accounts WHERE customer_id = ANY($1::int[]))`,
      [customerIds],
    )
    await payload.db.pool.query('DELETE FROM wallet_accounts WHERE customer_id = ANY($1::int[])', [
      customerIds,
    ])
    await payload.db.pool.query(
      'DELETE FROM account_closure_requests WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query('DELETE FROM step_up_grants WHERE customer_id = ANY($1::int[])', [
      customerIds,
    ])
    await payload.db.pool.query(
      'DELETE FROM customer_security_events WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query('DELETE FROM quotes WHERE customer_id = ANY($1::int[])', [
      customerIds,
    ])
    await payload.db.pool.query(
      'DELETE FROM realname_templates WHERE customer_id = ANY($1::int[])',
      [customerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM audit_logs
       WHERE trace_id LIKE $1
          OR (
            (target_id = ANY($2::text[]) OR target_id = ANY($3::text[]))
            AND (action LIKE 'wallet.%' OR action LIKE 'customer.%')
          )`,
      [`${prefix}-%`, customerIds.map(String), orderIds.map(String)],
    )
    await payload.db.pool.query('DELETE FROM customers WHERE id = ANY($1::int[])', [customerIds])
  }
  customerIds = []
  orderIds = []
  await payload.db.destroy?.()
})

describe('D9-B-4 wallet funds scenarios and policy', () => {
  it('versions policy updates with a head CAS and one scoped audit event', async () => {
    const current = await loadWalletFundsPolicy(await systemRequest('policy-read'))
    const input = {
      accountBalanceLimitFen: current.accountBalanceLimitFen,
      allowNegativeBalanceRecovery: current.allowNegativeBalanceRecovery,
      allowRestrictedAccountEmergencyRenewal: current.allowRestrictedAccountEmergencyRenewal,
      balanceExpiration: current.balanceExpiration,
      changeNote: 'D9-B-4 concurrency fixture keeps effective values unchanged',
      currency: current.currency,
      expectedVersion: current.version,
      financialDayCutTimezone: current.financialDayCutTimezone,
      singleSpendLimitFen: current.singleSpendLimitFen,
      singleTopUpLimitFen: current.singleTopUpLimitFen,
      statementCalculation: current.statementCalculation,
    } as const
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, async (_, index) =>
        updateWalletFundsPolicy(await adminRequest(`policy-update-${index}`), input),
      ),
    )
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(5)
    for (const outcome of rejected) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ code: 'WALLET_POLICY_VERSION_CONFLICT' })
      }
    }
    const updated = await loadWalletFundsPolicy(await systemRequest('policy-read-updated'))
    expect(updated).toEqual({ ...current, version: current.version + 1 })
    const audits = await payload.count({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.policy.updated' } },
          { targetType: { equals: 'wallet-policy-version' } },
          { traceId: { contains: `${prefix}-policy-update-` } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(1)
  })

  it('requires an active system administrator at the policy update callpoint', async () => {
    const current = await loadWalletFundsPolicy(await systemRequest('policy-auth-read'))
    await expect(
      updateWalletFundsPolicy(await systemRequest('policy-auth-update'), {
        ...current,
        changeNote: 'Anonymous policy mutation must be rejected',
        expectedVersion: current.version,
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_SYSTEM_ROLE_REQUIRED' })
  })

  it('rejects customer-authenticated callers at every funds-scenario system boundary', async () => {
    const customer = await createCustomer()
    const factories = [
      (req: PayloadRequest) =>
        refundDuplicateWalletTopUp(req, {
          duplicateTopUpOrderNumber: 'WT000000000000000000000000000000',
          evidence: {},
          originalTopUpOrderNumber: 'WT111111111111111111111111111111',
          traceId: `${prefix}-scenario-system-duplicate`,
        }),
      (req: PayloadRequest) =>
        refundOrderWhenServiceNotProvided(req, {
          evidence: {},
          note: 'system boundary fixture',
          orderId: 1,
          traceId: `${prefix}-scenario-system-service`,
        }),
      (req: PayloadRequest) =>
        requestAccountClosureBalanceRefunds(req, {
          customerId: customer.id,
          requestId: 'missing',
          traceId: `${prefix}-scenario-system-closure`,
        }),
      (req: PayloadRequest) =>
        recoverWalletTopUpPaymentReversal(req, {
          occurredAt: now.toISOString(),
          recoveryKey: 'system-boundary',
          recoveryType: 'dispute',
          topUpOrderNumber: 'WT222222222222222222222222222222',
        }),
      (req: PayloadRequest) =>
        requestWalletTopUpOriginalRefund(req, {
          amountFen: 1,
          evidence: {},
          note: 'system boundary fixture',
          reason: 'duplicate_top_up',
          topUpOrderId: 1,
          traceId: `${prefix}-scenario-system-top-up-refund`,
        }),
    ]
    for (const [index, factory] of factories.entries()) {
      await expect(
        factory(await customerRequest(customer, `scenario-system-${index}`)),
      ).rejects.toMatchObject({
        code:
          index === factories.length - 1
            ? 'WALLET_TOP_UP_REFUND_SYSTEM_ONLY'
            : 'WALLET_FUNDS_SCENARIO_SYSTEM_ONLY',
      })
    }
  })

  it('rejects non-CNY, single top-up, account-balance and single-spend limits independently', async () => {
    const currencyCustomer = await createCustomer()
    await expect(
      createWalletTopUpOrder(
        await customerRequest(currencyCustomer, 'currency-create'),
        { amountFen: 100, currency: 'USD', fundingSource: 'wechat' },
        { customer: currencyCustomer },
      ),
    ).rejects.toMatchObject({ code: 'WALLET_CURRENCY_UNSUPPORTED' })

    const topUpCustomer = await createCustomer()
    await expect(
      createWalletTopUpOrder(
        await customerRequest(topUpCustomer, 'single-top-up-limit-create'),
        { amountFen: 5_000_001, currency: 'CNY', fundingSource: 'wechat' },
        { customer: topUpCustomer },
      ),
    ).rejects.toMatchObject({ code: 'WALLET_TOP_UP_LIMIT_EXCEEDED' })

    const balanceCustomer = await createCustomer()
    const balanceAccount = Number(
      (
        await createWalletAccount(
          await systemRequest('account-balance-limit-account'),
          balanceCustomer.id,
        )
      ).accountId,
    )
    await postWalletCredit(await systemRequest('account-balance-limit-credit'), {
      accountId: balanceAccount,
      amountFen: 9_000_000,
      transactionKey: `${prefix}:account-balance-limit:credit`,
    })
    await expect(
      createWalletTopUpOrder(
        await customerRequest(balanceCustomer, 'account-balance-limit-create'),
        { amountFen: 2_000_000, currency: 'CNY', fundingSource: 'wechat' },
        { customer: balanceCustomer },
      ),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_BALANCE_LIMIT_EXCEEDED' })
    await expect(
      postWalletCredit(await systemRequest('account-balance-limit-post-credit'), {
        accountId: balanceAccount,
        amountFen: 2_000_000,
        maximumPostedBalanceFen: 10_000_000,
        transactionKey: `${prefix}:account-balance-limit:post-credit`,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_BALANCE_LIMIT_EXCEEDED' })

    const spendCustomer = await createCustomer()
    const spendAccount = Number(
      (
        await createWalletAccount(
          await systemRequest('single-spend-limit-account'),
          spendCustomer.id,
        )
      ).accountId,
    )
    await postWalletCredit(await systemRequest('single-spend-limit-credit'), {
      accountId: spendAccount,
      amountFen: 4_000_000,
      transactionKey: `${prefix}:single-spend-limit:credit`,
    })
    const order = await createPendingOrder(spendCustomer, 'single-spend-limit', 3_000_001)
    const req = await customerRequest(spendCustomer, 'single-spend-limit-pay')
    const grant = await issueStepUpGrantFixture(payload, req, spendCustomer.id, 'balance_spend')
    await expect(
      createBalancePayment(req, order.orderNumber, {
        customer: spendCustomer,
        ...grant,
        traceId: `${prefix}-single-spend-limit-pay`,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_SPEND_LIMIT_EXCEEDED' })
    const spendHolds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: spendAccount } },
          { type: { equals: 'hold' } },
          { transactionKey: { equals: `order-balance-payment:${order.id}` } },
        ],
      },
    })
    expect(spendHolds.totalDocs).toBe(0)
  })

  it('rechecks the account-balance limit when a paid top-up is confirmed after another credit races in', async () => {
    const customer = await createCustomer()
    const accountId = Number(
      (
        await createWalletAccount(
          await systemRequest('confirmation-balance-limit-account'),
          customer.id,
        )
      ).accountId,
    )
    await postWalletCredit(await systemRequest('confirmation-balance-limit-initial'), {
      accountId,
      amountFen: 8_000_000,
      transactionKey: `${prefix}:confirmation-balance-limit:initial`,
    })
    const created = await createWalletTopUpOrder(
      await customerRequest(customer, 'confirmation-balance-limit-create'),
      { amountFen: 1_000_000, currency: 'CNY', fundingSource: 'wechat' },
      { customer },
    )
    const fixture = createWechatPayFixture({ now: () => now })
    await createWalletTopUpPayment(
      await customerRequest(customer, 'confirmation-balance-limit-payment'),
      created.data.topUpOrderNumber,
      { channel: 'native' },
      {
        customer,
        now: () => now,
        provider: fixture.provider,
        traceId: `${prefix}-confirmation-balance-limit-payment`,
      },
    )
    await postWalletCredit(await systemRequest('confirmation-balance-limit-racing-credit'), {
      accountId,
      amountFen: 2_000_000,
      transactionKey: `${prefix}:confirmation-balance-limit:racing-credit`,
    })
    fixture.setOrder({
      amountMinor: 1_000_000,
      channel: 'native',
      merchantOrderNumber: created.data.topUpOrderNumber,
      paidAt: now.toISOString(),
      state: 'paid',
      transactionId: randomUUID().replaceAll('-', ''),
    })
    await expect(
      queryAndConfirmWalletTopUpPayment(
        await customerRequest(customer, 'confirmation-balance-limit-confirm'),
        created.data.topUpOrderNumber,
        {
          customer,
          provider: fixture.provider,
          traceId: `${prefix}-confirmation-balance-limit-confirm`,
        },
      ),
    ).rejects.toMatchObject({ code: 'WALLET_ACCOUNT_BALANCE_LIMIT_EXCEEDED' })
    const topUp = await payload.find({
      collection: 'walletTopUpOrders',
      limit: 1,
      overrideAccess: true,
      where: { topUpOrderNumber: { equals: created.data.topUpOrderNumber } },
    })
    expect(topUp.docs[0]).toMatchObject({ status: 'payment_pending' })
    const credits = await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: accountId } },
          { entryKey: { equals: `wallet-top-up:${created.data.topUpOrderNumber}:credit:credit` } },
        ],
      },
    })
    expect(credits.totalDocs).toBe(0)
  })

  it('refunds a duplicate top-up once under concurrent requests and uses the existing WeChat refund path once', async () => {
    const original = await creditedTopUp('duplicate-original', 500)
    const duplicate = await creditedTopUp('duplicate-copy', 500, original)
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        systemRequest(`duplicate-request-${index}`).then((req) =>
          refundDuplicateWalletTopUp(req, {
            duplicateTopUpOrderNumber: duplicate.orderNumber,
            evidence: { observedTransactionCount: 2 },
            originalTopUpOrderNumber: original.orderNumber,
            traceId: `${prefix}-duplicate-request-${index}`,
          }),
        ),
      ),
    )
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true)
    const refunds = await payload.find({
      collection: 'refunds',
      limit: 2,
      overrideAccess: true,
      where: {
        and: [
          { walletTopUpOrder: { equals: duplicate.id } },
          { reasonCode: { equals: 'wallet_top_up.duplicate_top_up' } },
        ],
      },
    })
    expect(refunds.totalDocs).toBe(1)
    const refund = refunds.docs[0]!
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: original.accountId } },
          { type: { equals: 'hold' } },
          { transactionKey: { equals: `wallet-top-up-refund:${refund.refundNumber}` } },
        ],
      },
    })
    expect(holds.totalDocs).toBe(1)

    const observed = observedRefundProvider()
    await runWechatRefund(
      await systemRequest('duplicate-refund-create'),
      { refundId: Number(refund.id), traceId: `${prefix}-duplicate-refund-create` },
      observed.provider,
    )
    expect(observed.calls).toEqual({ create: 1, query: 0 })
    observed.fixture.setRefund({
      amountMinor: 500,
      merchantOrderNumber: duplicate.orderNumber,
      providerRefundId: providerRefundId(),
      refundedAt: now.toISOString(),
      refundNumber: refund.refundNumber,
      state: 'succeeded',
    })
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        runWechatRefund(
          await systemRequest(`duplicate-refund-query-${index}`),
          { refundId: Number(refund.id), traceId: `${prefix}-duplicate-refund-query-${index}` },
          observed.provider,
        ),
      ),
    )
    expect(observed.calls.create).toBe(1)
    expect(
      (
        await payload.count({
          collection: 'walletEntries',
          overrideAccess: true,
          where: {
            and: [
              { account: { equals: original.accountId } },
              { entryType: { equals: 'capture' } },
              {
                transaction: {
                  equals: (
                    await payload.find({
                      collection: 'walletTransactions',
                      limit: 1,
                      overrideAccess: true,
                      where: {
                        transactionKey: { equals: `wallet-top-up-refund:${refund.refundNumber}` },
                      },
                    })
                  ).docs[0]!.id,
                },
              },
            ],
          },
        })
      ).totalDocs,
    ).toBe(1)
    await expect(
      readWalletBalance(await systemRequest('duplicate-balance'), original.accountId),
    ).resolves.toEqual({
      availableBalance: 500n,
      heldBalance: 0n,
      postedBalance: 500n,
    })
  })

  it('reads every duplicate-top-up evidence field independently instead of inferring it from correlated fixture data', async () => {
    const original = await creditedTopUp('duplicate-source-original', 600)
    const duplicate = await creditedTopUp('duplicate-source-copy', 600, original)
    const decoyCustomer = await createCustomer()
    const decoyAccount = Number(
      (
        await createWalletAccount(
          await systemRequest('duplicate-source-decoy-account'),
          decoyCustomer.id,
        )
      ).accountId,
    )
    const originalDoc = await payload.findByID({
      collection: 'walletTopUpOrders',
      id: original.id,
      overrideAccess: true,
    })
    await expect(
      refundDuplicateWalletTopUp(await systemRequest('duplicate-source-same-order'), {
        duplicateTopUpOrderNumber: original.orderNumber,
        evidence: { fixtureCorrelationBroken: 'same-order' },
        originalTopUpOrderNumber: original.orderNumber,
        traceId: `${prefix}-duplicate-source-same-order`,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_DUPLICATE_TOP_UP_INVALID' })
    const cases: Array<{
      label: string
      orderNumber: string
      override: Record<string, unknown>
    }> = [
      {
        label: 'customer',
        orderNumber: duplicate.orderNumber,
        override: { customer: decoyCustomer.id },
      },
      {
        label: 'account',
        orderNumber: duplicate.orderNumber,
        override: { account: decoyAccount },
      },
      {
        label: 'original-currency',
        orderNumber: original.orderNumber,
        override: { currency: 'USD' },
      },
      { label: 'currency', orderNumber: duplicate.orderNumber, override: { currency: 'USD' } },
      { label: 'amount', orderNumber: duplicate.orderNumber, override: { amountFen: 601 } },
      {
        label: 'original-status',
        orderNumber: original.orderNumber,
        override: { status: 'refunded' },
      },
      {
        label: 'duplicate-status',
        orderNumber: duplicate.orderNumber,
        override: { status: 'refunded' },
      },
      {
        label: 'original-missing-transaction',
        orderNumber: original.orderNumber,
        override: { wechatTransactionId: null },
      },
      {
        label: 'missing-transaction',
        orderNumber: duplicate.orderNumber,
        override: { wechatTransactionId: null },
      },
      {
        label: 'same-transaction',
        orderNumber: duplicate.orderNumber,
        override: { wechatTransactionId: originalDoc.wechatTransactionId },
      },
    ]
    for (const testCase of cases) {
      await expect(
        withTopUpSourceOverride(testCase.orderNumber, testCase.override, async () =>
          refundDuplicateWalletTopUp(await systemRequest(`duplicate-source-${testCase.label}`), {
            duplicateTopUpOrderNumber: duplicate.orderNumber,
            evidence: { fixtureCorrelationBroken: testCase.label },
            originalTopUpOrderNumber: original.orderNumber,
            traceId: `${prefix}-duplicate-source-${testCase.label}`,
          }),
        ),
      ).rejects.toMatchObject({ code: 'WALLET_DUPLICATE_TOP_UP_EVIDENCE_MISMATCH' })
    }
    const refunds = await payload.count({
      collection: 'refunds',
      overrideAccess: true,
      where: {
        and: [
          { walletTopUpOrder: { equals: duplicate.id } },
          { reasonCode: { equals: 'wallet_top_up.duplicate_top_up' } },
        ],
      },
    })
    expect(refunds.totalDocs).toBe(0)
  })

  it('refuses a top-up original refund amount above the immutable top-up and B-1 credit facts', async () => {
    const topUp = await creditedTopUp('top-up-refund-amount', 500)
    await expect(
      requestWalletTopUpOriginalRefund(await systemRequest('top-up-refund-amount-request'), {
        amountFen: 501,
        evidence: { providerState: 'duplicate_confirmed' },
        note: 'Mutation fixture must never exceed the source top-up.',
        reason: 'duplicate_top_up',
        topUpOrderId: topUp.id,
        traceId: `${prefix}-top-up-refund-amount-request`,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_AMOUNT_MISMATCH' })
    const refunds = await payload.count({
      collection: 'refunds',
      overrideAccess: true,
      where: { walletTopUpOrder: { equals: topUp.id } },
    })
    expect(refunds.totalDocs).toBe(0)
  })

  it('routes no-service refunds only from paymentChannel and always uses the frozen order amount', async () => {
    const balanceTopUp = await creditedTopUp('service-balance-source', 1_234)
    const balanceOrder = await createPaidRefundOrder(
      balanceTopUp.customer,
      balanceTopUp.accountId,
      'service-balance',
      1_234,
      'balance',
    )
    const balancePromise = refundOrderWhenServiceNotProvided(
      await systemRequest('service-balance-refund'),
      {
        evidence: { providerState: 'not_submitted' },
        note: '平台未提供服务，余额支付按订单冻结金额退回。',
        orderId: balanceOrder.id,
        traceId: `${prefix}-service-balance-refund`,
      },
    )
    await expect(balancePromise).resolves.toMatchObject({ idempotentReplay: false })
    const balanceResult = await balancePromise
    const balanceRefund = await payload.findByID({
      collection: 'refunds',
      id: balanceResult.refundId,
      overrideAccess: true,
    })
    expect(balanceRefund).toMatchObject({ amountMinor: 1_234, status: 'succeeded' })
    expect(
      (
        await payload.findByID({
          collection: 'orders',
          id: balanceOrder.id,
          overrideAccess: true,
        })
      ).status,
    ).toBe('refunded')

    const nativeTopUp = await creditedTopUp('service-native-source', 2_345)
    const nativeOrder = await createPaidRefundOrder(
      nativeTopUp.customer,
      nativeTopUp.accountId,
      'service-native',
      2_345,
      'native',
    )
    const nativeResult = await refundOrderWhenServiceNotProvided(
      await systemRequest('service-native-refund'),
      {
        evidence: { providerState: 'not_submitted' },
        note: '平台未提供服务，微信支付按订单冻结金额原路退回。',
        orderId: nativeOrder.id,
        traceId: `${prefix}-service-native-refund`,
      },
    )
    const nativeRefund = await payload.findByID({
      collection: 'refunds',
      id: nativeResult.refundId,
      overrideAccess: true,
    })
    expect(nativeRefund).toMatchObject({ amountMinor: 2_345, status: 'pending' })
    expect(
      (
        await payload.findByID({
          collection: 'orders',
          id: nativeOrder.id,
          overrideAccess: true,
        })
      ).status,
    ).toBe('refund_pending')
  })

  it('recovers a consumed disputed top-up into a negative balance and immediately disables balance spending', async () => {
    const topUp = await creditedTopUp('negative-recovery', 1_000)
    await holdWalletBalance(await systemRequest('negative-consume-hold'), {
      accountId: topUp.accountId,
      amountFen: 800,
      transactionKey: `${prefix}:negative-consume`,
    })
    await captureWalletHold(
      await systemRequest('negative-consume-capture'),
      `${prefix}:negative-consume`,
    )
    const recovered = await recoverWalletTopUpPaymentReversal(
      await systemRequest('negative-recovery-apply'),
      {
        occurredAt: now.toISOString(),
        recoveryKey: `${prefix}:dispute:negative-recovery`,
        recoveryType: 'dispute',
        topUpOrderNumber: topUp.orderNumber,
      },
    )
    expect(recovered).toMatchObject({ applied: true, restricted: true })
    expect(recovered.balance).toEqual({
      availableBalance: -800n,
      heldBalance: 0n,
      postedBalance: -800n,
    })
    const customer = await payload.findByID({
      collection: 'customers',
      id: topUp.customer.id,
      overrideAccess: true,
    })
    expect(customer).toMatchObject({
      capabilityRestrictions: expect.arrayContaining(['balance_spend_disabled']),
      status: 'restricted',
    })
    await expect(
      holdWalletBalance(await systemRequest('negative-normal-spend'), {
        accountId: topUp.accountId,
        amountFen: 1,
        transactionKey: `${prefix}:negative-normal-spend`,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_BALANCE_INSUFFICIENT' })
    const recoveries = await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: topUp.accountId } },
          { entryType: { equals: 'recovery' } },
          { amountFen: { equals: 1_000 } },
        ],
      },
    })
    expect(recoveries.totalDocs).toBe(1)
    const audits = await payload.count({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.top_up.payment_recovered' } },
          { targetId: { equals: String(topUp.id) } },
          { traceId: { equals: `${prefix}-negative-recovery-apply` } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(1)
  })

  it('honors the negative-recovery policy switch and rolls the top-up claim back when disabled', async () => {
    const topUp = await creditedTopUp('negative-recovery-disabled', 400)
    await holdWalletBalance(await systemRequest('negative-recovery-disabled-hold'), {
      accountId: topUp.accountId,
      amountFen: 400,
      transactionKey: `${prefix}:negative-recovery-disabled:consume`,
    })
    await captureWalletHold(
      await systemRequest('negative-recovery-disabled-capture'),
      `${prefix}:negative-recovery-disabled:consume`,
    )
    const currentPolicy = await loadWalletFundsPolicy(
      await systemRequest('negative-recovery-disabled-policy'),
    )
    const policy = vi
      .spyOn(walletPolicyService, 'loadWalletFundsPolicy')
      .mockResolvedValue({ ...currentPolicy, allowNegativeBalanceRecovery: false })
    await expect(
      recoverWalletTopUpPaymentReversal(await systemRequest('negative-recovery-disabled-apply'), {
        occurredAt: now.toISOString(),
        recoveryKey: `${prefix}:negative-recovery-disabled:event`,
        recoveryType: 'provider_refund',
        topUpOrderNumber: topUp.orderNumber,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_NEGATIVE_RECOVERY_DISABLED' })
    policy.mockRestore()
    const currentTopUp = await payload.findByID({
      collection: 'walletTopUpOrders',
      id: topUp.id,
      overrideAccess: true,
    })
    expect(currentTopUp).toMatchObject({ paymentRecoveryKey: null, status: 'credited' })
    const recoveries = await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [{ account: { equals: topUp.accountId } }, { entryType: { equals: 'recovery' } }],
      },
    })
    expect(recoveries.totalDocs).toBe(0)
  })

  it('revalidates payment-recovery evidence against the independent B-1 credit fact', async () => {
    const topUp = await creditedTopUp('recovery-source', 400)
    const decoyCustomer = await createCustomer()
    const decoyAccount = Number(
      (
        await createWalletAccount(
          await systemRequest('recovery-source-decoy-account'),
          decoyCustomer.id,
        )
      ).accountId,
    )
    const cases: Array<{
      code: string
      label: string
      override: Record<string, unknown>
    }> = [
      {
        code: 'WALLET_PAYMENT_RECOVERY_EVIDENCE_INVALID',
        label: 'currency',
        override: { currency: 'USD' },
      },
      {
        code: 'WALLET_PAYMENT_RECOVERY_EVIDENCE_INVALID',
        label: 'unsafe-amount',
        override: { amountFen: 400.5 },
      },
      {
        code: 'WALLET_PAYMENT_RECOVERY_EVIDENCE_INVALID',
        label: 'non-positive-amount',
        override: { amountFen: 0 },
      },
      { code: 'WALLET_CREDIT_FACT_MISMATCH', label: 'amount', override: { amountFen: 401 } },
      {
        code: 'WALLET_PAYMENT_RECOVERY_EVIDENCE_INVALID',
        label: 'credited-at',
        override: { creditedAt: null },
      },
      {
        code: 'WALLET_PAYMENT_RECOVERY_EVIDENCE_INVALID',
        label: 'provider-paid-at',
        override: { providerPaidAt: null },
      },
      {
        code: 'WALLET_PAYMENT_RECOVERY_EVIDENCE_INVALID',
        label: 'wechat-transaction',
        override: { wechatTransactionId: null },
      },
      {
        code: 'WALLET_CREDIT_FACT_MISMATCH',
        label: 'ledger-key',
        override: { ledgerTransactionKey: `${prefix}:recovery-source:decoy-credit` },
      },
    ]
    for (const testCase of cases) {
      await expect(
        withTopUpSourceOverride(topUp.orderNumber, testCase.override, async () =>
          recoverWalletTopUpPaymentReversal(
            await systemRequest(`recovery-source-${testCase.label}`),
            {
              occurredAt: now.toISOString(),
              recoveryKey: `${prefix}:recovery-source:${testCase.label}`,
              recoveryType: 'dispute',
              topUpOrderNumber: topUp.orderNumber,
            },
          ),
        ),
      ).rejects.toMatchObject({ code: testCase.code })
    }
    const creditCases: Array<{ label: string; override: Record<string, unknown> }> = [
      { label: 'credit-type', override: { type: 'hold' } },
      { label: 'credit-status', override: { status: 'held' } },
      { label: 'credit-account', override: { account: decoyAccount } },
      { label: 'credit-customer', override: { customer: decoyCustomer.id } },
      { label: 'credit-safe-amount', override: { amountFen: 400.5 } },
    ]
    for (const testCase of creditCases) {
      await expect(
        withWalletCreditSourceOverride(topUp.transactionKey, testCase.override, async () =>
          recoverWalletTopUpPaymentReversal(
            await systemRequest(`recovery-source-${testCase.label}`),
            {
              occurredAt: now.toISOString(),
              recoveryKey: `${prefix}:recovery-source:${testCase.label}`,
              recoveryType: 'dispute',
              topUpOrderNumber: topUp.orderNumber,
            },
          ),
        ),
      ).rejects.toMatchObject({ code: 'WALLET_CREDIT_FACT_MISMATCH' })
    }
    const recoveries = await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [{ account: { equals: topUp.accountId } }, { entryType: { equals: 'recovery' } }],
      },
    })
    expect(recoveries.totalDocs).toBe(0)
  })

  it('rejects a zero-row payment-recovery claim before any ledger write', async () => {
    const topUp = await creditedTopUp('recovery-zero-claim', 400)
    await payload.db.pool.query(
      `UPDATE wallet_top_up_orders
       SET status = 'provider_confirmed', credited_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [topUp.id],
    )
    await expect(
      withTopUpSourceOverride(topUp.orderNumber, { creditedAt: now.toISOString() }, async () =>
        recoverWalletTopUpPaymentReversal(await systemRequest('recovery-zero-claim-apply'), {
          occurredAt: now.toISOString(),
          recoveryKey: `${prefix}:recovery-zero-claim:event`,
          recoveryType: 'provider_refund',
          topUpOrderNumber: topUp.orderNumber,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'WALLET_PAYMENT_RECOVERY_CONFLICT',
      message: '充值状态已变化，退款或争议追回未执行',
    })
    const recoveries = await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [{ account: { equals: topUp.accountId } }, { entryType: { equals: 'recovery' } }],
      },
    })
    expect(recoveries.totalDocs).toBe(0)
  })

  it('binds payment-recovery finalization to the exact claimed recovery key', async () => {
    const topUp = await creditedTopUp('recovery-final-key', 400)
    const originalRecover = walletLedgerService.recoverWalletBalance
    const recover = vi
      .spyOn(walletLedgerService, 'recoverWalletBalance')
      .mockImplementation(async (req, input) => {
        const result = await originalRecover(req, input)
        const transactionId = await req.transactionID
        const database = (
          transactionId ? req.payload.db.sessions?.[transactionId]?.db : undefined
        ) as { execute(statement: ReturnType<typeof sql>): Promise<unknown> } | undefined
        if (!database) throw new Error('expected active payment-recovery transaction')
        await database.execute(sql`
          UPDATE wallet_top_up_orders
          SET payment_recovery_key = ${`${prefix}:recovery-final-key:tampered`}
          WHERE id = ${topUp.id}
        `)
        return result
      })
    try {
      await expect(
        recoverWalletTopUpPaymentReversal(await systemRequest('recovery-final-key-apply'), {
          occurredAt: now.toISOString(),
          recoveryKey: `${prefix}:recovery-final-key:event`,
          recoveryType: 'provider_refund',
          topUpOrderNumber: topUp.orderNumber,
        }),
      ).rejects.toMatchObject({
        code: 'WALLET_PAYMENT_RECOVERY_CONFLICT',
        message: '充值退款或争议追回状态提交失败',
      })
    } finally {
      recover.mockRestore()
    }
    const current = await payload.findByID({
      collection: 'walletTopUpOrders',
      id: topUp.id,
      overrideAccess: true,
    })
    expect(current).toMatchObject({ paymentRecoveryKey: null, status: 'credited' })
  })

  it('never lets ordinary concurrent deductions create a negative balance', async () => {
    const topUp = await creditedTopUp('ordinary-no-overdraft', 100)
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        systemRequest(`ordinary-no-overdraft-${index}`).then((req) =>
          holdWalletBalance(req, {
            accountId: topUp.accountId,
            amountFen: 100,
            transactionKey: `${prefix}:ordinary-no-overdraft:${index}`,
          }),
        ),
      ),
    )
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    for (const outcome of outcomes.filter((item) => item.status === 'rejected')) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ code: 'WALLET_BALANCE_INSUFFICIENT' })
      }
    }
    await expect(
      readWalletBalance(await systemRequest('ordinary-no-overdraft-read'), topUp.accountId),
    ).resolves.toEqual({
      availableBalance: 0n,
      heldBalance: 100n,
      postedBalance: 100n,
    })
    const negativeSnapshots = await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: topUp.accountId } },
          { entryType: { not_equals: 'recovery' } },
          { postedBalanceAfterFen: { less_than: 0 } },
        ],
      },
    })
    expect(negativeSnapshots.totalDocs).toBe(0)
  })

  it('serializes a payment recovery against N normal spends with one recovery and an exact ledger equation', async () => {
    const topUp = await creditedTopUp('recovery-spend-race', 1_000)
    const spendPromises = Array.from({ length: 8 }, (_, index) =>
      systemRequest(`recovery-spend-race-hold-${index}`).then((req) =>
        holdWalletBalance(req, {
          accountId: topUp.accountId,
          amountFen: 100,
          transactionKey: `${prefix}:recovery-spend-race:${index}`,
        }),
      ),
    )
    const recoveryPromises = Array.from({ length: 4 }, (_, index) =>
      systemRequest(`recovery-spend-race-recovery-${index}`).then((req) =>
        recoverWalletTopUpPaymentReversal(req, {
          occurredAt: now.toISOString(),
          recoveryKey: `${prefix}:recovery-spend-race:provider-event`,
          recoveryType: 'provider_refund',
          topUpOrderNumber: topUp.orderNumber,
        }),
      ),
    )
    const outcomes = await Promise.allSettled([...spendPromises, ...recoveryPromises])
    const successfulHolds = outcomes
      .slice(0, spendPromises.length)
      .filter((outcome) => outcome.status === 'fulfilled').length
    expect(
      outcomes.slice(spendPromises.length).some((outcome) => outcome.status === 'fulfilled'),
    ).toBe(true)
    const balance = await readWalletBalance(
      await systemRequest('recovery-spend-race-read'),
      topUp.accountId,
    )
    expect(balance).toEqual({
      availableBalance: BigInt(-successfulHolds * 100),
      heldBalance: BigInt(successfulHolds * 100),
      postedBalance: 0n,
    })
    const recoveries = await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: topUp.accountId } },
          { entryType: { equals: 'recovery' } },
          { amountFen: { equals: 1_000 } },
        ],
      },
    })
    expect(recoveries.totalDocs).toBe(1)
  })

  it('blocks closure on positive balance and permits continuation only after the original refund succeeds', async () => {
    const topUp = await creditedTopUp('closure-refund', 1_000)
    await holdWalletBalance(await systemRequest('closure-refund-consume-hold'), {
      accountId: topUp.accountId,
      amountFen: 300,
      transactionKey: `${prefix}:closure-refund:consume`,
    })
    await captureWalletHold(
      await systemRequest('closure-refund-consume-capture'),
      `${prefix}:closure-refund:consume`,
    )
    const requestId = `${prefix}:closure:${randomUUID()}`
    await payload.db.pool.query(
      `UPDATE customers
       SET active_account_closure_request_key = $1, updated_at = NOW()
       WHERE id = $2`,
      [requestId, topUp.customer.id],
    )
    await expect(
      requestAccountClosureBalanceRefunds(await systemRequest('closure-refund-wrong-request'), {
        customerId: topUp.customer.id,
        requestId: `${requestId}:wrong`,
        traceId: `${prefix}-closure-refund-wrong-request`,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSURE_REQUEST_NOT_FOUND' })
    await expect(blockers(topUp.customer.id)).resolves.toContain('positive_balance')
    const requestedPromise = requestAccountClosureBalanceRefunds(
      await systemRequest('closure-refund-request'),
      { customerId: topUp.customer.id, requestId, traceId: `${prefix}-closure-refund-request` },
    )
    await expect(requestedPromise).resolves.toMatchObject({ totalAmountFen: '700' })
    const requested = await requestedPromise
    expect(requested).toMatchObject({ totalAmountFen: '700' })
    const pendingBlockers = await blockers(topUp.customer.id)
    expect(pendingBlockers).not.toContain('positive_balance')
    expect(pendingBlockers).toContain('refund_or_reconciliation_issue')
    const refund = await payload.findByID({
      collection: 'refunds',
      id: Number(requested.refunds[0]!.refundId),
      overrideAccess: true,
    })
    const observed = observedRefundProvider()
    await runWechatRefund(
      await systemRequest('closure-refund-create'),
      { refundId: Number(refund.id), traceId: `${prefix}-closure-refund-create` },
      observed.provider,
    )
    observed.fixture.setRefund({
      amountMinor: 700,
      merchantOrderNumber: topUp.orderNumber,
      providerRefundId: providerRefundId(),
      refundedAt: now.toISOString(),
      refundNumber: refund.refundNumber,
      state: 'succeeded',
    })
    await runWechatRefund(
      await systemRequest('closure-refund-query'),
      { refundId: Number(refund.id), traceId: `${prefix}-closure-refund-query` },
      observed.provider,
    )
    const finalBlockers = await blockers(topUp.customer.id)
    expect(finalBlockers).not.toContain('positive_balance')
    expect(finalBlockers).not.toContain('refund_or_reconciliation_issue')
    await expect(
      readWalletBalance(await systemRequest('closure-refund-balance'), topUp.accountId),
    ).resolves.toEqual({
      availableBalance: 0n,
      heldBalance: 0n,
      postedBalance: 0n,
    })
  })

  it('exports opening and closing balances at the fixed Asia/Shanghai day boundary', async () => {
    const customer = await createCustomer()
    const accountId = Number(
      (await createWalletAccount(await systemRequest('statement-boundary-account'), customer.id))
        .accountId,
    )
    await postWalletCredit(await systemRequest('statement-boundary-before'), {
      accountId,
      amountFen: 100,
      transactionKey: `${prefix}:statement-boundary:before`,
    })
    await postWalletCredit(await systemRequest('statement-boundary-at'), {
      accountId,
      amountFen: 200,
      transactionKey: `${prefix}:statement-boundary:at`,
    })
    await payload.db.pool.query(
      `UPDATE wallet_entries
       SET created_at = CASE entry_key
         WHEN $1 THEN '2026-08-17T15:59:59.999Z'::timestamptz
         WHEN $2 THEN '2026-08-17T16:00:00.000Z'::timestamptz
       END,
       updated_at = CASE entry_key
         WHEN $1 THEN '2026-08-17T15:59:59.999Z'::timestamptz
         WHEN $2 THEN '2026-08-17T16:00:00.000Z'::timestamptz
       END
       WHERE account_id = $3 AND entry_key IN ($1, $2)`,
      [
        `${prefix}:statement-boundary:before:credit`,
        `${prefix}:statement-boundary:at:credit`,
        accountId,
      ],
    )
    await expect(
      exportWalletStatement(await systemRequest('statement-boundary-anonymous'), {
        endDate: '2026-08-18',
        startDate: '2026-08-18',
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
    await expect(
      exportWalletStatement(await customerRequest(customer, 'statement-boundary-too-large'), {
        endDate: '2027-08-19',
        startDate: '2026-08-18',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_STATEMENT_PERIOD_TOO_LARGE' })
    const statementPromise = exportWalletStatement(
      await customerRequest(customer, 'statement-boundary-export'),
      { endDate: '2026-08-18', startDate: '2026-08-18' },
    )
    await expect(statementPromise).resolves.toMatchObject({ accountId })
    const statement = await statementPromise
    expect(statement).toMatchObject({
      closing: { availableFen: '300', heldFen: '0', postedFen: '300' },
      currency: 'CNY',
      opening: { availableFen: '100', heldFen: '0', postedFen: '100' },
      period: {
        endExclusive: '2026-08-18T16:00:00.000Z',
        startInclusive: '2026-08-17T16:00:00.000Z',
      },
      timezone: 'Asia/Shanghai',
      totals: { creditedFen: '200' },
    })
    expect(statement.entries).toHaveLength(1)
    expect(statement.entries[0]).toMatchObject({
      amountFen: '200',
      createdAt: '2026-08-17T16:00:00.000Z',
    })
    const audits = await payload.count({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.statement.exported' } },
          { targetId: { equals: String(accountId) } },
          { traceId: { equals: `${prefix}-statement-boundary-export` } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(1)
  })

  it('fails statement export closed when an append-only ledger snapshot is corrupted', async () => {
    const customer = await createCustomer()
    const accountId = Number(
      (await createWalletAccount(await systemRequest('statement-integrity-account'), customer.id))
        .accountId,
    )
    await postWalletCredit(await systemRequest('statement-integrity-credit'), {
      accountId,
      amountFen: 300,
      transactionKey: `${prefix}:statement-integrity:credit`,
    })
    await payload.db.pool.query(
      `UPDATE wallet_entries
       SET posted_balance_after_fen = 301
       WHERE account_id = $1 AND entry_key = $2`,
      [accountId, `${prefix}:statement-integrity:credit:credit`],
    )
    await expect(
      exportWalletStatement(await customerRequest(customer, 'statement-integrity-export'), {
        endDate: '2026-08-18',
        startDate: '2026-08-18',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_STATEMENT_UNAVAILABLE' })

    const sequenceCustomer = await createCustomer()
    const sequenceAccountId = Number(
      (
        await createWalletAccount(
          await systemRequest('statement-sequence-account'),
          sequenceCustomer.id,
        )
      ).accountId,
    )
    await postWalletCredit(await systemRequest('statement-sequence-credit'), {
      accountId: sequenceAccountId,
      amountFen: 300,
      transactionKey: `${prefix}:statement-sequence:credit`,
    })
    await payload.db.pool.query(
      `UPDATE wallet_entries SET ledger_sequence = 2 WHERE account_id = $1`,
      [sequenceAccountId],
    )
    await expect(
      exportWalletStatement(await customerRequest(sequenceCustomer, 'statement-sequence-export'), {
        endDate: '2026-08-18',
        startDate: '2026-08-18',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_STATEMENT_UNAVAILABLE' })

    const versionCustomer = await createCustomer()
    const versionAccountId = Number(
      (
        await createWalletAccount(
          await systemRequest('statement-version-account'),
          versionCustomer.id,
        )
      ).accountId,
    )
    await postWalletCredit(await systemRequest('statement-version-credit'), {
      accountId: versionAccountId,
      amountFen: 300,
      transactionKey: `${prefix}:statement-version:credit`,
    })
    await payload.db.pool.query(`UPDATE wallet_accounts SET ledger_version = 2 WHERE id = $1`, [
      versionAccountId,
    ])
    await expect(
      exportWalletStatement(await customerRequest(versionCustomer, 'statement-version-export'), {
        endDate: '2026-08-18',
        startDate: '2026-08-18',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_STATEMENT_UNAVAILABLE' })
  })
})
