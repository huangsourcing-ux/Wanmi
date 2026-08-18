import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ProviderResult } from '@/lib/domain'
import { mockSuccess } from '@/providers/mock'
import type { WestDigitalAvailability, WestDigitalWriteProvider } from '@/providers/types'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import {
  WestDigitalWriteAdapter,
  WestDigitalWriteTransportError,
} from '@/providers/westdigital-write'
import {
  FixtureWestDigitalWriteTransport,
  timeoutAfterSubmission,
} from '@/providers/westdigital-write-fixtures'
import {
  runCommerceFulfillment,
  type FulfillmentDependencies,
} from '@/services/commerce/fulfillment'
import { balancePaymentTransactionKey } from '@/services/commerce/balance-payments'
import { createCustomerOrder } from '@/services/commerce/order-creation'
import {
  createCustomerQuote,
  PayloadCustomerDomainAssetStore,
  PayloadCustomerQuoteStore,
} from '@/services/pricing/customer-quotes'
import { PayloadPriceSnapshotStore } from '@/services/pricing/price-snapshots'
import {
  createWalletAccount,
  holdWalletBalance,
  postWalletCredit,
  readWalletBalance,
} from '@/services/wallet/ledger'

import { PRICING_RULE_FIXTURES } from '../fixtures/pricing'
import { realnameTemplateFixture } from '../fixtures/realname'
import { findOrCreateUniqueFixture, ignorePayloadNotFound } from '../test-cleanup'

const fixturePrefix = `d6-active-renewals-${randomUUID()}`
const fixtureScope = fixturePrefix.slice(0, 36)
const fixtureToken = `d605-${fixturePrefix.slice(-12)}`
const originalExpiresAt = '2027-08-08T12:00:00.000Z'
const renewedExpiresAt = '2029-08-08T12:00:00.000Z'
let payload: Payload

async function request(suffix: string, user?: unknown): Promise<PayloadRequest> {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) } },
    payload,
  )
  if (user) req.user = user as never
  return req
}

async function customer(suffix: string) {
  const phone = `${fixturePrefix}-${suffix}`
  const fixture = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'customers',
        data: {
          capabilityRestrictions: [],
          phone,
          phoneMasked: `***${suffix.slice(-4)}`,
          status: 'active',
        },
        overrideAccess: true,
      }),
    find: async () =>
      (
        await payload.find({
          collection: 'customers',
          limit: 1,
          overrideAccess: true,
          where: { phone: { equals: phone } },
        })
      ).docs[0],
    path: 'phone',
    tableName: 'customers',
  })
  return { ...fixture.value, collection: 'customers' as const, id: Number(fixture.value.id) }
}

async function assetFor(owner: Awaited<ReturnType<typeof customer>>, suffix: string, tld = 'com') {
  const displayName = `${fixturePrefix.slice(0, 34)}-${suffix.slice(0, 18)}`
  const templateFixture = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'realnameTemplates',
        data: {
          ...realnameTemplateFixture({
            displayName,
            providerConfirmedAt: '2026-08-08T12:00:00.000Z',
            providerReviewState: 'approved',
            providerTemplateId: '1664777',
            status: 'approved',
          }),
          customer: owner.id,
        },
        overrideAccess: true,
      }),
    find: async () =>
      (
        await payload.find({
          collection: 'realnameTemplates',
          limit: 1,
          overrideAccess: true,
          where: {
            and: [{ customer: { equals: owner.id } }, { displayName: { equals: displayName } }],
          },
        })
      ).docs[0],
    path: 'displayName',
    tableName: 'realname_templates',
  })
  const domainAscii = `${fixtureToken}-${suffix.slice(0, 10)}-${randomUUID().slice(0, 8)}.${tld}`
  const assetFixture = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'domainAssets',
        data: {
          customer: owner.id,
          domainAscii,
          expiresAt: originalExpiresAt,
          lastSyncedAt: '2026-08-08T12:00:00.000Z',
          nameservers: ['ns1.myhostadmin.net', 'ns2.myhostadmin.net'],
          realnameTemplate: templateFixture.value.id,
          registeredAt: '2026-08-08T12:00:00.000Z',
          registrar: 'west',
          status: 'active',
          syncReviewStatus: 'none',
          syncVersion: 0,
          upstreamOwnershipStatus: 'unknown',
        },
        overrideAccess: true,
      }),
    find: async () =>
      (
        await payload.find({
          collection: 'domainAssets',
          limit: 1,
          overrideAccess: true,
          where: { domainAscii: { equals: domainAscii } },
        })
      ).docs[0],
    path: 'domainAscii',
    tableName: 'domain_assets',
  })
  return { asset: assetFixture.value, domainAscii, template: templateFixture.value }
}

