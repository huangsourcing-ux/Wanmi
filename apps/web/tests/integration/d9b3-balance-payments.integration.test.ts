import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { PaymentProvider, RefundProvider, WestDigitalWriteProvider } from '@/providers/types'
import { createWechatPayFixture } from '@/providers/wechatpay'
import {
  FixtureWestDigitalWriteTransport,
  timeoutAfterSubmission,
} from '@/providers/westdigital-write-fixtures'
import {
  WestDigitalWriteAdapter,
  WestDigitalWriteTransportError,
} from '@/providers/westdigital-write'
import {
  balancePaymentTransactionKey,
  captureBalancePaymentForFulfillment,
  claimBalancePaymentChannel,
  createBalancePayment,
} from '@/services/commerce/balance-payments'
import {
  runCommerceFulfillment,
  type FulfillmentDependencies,
} from '@/services/commerce/fulfillment'
import {
  claimWechatPaymentChannel,
  createWechatPayment,
  queryAndConfirmWechatPayment,
  runPaymentTimeoutClose,
} from '@/services/commerce/payments'
import {
  requestAutomaticRegistrationFailureRefund,
  requestBalanceRegistrationFailureRefund,
  requestWechatRegistrationFailureRefund,
  runWechatRefund,
} from '@/services/commerce/refunds'
import {
  createWalletAccount,
  holdWalletBalance,
  postWalletCredit,
  readWalletBalance,
  releaseWalletHold,
} from '@/services/wallet/ledger'
import { submitRealnameTemplate, syncRealnameTemplateStatus } from '@/services/realname/templates'

import { fulfillmentQuoteSnapshotFixture } from '../fixtures/commerce'
import { approvedRealnameProviderFixture, realnameTemplateFixture } from '../fixtures/realname'

const prefix = `d9b3-${randomUUID().slice(0, 8)}`
const amountMinor = 2_999
let payload: Payload
let customerIds: number[] = []
let orderIds: number[] = []

type Fixture = Awaited<ReturnType<typeof createFixture>>
type FixtureCustomer = {
  collection: 'customers'
  id: number
  status?: string
}