function renewalSnapshot(input: {
  amountMinor: number
  assetId: number
  customerId: number
  domainAscii: string
  quoteId: number
  years: number
}) {
  const now = new Date().toISOString()
  return {
    assetExpiresAt: originalExpiresAt,
    availabilityObservedAt: now,
    availabilityRequestId: `${fixturePrefix}-owned-asset`,
    calculation: {
      registrationPriceFen: 2_999,
      renewalPriceFen: input.amountMinor / input.years,
      upstreamRegistrationPriceFen: 2_999,
      upstreamRenewalPriceFen: input.amountMinor / input.years,
    },
    createdTraceId: `${fixturePrefix}-quote-snapshot`,
    currency: 'CNY' as const,
    customerId: String(input.customerId),
    domainAssetId: input.assetId,
    domainAscii: input.domainAscii,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    operation: 'renewal' as const,
    orderAvailability: {
      observedAt: now,
      requestId: `${fixturePrefix}-asset-revalidated`,
    },
    providerCacheStatus: 'miss' as const,
    providerObservedAt: now,
    providerProductId: `${fixturePrefix}-product`,
    providerRequestId: `${fixturePrefix}-price`,
    quoteId: input.quoteId,
    quoteIntegrityHash: '2'.repeat(64),
    quoteRef: randomUUID(),
    quotedAt: now,
    schemaVersion: 1 as const,
    sourceCalculationHash: '3'.repeat(64),
    sourcePriceSnapshotRef: randomUUID(),
    tld: input.domainAscii.split('.').at(-1)!,
    upstreamCostMinor: input.amountMinor,
    userPriceMinor: input.amountMinor,
    years: input.years,
  }
}

async function paidRenewal(
  suffix: string,
  options: { balance?: boolean; status?: 'fulfilling' | 'paid'; years?: number } = {},
) {
  const owner = await customer(suffix)
  const { asset, domainAscii, template } = await assetFor(owner, suffix)
  const years = options.years ?? 2
  const amountMinor = 1_999 * years
  const quoteRef = randomUUID()
  const quoteFixture = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'quotes',
        data: {
          assetExpiresAt: originalExpiresAt,
          availabilityObservedAt: new Date().toISOString(),
          availabilityRequestId: `${fixturePrefix}-availability-${suffix}`,
          calculationFormula: 'registration_price_plus_annual_renewal_price',
          calculationVersion: 1,
          createdTraceId: `${fixturePrefix}-quote-${suffix}`,
          currency: 'CNY',
          customer: owner.id,
          domainAsset: asset.id,
          domainAscii,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          operation: 'renewal',
          priceClass: 'standard',
          provider: 'westdigital_fixture',
          providerCacheStatus: 'miss',
          providerObservedAt: new Date().toISOString(),
          providerProductId: `${fixturePrefix}-product-${suffix}`,
          providerRequestId: `${fixturePrefix}-price-${suffix}`,
          quotedAt: new Date().toISOString(),
          quoteIntegrityHash: '2'.repeat(64),
          quoteRef,
          registrationPriceMinor: 2_999,
          renewalPriceMinor: 1_999,
          ruleFixedAmountMinor: 0,
          ruleKey: `${fixturePrefix}-rule-${suffix}`,
          ruleMode: 'fixed',
          ruleSource: 'wanmi_fixture',
          ruleVersion: 1,
          roundingMode: 'half_up_to_fen',
          schemaVersion: 1,
          sourceCalculationHash: '3'.repeat(64),
          sourcePriceSnapshotRef: randomUUID(),
          tld: 'com',
          upstreamCostMinor: amountMinor,
          upstreamRegistrationPriceMinor: 2_999,
          upstreamRenewalPriceMinor: 1_999,
          userPriceMinor: amountMinor,
          years,
        },
        overrideAccess: true,
      }),
    find: async () =>
      (
        await payload.find({
          collection: 'quotes',
          limit: 1,
          overrideAccess: true,
          where: { quoteRef: { equals: quoteRef } },
        })
      ).docs[0],
    path: 'quoteRef',
    tableName: 'quotes',
  })
  const orderNumber = `${fixturePrefix}-${suffix}-${randomUUID()}`
  const merchantOrderNumber = `WM${randomUUID().replaceAll('-', '')}`
  const paidAt = new Date().toISOString()
  let walletAccountId: number | undefined
  if (options.balance) {
    const account = await createWalletAccount(await request(`${suffix}-wallet`), owner.id)
    walletAccountId = Number(account.accountId)
    await postWalletCredit(await request(`${suffix}-wallet-credit`), {
      accountId: walletAccountId,
      amountFen: amountMinor,
      transactionKey: `${fixturePrefix}:${suffix}:wallet-credit`,
    })
  }
  const orderFixture = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'orders',
        data: {
          amountMinor,
          currency: 'CNY',
          customer: owner.id,
          domainAsset: asset.id,
          domainAscii,
          operation: 'renewal',
          orderNumber,
          paidAt,
          ...(options.balance
            ? { paymentChannel: 'balance' as const }
            : { merchantOrderNumber, paymentChannel: 'native' as const }),
          quote: quoteFixture.value.id,
          quoteSnapshot: renewalSnapshot({
            amountMinor,
            assetId: Number(asset.id),
            customerId: owner.id,
            domainAscii,
            quoteId: Number(quoteFixture.value.id),
            years,
          }),
          realnameTemplate: template.id,
          status: options.status ?? 'paid',
        },
        overrideAccess: true,
      }),
    find: async () =>
      (
        await payload.find({
          collection: 'orders',
          limit: 1,
          overrideAccess: true,
          where: { orderNumber: { equals: orderNumber } },
        })
      ).docs[0],
    path: 'orderNumber',
    tableName: 'orders',
  })
  if (options.balance) {
    await holdWalletBalance(await request(`${suffix}-wallet-hold`), {
      accountId: walletAccountId!,
      amountFen: amountMinor,
      transactionKey: balancePaymentTransactionKey(orderFixture.value.id),
    })
  } else {
    const notificationId = `PAY-${randomUUID()}`
    await findOrCreateUniqueFixture({
      create: () =>
        payload.create({
          collection: 'paymentNotifications',
          data: {
            amountMinor,
            confirmationStatus: 'confirmed',
            currency: 'CNY',
            merchantOrderNumber,
            notificationId,
            order: orderFixture.value.id,
            paidAt,
            payloadDigest: '4'.repeat(64),
            providerRequestId: `${fixturePrefix}-payment-${suffix}`,
            receivedAt: paidAt,
            signatureVerified: true,
            source: 'query',
            wechatTransactionId: `WX-${randomUUID()}`,
          },
          overrideAccess: true,
        }),
      find: async () =>
        (
          await payload.find({
            collection: 'paymentNotifications',
            limit: 1,
            overrideAccess: true,
            where: { notificationId: { equals: notificationId } },
          })
        ).docs[0],
      path: 'notificationId',
      tableName: 'payment_notifications',
    })
  }
  return {
    asset,
    domainAscii,
    order: orderFixture.value,
    owner,
    walletAccountId,
    years,
  }
}

function assetResponse(domainAscii: string, expiresAt = renewedExpiresAt) {
  return {
    body: {
      clientid: `${fixturePrefix}-asset-query`,
      data: {
        dns1: 'ns1.myhostadmin.net',
        dns2: 'ns2.myhostadmin.net',
        dns3: '',
        dns4: '',
        dns5: '',
        dns6: '',
        domain: domainAscii,
        expdate: expiresAt,
        id: '44169980',
        regdate: '2026-08-08 12:00:00',
        registrars: 'west',
      },
      result: 200,
    },
    status: 200,
  }
}