async function systemRequest(suffix: string): Promise<PayloadRequest> {
  return createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${prefix}-${suffix}` }) } },
    payload,
  )
}

async function customerRequest(customer: FixtureCustomer, suffix: string): Promise<PayloadRequest> {
  const req = await systemRequest(suffix)
  req.user = customer as never
  return req
}

async function createFixture(
  suffix: string,
  options: {
    availableMinor?: number
    capabilityRestrictions?: Array<'balance_spend_disabled' | 'purchase_disabled'>
  } = {},
) {
  const customerDoc = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: options.capabilityRestrictions ?? [],
      phone: `${prefix}-${suffix}`,
      phoneMasked: `***${suffix}`,
      status: options.capabilityRestrictions?.length ? 'restricted' : 'active',
    },
    overrideAccess: true,
  })
  const customer = { ...customerDoc, collection: 'customers' as const, id: Number(customerDoc.id) }
  customerIds.push(customer.id)
  const wallet = await createWalletAccount(await systemRequest(`${suffix}-account`), customer.id)
  const accountId = Number(wallet.accountId)
  const availableMinor = options.availableMinor ?? amountMinor
  if (availableMinor > 0) {
    await postWalletCredit(await systemRequest(`${suffix}-credit`), {
      accountId,
      amountFen: availableMinor,
      transactionKey: `${prefix}:${suffix}:credit`,
    })
  }

  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({ displayName: `${prefix}-${suffix}` }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  const realnameProvider = approvedRealnameProviderFixture()
  await submitRealnameTemplate(
    await customerRequest(customer, `${suffix}-template-submit`),
    template.id,
    realnameProvider,
  )
  await syncRealnameTemplateStatus(
    await systemRequest(`${suffix}-template-sync`),
    template.id,
    realnameProvider,
  )

  const domainAscii = `${suffix}-${randomUUID()}.com`
  const expiresAt = new Date(Date.now() + 300_000).toISOString()
  const quote = await payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: new Date().toISOString(),
      availabilityRequestId: `${prefix}-availability-${suffix}`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `${prefix}-quote-${suffix}`,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      expiresAt,
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: new Date().toISOString(),
      providerProductId: `${prefix}-product-${suffix}`,
      providerRequestId: `${prefix}-price-${suffix}`,
      quotedAt: new Date().toISOString(),
      quoteIntegrityHash: 'a'.repeat(64),
      quoteRef: randomUUID(),
      registrationPriceMinor: amountMinor + 700,
      renewalPriceMinor: amountMinor + 700,
      ruleFixedAmountMinor: 0,
      ruleKey: `${prefix}-rule-${suffix}`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
      roundingMode: 'half_up_to_fen',
      schemaVersion: 1,
      sourceCalculationHash: 'b'.repeat(64),
      sourcePriceSnapshotRef: randomUUID(),
      tld: 'com',
      upstreamCostMinor: amountMinor,
      upstreamRegistrationPriceMinor: amountMinor,
      upstreamRenewalPriceMinor: amountMinor,
      userPriceMinor: amountMinor + 700,
      years: 1,
    },
    overrideAccess: true,
  })
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      orderNumber: `${prefix}-${suffix}-${randomUUID()}`,
      quote: quote.id,
      quoteSnapshot: {
        ...fulfillmentQuoteSnapshotFixture({
          amountMinor,
          customerId: customer.id,
          domainAscii,
          expiresAt,
          quoteId: quote.id,
        }),
        currentPriceMinor: amountMinor + 700,
      },
      realnameTemplate: template.id,
      status: 'pending_payment',
    },
    overrideAccess: true,
  })
  orderIds.push(Number(order.id))
  return { accountId, customer, domainAscii, order, quote, template }
}

async function pay(fixture: Fixture, suffix: string) {
  return createBalancePayment(
    await customerRequest(fixture.customer, suffix),
    fixture.order.orderNumber,
    { customer: fixture.customer, traceId: `${prefix}-${suffix}` },
  )
}

function assetResponse(domain: string) {
  return {
    body: {
      clientid: `${prefix}-asset-query`,
      data: {
        dns1: 'ns1.myhostadmin.net',
        dns2: 'ns2.myhostadmin.net',
        dns3: '',
        dns4: '',
        dns5: '',
        dns6: '',
        domain,
        expdate: '2027-08-18 12:00:00',
        id: '44169980',
        regdate: '2026-08-18 12:00:00',
        registrars: 'west',
      },
      result: 200,
    },
    status: 200,
  }
}

function registrationResponse(domain: string) {
  return {
    body: { clientid: `${prefix}-registration-write`, data: { [domain]: 200 }, result: 200 },
    status: 200,
  }
}

function dependencies(
  write: WestDigitalWriteProvider,
  options: { domainAvailable?: boolean } = {},
): FulfillmentDependencies {
  return {
    preflight: {
      queryAvailability: async ({ domain, traceId }) => ({
        data: {
          available: options.domainAvailable ?? true,
          currency: 'CNY',
          domainAscii: domain,
          premium: false,
        },
        observedAt: new Date().toISOString(),
        ok: true,
        requestId: `${traceId}-availability`,
      }),
      queryBalance: async ({ traceId }) => ({
        data: { availableMinor: 1_000_000, frozenMinor: 0 },
        observedAt: new Date().toISOString(),
        ok: true,
        requestId: `${traceId}-balance`,
      }),
    },
    write,
  }
}

function forbiddenPaymentProvider(): PaymentProvider {
  const fail = async (): Promise<never> => {
    throw new Error('Wechat provider must not be called for a balance order')
  }
  return {
    closeOrder: fail,
    createPayment: fail,
    health: async () => ({
      data: { healthy: true },
      observedAt: new Date().toISOString(),
      ok: true,
      requestId: `${prefix}-forbidden-payment-health`,
    }),
    queryOrder: fail,
    verifyNotification: fail,
  }
}

function forbiddenRefundProvider(): RefundProvider {
  const fail = async (): Promise<never> => {
    throw new Error('Wechat refund provider must not be called for a balance order')
  }
  return {
    createRefund: fail,
    health: async () => ({
      data: { healthy: true },
      observedAt: new Date().toISOString(),
      ok: true,
      requestId: `${prefix}-forbidden-refund-health`,
    }),
    queryRefund: fail,
    verifyRefundNotification: fail,
  }
}

async function countOrderEvents(orderId: number, reasonCode: string): Promise<number> {
  return (
    await payload.count({
      collection: 'orderEvents',
      overrideAccess: true,
      where: {
        and: [{ order: { equals: orderId } }, { reasonCode: { equals: reasonCode } }],
      },
    })
  ).totalDocs
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterEach(async () => {
  if (!customerIds.length) return
  await payload.db.pool.query(
    `DELETE FROM audit_logs WHERE trace_id LIKE $1 OR target_id = ANY($2::text[])`,
    [`${prefix}-%`, orderIds.map(String)],
  )
  await payload.db.pool.query(
    `DELETE FROM payload_jobs
     WHERE workflow_slug = 'commerceFulfillment'
       AND (input->>'orderId')::int = ANY($1::int[])`,
    [orderIds],
  )
  await payload.db.pool.query(
    `DELETE FROM refund_notifications
     WHERE refund_id IN (SELECT id FROM refunds WHERE order_id = ANY($1::int[]))`,
    [orderIds],
  )
  await payload.db.pool.query('DELETE FROM refunds WHERE order_id = ANY($1::int[])', [orderIds])
  await payload.db.pool.query('DELETE FROM manual_reviews WHERE order_id = ANY($1::int[])', [
    orderIds,
  ])
  await payload.db.pool.query('DELETE FROM order_events WHERE order_id = ANY($1::int[])', [
    orderIds,
  ])
  await payload.db.pool.query('DELETE FROM payment_notifications WHERE order_id = ANY($1::int[])', [
    orderIds,
  ])
  await payload.db.pool.query('DELETE FROM provider_operations WHERE order_id = ANY($1::int[])', [
    orderIds,
  ])
  await payload.db.pool.query('DELETE FROM domain_assets WHERE customer_id = ANY($1::int[])', [
    customerIds,
  ])
  await payload.db.pool.query('DELETE FROM orders WHERE id = ANY($1::int[])', [orderIds])
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
  await payload.db.pool.query('DELETE FROM quotes WHERE customer_id = ANY($1::int[])', [
    customerIds,
  ])
  await payload.db.pool.query('DELETE FROM realname_templates WHERE customer_id = ANY($1::int[])', [
    customerIds,
  ])
  await payload.db.pool.query('DELETE FROM customers WHERE id = ANY($1::int[])', [customerIds])
  customerIds = []
  orderIds = []
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9-B-3 balance payment and channel-bound refunds', () => {
  it('persists balance as an explicit Orders paymentChannel value', async () => {
    const fixture = await createFixture('channel-schema')
    await payload.update({
      collection: 'orders',
      data: { paymentChannel: 'balance' },
      id: fixture.order.id,
      overrideAccess: true,
    })
    expect(
      (
        await payload.findByID({
          collection: 'orders',
          id: fixture.order.id,
          overrideAccess: true,
        })
      ).paymentChannel,
    ).toBe('balance')
  })

  it('rejects a request identity/options mismatch before looking up the order', async () => {
    const owner = await createFixture('identity-owner')
    const stranger = await createFixture('identity-stranger')
    await expect(
      createBalancePayment(
        await customerRequest(stranger.customer, 'identity-spoof'),
        owner.order.orderNumber,
        { customer: owner.customer, traceId: `${prefix}-identity-spoof` },
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
  })

  it('does not let one customer select balance payment for another customer order', async () => {
    const owner = await createFixture('cross-customer-owner')
    const stranger = await createFixture('cross-customer-stranger')
    await expect(
      createBalancePayment(
        await customerRequest(stranger.customer, 'cross-customer-pay'),
        owner.order.orderNumber,
        { customer: stranger.customer, traceId: `${prefix}-cross-customer-pay` },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' })
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: { transactionKey: { equals: balancePaymentTransactionKey(owner.order.id) } },
    })
    expect(holds.totalDocs).toBe(0)
  })

  it('selects only the authenticated customer wallet when another CNY wallet exists', async () => {
    const owner = await createFixture('wallet-owner')
    const other = await createFixture('wallet-other')
    await pay(owner, 'wallet-owner-pay')
    await expect(
      readWalletBalance(await systemRequest('wallet-owner-read'), owner.accountId),
    ).resolves.toEqual({
      availableBalance: 0n,
      heldBalance: BigInt(amountMinor),
      postedBalance: BigInt(amountMinor),
    })
    await expect(
      readWalletBalance(await systemRequest('wallet-other-read'), other.accountId),
    ).resolves.toEqual({
      availableBalance: BigInt(amountMinor),
      heldBalance: 0n,
      postedBalance: BigInt(amountMinor),
    })
  })

  it('rejects insufficient balance atomically without a negative available balance or paid order', async () => {
    const fixture = await createFixture('insufficient', { availableMinor: amountMinor - 1 })
    await expect(pay(fixture, 'insufficient-pay')).rejects.toMatchObject({
      code: 'WALLET_BALANCE_INSUFFICIENT',
    })
    await expect(
      readWalletBalance(await systemRequest('insufficient-balance'), fixture.accountId),
    ).resolves.toEqual({
      availableBalance: BigInt(amountMinor - 1),
      heldBalance: 0n,
      postedBalance: BigInt(amountMinor - 1),
    })
    const order = await payload.findByID({
      collection: 'orders',
      id: fixture.order.id,
      overrideAccess: true,
    })
    expect(order).toMatchObject({ paidAt: null, paymentChannel: null, status: 'pending_payment' })
    expect(await countOrderEvents(Number(order.id), 'wallet.balance_payment_confirmed')).toBe(0)
  })

  it('rejects a corrupted non-positive order frozen amount before touching the wallet', async () => {
    const fixture = await createFixture('invalid-amount')
    await payload.db.pool.query('UPDATE orders SET amount_minor = 0 WHERE id = $1', [
      fixture.order.id,
    ])
    await expect(pay(fixture, 'invalid-amount-pay')).rejects.toMatchObject({
      code: 'BALANCE_PAYMENT_AMOUNT_INVALID',
    })
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: { transactionKey: { equals: balancePaymentTransactionKey(fixture.order.id) } },
    })
    expect(holds.totalDocs).toBe(0)
  })

  it('holds atomically, returns no WeChat URL, skips provider polling, and is skipped by timeout close', async () => {
    const fixture = await createFixture('instant')
    const session = await pay(fixture, 'instant-pay')
    expect(session).toMatchObject({
      data: {
        amountMinor,
        channel: 'balance',
        currency: 'CNY',
        orderNumber: fixture.order.orderNumber,
        status: 'paid',
      },
      state: 'ready',
    })
    expect(session.data).not.toHaveProperty('codeUrl')
    expect(session.data).not.toHaveProperty('h5Url')
    expect(session.data).not.toHaveProperty('merchantOrderNumber')
    expect(session.data).not.toHaveProperty('expiresAt')

    const status = await queryAndConfirmWechatPayment(
      await customerRequest(fixture.customer, 'instant-status'),
      fixture.order.orderNumber,
      {
        customer: fixture.customer,
        provider: forbiddenPaymentProvider(),
        traceId: `${prefix}-instant-status`,
      },
    )
    expect(status.data.status).toBe('paid')
    const stored = await payload.findByID({
      collection: 'orders',
      id: fixture.order.id,
      overrideAccess: true,
    })
    expect(stored).toMatchObject({
      merchantOrderNumber: null,
      paymentChannel: 'balance',
      paymentExpiresAt: null,
      paymentStatusPolledAt: null,
      status: 'paid',
    })
    const jobs = await payload.db.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM payload_jobs
       WHERE workflow_slug = 'commerceFulfillment'
         AND (input->>'orderId')::int = $1`,
      [fixture.order.id],
    )
    expect(jobs.rows[0]?.count).toBe(1)
    const audits = await payload.count({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.balance_payment.held' } },
          { targetId: { equals: String(fixture.order.id) } },
          { traceId: { equals: `${prefix}-instant-pay` } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(1)

    await payload.update({
      collection: 'orders',
      data: {
        merchantOrderNumber: `WM${randomUUID().replaceAll('-', '').slice(0, 30)}`,
        paymentExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        status: 'pending_payment',
      },
      id: fixture.order.id,
      overrideAccess: true,
    })
    await expect(
      runPaymentTimeoutClose(await systemRequest('instant-timeout'), {
        now: new Date(),
        orderId: fixture.order.id,
        provider: forbiddenPaymentProvider(),
        traceId: `${prefix}-instant-timeout`,
      }),
    ).resolves.toEqual({ cancelled: 0, checked: 0, failed: 0, paid: 0, unchanged: 0 })
    expect(
      (
        await payload.findByID({
          collection: 'orders',
          id: fixture.order.id,
          overrideAccess: true,
        })
      ).status,
    ).toBe('pending_payment')
  })

  it('lets exactly one of N concurrent balance-payment attempts hold funds and confirm the order', async () => {
    const fixture = await createFixture('pay-race')
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) => pay(fixture, `pay-race-${index}`)),
    )
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(7)
    await expect(
      readWalletBalance(await systemRequest('pay-race-balance'), fixture.accountId),
    ).resolves.toEqual({
      availableBalance: 0n,
      heldBalance: BigInt(amountMinor),
      postedBalance: BigInt(amountMinor),
    })
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: fixture.accountId } },
          { transactionKey: { equals: balancePaymentTransactionKey(fixture.order.id) } },
          { status: { equals: 'held' } },
        ],
      },
    })
    expect(holds.totalDocs).toBe(1)
    expect(
      await countOrderEvents(Number(fixture.order.id), 'wallet.balance_payment_confirmed'),
    ).toBe(1)
  })

  it('keeps every balance-channel CAS predicate effective against stale or cross-order state', async () => {
    const idTarget = await createFixture('balance-cas-id-target')
    const idDecoy = await createFixture('balance-cas-id-decoy')
    await expect(
      claimBalancePaymentChannel(await systemRequest('balance-cas-id'), {
        orderId: idTarget.order.id,
        paidAt: new Date().toISOString(),
      }),
    ).resolves.toBe(true)
    expect(
      (
        await payload.findByID({
          collection: 'orders',
          id: idDecoy.order.id,
          overrideAccess: true,
        })
      ).paymentChannel,
    ).toBeNull()

    const cases = [
      { column: 'status', suffix: 'status', value: 'cancelled' },
      { column: 'payment_channel', suffix: 'channel', value: 'native' },
      {
        column: 'merchant_order_number',
        suffix: 'merchant',
        value: `WM${randomUUID().replaceAll('-', '').slice(0, 30)}`,
      },
      {
        column: 'payment_expires_at',
        suffix: 'expiry',
        value: new Date(Date.now() + 60_000).toISOString(),
      },
    ] as const
    for (const testCase of cases) {
      const fixture = await createFixture(`balance-cas-${testCase.suffix}`)
      await payload.db.pool.query(`UPDATE orders SET ${testCase.column} = $1 WHERE id = $2`, [
        testCase.value,
        fixture.order.id,
      ])
      await expect(
        claimBalancePaymentChannel(await systemRequest(`balance-cas-${testCase.suffix}`), {
          orderId: fixture.order.id,
          paidAt: new Date().toISOString(),
        }),
      ).resolves.toBe(false)
    }
  })

  it('keeps every WeChat-channel CAS predicate effective against stale or cross-order state', async () => {
    const claim = async (fixture: Fixture, suffix: string) =>
      claimWechatPaymentChannel(await systemRequest(`wechat-cas-${suffix}`), {
        channel: 'native',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        merchantOrderNumber: `WM${randomUUID().replaceAll('-', '').slice(0, 30)}`,
        orderId: fixture.order.id,
      })
    const idTarget = await createFixture('wechat-cas-id-target')
    const idDecoy = await createFixture('wechat-cas-id-decoy')
    await expect(claim(idTarget, 'id')).resolves.toBe(true)
    expect(
      (
        await payload.findByID({
          collection: 'orders',
          id: idDecoy.order.id,
          overrideAccess: true,
        })
      ).paymentChannel,
    ).toBeNull()

    const cases = [
      { column: 'status', suffix: 'status', value: 'cancelled' },
      { column: 'payment_channel', suffix: 'channel', value: 'balance' },
      {
        column: 'merchant_order_number',
        suffix: 'merchant',
        value: `WM${randomUUID().replaceAll('-', '').slice(0, 30)}`,
      },
      {
        column: 'payment_expires_at',
        suffix: 'expiry',
        value: new Date(Date.now() + 60_000).toISOString(),
      },
    ] as const
    for (const testCase of cases) {
      const fixture = await createFixture(`wechat-cas-${testCase.suffix}`)
      await payload.db.pool.query(`UPDATE orders SET ${testCase.column} = $1 WHERE id = $2`, [
        testCase.value,
        fixture.order.id,
      ])
      await expect(claim(fixture, testCase.suffix)).resolves.toBe(false)
    }
  })

  it('blocks balance spending through the existing A3 capability before creating a hold', async () => {
    const fixture = await createFixture('capability', {
      capabilityRestrictions: ['balance_spend_disabled'],
    })
    await expect(pay(fixture, 'capability-pay')).rejects.toMatchObject({
      code: 'ACCOUNT_BALANCE_SPEND_DISABLED',
    })
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: { transactionKey: { equals: balancePaymentTransactionKey(fixture.order.id) } },
    })
    expect(holds.totalDocs).toBe(0)
  })

  it('blocks purchase through the existing A3 capability before creating a hold', async () => {
    const fixture = await createFixture('purchase-capability', {
      capabilityRestrictions: ['purchase_disabled'],
    })
    await expect(pay(fixture, 'purchase-capability-pay')).rejects.toMatchObject({
      code: 'ACCOUNT_PURCHASE_DISABLED',
    })
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: { transactionKey: { equals: balancePaymentTransactionKey(fixture.order.id) } },
    })
    expect(holds.totalDocs).toBe(0)
  })

  it('rejects an already selected balance channel with its stable conflict code', async () => {
    const fixture = await createFixture('already-selected')
    await pay(fixture, 'already-selected-first')
    await expect(pay(fixture, 'already-selected-second')).rejects.toMatchObject({
      code: 'BALANCE_PAYMENT_ALREADY_SELECTED',
    })
  })

  it('rejects a non-pending order before any balance hold', async () => {
    const fixture = await createFixture('not-pending')
    await payload.db.pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [
      fixture.order.id,
    ])
    await expect(pay(fixture, 'not-pending-pay')).rejects.toMatchObject({
      code: 'ORDER_NOT_PENDING_PAYMENT',
    })
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: { transactionKey: { equals: balancePaymentTransactionKey(fixture.order.id) } },
    })
    expect(holds.totalDocs).toBe(0)
  })

  it('rejects an expired frozen quote before any balance hold', async () => {
    const fixture = await createFixture('expired')
    await payload.update({
      collection: 'orders',
      data: {
        quoteSnapshot: {
          ...(fixture.order.quoteSnapshot as Record<string, unknown>),
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
      id: fixture.order.id,
      overrideAccess: true,
    })
    await expect(pay(fixture, 'expired-pay')).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' })
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: { transactionKey: { equals: balancePaymentTransactionKey(fixture.order.id) } },
    })
    expect(holds.totalDocs).toBe(0)
  })

  it('rejects a missing frozen quote expiry before any balance hold', async () => {
    const fixture = await createFixture('invalid-snapshot')
    await payload.db.pool.query(`UPDATE orders SET quote_snapshot = '{}'::jsonb WHERE id = $1`, [
      fixture.order.id,
    ])
    await expect(pay(fixture, 'invalid-snapshot-pay')).rejects.toMatchObject({
      code: 'ORDER_QUOTE_SNAPSHOT_INVALID',
    })
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: { transactionKey: { equals: balancePaymentTransactionKey(fixture.order.id) } },
    })
    expect(holds.totalDocs).toBe(0)
  })

  it('rejects a stale released hold instead of confirming payment', async () => {
    const fixture = await createFixture('stale-hold')
    const key = balancePaymentTransactionKey(fixture.order.id)
    await holdWalletBalance(await systemRequest('stale-hold-create'), {
      accountId: fixture.accountId,
      amountFen: amountMinor,
      transactionKey: key,
    })
    await releaseWalletHold(await systemRequest('stale-hold-release'), key)
    await expect(pay(fixture, 'stale-hold-pay')).rejects.toMatchObject({
      code: 'BALANCE_PAYMENT_HOLD_INVALID',
    })
    expect(
      await payload.findByID({
        collection: 'orders',
        id: fixture.order.id,
        overrideAccess: true,
      }),
    ).toMatchObject({ paidAt: null, paymentChannel: null, status: 'pending_payment' })
  })

  it('captures on confirmed fulfillment, releases on explicit failure, and keeps unknown outcomes held', async () => {
    const success = await createFixture('fulfillment-success')
    await pay(success, 'fulfillment-success-pay')
    await payload.update({
      collection: 'orders',
      data: { merchantOrderNumber: `WM${randomUUID().replaceAll('-', '').slice(0, 30)}` },
      id: success.order.id,
      overrideAccess: true,
    })
    const successTransport = new FixtureWestDigitalWriteTransport((input) =>
      input.operation === 'register'
        ? registrationResponse(success.domainAscii)
        : assetResponse(success.domainAscii),
    )
    await expect(
      runCommerceFulfillment(
        await systemRequest('fulfillment-success-run'),
        {
          operationKey: `commerce-fulfillment:${success.order.id}`,
          orderId: Number(success.order.id),
          traceId: `${prefix}-fulfillment-success`,
        },
        dependencies(new WestDigitalWriteAdapter({ transport: successTransport })),
      ),
    ).resolves.toMatchObject({ status: 'succeeded' })
    await expect(
      readWalletBalance(await systemRequest('fulfillment-success-balance'), success.accountId),
    ).resolves.toEqual({
      availableBalance: 0n,
      heldBalance: 0n,
      postedBalance: 0n,
    })

    const failure = await createFixture('fulfillment-failure')
    await pay(failure, 'fulfillment-failure-pay')
    const failureTransport = new FixtureWestDigitalWriteTransport(() => ({
      body: { clientid: `${prefix}-explicit-failure`, result: 500 },
      status: 200,
    }))
    await expect(
      runCommerceFulfillment(
        await systemRequest('fulfillment-failure-run'),
        {
          operationKey: `commerce-fulfillment:${failure.order.id}`,
          orderId: Number(failure.order.id),
          traceId: `${prefix}-fulfillment-failure`,
        },
        dependencies(new WestDigitalWriteAdapter({ transport: failureTransport })),
      ),
    ).resolves.toMatchObject({ status: 'refunded' })
    await expect(
      readWalletBalance(await systemRequest('fulfillment-failure-balance'), failure.accountId),
    ).resolves.toEqual({
      availableBalance: BigInt(amountMinor),
      heldBalance: 0n,
      postedBalance: BigInt(amountMinor),
    })

    const unknown = await createFixture('fulfillment-unknown')
    await pay(unknown, 'fulfillment-unknown-pay')
    const unknownTransport = new FixtureWestDigitalWriteTransport((input) => {
      if (input.operation === 'register') timeoutAfterSubmission()
      throw new WestDigitalWriteTransportError('TEMPORARILY_UNAVAILABLE', 'not_submitted')
    })
    await expect(
      runCommerceFulfillment(
        await systemRequest('fulfillment-unknown-run'),
        {
          operationKey: `commerce-fulfillment:${unknown.order.id}`,
          orderId: Number(unknown.order.id),
          traceId: `${prefix}-fulfillment-unknown`,
        },
        dependencies(new WestDigitalWriteAdapter({ transport: unknownTransport })),
      ),
    ).resolves.toMatchObject({ status: 'manual_review' })
    await expect(
      readWalletBalance(await systemRequest('fulfillment-unknown-balance'), unknown.accountId),
    ).resolves.toEqual({
      availableBalance: 0n,
      heldBalance: BigInt(amountMinor),
      postedBalance: BigInt(amountMinor),
    })
    const unknownSettlementEntries = await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: unknown.accountId } },
          { entryType: { in: ['capture', 'release'] } },
        ],
      },
    })
    expect(unknownSettlementEntries.totalDocs).toBe(0)
  }, 90_000)

  it('rejects both refund-path crossings before any opposite-channel effect', async () => {
    const balance = await createFixture('cross-balance')
    await pay(balance, 'cross-balance-pay')
    await expect(
      requestWechatRegistrationFailureRefund(await systemRequest('cross-balance-wechat'), {
        evidence: { result: 'failed' },
        note: 'fixture',
        orderId: balance.order.id,
        traceId: `${prefix}-cross-balance-wechat`,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_CHANNEL_MISMATCH' })

    const rogueRefund = await payload.create({
      collection: 'refunds',
      data: {
        amountMinor,
        createdTraceId: `${prefix}-cross-balance-rogue`,
        currency: 'CNY',
        order: balance.order.id,
        refundNumber: `WR${randomUUID().replaceAll('-', '')}`,
        status: 'pending',
      },
      overrideAccess: true,
    })
    await expect(
      runWechatRefund(
        await systemRequest('cross-balance-job'),
        { refundId: Number(rogueRefund.id), traceId: `${prefix}-cross-balance-job` },
        forbiddenRefundProvider(),
      ),
    ).rejects.toMatchObject({ code: 'REFUND_CHANNEL_MISMATCH' })

    const wechat = await createFixture('cross-wechat')
    await payload.update({
      collection: 'orders',
      data: {
        merchantOrderNumber: `WM${randomUUID().replaceAll('-', '').slice(0, 30)}`,
        paidAt: new Date().toISOString(),
        paymentChannel: 'native',
        status: 'paid',
      },
      id: wechat.order.id,
      overrideAccess: true,
    })
    await expect(
      requestBalanceRegistrationFailureRefund(await systemRequest('cross-wechat-balance'), {
        evidence: { result: 'failed' },
        note: 'fixture',
        orderId: wechat.order.id,
        traceId: `${prefix}-cross-wechat-balance`,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_CHANNEL_MISMATCH' })
    expect(
      (
        await payload.count({
          collection: 'walletEntries',
          overrideAccess: true,
          where: {
            and: [
              { account: { equals: wechat.accountId } },
              { entryType: { in: ['capture', 'hold', 'release'] } },
            ],
          },
        })
      ).totalDocs,
    ).toBe(0)
  })

  it('never refunds a succeeded balance-paid registration order', async () => {
    const fixture = await createFixture('succeeded-refund')
    await pay(fixture, 'succeeded-refund-pay')
    await captureBalancePaymentForFulfillment(
      await systemRequest('succeeded-refund-capture'),
      fixture.order.id,
    )
    await payload.db.pool.query(`UPDATE orders SET status = 'succeeded' WHERE id = $1`, [
      fixture.order.id,
    ])
    await expect(
      requestBalanceRegistrationFailureRefund(await systemRequest('succeeded-refund-request'), {
        evidence: { result: 'failed' },
        note: 'fixture',
        orderId: fixture.order.id,
        traceId: `${prefix}-succeeded-refund-request`,
      }),
    ).rejects.toMatchObject({ code: 'SUCCEEDED_ORDER_REFUND_FORBIDDEN' })
    const refunds = await payload.count({
      collection: 'refunds',
      overrideAccess: true,
      where: { order: { equals: fixture.order.id } },
    })
    expect(refunds.totalDocs).toBe(0)
  })

  it('rejects a cancelled balance order as non-refundable without releasing its hold', async () => {
    const fixture = await createFixture('cancelled-refund')
    await pay(fixture, 'cancelled-refund-pay')
    await payload.db.pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [
      fixture.order.id,
    ])
    await expect(
      requestBalanceRegistrationFailureRefund(await systemRequest('cancelled-refund-request'), {
        evidence: { result: 'failed' },
        note: 'fixture',
        orderId: fixture.order.id,
        traceId: `${prefix}-cancelled-refund-request`,
      }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_REFUNDABLE' })
    await expect(
      readWalletBalance(await systemRequest('cancelled-refund-balance'), fixture.accountId),
    ).resolves.toEqual({
      availableBalance: 0n,
      heldBalance: BigInt(amountMinor),
      postedBalance: BigInt(amountMinor),
    })
  })

  it('rejects an order/hold amount mismatch, records one scoped manual review, and keeps the hold', async () => {
    const fixture = await createFixture('amount-mismatch')
    await pay(fixture, 'amount-mismatch-pay')
    await payload.update({
      collection: 'orders',
      data: { amountMinor: amountMinor + 1 },
      id: fixture.order.id,
      overrideAccess: true,
    })
    await expect(
      requestBalanceRegistrationFailureRefund(await systemRequest('amount-mismatch-refund'), {
        evidence: { result: 'failed' },
        note: 'fixture',
        orderId: fixture.order.id,
        traceId: `${prefix}-amount-mismatch-refund`,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_AMOUNT_MISMATCH' })
    expect(
      (
        await payload.findByID({
          collection: 'orders',
          id: fixture.order.id,
          overrideAccess: true,
        })
      ).status,
    ).toBe('manual_review')
    const reviews = await payload.count({
      collection: 'manualReviews',
      overrideAccess: true,
      where: {
        and: [
          { order: { equals: fixture.order.id } },
          { reasonCode: { equals: 'wallet.refund_amount_mismatch' } },
          { status: { equals: 'open' } },
        ],
      },
    })
    expect(reviews.totalDocs).toBe(1)
    const audits = await payload.count({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.balance_refund.blocked' } },
          { targetId: { equals: String(fixture.order.id) } },
          { traceId: { equals: `${prefix}-amount-mismatch-refund` } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(1)
    await expect(
      readWalletBalance(await systemRequest('amount-mismatch-balance'), fixture.accountId),
    ).resolves.toEqual({
      availableBalance: 0n,
      heldBalance: BigInt(amountMinor),
      postedBalance: BigInt(amountMinor),
    })
  })

  it.each(['customer', 'lifecycle'] as const)(
    'rejects corrupted hold %s provenance and opens a scoped manual review',
    async (field) => {
      const fixture = await createFixture(`hold-${field}-mismatch`)
      await pay(fixture, `hold-${field}-mismatch-pay`)
      const key = balancePaymentTransactionKey(fixture.order.id)
      if (field === 'customer') {
        const other = await createFixture('hold-customer-other')
        await payload.db.pool.query(
          'UPDATE wallet_transactions SET customer_id = $1 WHERE transaction_key = $2',
          [other.customer.id, key],
        )
      } else {
        await payload.db.pool.query(
          `UPDATE wallet_transactions
           SET type = 'credit', status = 'posted'
           WHERE transaction_key = $1`,
          [key],
        )
      }
      await expect(
        requestBalanceRegistrationFailureRefund(
          await systemRequest(`hold-${field}-mismatch-refund`),
          {
            evidence: { result: 'failed' },
            note: 'fixture',
            orderId: fixture.order.id,
            traceId: `${prefix}-hold-${field}-mismatch-refund`,
          },
        ),
      ).rejects.toMatchObject({ code: 'REFUND_AMOUNT_MISMATCH' })
      const reviews = await payload.count({
        collection: 'manualReviews',
        overrideAccess: true,
        where: {
          and: [
            { order: { equals: fixture.order.id } },
            { reasonCode: { equals: 'wallet.refund_amount_mismatch' } },
            { status: { equals: 'open' } },
          ],
        },
      })
      expect(reviews.totalDocs).toBe(1)
    },
  )

  it('releases the balance hold when registration preflight finds the domain unavailable', async () => {
    const fixture = await createFixture('preflight-unavailable')
    await pay(fixture, 'preflight-unavailable-pay')
    const provider = new WestDigitalWriteAdapter({
      transport: new FixtureWestDigitalWriteTransport(() => {
        throw new Error('Registration write must not run after unavailable preflight')
      }),
    })

    const result = await runCommerceFulfillment(
      await systemRequest('preflight-unavailable-run'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${prefix}-preflight-unavailable-run`,
      },
      dependencies(provider, { domainAvailable: false }),
    )

    expect(result.status).toBe('refunded')
    expect(
      (
        await payload.findByID({
          collection: 'orders',
          id: fixture.order.id,
          overrideAccess: true,
        })
      ).status,
    ).toBe('refunded')
    await expect(
      readWalletBalance(await systemRequest('preflight-unavailable-balance'), fixture.accountId),
    ).resolves.toEqual({
      availableBalance: BigInt(amountMinor),
      heldBalance: 0n,
      postedBalance: BigInt(amountMinor),
    })
    const releases = await payload.find({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: fixture.accountId } },
          { entryType: { equals: 'release' } },
          { amountFen: { equals: amountMinor } },
        ],
      },
    })
    expect(releases.totalDocs).toBe(1)
  })

  it('rejects refunding an already captured hold and rolls back refund state', async () => {
    const fixture = await createFixture('captured-refund')
    await pay(fixture, 'captured-refund-pay')
    await captureBalancePaymentForFulfillment(
      await systemRequest('captured-refund-capture'),
      fixture.order.id,
    )
    await expect(
      requestBalanceRegistrationFailureRefund(await systemRequest('captured-refund-request'), {
        evidence: { result: 'failed' },
        note: 'fixture',
        orderId: fixture.order.id,
        traceId: `${prefix}-captured-refund-request`,
      }),
    ).rejects.toMatchObject({ code: 'WALLET_HOLD_ALREADY_RESOLVED' })
    expect(
      await payload.findByID({
        collection: 'orders',
        id: fixture.order.id,
        overrideAccess: true,
      }),
    ).toMatchObject({ paymentChannel: 'balance', status: 'paid' })
    const refunds = await payload.count({
      collection: 'refunds',
      overrideAccess: true,
      where: { order: { equals: fixture.order.id } },
    })
    expect(refunds.totalDocs).toBe(0)
  })

  it('routes solely by the stored paymentChannel even when indirect WeChat signals disagree', async () => {
    const fixture = await createFixture('channel-source')
    await pay(fixture, 'channel-source-pay')
    await payload.update({
      collection: 'orders',
      data: { merchantOrderNumber: `WM${randomUUID().replaceAll('-', '').slice(0, 30)}` },
      id: fixture.order.id,
      overrideAccess: true,
    })
    await expect(
      queryAndConfirmWechatPayment(
        await customerRequest(fixture.customer, 'channel-source-status'),
        fixture.order.orderNumber,
        {
          customer: fixture.customer,
          provider: forbiddenPaymentProvider(),
          traceId: `${prefix}-channel-source-status`,
        },
      ),
    ).resolves.toMatchObject({ data: { status: 'paid' } })
    await expect(
      requestWechatRegistrationFailureRefund(await systemRequest('channel-source-wechat'), {
        evidence: { result: 'failed' },
        note: 'fixture',
        orderId: fixture.order.id,
        traceId: `${prefix}-channel-source-wechat`,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_CHANNEL_MISMATCH' })
    await expect(
      requestAutomaticRegistrationFailureRefund(await systemRequest('channel-source-refund'), {
        evidence: { result: 'failed' },
        note: 'fixture',
        orderId: fixture.order.id,
        traceId: `${prefix}-channel-source-refund`,
      }),
    ).resolves.toMatchObject({ idempotentReplay: false })
    await expect(
      requestAutomaticRegistrationFailureRefund(await systemRequest('channel-source-replay'), {
        evidence: { result: 'failed' },
        note: 'fixture replay',
        orderId: fixture.order.id,
        traceId: `${prefix}-channel-source-replay`,
      }),
    ).resolves.toMatchObject({ idempotentReplay: true })
    expect(
      (
        await payload.findByID({
          collection: 'orders',
          id: fixture.order.id,
          overrideAccess: true,
        })
      ).status,
    ).toBe('refunded')
    const refunds = await payload.find({
      collection: 'refunds',
      overrideAccess: true,
      where: {
        and: [
          { order: { equals: fixture.order.id } },
          { amountMinor: { equals: amountMinor } },
          { status: { equals: 'succeeded' } },
        ],
      },
    })
    expect(refunds.totalDocs).toBe(1)
    expect(
      await countOrderEvents(Number(fixture.order.id), 'wallet.balance_refund_processing'),
    ).toBe(1)
    expect(
      await countOrderEvents(Number(fixture.order.id), 'wallet.balance_refund_confirmed'),
    ).toBe(1)
    const audits = await payload.count({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'wallet.balance_refund.completed' } },
          { targetId: { equals: String(fixture.order.id) } },
          { traceId: { equals: `${prefix}-channel-source-refund` } },
        ],
      },
    })
    expect(audits.totalDocs).toBe(1)
  })

  it('rejects mixed balance and WeChat selection with the dedicated error in both directions', async () => {
    const balance = await createFixture('mixed-balance')
    await pay(balance, 'mixed-balance-pay')
    await expect(
      createWechatPayment(
        await customerRequest(balance.customer, 'mixed-balance-wechat'),
        balance.order.orderNumber,
        { channel: 'native' },
        {
          customer: balance.customer,
          provider: forbiddenPaymentProvider(),
          traceId: `${prefix}-mixed-balance-wechat`,
        },
      ),
    ).rejects.toMatchObject({ code: 'MIXED_PAYMENT_CHANNELS_FORBIDDEN' })

    const wechat = await createFixture('mixed-wechat')
    await payload.update({
      collection: 'orders',
      data: {
        merchantOrderNumber: `WM${randomUUID().replaceAll('-', '').slice(0, 30)}`,
        paymentChannel: 'native',
        paymentExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
      id: wechat.order.id,
      overrideAccess: true,
    })
    await expect(pay(wechat, 'mixed-wechat-balance')).rejects.toMatchObject({
      code: 'MIXED_PAYMENT_CHANNELS_FORBIDDEN',
    })
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: { transactionKey: { equals: balancePaymentTransactionKey(wechat.order.id) } },
    })
    expect(holds.totalDocs).toBe(0)
  })

  it.each([
    ['native channel', { paymentChannel: 'native' as const }],
    ['h5 channel', { paymentChannel: 'h5' as const }],
    [
      'merchant number',
      { merchantOrderNumber: `WM${randomUUID().replaceAll('-', '').slice(0, 30)}` },
    ],
    ['payment expiry', { paymentExpiresAt: new Date(Date.now() + 120_000).toISOString() }],
  ])('rejects the isolated WeChat signal %s with the mixed-channel code', async (_, data) => {
    const fixture = await createFixture(`mixed-signal-${randomUUID().slice(0, 8)}`)
    await payload.update({
      collection: 'orders',
      data,
      id: fixture.order.id,
      overrideAccess: true,
    })
    await expect(pay(fixture, 'mixed-signal-pay')).rejects.toMatchObject({
      code: 'MIXED_PAYMENT_CHANNELS_FORBIDDEN',
    })
  })

  it('atomically chooses exactly one channel under a concurrent balance/WeChat race', async () => {
    const fixture = await createFixture('cross-channel-race')
    const wechat = createWechatPayFixture()
    const attempts = await Promise.allSettled([
      pay(fixture, 'cross-channel-race-balance'),
      createWechatPayment(
        await customerRequest(fixture.customer, 'cross-channel-race-wechat'),
        fixture.order.orderNumber,
        { channel: 'native' },
        {
          customer: fixture.customer,
          provider: wechat.provider,
          traceId: `${prefix}-cross-channel-race-wechat`,
        },
      ),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    const stored = await payload.findByID({
      collection: 'orders',
      id: fixture.order.id,
      overrideAccess: true,
    })
    const holds = await payload.count({
      collection: 'walletTransactions',
      overrideAccess: true,
      where: { transactionKey: { equals: balancePaymentTransactionKey(fixture.order.id) } },
    })
    if (stored.paymentChannel === 'balance') {
      expect(stored.merchantOrderNumber).toBeNull()
      expect(holds.totalDocs).toBe(1)
    } else {
      expect(stored.paymentChannel).toBe('native')
      expect(stored.merchantOrderNumber).toBeTruthy()
      expect(holds.totalDocs).toBe(0)
    }
  })

  it('settles a concurrent capture/release race exactly once without a negative balance', async () => {
    const fixture = await createFixture('settlement-race')
    await pay(fixture, 'settlement-race-pay')
    const key = balancePaymentTransactionKey(fixture.order.id)
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, async (_, index) =>
        index % 2 === 0
          ? captureBalancePaymentForFulfillment(
              await systemRequest(`settlement-race-capture-${index}`),
              fixture.order.id,
            )
          : releaseWalletHold(await systemRequest(`settlement-race-release-${index}`), key),
      ),
    )
    const applied = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' && attempt.value ? [attempt.value.applied] : [],
    )
    expect(applied.filter(Boolean)).toHaveLength(1)
    const balance = await readWalletBalance(
      await systemRequest('settlement-race-balance'),
      fixture.accountId,
    )
    expect(balance.availableBalance >= 0n).toBe(true)
    expect(balance.heldBalance).toBe(0n)
    const settlementEntries = await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: fixture.accountId } },
          { entryType: { in: ['capture', 'release'] } },
        ],
      },
    })
    expect(settlementEntries.totalDocs).toBe(1)
  })

  it('applies exactly one of N concurrent balance refunds and never duplicates the refund or release', async () => {
    const fixture = await createFixture('refund-race')
    await pay(fixture, 'refund-race-pay')
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        requestBalanceRegistrationFailureRefund(await systemRequest(`refund-race-${index}`), {
          evidence: { result: 'failed' },
          note: 'fixture',
          orderId: fixture.order.id,
          traceId: `${prefix}-refund-race-${index}`,
        }),
      ),
    )
    const applied = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [!attempt.value.idempotentReplay] : [],
    )
    expect(applied.filter(Boolean)).toHaveLength(1)
    const refunds = await payload.count({
      collection: 'refunds',
      overrideAccess: true,
      where: {
        and: [
          { order: { equals: fixture.order.id } },
          { amountMinor: { equals: amountMinor } },
          { status: { equals: 'succeeded' } },
        ],
      },
    })
    expect(refunds.totalDocs).toBe(1)
    const releases = await payload.count({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: fixture.accountId } },
          { entryType: { equals: 'release' } },
          { amountFen: { equals: amountMinor } },
        ],
      },
    })
    expect(releases.totalDocs).toBe(1)
    await expect(
      readWalletBalance(await systemRequest('refund-race-balance'), fixture.accountId),
    ).resolves.toEqual({
      availableBalance: BigInt(amountMinor),
      heldBalance: 0n,
      postedBalance: BigInt(amountMinor),
    })
  })
})