function dependencies(
  write: WestDigitalWriteProvider,
  queryBalance?: FulfillmentDependencies['preflight']['queryBalance'],
): FulfillmentDependencies {
  return {
    preflight: {
      queryAvailability: async ({ domain, traceId }) =>
        mockSuccess(
          { available: true, currency: 'CNY', domainAscii: domain, premium: false },
          `${traceId}-availability`,
        ) as ProviderResult<WestDigitalAvailability>,
      queryBalance:
        queryBalance ??
        (async ({ traceId }) =>
          mockSuccess({ availableMinor: 1_000_000, frozenMinor: 0 }, `${traceId}-balance`)),
    },
    write,
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  const orders = await payload.find({
    collection: 'orders',
    limit: 200,
    overrideAccess: true,
    where: { orderNumber: { contains: fixtureScope } },
  })
  for (const order of orders.docs) {
    for (const collection of [
      'renewals',
      'manualReviews',
      'orderEvents',
      'paymentNotifications',
      'providerOperations',
      'refunds',
    ] as const) {
      const rows = await payload.find({
        collection,
        limit: 200,
        overrideAccess: true,
        where: { order: { equals: order.id } },
      })
      for (const row of rows.docs) {
        await ignorePayloadNotFound(() =>
          payload.delete({ collection, id: row.id, overrideAccess: true }),
        )
      }
    }
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'orders', id: order.id, overrideAccess: true }),
    )
  }
  const fixtureCustomers = await payload.find({
    collection: 'customers',
    limit: 200,
    overrideAccess: true,
    where: { phone: { contains: fixtureScope } },
  })
  const fixtureCustomerIds = fixtureCustomers.docs.map((customer) => Number(customer.id))
  if (fixtureCustomerIds.length > 0) {
    await payload.db.pool.query(
      `DELETE FROM wallet_entries
       WHERE account_id IN (SELECT id FROM wallet_accounts WHERE customer_id = ANY($1::int[]))`,
      [fixtureCustomerIds],
    )
    await payload.db.pool.query(
      `DELETE FROM wallet_transactions
       WHERE account_id IN (SELECT id FROM wallet_accounts WHERE customer_id = ANY($1::int[]))`,
      [fixtureCustomerIds],
    )
    await payload.db.pool.query('DELETE FROM wallet_accounts WHERE customer_id = ANY($1::int[])', [
      fixtureCustomerIds,
    ])
  }
  for (const collection of [
    'quotes',
    'priceSnapshots',
    'domainAssets',
    'realnameTemplates',
    'customers',
  ] as const) {
    const where =
      collection === 'customers'
        ? { phone: { contains: fixtureScope } }
        : collection === 'quotes' || collection === 'priceSnapshots'
          ? { createdTraceId: { contains: fixtureScope } }
          : collection === 'domainAssets'
            ? { domainAscii: { contains: fixtureToken } }
            : { displayName: { contains: fixturePrefix.slice(0, 34) } }
    const rows = await payload.find({
      collection,
      limit: 200,
      overrideAccess: true,
      where: where as never,
    })
    for (const row of rows.docs) {
      await ignorePayloadNotFound(() =>
        payload.delete({ collection, id: row.id, overrideAccess: true }),
      )
    }
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 500,
    overrideAccess: true,
    where: { traceId: { contains: fixtureScope } },
  })
  for (const audit of audits.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true }),
    )
  }
  await payload.db.destroy?.()
}, 120_000)

describe('D6-05 active renewals', () => {
  it('reuses the customer quote and order services while denying another customer asset', async () => {
    const owner = await customer('quote-owner')
    const other = await customer('quote-other')
    const { asset, domainAscii } = await assetFor(owner, 'quote-owned')
    const provider = new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() })
    const otherReq = await request('quote-other', other)
    await expect(
      createCustomerQuote(
        { assetId: Number(asset.id), operation: 'renewal', years: 2 },
        {
          assetStore: new PayloadCustomerDomainAssetStore(otherReq, other),
          customer: other,
          provider,
          quoteStore: new PayloadCustomerQuoteStore(otherReq, other),
          rules: PRICING_RULE_FIXTURES,
          snapshots: new PayloadPriceSnapshotStore(payload),
          traceId: `${fixturePrefix}-cross-customer-quote`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND' })

    const ownerReq = await request('quote-owner', owner)
    const quoteResult = await createCustomerQuote(
      { assetId: Number(asset.id), operation: 'renewal', years: 2 },
      {
        assetStore: new PayloadCustomerDomainAssetStore(ownerReq, owner),
        customer: owner,
        provider,
        quoteStore: new PayloadCustomerQuoteStore(ownerReq, owner),
        rules: PRICING_RULE_FIXTURES,
        snapshots: new PayloadPriceSnapshotStore(payload),
        traceId: `${fixturePrefix}-owned-quote`,
      },
    )
    expect(quoteResult).toMatchObject({
      data: {
        quote: {
          domainAscii,
          domainAssetId: asset.id,
          operation: 'renewal',
          years: 2,
        },
      },
      state: 'ready',
    })
    if (!('data' in quoteResult) || !quoteResult.data.quote) throw new Error('Expected quote')
    const orderProviderTransport = new FixtureWestDigitalTransport()
    const order = await createCustomerOrder(
      ownerReq,
      { quoteRef: quoteResult.data.quote.quoteRef },
      {
        customer: owner,
        orderNumber: () => `${fixtureScope}-svc-${randomUUID()}`,
        provider: new WestDigitalReadAdapter({ transport: orderProviderTransport }),
        rules: PRICING_RULE_FIXTURES,
        traceId: `${fixturePrefix}-owned-order`,
      },
    )
    expect(order).toMatchObject({ data: { operation: 'renewal', years: 2 }, state: 'ready' })
    expect(orderProviderTransport.requests).toHaveLength(0)
  })

  it('uses one provider write and one atomic expiry update under concurrent duplicate jobs', async () => {
    const fixture = await paidRenewal('concurrent', { status: 'fulfilling' })
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const transport = new FixtureWestDigitalWriteTransport((input) =>
      input.operation === 'renew'
        ? { body: { clientid: `${fixturePrefix}-renew`, result: 200 }, status: 200 }
        : assetResponse(fixture.domainAscii),
    )
    const provider = new WestDigitalWriteAdapter({ transport })
    const runs = 5
    const results = await Promise.all(
      Array.from({ length: runs }, async (_, index) =>
        runCommerceFulfillment(
          await request(`concurrent-${index}`),
          {
            operationKey: `commerce-fulfillment:${fixture.order.id}`,
            orderId: Number(fixture.order.id),
            traceId: `${fixturePrefix}-concurrent-${index}`,
          },
          dependencies(provider, async ({ traceId }) => {
            arrived += 1
            if (arrived === runs) release()
            await gate
            return mockSuccess({ availableMinor: 1_000_000, frozenMinor: 0 }, `${traceId}-balance`)
          }),
        ),
      ),
    )
    expect(results.every((result) => result.status === 'succeeded')).toBe(true)
    expect(transport.writeCount).toBe(1)
    expect(transport.requests.find((request) => request.operation === 'renew')?.body).toMatchObject(
      {
        client_price: '39.98',
        domain: fixture.domainAscii,
        expiredate: '2027-08-08',
        year: '2',
      },
    )
    const renewals = await payload.find({
      collection: 'renewals',
      overrideAccess: true,
      where: { order: { equals: fixture.order.id } },
    })
    expect(renewals.docs).toHaveLength(1)
    expect(renewals.docs[0]).toMatchObject({
      confirmedExpiresAt: renewedExpiresAt,
      previousExpiresAt: originalExpiresAt,
      status: 'succeeded',
      years: fixture.years,
    })
    const other = await customer('concurrent-other')
    expect(
      (
        await payload.find({
          collection: 'renewals',
          overrideAccess: false,
          user: other,
          where: { order: { equals: fixture.order.id } },
        })
      ).docs,
    ).toHaveLength(0)
    expect(
      (
        await payload.find({
          collection: 'renewals',
          overrideAccess: false,
          user: fixture.owner,
          where: { order: { equals: fixture.order.id } },
        })
      ).docs,
    ).toHaveLength(1)
    const audits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'commerce.renewal.recorded' } },
          { traceId: { contains: `${fixturePrefix}-concurrent-` } },
        ],
      },
    })
    expect(audits.docs).toHaveLength(1)
    expect(audits.docs[0]).toMatchObject({
      actorType: 'system',
      metadata: expect.objectContaining({
        confirmedExpiresAt: renewedExpiresAt,
        previousExpiresAt: originalExpiresAt,
        years: fixture.years,
      }),
      targetId: String(renewals.docs[0]!.id),
      targetType: 'renewal',
    })
    expect(
      (
        await payload.findByID({
          collection: 'domainAssets',
          id: fixture.asset.id,
          overrideAccess: true,
        })
      ).expiresAt,
    ).toBe(renewedExpiresAt)
    const replay = await runCommerceFulfillment(
      await request('concurrent-replay'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${fixturePrefix}-concurrent-replay`,
      },
      dependencies(provider),
    )
    expect(replay).toEqual({ idempotentReplay: true, status: 'succeeded' })
    expect(transport.writeCount).toBe(1)
  })

  it('captures the stored balance hold when a renewal is confirmed', async () => {
    const fixture = await paidRenewal('balance-capture', { balance: true })
    const transport = new FixtureWestDigitalWriteTransport((input) =>
      input.operation === 'renew'
        ? { body: { clientid: `${fixturePrefix}-balance-capture`, result: 200 }, status: 200 }
        : assetResponse(fixture.domainAscii),
    )
    const result = await runCommerceFulfillment(
      await request('balance-capture'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${fixturePrefix}-balance-capture`,
      },
      dependencies(new WestDigitalWriteAdapter({ transport })),
    )

    expect(result.status).toBe('succeeded')
    await expect(
      readWalletBalance(await request('balance-capture-read'), fixture.walletAccountId!),
    ).resolves.toEqual({ availableBalance: 0n, heldBalance: 0n, postedBalance: 0n })
    const captures = await payload.find({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: fixture.walletAccountId } },
          { entryType: { equals: 'capture' } },
          { amountFen: { equals: 3_998 } },
        ],
      },
    })
    expect(captures.totalDocs).toBe(1)
  })

  it('recovers after provider confirmation but before asset persistence without renewing twice', async () => {
    const fixture = await paidRenewal('restart')
    let assetQueries = 0
    const transport = new FixtureWestDigitalWriteTransport((input) => {
      if (input.operation === 'renew') {
        return { body: { clientid: `${fixturePrefix}-restart-renew`, result: 200 }, status: 200 }
      }
      assetQueries += 1
      if (assetQueries === 2) {
        throw new WestDigitalWriteTransportError('TEMPORARILY_UNAVAILABLE', 'not_submitted')
      }
      return assetResponse(fixture.domainAscii)
    })
    const provider = new WestDigitalWriteAdapter({ transport })
    const first = await runCommerceFulfillment(
      await request('restart-first'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${fixturePrefix}-restart-first`,
      },
      dependencies(provider),
    )
    expect(first.status).toBe('manual_review')
    expect(
      (
        await payload.findByID({
          collection: 'domainAssets',
          id: fixture.asset.id,
          overrideAccess: true,
        })
      ).expiresAt,
    ).toBe(originalExpiresAt)
    const replay = await runCommerceFulfillment(
      await request('restart-replay'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${fixturePrefix}-restart-replay`,
      },
      dependencies(provider),
    )
    expect(replay.status).toBe('succeeded')
    expect(transport.writeCount).toBe(1)
    expect(
      (
        await payload.findByID({
          collection: 'domainAssets',
          id: fixture.asset.id,
          overrideAccess: true,
        })
      ).expiresAt,
    ).toBe(renewedExpiresAt)
  })

  it('routes an explicit failure to automatic full refund', async () => {
    const fixture = await paidRenewal('failure')
    const transport = new FixtureWestDigitalWriteTransport((input) =>
      input.operation === 'asset_query'
        ? assetResponse(fixture.domainAscii)
        : {
            body: { clientid: `${fixturePrefix}-failure`, result: 500 },
            status: 200,
          },
    )
    const result = await runCommerceFulfillment(
      await request('failure'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${fixturePrefix}-failure`,
      },
      dependencies(new WestDigitalWriteAdapter({ transport })),
    )
    expect(result.status).toBe('refund_pending')
    expect(
      (await payload.findByID({ collection: 'orders', id: fixture.order.id, overrideAccess: true }))
        .status,
    ).toBe('refund_pending')
    expect(
      (
        await payload.find({
          collection: 'refunds',
          overrideAccess: true,
          where: { order: { equals: fixture.order.id } },
        })
      ).docs,
    ).toHaveLength(1)
    expect(
      (
        await payload.findByID({
          collection: 'domainAssets',
          id: fixture.asset.id,
          overrideAccess: true,
        })
      ).expiresAt,
    ).toBe(originalExpiresAt)
  })

  it('releases the stored balance hold when renewal failure is explicit', async () => {
    const fixture = await paidRenewal('balance-release', { balance: true })
    const transport = new FixtureWestDigitalWriteTransport((input) =>
      input.operation === 'asset_query'
        ? assetResponse(fixture.domainAscii)
        : {
            body: { clientid: `${fixturePrefix}-balance-release`, result: 500 },
            status: 200,
          },
    )
    const result = await runCommerceFulfillment(
      await request('balance-release'),
      {
        operationKey: `commerce-fulfillment:${fixture.order.id}`,
        orderId: Number(fixture.order.id),
        traceId: `${fixturePrefix}-balance-release`,
      },
      dependencies(new WestDigitalWriteAdapter({ transport })),
    )

    expect(result.status).toBe('refunded')
    await expect(
      readWalletBalance(await request('balance-release-read'), fixture.walletAccountId!),
    ).resolves.toEqual({
      availableBalance: 3_998n,
      heldBalance: 0n,
      postedBalance: 3_998n,
    })
    const releases = await payload.find({
      collection: 'walletEntries',
      overrideAccess: true,
      where: {
        and: [
          { account: { equals: fixture.walletAccountId } },
          { entryType: { equals: 'release' } },
          { amountFen: { equals: 3_998 } },
        ],
      },
    })
    expect(releases.totalDocs).toBe(1)
  })

  it('moves a post-submission timeout to manual review and only queries on replay', async () => {
    const fixture = await paidRenewal('timeout')
    const transport = new FixtureWestDigitalWriteTransport((input) => {
      if (input.operation === 'asset_query') {
        return assetResponse(fixture.domainAscii, originalExpiresAt)
      }
      if (input.operation === 'renew') timeoutAfterSubmission()
      throw new WestDigitalWriteTransportError('TEMPORARILY_UNAVAILABLE', 'not_submitted')
    })
    const provider = new WestDigitalWriteAdapter({ transport })
    const run = (suffix: string) =>
      request(suffix).then((req) =>
        runCommerceFulfillment(
          req,
          {
            operationKey: `commerce-fulfillment:${fixture.order.id}`,
            orderId: Number(fixture.order.id),
            traceId: `${fixturePrefix}-${suffix}`,
          },
          dependencies(provider),
        ),
      )
    await expect(run('timeout-first')).resolves.toMatchObject({ status: 'manual_review' })
    await expect(run('timeout-replay')).resolves.toMatchObject({
      idempotentReplay: true,
      status: 'manual_review',
    })
    expect(transport.writeCount).toBe(1)
    expect(
      (
        await payload.findByID({
          collection: 'domainAssets',
          id: fixture.asset.id,
          overrideAccess: true,
        })
      ).expiresAt,
    ).toBe(originalExpiresAt)
  })
})
