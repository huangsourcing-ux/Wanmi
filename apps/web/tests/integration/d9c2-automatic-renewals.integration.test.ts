import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { mockFailure, mockSuccess } from '@/providers/mock'
import type { SmsProvider, WestDigitalReadProvider } from '@/providers/types'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import {
  FixtureWestDigitalWriteTransport,
  type WestDigitalWriteFixtureHandler,
} from '@/providers/westdigital-write-fixtures'
import { WestDigitalWriteAdapter } from '@/providers/westdigital-write'
import * as stepUpService from '@/services/auth/step-up'
import { runCommerceFulfillment } from '@/services/commerce/fulfillment'
import {
  runAutomaticRenewalForAsset,
  runAutomaticRenewals,
  sortAutomaticRenewalCandidates,
  type AutomaticRenewalDependencies,
} from '@/services/domains/automatic-renewals'
import {
  AUTOMATIC_RENEWAL_RULES_VERSION,
  type AutomaticRenewalRules,
} from '@/services/domains/automatic-renewal-rules'
import { signBoundChangePreview } from '@/services/domains/change-preview'
import {
  changeCustomerRenewalMandate,
  previewCustomerRenewalMandateChange,
  type RenewalMandateRecord,
} from '@/services/domains/renewal-mandates'
import { createWalletAccount, postWalletCredit, readWalletBalance } from '@/services/wallet/ledger'

import { realnameTemplateFixture } from '../fixtures/realname'
import { issueStepUpGrantFixture } from '../fixtures/step-up'

const fixturePrefix = `d9c2-automatic-renewal-${randomUUID()}`
const now = new Date('2027-08-01T12:00:00.000Z')
const expiresAt = '2027-08-08T12:00:00.000Z'
const renewedExpiresAt = '2028-08-08T12:00:00.000Z'
const rules: AutomaticRenewalRules = {
  balanceReminderLimit: 2,
  firstAttemptDays: 7,
  mandateMaxFen: 100_000_000n,
  retryDays: [3, 1],
  version: AUTOMATIC_RENEWAL_RULES_VERSION,
}

let payload: Payload
let previousComRule:
  | {
      enabled: boolean
      fixedAmountMinor?: null | number
      id: number | string
      mode: 'fixed' | 'percentage'
      percentageBasisPoints?: null | number
    }
  | undefined
let createdComRuleId: number | string | undefined
let customerIds: number[] = []

type CustomerFixture = {
  collection: 'customers'
  id: number
  status: 'active'
}

type AssetFixture = {
  customer: number
  domainAscii: string
  expiresAt: string
  id: number
  status: 'active' | 'expired'
}

async function request(suffix: string, user?: CustomerFixture): Promise<PayloadRequest> {
  const req = await createLocalReq(
    {
      req: {
        headers: new Headers({
          'user-agent': `Wanmi-D9C2/${suffix}`,
          'x-forwarded-for': '198.51.100.82',
          'x-request-id': `${fixturePrefix}-${suffix}`,
        }),
      },
    },
    payload,
  )
  if (user) req.user = user as never
  return req
}

async function fixture(
  suffix: string,
  options: {
    balanceFen?: number
    cooldown?: boolean
    expires?: string
    status?: 'active' | 'expired'
  } = {},
) {
  const phone = `+86139${String(customerIds.length + 1).padStart(8, '0')}`
  const customerDocument = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: [],
      identityRiskCooldownStartedAt: options.cooldown ? new Date().toISOString() : undefined,
      phone,
      phoneMasked: `+86139****${phone.slice(-4)}`,
      status: 'active',
    },
    overrideAccess: true,
  })
  const customer: CustomerFixture = {
    collection: 'customers',
    id: Number(customerDocument.id),
    status: 'active',
  }
  customerIds.push(customer.id)
  const template = await payload.create({
    collection: 'realnameTemplates',
    data: {
      ...realnameTemplateFixture({
        displayName: `${fixturePrefix.slice(0, 20)}-${suffix.slice(0, 12)}-${randomUUID().slice(0, 6)}`,
        providerConfirmedAt: '2026-08-18T12:00:00.000Z',
        providerReviewState: 'approved',
        providerTemplateId: '1664777',
        status: 'approved',
      }),
      customer: customer.id,
    },
    overrideAccess: true,
  })
  const assetDocument = await payload.create({
    collection: 'domainAssets',
    data: {
      customer: customer.id,
      domainAscii: `d9c2-${suffix}-${randomUUID().slice(0, 8)}.com`,
      expiresAt: options.expires ?? expiresAt,
      expiryReminderChannels: ['in_app'],
      expiryReminderDays: [30, 7, 1],
      lastSyncedAt: '2027-07-01T12:00:00.000Z',
      nameservers: ['ns1.myhostadmin.net', 'ns2.myhostadmin.net'],
      realnameTemplate: Number(template.id),
      registeredAt: '2026-08-08T12:00:00.000Z',
      registrar: 'west',
      status: options.status ?? 'active',
      syncReviewStatus: 'none',
      syncVersion: 0,
      upstreamOwnershipStatus: 'unknown',
    },
    overrideAccess: true,
  })
  const asset: AssetFixture = {
    customer: customer.id,
    domainAscii: assetDocument.domainAscii,
    expiresAt: assetDocument.expiresAt,
    id: Number(assetDocument.id),
    status: (options.status ?? 'active') as 'active' | 'expired',
  }
  const wallet = await createWalletAccount(await request(`${suffix}-wallet`), customer.id)
  if (options.balanceFen) {
    await postWalletCredit(await request(`${suffix}-credit`), {
      accountId: wallet.accountId,
      amountFen: options.balanceFen,
      transactionKey: `${fixturePrefix}:${suffix}:credit`,
    })
  }
  return { asset, customer, template, walletAccountId: Number(wallet.accountId) }
}

async function seedMandate(
  owner: Awaited<ReturnType<typeof fixture>>,
  options: {
    eventType?: 'authorized' | 'revoked'
    maxDebitFen?: number
    validUntil?: string
  } = {},
): Promise<RenewalMandateRecord> {
  const authorized = await payload.create({
    collection: 'renewalMandates',
    data: {
      asset: owner.asset.id,
      authorizedAt: '2027-01-01T12:00:00.000Z',
      createdTraceId: `${fixturePrefix}-mandate`,
      currency: 'CNY',
      customer: owner.customer.id,
      domainAsciiSnapshot: owner.asset.domainAscii,
      eventType: 'authorized',
      mandateKey: `${fixturePrefix}:${owner.asset.id}:mandate`,
      maxDebitFen: options.maxDebitFen ?? 3_500,
      previewDigest: 'a'.repeat(64),
      revision: 1,
      rulesVersion: rules.version,
      scope: 'renew_one_year',
      stepUpGrantId: `${fixturePrefix}-step-up`,
      validUntil: options.validUntil ?? '2028-08-01T12:00:00.000Z',
    },
    overrideAccess: true,
  })
  if (options.eventType !== 'revoked') return authorized as unknown as RenewalMandateRecord
  const revoked = await payload.create({
    collection: 'renewalMandates',
    data: {
      asset: owner.asset.id,
      authorizedAt: authorized.authorizedAt,
      createdTraceId: `${fixturePrefix}-mandate-revoked`,
      currency: 'CNY',
      customer: owner.customer.id,
      domainAsciiSnapshot: owner.asset.domainAscii,
      eventType: 'revoked',
      mandateKey: authorized.mandateKey,
      maxDebitFen: authorized.maxDebitFen,
      previousMandate: authorized.id,
      previewDigest: 'b'.repeat(64),
      revision: 2,
      revokedAt: '2027-07-01T12:00:00.000Z',
      rulesVersion: rules.version,
      scope: 'renew_one_year',
      stepUpGrantId: `${fixturePrefix}-step-up-revoke`,
      validUntil: authorized.validUntil,
    },
    overrideAccess: true,
  })
  return revoked as unknown as RenewalMandateRecord
}

async function appendAuthorizedMandateRevision(
  owner: Awaited<ReturnType<typeof fixture>>,
  current: RenewalMandateRecord,
  options: { maxDebitFen?: number; rulesVersion?: string } = {},
): Promise<RenewalMandateRecord> {
  return (await payload.create({
    collection: 'renewalMandates',
    data: {
      asset: owner.asset.id,
      authorizedAt: '2027-08-01T12:01:00.000Z',
      createdTraceId: `${fixturePrefix}-replacement-mandate`,
      currency: 'CNY',
      customer: owner.customer.id,
      domainAsciiSnapshot: owner.asset.domainAscii,
      eventType: 'authorized',
      mandateKey: current.mandateKey,
      maxDebitFen: options.maxDebitFen ?? current.maxDebitFen,
      previousMandate: current.id as never,
      previewDigest: 'e'.repeat(64),
      revision: current.revision + 1,
      rulesVersion: options.rulesVersion ?? current.rulesVersion,
      scope: 'renew_one_year',
      stepUpGrantId: `${fixturePrefix}-replacement-step-up`,
      validUntil: current.validUntil,
    },
    overrideAccess: true,
  })) as unknown as RenewalMandateRecord
}

function readProvider(userPriceFen = 3_500) {
  const upstreamFen = userPriceFen - 500
  return new WestDigitalReadAdapter({
    transport: new FixtureWestDigitalTransport((input) => {
      if (input.operation !== 'price') throw new Error(`Unexpected read ${input.operation}`)
      return {
        body: {
          clientid: `${fixturePrefix}-price`,
          data: {
            buyprice: upstreamFen / 100,
            buyyear: '1',
            proid: 'fixture-domain-com',
            renewprice: upstreamFen / 100,
          },
          result: 200,
        },
        status: 200,
      }
    }),
  })
}

function writeProvider(
  asset: AssetFixture,
  options: {
    assetMode?: 'not_owned' | 'owned' | 'wrong_expiry'
    eligibilityStatus?: string
    renewGate?: () => Promise<void>
  } = {},
) {
  let currentExpiresAt = asset.expiresAt
  const handler: WestDigitalWriteFixtureHandler = async (input) => {
    const clientid = `${fixturePrefix}-${input.requestId}`
    if (input.operation === 'asset_query') {
      if (options.assetMode === 'not_owned') {
        return { body: { clientid, result: 404 }, status: 200 }
      }
      return {
        body: {
          clientid,
          data: {
            dns1: 'ns1.myhostadmin.net',
            dns2: 'ns2.myhostadmin.net',
            domain: asset.domainAscii,
            expdate:
              options.assetMode === 'wrong_expiry' ? '2027-08-09T12:00:00.000Z' : currentExpiresAt,
            id: String(asset.id),
            regdate: '2026-08-08T12:00:00.000Z',
            registrars: 'west',
          },
          result: 200,
        },
        status: 200,
      }
    }
    if (input.operation === 'renewal_eligibility_query') {
      return {
        body: {
          clientid,
          data: { domain: asset.domainAscii, status: options.eligibilityStatus ?? 'ok' },
          result: 200,
        },
        status: 200,
      }
    }
    if (input.operation === 'renew') {
      await options.renewGate?.()
      currentExpiresAt = renewedExpiresAt
      return { body: { clientid, result: 200 }, status: 200 }
    }
    throw new Error(`Unexpected write fixture operation ${input.operation}`)
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
          deliveryStatus: 'accepted' as const,
          providerMessageId: `${fixturePrefix}-otp-message`,
        },
        `${fixturePrefix}-otp-send`,
      ),
    ),
    sendStepUpOtp: vi.fn(async () =>
      mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'accepted' as const,
          providerMessageId: `${fixturePrefix}-step-up-message`,
        },
        `${fixturePrefix}-step-up-send`,
      ),
    ),
  }
}

function dependencies(
  asset: AssetFixture,
  options: {
    eligibilityStatus?: string
    now?: Date
    readProvider?: WestDigitalReadProvider
    userPriceFen?: number
    write?: ReturnType<typeof writeProvider>
  } = {},
): AutomaticRenewalDependencies {
  return {
    now: () => options.now ?? now,
    orderNumber: () => `${fixturePrefix}-${asset.id}-${randomUUID()}`,
    readProvider: options.readProvider ?? readProvider(options.userPriceFen),
    rules,
    smsProvider: smsProvider(),
    writeProvider:
      options.write?.provider ??
      writeProvider(asset, { eligibilityStatus: options.eligibilityStatus }).provider,
  }
}

function fulfillmentDependencies(
  owner: Awaited<ReturnType<typeof fixture>>,
  write: ReturnType<typeof writeProvider>,
) {
  return {
    preflight: {
      queryAvailability: vi.fn(async () =>
        mockSuccess(
          {
            available: true,
            currency: 'CNY' as const,
            domainAscii: owner.asset.domainAscii,
            premium: false,
          },
          `${fixturePrefix}-availability`,
        ),
      ),
      queryBalance: vi.fn(async () =>
        mockSuccess({ availableMinor: 1_000_000, frozenMinor: 0 }, `${fixturePrefix}-balance`),
      ),
    },
    write: write.provider,
  }
}

async function count(collection: Parameters<Payload['count']>[0]['collection'], where: unknown) {
  return (
    await payload.count({
      collection,
      overrideAccess: true,
      where: where as never,
    })
  ).totalDocs
}

async function cleanupFixtures(): Promise<void> {
  if (!customerIds.length) return
  const ids = customerIds
  await payload.db.pool.query(
    `DELETE FROM payload_jobs
     WHERE input::text LIKE $1`,
    [`%${fixturePrefix}%`],
  )
  for (const table of [
    'automatic_renewal_events',
    'domain_expiry_reminders',
    'provider_operations',
    'renewals',
    'refunds',
    'order_events',
  ]) {
    const relation = ['provider_operations', 'renewals', 'refunds', 'order_events'].includes(table)
      ? `order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))`
      : `customer_id = ANY($1::int[])`
    await payload.db.pool.query(`DELETE FROM ${table} WHERE ${relation}`, [ids])
  }
  await payload.db.pool.query('DELETE FROM orders WHERE customer_id = ANY($1::int[])', [ids])
  await payload.db.pool.query('DELETE FROM quotes WHERE customer_id = ANY($1::int[])', [ids])
  await payload.db.pool.query(`DELETE FROM price_snapshots WHERE created_trace_id LIKE $1`, [
    `${fixturePrefix}%`,
  ])
  await payload.db.pool.query(
    `DELETE FROM wallet_entries
     WHERE account_id IN (SELECT id FROM wallet_accounts WHERE customer_id = ANY($1::int[]))`,
    [ids],
  )
  await payload.db.pool.query(
    `DELETE FROM wallet_transactions
     WHERE account_id IN (SELECT id FROM wallet_accounts WHERE customer_id = ANY($1::int[]))`,
    [ids],
  )
  await payload.db.pool.query('DELETE FROM wallet_accounts WHERE customer_id = ANY($1::int[])', [
    ids,
  ])
  await payload.db.pool.query('DELETE FROM renewal_mandates WHERE customer_id = ANY($1::int[])', [
    ids,
  ])
  await payload.db.pool.query(
    'DELETE FROM domain_asset_sync_events WHERE customer_id = ANY($1::int[])',
    [ids],
  )
  await payload.db.pool.query('DELETE FROM domain_assets WHERE customer_id = ANY($1::int[])', [ids])
  await payload.db.pool.query('DELETE FROM realname_templates WHERE customer_id = ANY($1::int[])', [
    ids,
  ])
  await payload.db.pool.query('DELETE FROM step_up_grants WHERE customer_id = ANY($1::int[])', [
    ids,
  ])
  await payload.db.pool.query(
    'DELETE FROM customer_security_events WHERE customer_id = ANY($1::int[])',
    [ids],
  )
  await payload.db.pool.query(
    `DELETE FROM audit_logs
     WHERE actor_id = ANY($1::text[])
        OR metadata::text LIKE $2`,
    [ids.map(String), `%${fixturePrefix}%`],
  )
  await payload.db.pool.query('DELETE FROM customers WHERE id = ANY($1::int[])', [ids])
  customerIds = []
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const existing = await payload.find({
    collection: 'priceRules',
    limit: 1,
    overrideAccess: true,
    where: { tld: { equals: 'com' } },
  })
  const document = existing.docs[0]
  if (document) {
    previousComRule = {
      enabled: document.enabled,
      fixedAmountMinor: document.fixedAmountMinor,
      id: document.id,
      mode: document.mode,
      percentageBasisPoints: document.percentageBasisPoints,
    }
    await payload.update({
      collection: 'priceRules',
      context: { skipPriceRuleAudit: true },
      data: {
        enabled: true,
        fixedAmountMinor: 500,
        mode: 'fixed',
        percentageBasisPoints: null,
      },
      id: document.id,
      overrideAccess: true,
    })
  } else {
    const created = await payload.create({
      collection: 'priceRules',
      context: { skipPriceRuleAudit: true },
      data: {
        effectiveAt: new Date().toISOString(),
        enabled: true,
        fixedAmountMinor: 500,
        mode: 'fixed',
        tld: 'com',
      },
      draft: false,
      overrideAccess: true,
    })
    createdComRuleId = created.id
  }
})

afterEach(async () => {
  await cleanupFixtures()
})

afterAll(async () => {
  await cleanupFixtures()
  if (previousComRule) {
    await payload.update({
      collection: 'priceRules',
      context: { skipPriceRuleAudit: true },
      data: {
        enabled: previousComRule.enabled,
        fixedAmountMinor: previousComRule.fixedAmountMinor,
        mode: previousComRule.mode,
        percentageBasisPoints: previousComRule.percentageBasisPoints,
      },
      id: previousComRule.id,
      overrideAccess: true,
    })
  } else if (createdComRuleId !== undefined) {
    await payload.delete({
      collection: 'priceRules',
      context: { skipPriceRuleAudit: true },
      id: createdComRuleId,
      overrideAccess: true,
    })
  }
  await payload.db.destroy?.()
})

describe('D9-C-2 renewal mandate authorization', () => {
  it('rejects empty, zero, negative, infinite, and deployment-unbounded debit limits', async () => {
    const owner = await fixture('invalid-max')
    const req = await request('invalid-max', owner.customer)
    const base = {
      action: 'authorize' as const,
      scope: 'renew_one_year' as const,
      validUntil: '2028-08-01T12:00:00.000Z',
    }
    for (const maxDebitFen of [undefined, 0, -1, Number.POSITIVE_INFINITY, 100_000_001]) {
      await expect(
        previewCustomerRenewalMandateChange(
          req,
          owner.asset.id,
          { ...base, ...(maxDebitFen === undefined ? {} : { maxDebitFen }) } as never,
          { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-invalid-max` },
        ),
      ).rejects.toBeDefined()
    }
    await expect(
      count('renewalMandates', {
        and: [{ asset: { equals: owner.asset.id } }, { customer: { equals: owner.customer.id } }],
      }),
    ).resolves.toBe(0)
  })

  it('rejects expired or overlong validity, inactive enablement, and revoke without an active mandate', async () => {
    const owner = await fixture('invalid-validity')
    const req = await request('invalid-validity', owner.customer)
    for (const validUntil of ['2027-08-01T12:00:00.000Z', '2037-08-02T12:00:00.000Z']) {
      await expect(
        previewCustomerRenewalMandateChange(
          req,
          owner.asset.id,
          {
            action: 'authorize',
            maxDebitFen: 3_500,
            scope: 'renew_one_year',
            validUntil,
          },
          { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-validity` },
        ),
      ).rejects.toBeDefined()
    }
    await expect(
      previewCustomerRenewalMandateChange(
        req,
        owner.asset.id,
        { action: 'revoke' },
        { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-revoke-missing` },
      ),
    ).rejects.toMatchObject({ code: 'RENEWAL_MANDATE_NOT_ACTIVE' })
    await seedMandate(owner, { eventType: 'revoked' })
    await expect(
      previewCustomerRenewalMandateChange(
        req,
        owner.asset.id,
        { action: 'revoke' },
        { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-revoke-again` },
      ),
    ).rejects.toMatchObject({ code: 'RENEWAL_MANDATE_NOT_ACTIVE' })
    await payload.update({
      collection: 'domainAssets',
      data: { status: 'expired' },
      id: owner.asset.id,
      overrideAccess: true,
    })
    await expect(
      previewCustomerRenewalMandateChange(
        req,
        owner.asset.id,
        {
          action: 'authorize',
          maxDebitFen: 3_500,
          scope: 'renew_one_year',
          validUntil: '2028-08-01T12:00:00.000Z',
        },
        { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-inactive` },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_RENEWABLE' })
  })

  it('binds preview to customer, asset, action, rules and expiry before consuming step-up', async () => {
    const owner = await fixture('preview-binding')
    const other = await fixture('preview-binding-other')
    await payload.update({
      collection: 'domainAssets',
      data: { customer: owner.customer.id },
      id: other.asset.id,
      overrideAccess: true,
    })
    const req = await request('preview-binding', owner.customer)
    const preview = await previewCustomerRenewalMandateChange(
      req,
      owner.asset.id,
      {
        action: 'authorize',
        maxDebitFen: 3_500,
        scope: 'renew_one_year',
        validUntil: '2028-08-01T12:00:00.000Z',
      },
      { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-binding-preview` },
    )
    if (preview.state !== 'ready') throw new Error('Expected bound preview')
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      owner.customer.id,
      'renewal_mandate_change',
    )
    const mismatchedCustomerToken = signBoundChangePreview({
      action: 'authorize',
      assetId: String(owner.asset.id),
      customerId: String(other.customer.id),
      domainAscii: owner.asset.domainAscii,
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      maxDebitFen: 3_500,
      nonce: randomUUID(),
      rulesVersion: rules.version,
      scope: 'renew_one_year',
      validUntil: '2028-08-01T12:00:00.000Z',
    })
    const mismatchedAssetToken = signBoundChangePreview({
      action: 'authorize',
      assetId: String(owner.asset.id),
      customerId: String(owner.customer.id),
      domainAscii: other.asset.domainAscii,
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      maxDebitFen: 3_500,
      nonce: randomUUID(),
      rulesVersion: rules.version,
      scope: 'renew_one_year',
      validUntil: '2028-08-01T12:00:00.000Z',
    })
    const staleRulesToken = signBoundChangePreview({
      action: 'authorize',
      assetId: String(owner.asset.id),
      customerId: String(owner.customer.id),
      domainAscii: owner.asset.domainAscii,
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      maxDebitFen: 3_500,
      nonce: randomUUID(),
      rulesVersion: 'stale-rules',
      scope: 'renew_one_year',
      validUntil: '2028-08-01T12:00:00.000Z',
    })
    for (const [assetId, expectedAction, observedAt, previewToken] of [
      [owner.asset.id, 'revoke', now, preview.data.previewToken],
      [other.asset.id, 'authorize', now, mismatchedAssetToken],
      [
        owner.asset.id,
        'authorize',
        new Date(now.getTime() + 6 * 60_000),
        preview.data.previewToken,
      ],
      [owner.asset.id, 'authorize', now, mismatchedCustomerToken],
      [owner.asset.id, 'authorize', now, staleRulesToken],
    ] as const) {
      await expect(
        changeCustomerRenewalMandate(
          req,
          assetId,
          {
            confirmed: true,
            deviceId: grant.deviceId,
            previewToken,
            stepUpToken: grant.stepUpToken,
          },
          {
            customer: owner.customer,
            expectedAction,
            now: () => observedAt,
            traceId: `${fixturePrefix}-binding-change`,
          },
        ),
      ).rejects.toMatchObject({ code: 'RENEWAL_MANDATE_PREVIEW_INVALID' })
    }
    await expect(
      count('stepUpGrants', {
        and: [
          { customer: { equals: owner.customer.id } },
          { purpose: { equals: 'renewal_mandate_change' } },
          { consumedAt: { exists: true } },
        ],
      }),
    ).resolves.toBe(0)
  })

  it('rechecks the asset snapshot under lock after step-up and refuses changed domain data', async () => {
    const owner = await fixture('snapshot-race')
    const req = await request('snapshot-race', owner.customer)
    const preview = await previewCustomerRenewalMandateChange(
      req,
      owner.asset.id,
      {
        action: 'authorize',
        maxDebitFen: 3_500,
        scope: 'renew_one_year',
        validUntil: '2028-08-01T12:00:00.000Z',
      },
      { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-snapshot-preview` },
    )
    if (preview.state !== 'ready') throw new Error('Expected snapshot preview')
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      owner.customer.id,
      'renewal_mandate_change',
    )
    await payload.db.pool.query('UPDATE domain_assets SET domain_ascii = $1 WHERE id = $2', [
      `changed-${randomUUID().slice(0, 8)}.com`,
      owner.asset.id,
    ])
    await expect(
      changeCustomerRenewalMandate(
        req,
        owner.asset.id,
        {
          confirmed: true,
          deviceId: grant.deviceId,
          previewToken: preview.data.previewToken,
          stepUpToken: grant.stepUpToken,
        },
        {
          customer: owner.customer,
          expectedAction: 'authorize',
          now: () => now,
          traceId: `${fixturePrefix}-snapshot-change`,
        },
      ),
    ).rejects.toMatchObject({ code: 'RENEWAL_MANDATE_PREVIEW_INVALID' })
    await expect(
      count('renewalMandates', {
        and: [{ asset: { equals: owner.asset.id } }, { customer: { equals: owner.customer.id } }],
      }),
    ).resolves.toBe(0)
  })

  it('revalidates signed maximum and validity facts at the change callpoint', async () => {
    const owner = await fixture('signed-facts')
    const req = await request('signed-facts', owner.customer)
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      owner.customer.id,
      'renewal_mandate_change',
    )
    for (const [maxDebitFen, validUntil] of [
      [100_000_001, '2028-08-01T12:00:00.000Z'],
      [3_500, '2027-08-01T12:00:00.000Z'],
      [3_500, '2037-08-02T12:00:00.000Z'],
    ] as const) {
      const previewToken = signBoundChangePreview({
        action: 'authorize',
        assetId: String(owner.asset.id),
        customerId: String(owner.customer.id),
        domainAscii: owner.asset.domainAscii,
        expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        maxDebitFen,
        nonce: randomUUID(),
        rulesVersion: rules.version,
        scope: 'renew_one_year',
        validUntil,
      })
      await expect(
        changeCustomerRenewalMandate(
          req,
          owner.asset.id,
          {
            confirmed: true,
            deviceId: grant.deviceId,
            previewToken,
            stepUpToken: grant.stepUpToken,
          },
          {
            customer: owner.customer,
            expectedAction: 'authorize',
            now: () => now,
            traceId: `${fixturePrefix}-signed-facts`,
          },
        ),
      ).rejects.toMatchObject({ code: 'RENEWAL_MANDATE_PREVIEW_INVALID' })
    }
    await expect(
      count('renewalMandates', {
        and: [{ asset: { equals: owner.asset.id } }, { customer: { equals: owner.customer.id } }],
      }),
    ).resolves.toBe(0)
  })

  it('rechecks active asset status under lock after the preview', async () => {
    const owner = await fixture('status-race')
    const req = await request('status-race', owner.customer)
    const preview = await previewCustomerRenewalMandateChange(
      req,
      owner.asset.id,
      {
        action: 'authorize',
        maxDebitFen: 3_500,
        scope: 'renew_one_year',
        validUntil: '2028-08-01T12:00:00.000Z',
      },
      { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-status-preview` },
    )
    if (preview.state !== 'ready') throw new Error('Expected status preview')
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      owner.customer.id,
      'renewal_mandate_change',
    )
    await payload.db.pool.query("UPDATE domain_assets SET status = 'expired' WHERE id = $1", [
      owner.asset.id,
    ])
    await expect(
      changeCustomerRenewalMandate(
        req,
        owner.asset.id,
        {
          confirmed: true,
          deviceId: grant.deviceId,
          previewToken: preview.data.previewToken,
          stepUpToken: grant.stepUpToken,
        },
        {
          customer: owner.customer,
          expectedAction: 'authorize',
          now: () => now,
          traceId: `${fixturePrefix}-status-change`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_RENEWABLE' })
  })

  it('locks the requested asset only while it still belongs to the authorizing customer', async () => {
    const owner = await fixture('owner-race')
    const other = await fixture('owner-race-other')
    const req = await request('owner-race', owner.customer)
    const preview = await previewCustomerRenewalMandateChange(
      req,
      owner.asset.id,
      {
        action: 'authorize',
        maxDebitFen: 3_500,
        scope: 'renew_one_year',
        validUntil: '2028-08-01T12:00:00.000Z',
      },
      { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-owner-preview` },
    )
    if (preview.state !== 'ready') throw new Error('Expected owner preview')
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      owner.customer.id,
      'renewal_mandate_change',
    )
    await payload.db.pool.query('UPDATE domain_assets SET customer_id = $2 WHERE id = $1', [
      owner.asset.id,
      other.customer.id,
    ])
    await expect(
      changeCustomerRenewalMandate(
        req,
        owner.asset.id,
        {
          confirmed: true,
          deviceId: grant.deviceId,
          previewToken: preview.data.previewToken,
          stepUpToken: grant.stepUpToken,
        },
        {
          customer: owner.customer,
          expectedAction: 'authorize',
          now: () => now,
          traceId: `${fixturePrefix}-owner-change`,
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND' })
  })

  it('requires the authenticated owner and the shared domain-write capability', async () => {
    const owner = await fixture('mandate-access')
    const other = await fixture('mandate-access-other')
    await expect(
      previewCustomerRenewalMandateChange(
        await request('mandate-access-other', other.customer),
        owner.asset.id,
        {
          action: 'authorize',
          maxDebitFen: 3_500,
          scope: 'renew_one_year',
          validUntil: '2028-08-01T12:00:00.000Z',
        },
        { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-wrong-owner` },
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
    await expect(
      previewCustomerRenewalMandateChange(
        await request('mandate-access-owned', owner.customer),
        other.asset.id,
        {
          action: 'authorize',
          maxDebitFen: 3_500,
          scope: 'renew_one_year',
          validUntil: '2028-08-01T12:00:00.000Z',
        },
        { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-other-asset` },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND' })
    const ownerReq = await request('mandate-access-change', owner.customer)
    const changePreview = await previewCustomerRenewalMandateChange(
      ownerReq,
      owner.asset.id,
      {
        action: 'authorize',
        maxDebitFen: 3_500,
        scope: 'renew_one_year',
        validUntil: '2028-08-01T12:00:00.000Z',
      },
      { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-change-preview` },
    )
    if (changePreview.state !== 'ready') throw new Error('Expected access change preview')
    const grant = await issueStepUpGrantFixture(
      payload,
      ownerReq,
      owner.customer.id,
      'renewal_mandate_change',
    )
    const changeInput = {
      confirmed: true as const,
      deviceId: grant.deviceId,
      previewToken: changePreview.data.previewToken,
      stepUpToken: grant.stepUpToken,
    }
    await expect(
      changeCustomerRenewalMandate(
        await request('mandate-access-change-other', other.customer),
        owner.asset.id,
        changeInput,
        {
          customer: owner.customer,
          expectedAction: 'authorize',
          now: () => now,
          traceId: `${fixturePrefix}-change-wrong-principal`,
        },
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_AUTH_REQUIRED' })
    await payload.db.pool.query(
      `UPDATE customers
       SET status = 'restricted', capability_restrictions = '["domain_write_disabled"]'::jsonb
       WHERE id = $1`,
      [owner.customer.id],
    )
    await expect(
      changeCustomerRenewalMandate(ownerReq, owner.asset.id, changeInput, {
        customer: owner.customer,
        expectedAction: 'authorize',
        now: () => now,
        traceId: `${fixturePrefix}-change-restricted`,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DOMAIN_WRITE_DISABLED' })
    await expect(
      previewCustomerRenewalMandateChange(
        await request('mandate-access-restricted', owner.customer),
        owner.asset.id,
        {
          action: 'authorize',
          maxDebitFen: 3_500,
          scope: 'renew_one_year',
          validUntil: '2028-08-01T12:00:00.000Z',
        },
        { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-restricted` },
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DOMAIN_WRITE_DISABLED' })
  })

  it('requires bound second confirmation and one-time step-up, records the authorization, and sends the enable reminder', async () => {
    const owner = await fixture('authorize')
    const req = await request('authorize', owner.customer)
    const preview = await previewCustomerRenewalMandateChange(
      req,
      owner.asset.id,
      {
        action: 'authorize',
        maxDebitFen: 4_321,
        scope: 'renew_one_year',
        validUntil: '2028-08-01T12:00:00.000Z',
      },
      { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-preview` },
    )
    const grant = await issueStepUpGrantFixture(
      payload,
      req,
      owner.customer.id,
      'renewal_mandate_change',
    )
    if (preview.state !== 'ready') throw new Error('Expected renewal mandate preview')
    await expect(
      changeCustomerRenewalMandate(
        req,
        owner.asset.id,
        {
          confirmed: false,
          deviceId: grant.deviceId,
          previewToken: preview.data.previewToken,
          stepUpToken: grant.stepUpToken,
        } as never,
        {
          customer: owner.customer,
          expectedAction: 'authorize',
          now: () => now,
          traceId: `${fixturePrefix}-unconfirmed`,
        },
      ),
    ).rejects.toBeDefined()
    const changePromise = changeCustomerRenewalMandate(
      req,
      owner.asset.id,
      {
        confirmed: true,
        deviceId: grant.deviceId,
        previewToken: preview.data.previewToken,
        stepUpToken: grant.stepUpToken,
      },
      {
        customer: owner.customer,
        expectedAction: 'authorize',
        now: () => now,
        traceId: `${fixturePrefix}-authorize`,
      },
    )
    await expect(changePromise).resolves.toMatchObject({ state: 'ready' })
    const changed = await changePromise
    if (changed.state !== 'ready' || !changed.data.mandate) {
      throw new Error('Expected renewal mandate change')
    }
    expect(changed.data.mandate).toMatchObject({
      eventType: 'authorized',
      maxDebitFen: 4_321,
      rulesVersion: rules.version,
      scope: 'renew_one_year',
      validUntil: '2028-08-01T12:00:00.000Z',
    })
    await expect(
      count('renewalMandates', {
        and: [
          { asset: { equals: owner.asset.id } },
          { customer: { equals: owner.customer.id } },
          { eventType: { equals: 'authorized' } },
          { maxDebitFen: { equals: 4_321 } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('auditLogs', {
        and: [
          { action: { equals: 'domain.renewal_mandate.authorized' } },
          { actorId: { equals: String(owner.customer.id) } },
          { targetId: { equals: changed.data.mandate.id } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('domainExpiryReminders', {
        and: [
          { asset: { equals: owner.asset.id } },
          { customer: { equals: owner.customer.id } },
          { noticeType: { equals: 'automatic_renewal_enabled' } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('stepUpGrants', {
        and: [
          { customer: { equals: owner.customer.id } },
          { purpose: { equals: 'renewal_mandate_change' } },
          { consumedAt: { exists: true } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('makes mandate and execution facts append-only even with system access', async () => {
    const owner = await fixture('append-only')
    const mandate = await seedMandate(owner)
    await expect(
      payload.update({
        collection: 'renewalMandates',
        data: { maxDebitFen: 99_999 },
        id: mandate.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'RENEWAL_MANDATE_APPEND_ONLY' })
    await expect(
      payload.delete({ collection: 'renewalMandates', id: mandate.id, overrideAccess: true }),
    ).rejects.toMatchObject({ code: 'RENEWAL_MANDATE_APPEND_ONLY' })

    await runAutomaticRenewalForAsset(
      await request('append-only-execution'),
      owner.asset.id,
      dependencies(owner.asset),
    )
    const events = await payload.find({
      collection: 'automaticRenewalEvents',
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { asset: { equals: owner.asset.id } },
          { eventType: { equals: 'balance_insufficient' } },
        ],
      },
    })
    expect(events.totalDocs).toBe(1)
    await expect(
      payload.update({
        collection: 'automaticRenewalEvents',
        data: { reasonCode: 'tampered' },
        id: events.docs[0]!.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATIC_RENEWAL_EVENT_APPEND_ONLY' })
    await expect(
      payload.delete({
        collection: 'automaticRenewalEvents',
        id: events.docs[0]!.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATIC_RENEWAL_EVENT_APPEND_ONLY' })
  })

  it('isolates mandate and execution facts to their owning customer', async () => {
    const owner = await fixture('fact-access-owner')
    const intruder = await fixture('fact-access-intruder')
    await seedMandate(owner)
    await runAutomaticRenewalForAsset(
      await request('fact-access-execution'),
      owner.asset.id,
      dependencies(owner.asset),
    )

    for (const collection of ['renewalMandates', 'automaticRenewalEvents'] as const) {
      const ownerView = await payload.find({
        collection,
        limit: 20,
        overrideAccess: false,
        user: owner.customer as never,
        where: { asset: { equals: owner.asset.id } },
      })
      const intruderView = await payload.find({
        collection,
        limit: 20,
        overrideAccess: false,
        user: intruder.customer as never,
        where: { asset: { equals: owner.asset.id } },
      })
      expect(ownerView.totalDocs).toBeGreaterThan(0)
      expect(intruderView.totalDocs).toBe(0)
    }
  })

  it('serializes concurrent mandate authorizations into unique immutable revisions', async () => {
    const owner = await fixture('mandate-concurrency')
    const build = async (suffix: string, maxDebitFen: number) => {
      const req = await request(`mandate-concurrency-${suffix}`, owner.customer)
      const preview = await previewCustomerRenewalMandateChange(
        req,
        owner.asset.id,
        {
          action: 'authorize',
          maxDebitFen,
          scope: 'renew_one_year',
          validUntil: '2028-08-01T12:00:00.000Z',
        },
        { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-${suffix}-preview` },
      )
      if (preview.state !== 'ready') throw new Error('Expected concurrent mandate preview')
      const grant = await issueStepUpGrantFixture(
        payload,
        req,
        owner.customer.id,
        'renewal_mandate_change',
      )
      return { grant, preview, req, suffix }
    }
    const first = await build('first', 4_000)
    const second = await build('second', 5_000)
    const changes = Promise.all(
      [first, second].map(({ grant, preview, req, suffix }) =>
        changeCustomerRenewalMandate(
          req,
          owner.asset.id,
          {
            confirmed: true,
            deviceId: grant.deviceId,
            previewToken: preview.data.previewToken,
            stepUpToken: grant.stepUpToken,
          },
          {
            customer: owner.customer,
            expectedAction: 'authorize',
            now: () => now,
            traceId: `${fixturePrefix}-${suffix}-change`,
          },
        ),
      ),
    )
    await expect(changes).resolves.toHaveLength(2)
    const results = await changes
    expect(results.every(({ state }) => state === 'ready')).toBe(true)
    const mandates = await payload.find({
      collection: 'renewalMandates',
      limit: 10,
      overrideAccess: true,
      sort: 'revision',
      where: {
        and: [
          { asset: { equals: owner.asset.id } },
          { customer: { equals: owner.customer.id } },
          { eventType: { equals: 'authorized' } },
        ],
      },
    })
    expect(mandates.docs.map(({ revision }) => revision)).toEqual([1, 2])
    expect(mandates.docs.map(({ maxDebitFen }) => maxDebitFen).sort()).toEqual([4_000, 5_000])
  })
})

describe('D9-C-2 unattended automatic renewal decisions', () => {
  it.each([
    ['missing mandate', 'missing'],
    ['revoked mandate', 'revoked'],
    ['expired mandate', 'expired'],
  ] as const)('%s independently skips without any debit', async (_label, mode) => {
    const owner = await fixture(`invalid-${mode}`, { balanceFen: 10_000 })
    if (mode === 'revoked') {
      const revoked = await seedMandate(owner, { eventType: 'revoked' })
      await payload.db.pool.query('UPDATE renewal_mandates SET revoked_at = NULL WHERE id = $1', [
        revoked.id,
      ])
    }
    if (mode === 'expired') {
      await seedMandate(owner, { validUntil: '2027-07-31T12:00:00.000Z' })
    }
    await expect(
      runAutomaticRenewalForAsset(
        await request(`invalid-${mode}`),
        owner.asset.id,
        dependencies(owner.asset),
      ),
    ).resolves.toMatchObject({ status: 'skipped' })
    expect(
      await readWalletBalance(await request(`invalid-${mode}-balance`), owner.walletAccountId),
    ).toMatchObject({ availableBalance: 10_000n, heldBalance: 0n, postedBalance: 10_000n })
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
    if (mode === 'missing') {
      const audits = await payload.find({
        collection: 'auditLogs',
        limit: 2,
        overrideAccess: true,
        where: {
          and: [
            { action: { equals: 'domain.automatic_renewal.skipped' } },
            { targetId: { equals: String(owner.asset.id) } },
          ],
        },
      })
      expect(audits.totalDocs).toBe(1)
      expect(audits.docs[0]?.metadata).toMatchObject({ reasonCode: 'RENEWAL_MANDATE_REQUIRED' })
    }
  })

  it('uses the mandate maximum as the price source: over-limit skips and equality is allowed', async () => {
    const over = await fixture('price-over', { balanceFen: 10_000 })
    await seedMandate(over, { maxDebitFen: 3_499 })
    const rejected = await runAutomaticRenewalForAsset(
      await request('price-over'),
      over.asset.id,
      dependencies(over.asset, { userPriceFen: 3_500 }),
    )
    expect(rejected.status).toBe('price_changed')
    const replayed = await runAutomaticRenewalForAsset(
      await request('price-over-replay'),
      over.asset.id,
      dependencies(over.asset, { userPriceFen: 3_500 }),
    )
    expect(replayed.status).toBe('price_changed')
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: over.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
    await expect(
      count('domainExpiryReminders', {
        and: [
          { asset: { equals: over.asset.id } },
          { noticeType: { equals: 'automatic_renewal_price_changed' } },
          { amountFen: { equals: 3_500 } },
          { authorizedMaxAmountFen: { equals: 3_499 } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('automaticRenewalEvents', {
        and: [
          { asset: { equals: over.asset.id } },
          { eventType: { equals: 'price_changed' } },
          { amountFen: { equals: 3_500 } },
          { authorizedMaxAmountFen: { equals: 3_499 } },
        ],
      }),
    ).resolves.toBe(1)

    const equal = await fixture('price-equal', { balanceFen: 3_500 })
    await seedMandate(equal, { maxDebitFen: 3_500 })
    const accepted = await runAutomaticRenewalForAsset(
      await request('price-equal'),
      equal.asset.id,
      dependencies(equal.asset, { userPriceFen: 3_500 }),
    )
    expect(accepted.status).toBe('queued')
    await expect(
      count('walletEntries', {
        and: [
          { account: { equals: equal.walletAccountId } },
          { entryType: { equals: 'hold' } },
          { amountFen: { equals: 3_500 } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('rechecks the latest mandate revision immediately before placing the wallet hold', async () => {
    const owner = await fixture('mandate-replaced-before-hold', { balanceFen: 3_500 })
    const mandate = await seedMandate(owner)
    const priceProvider = readProvider()
    const originalQueryPrice = priceProvider.queryPrice.bind(priceProvider)
    let replaced = false
    vi.spyOn(priceProvider, 'queryPrice').mockImplementation(async (input) => {
      const result = await originalQueryPrice(input)
      if (!replaced) {
        replaced = true
        await appendAuthorizedMandateRevision(owner, mandate)
      }
      return result
    })
    const outcome = await runAutomaticRenewalForAsset(
      await request('mandate-replaced-before-hold'),
      owner.asset.id,
      dependencies(owner.asset, { readProvider: priceProvider }),
    )
    expect(outcome.status).toBe('skipped')
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
  })

  it.each([
    [
      'authorized event carrying an independent revokedAt fact',
      `UPDATE renewal_mandates SET revoked_at = '2027-07-01T12:00:00.000Z' WHERE id = $1`,
      'RENEWAL_MANDATE_REVOKED',
    ],
    [
      'rules version changed independently from the mandate existence',
      `UPDATE renewal_mandates SET rules_version = 'old-rules-version' WHERE id = $1`,
      'RENEWAL_MANDATE_RULES_CHANGED',
    ],
    [
      'domain snapshot changed independently from the live asset',
      `UPDATE renewal_mandates SET domain_ascii_snapshot = 'different.example' WHERE id = $1`,
      'AUTOMATIC_RENEWAL_ASSET_INVALID',
    ],
    [
      'zero maximum persisted independently from current market price',
      `UPDATE renewal_mandates SET max_debit_fen = 0 WHERE id = $1`,
      'RENEWAL_MANDATE_MAX_DEBIT_INVALID',
    ],
    [
      'fractional maximum persisted independently from current market price',
      `UPDATE renewal_mandates SET max_debit_fen = 1.5 WHERE id = $1`,
      'RENEWAL_MANDATE_MAX_DEBIT_INVALID',
    ],
    [
      'deployment-unbounded maximum persisted independently from current market price',
      `UPDATE renewal_mandates SET max_debit_fen = 100000001 WHERE id = $1`,
      'RENEWAL_MANDATE_MAX_DEBIT_INVALID',
    ],
  ])('%s is read from the mandate fact and blocks debit', async (_label, mutation, reasonCode) => {
    const owner = await fixture(`source-${reasonCode.slice(-12).toLowerCase()}`, {
      balanceFen: 10_000,
    })
    const mandate = await seedMandate(owner)
    await payload.db.pool.query(mutation, [mandate.id])
    const outcome = await runAutomaticRenewalForAsset(
      await request(`source-${reasonCode}`),
      owner.asset.id,
      dependencies(owner.asset),
    )
    expect(outcome.status).toBe('skipped')
    await expect(
      count('automaticRenewalEvents', {
        and: [{ asset: { equals: owner.asset.id } }, { reasonCode: { equals: reasonCode } }],
      }),
    ).resolves.toBe(1)
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
  })

  it('does not infer mandate ownership from the asset when the mandate customer fact differs', async () => {
    const owner = await fixture('source-mandate-customer', { balanceFen: 10_000 })
    const other = await fixture('source-mandate-customer-other')
    const mandate = await seedMandate(owner)
    await payload.db.pool.query('UPDATE renewal_mandates SET customer_id = $2 WHERE id = $1', [
      mandate.id,
      other.customer.id,
    ])
    const outcome = await runAutomaticRenewalForAsset(
      await request('source-mandate-customer'),
      owner.asset.id,
      dependencies(owner.asset),
    )
    expect(outcome.status).toBe('skipped')
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
  })

  it.each([
    ['domain transferred out of the provider account', 'not_owned' as const],
    ['provider expiry fact differs from the local asset', 'wrong_expiry' as const],
  ])('%s blocks debit through the shared ownership path', async (_label, assetMode) => {
    const owner = await fixture(`ownership-${assetMode}`, { balanceFen: 10_000 })
    await seedMandate(owner)
    const write = writeProvider(owner.asset, { assetMode })
    vi.spyOn(write.provider, 'queryAsset').mockResolvedValue(
      assetMode === 'not_owned'
        ? mockFailure('WESTDIGITAL_ASSET_NOT_IN_ACCOUNT')
        : mockSuccess(
            {
              domainAscii: owner.asset.domainAscii,
              expiresAt: '2027-08-09T12:00:00.000Z',
              nameservers: ['ns1.myhostadmin.net', 'ns2.myhostadmin.net'],
              providerAssetId: String(owner.asset.id),
              registeredAt: '2026-08-08T12:00:00.000Z',
              registrarCode: 'west',
              status: 'active' as const,
            },
            `${fixturePrefix}-ownership-${assetMode}`,
          ),
    )
    const outcome = await runAutomaticRenewalForAsset(
      await request(`ownership-${assetMode}`),
      owner.asset.id,
      dependencies(owner.asset, { write }),
    )
    expect(outcome.status).toBe('skipped')
    expect(write.transport.requests.filter(({ operation }) => operation === 'renew')).toHaveLength(
      0,
    )
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
    const skipEvents = await payload.find({
      collection: 'automaticRenewalEvents',
      limit: 2,
      overrideAccess: true,
      where: { asset: { equals: owner.asset.id } },
    })
    expect(skipEvents.totalDocs).toBe(1)
    expect(skipEvents.docs[0]).toMatchObject({
      reasonCode:
        assetMode === 'not_owned'
          ? 'DOMAIN_UPSTREAM_ASSET_NOT_OWNED'
          : 'AUTOMATIC_RENEWAL_UPSTREAM_ASSET_CHANGED',
    })
  })

  it.each([
    ['provider result failure', 'failure'],
    ['mismatched response domain', 'domain'],
    ['registry-restricted response state', 'state'],
  ] as const)('%s independently fails closed before debit', async (_label, mode) => {
    const owner = await fixture(`eligibility-source-${mode}`, { balanceFen: 10_000 })
    await seedMandate(owner)
    const write = writeProvider(owner.asset)
    vi.spyOn(write.provider, 'queryRenewalEligibility').mockResolvedValue(
      mode === 'failure'
        ? mockFailure('FIXTURE_ELIGIBILITY_UNAVAILABLE')
        : mockSuccess(
            {
              domainAscii: mode === 'domain' ? 'different.example' : owner.asset.domainAscii,
              state: mode === 'state' ? ('registry_restricted' as const) : ('eligible' as const),
              statusCodes: mode === 'state' ? ['serverRenewProhibited'] : ['ok'],
            },
            `${fixturePrefix}-eligibility-${mode}`,
          ),
    )
    const outcome = await runAutomaticRenewalForAsset(
      await request(`eligibility-source-${mode}`),
      owner.asset.id,
      dependencies(owner.asset, { write }),
    )
    expect(outcome.status).toBe('skipped')
    await expect(
      count('automaticRenewalEvents', {
        and: [
          { asset: { equals: owner.asset.id } },
          { reasonCode: { equals: 'AUTOMATIC_RENEWAL_DOMAIN_STATUS_BLOCKED' } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
  })

  it('insufficient balance never partially debits or overdrafts and emits a capped reminder', async () => {
    const owner = await fixture('insufficient', { balanceFen: 3_499 })
    await seedMandate(owner)
    for (const attemptNow of [
      now,
      new Date('2027-08-05T12:00:00.000Z'),
      new Date('2027-08-07T12:00:00.000Z'),
    ]) {
      const outcome = await runAutomaticRenewalForAsset(
        await request(`insufficient-${attemptNow.toISOString()}`),
        owner.asset.id,
        dependencies(owner.asset, { now: attemptNow }),
      )
      expect(outcome.status).toBe('balance_insufficient')
    }
    const balance = await readWalletBalance(
      await request('insufficient-balance'),
      owner.walletAccountId,
    )
    expect(balance).toEqual({ availableBalance: 3_499n, heldBalance: 0n, postedBalance: 3_499n })
    expect(balance.availableBalance).toBeGreaterThanOrEqual(0n)
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
    await expect(
      count('domainExpiryReminders', {
        and: [
          { asset: { equals: owner.asset.id } },
          { noticeType: { equals: 'automatic_renewal_balance_insufficient' } },
        ],
      }),
    ).resolves.toBe(2)
  })

  it('atomically claims one same-slot insufficient attempt under concurrent triggers', async () => {
    const owner = await fixture('insufficient-concurrent')
    await seedMandate(owner)
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        runAutomaticRenewalForAsset(
          await request(`insufficient-concurrent-${index}`),
          owner.asset.id,
          dependencies(owner.asset),
        ),
      ),
    )
    expect(outcomes.filter(({ status }) => status === 'balance_insufficient')).toHaveLength(1)
    expect(outcomes.filter(({ status }) => status === 'duplicate')).toHaveLength(4)
    await expect(
      count('automaticRenewalEvents', {
        and: [{ asset: { equals: owner.asset.id } }, { eventType: { equals: 'attempt_claimed' } }],
      }),
    ).resolves.toBe(1)
    await expect(
      count('automaticRenewalEvents', {
        and: [
          { asset: { equals: owner.asset.id } },
          { eventType: { equals: 'balance_insufficient' } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('does not create a second hold at a later retry slot while the cycle order is unfinished', async () => {
    const owner = await fixture('unfinished-cycle', { balanceFen: 7_000 })
    await seedMandate(owner)
    const first = await runAutomaticRenewalForAsset(
      await request('unfinished-cycle-first'),
      owner.asset.id,
      dependencies(owner.asset, { now }),
    )
    const retry = await runAutomaticRenewalForAsset(
      await request('unfinished-cycle-retry'),
      owner.asset.id,
      dependencies(owner.asset, { now: new Date('2027-08-05T12:00:00.000Z') }),
    )
    expect(first.status).toBe('queued')
    expect(retry.status).toBe('duplicate')
    await expect(
      count('orders', {
        and: [
          { customer: { equals: owner.customer.id } },
          { automaticRenewalMandate: { exists: true } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(1)
  })

  it('sorts every batch deterministically by expiry and then numeric domain asset id', async () => {
    const later = await fixture('priority-later')
    const first = await fixture('priority-first')
    const sameExpiryHigherId = await fixture('priority-same')
    await seedMandate(later)
    await seedMandate(first)
    await seedMandate(sameExpiryHigherId)
    await payload.update({
      collection: 'domainAssets',
      data: { expiresAt: '2027-08-07T12:00:00.000Z' },
      id: first.asset.id,
      overrideAccess: true,
    })
    first.asset.expiresAt = '2027-08-07T12:00:00.000Z'
    await payload.update({
      collection: 'domainAssets',
      data: { expiresAt: '2027-08-07T12:00:00.000Z' },
      id: sameExpiryHigherId.asset.id,
      overrideAccess: true,
    })
    sameExpiryHigherId.asset.expiresAt = '2027-08-07T12:00:00.000Z'
    const expected = [
      String(first.asset.id),
      String(sameExpiryHigherId.asset.id),
      String(later.asset.id),
    ]
    const shuffled = [
      { asset: later.asset, mandate: {} as RenewalMandateRecord },
      { asset: sameExpiryHigherId.asset, mandate: {} as RenewalMandateRecord },
      { asset: first.asset, mandate: {} as RenewalMandateRecord },
    ]
    expect(sortAutomaticRenewalCandidates(shuffled).map(({ asset }) => String(asset.id))).toEqual(
      expected,
    )
    expect(sortAutomaticRenewalCandidates(shuffled).map(({ asset }) => String(asset.id))).toEqual(
      expected,
    )
    const firstBatch = await runAutomaticRenewals(
      await request('priority-batch-one'),
      dependencies(first.asset),
    )
    const secondBatch = await runAutomaticRenewals(
      await request('priority-batch-two'),
      dependencies(first.asset),
    )
    expect(firstBatch.processingOrder).toEqual(expected)
    expect(secondBatch.processingOrder).toEqual(expected)
  })

  it('derives scheduler candidates from the latest mandate revision and excludes a closed mandate', async () => {
    const owner = await fixture('scheduler-revoked', { balanceFen: 10_000 })
    await seedMandate(owner, { eventType: 'revoked' })
    const batch = await runAutomaticRenewals(
      await request('scheduler-revoked'),
      dependencies(owner.asset),
    )
    expect(batch.processingOrder).toEqual([])
    expect(batch.outcomes).toEqual([])
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
  })

  it.each([
    ['expired local state', { localStatus: 'expired' as const, epp: 'ok' }],
    ['redemption EPP state', { localStatus: 'active' as const, epp: 'autoRenewPeriod' }],
    [
      'registry renewal restriction',
      { localStatus: 'active' as const, epp: 'serverRenewProhibited' },
    ],
  ])('%s never enters the ordinary renewal path', async (_label, state) => {
    const owner = await fixture(`domain-state-${state.epp}`, {
      balanceFen: 10_000,
      status: state.localStatus,
    })
    await seedMandate(owner)
    const write = writeProvider(owner.asset, { eligibilityStatus: state.epp })
    const execution = runAutomaticRenewalForAsset(
      await request(`domain-state-${state.epp}`),
      owner.asset.id,
      dependencies(owner.asset, { write }),
    )
    await expect(execution).resolves.toMatchObject({ status: 'skipped' })
    const outcome = await execution
    expect(outcome.status).toBe('skipped')
    expect(write.transport.requests.filter(({ operation }) => operation === 'renew')).toHaveLength(
      0,
    )
    await expect(
      count('orders', {
        and: [
          { customer: { equals: owner.customer.id } },
          { automaticRenewalMandate: { exists: true } },
        ],
      }),
    ).resolves.toBe(0)
  })

  it('records and skips an already-expired date even if the cached asset status still says active', async () => {
    const owner = await fixture('expired-date', {
      balanceFen: 10_000,
      expires: '2027-07-31T12:00:00.000Z',
    })
    await seedMandate(owner)
    const write = writeProvider(owner.asset)
    const outcome = await runAutomaticRenewalForAsset(
      await request('expired-date'),
      owner.asset.id,
      dependencies(owner.asset, { write }),
    )
    expect(outcome.status).toBe('skipped')
    expect(write.transport.requests).toHaveLength(0)
    await expect(
      count('automaticRenewalEvents', {
        and: [
          { asset: { equals: owner.asset.id } },
          { eventType: { equals: 'skipped_domain_status' } },
          { reasonCode: { equals: 'AUTOMATIC_RENEWAL_ASSET_EXPIRED' } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('does not request interactive step-up during unattended execution', async () => {
    const owner = await fixture('no-step-up')
    await seedMandate(owner)
    const authorize = vi.spyOn(stepUpService, 'authorizeStepUpGrant')
    await runAutomaticRenewalForAsset(
      await request('no-step-up'),
      owner.asset.id,
      dependencies(owner.asset),
    )
    expect(authorize).not.toHaveBeenCalled()
  })

  it('rejects a customer-authenticated caller at the system executor boundary', async () => {
    const owner = await fixture('system-boundary', { balanceFen: 10_000 })
    await seedMandate(owner)
    await expect(
      runAutomaticRenewalForAsset(
        await request('system-boundary', owner.customer),
        owner.asset.id,
        dependencies(owner.asset),
      ),
    ).rejects.toMatchObject({ code: 'AUTOMATIC_RENEWAL_SYSTEM_CONTEXT_REQUIRED' })
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
  })

  it.each([
    ['purchase restriction', 'restricted', ['purchase_disabled']],
    ['balance-spend restriction', 'restricted', ['balance_spend_disabled']],
  ])(
    '%s is re-read independently and blocks automatic debit',
    async (_label, status, restrictions) => {
      const owner = await fixture(`account-${status}-${restrictions[0] ?? 'none'}`, {
        balanceFen: 10_000,
      })
      await seedMandate(owner)
      await payload.db.pool.query(
        `UPDATE customers
       SET status = $2, capability_restrictions = $3::jsonb
       WHERE id = $1`,
        [owner.customer.id, status, JSON.stringify(restrictions)],
      )
      const priceProvider = readProvider()
      const queryPrice = vi.spyOn(priceProvider, 'queryPrice')
      const outcome = await runAutomaticRenewalForAsset(
        await request(`account-${status}-${restrictions[0] ?? 'none'}`),
        owner.asset.id,
        dependencies(owner.asset, { readProvider: priceProvider }),
      )
      expect(outcome.status).toBe('skipped')
      expect(queryPrice).not.toHaveBeenCalled()
      await expect(
        count('automaticRenewalEvents', {
          and: [
            { asset: { equals: owner.asset.id } },
            { eventType: { equals: 'skipped_account_restricted' } },
            { reasonCode: { equals: 'AUTOMATIC_RENEWAL_ACCOUNT_RESTRICTED' } },
          ],
        }),
      ).resolves.toBe(1)
      await expect(
        count('walletEntries', {
          and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
        }),
      ).resolves.toBe(0)
    },
  )

  it('blocks automatic debit during identity-risk cooldown', async () => {
    const owner = await fixture('cooldown', { balanceFen: 10_000, cooldown: true })
    await seedMandate(owner)
    const outcome = await runAutomaticRenewalForAsset(
      await request('cooldown'),
      owner.asset.id,
      dependencies(owner.asset),
    )
    expect(outcome.status).toBe('skipped')
    await expect(
      count('automaticRenewalEvents', {
        and: [
          { asset: { equals: owner.asset.id } },
          { eventType: { equals: 'skipped_identity_cooldown' } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
  })
})

describe('D9-C-2 queue-time races and D6 fulfillment reuse', () => {
  it('revalidates a queued task, abandons a revoked mandate, releases the complete hold, and records the skip', async () => {
    const owner = await fixture('queued-revoked', { balanceFen: 3_500 })
    const mandate = await seedMandate(owner)
    const write = writeProvider(owner.asset)
    const queued = await runAutomaticRenewalForAsset(
      await request('queued-revoked-create'),
      owner.asset.id,
      dependencies(owner.asset, { write }),
    )
    expect(queued.status).toBe('queued')
    await payload.create({
      collection: 'renewalMandates',
      data: {
        asset: owner.asset.id,
        authorizedAt: mandate.authorizedAt,
        createdTraceId: `${fixturePrefix}-queued-revoked`,
        currency: 'CNY',
        customer: owner.customer.id,
        domainAsciiSnapshot: owner.asset.domainAscii,
        eventType: 'revoked',
        mandateKey: mandate.mandateKey,
        maxDebitFen: mandate.maxDebitFen,
        previousMandate: mandate.id as never,
        previewDigest: 'c'.repeat(64),
        revision: 2,
        revokedAt: '2027-08-01T12:01:00.000Z',
        rulesVersion: rules.version,
        scope: 'renew_one_year',
        stepUpGrantId: `${fixturePrefix}-queued-revoke-step-up`,
        validUntil: mandate.validUntil,
      },
      overrideAccess: true,
    })
    const result = await runCommerceFulfillment(
      await request('queued-revoked-job'),
      {
        operationKey: `commerce-fulfillment:${queued.orderId}`,
        orderId: Number(queued.orderId),
        traceId: `${fixturePrefix}-queued-revoked-job`,
      },
      {
        preflight: {
          queryAvailability: vi.fn(async () =>
            mockSuccess(
              {
                available: true,
                currency: 'CNY' as const,
                domainAscii: owner.asset.domainAscii,
                premium: false,
              },
              `${fixturePrefix}-availability`,
            ),
          ),
          queryBalance: vi.fn(async () =>
            mockSuccess({ availableMinor: 1_000_000, frozenMinor: 0 }, `${fixturePrefix}-balance`),
          ),
        },
        write: write.provider,
      },
    )
    expect(result.status).toBe('refunded')
    expect(write.transport.requests.filter(({ operation }) => operation === 'renew')).toHaveLength(
      0,
    )
    expect(
      await readWalletBalance(await request('queued-revoked-balance'), owner.walletAccountId),
    ).toEqual({ availableBalance: 3_500n, heldBalance: 0n, postedBalance: 3_500n })
    await expect(
      count('automaticRenewalEvents', {
        and: [
          { asset: { equals: owner.asset.id } },
          { order: { equals: Number(queued.orderId) } },
          { eventType: { equals: 'skipped_job_revalidation' } },
        ],
      }),
    ).resolves.toBe(1)
  })

  it('revalidates again after preflight and catches revocation racing the queued job', async () => {
    const owner = await fixture('queued-revoke-race', { balanceFen: 3_500 })
    const mandate = await seedMandate(owner)
    const write = writeProvider(owner.asset)
    const queued = await runAutomaticRenewalForAsset(
      await request('queued-revoke-race-create'),
      owner.asset.id,
      dependencies(owner.asset, { write }),
    )
    expect(queued.status).toBe('queued')
    let balanceReached!: () => void
    let releaseBalance!: () => void
    const reached = new Promise<void>((resolve) => (balanceReached = resolve))
    const balanceGate = new Promise<void>((resolve) => (releaseBalance = resolve))
    const fulfillment = runCommerceFulfillment(
      await request('queued-revoke-race-job'),
      {
        operationKey: `commerce-fulfillment:${queued.orderId}`,
        orderId: Number(queued.orderId),
        traceId: `${fixturePrefix}-queued-revoke-race-job`,
      },
      {
        preflight: {
          queryAvailability: vi.fn(async () =>
            mockSuccess(
              {
                available: true,
                currency: 'CNY' as const,
                domainAscii: owner.asset.domainAscii,
                premium: false,
              },
              `${fixturePrefix}-availability`,
            ),
          ),
          queryBalance: vi.fn(async () => {
            balanceReached()
            await balanceGate
            return mockSuccess(
              { availableMinor: 1_000_000, frozenMinor: 0 },
              `${fixturePrefix}-balance`,
            )
          }),
        },
        write: write.provider,
      },
    )
    await reached
    await payload.create({
      collection: 'renewalMandates',
      data: {
        asset: owner.asset.id,
        authorizedAt: mandate.authorizedAt,
        createdTraceId: `${fixturePrefix}-queued-revoke-race`,
        currency: 'CNY',
        customer: owner.customer.id,
        domainAsciiSnapshot: owner.asset.domainAscii,
        eventType: 'revoked',
        mandateKey: mandate.mandateKey,
        maxDebitFen: mandate.maxDebitFen,
        previousMandate: mandate.id as never,
        previewDigest: 'd'.repeat(64),
        revision: 2,
        revokedAt: '2027-08-01T12:02:00.000Z',
        rulesVersion: rules.version,
        scope: 'renew_one_year',
        stepUpGrantId: `${fixturePrefix}-queued-race-step-up`,
        validUntil: mandate.validUntil,
      },
      overrideAccess: true,
    })
    releaseBalance()
    const result = await fulfillment
    expect(result.status).toBe('refunded')
    expect(write.transport.requests.filter(({ operation }) => operation === 'renew')).toHaveLength(
      0,
    )
    expect(
      await readWalletBalance(await request('queued-race-balance'), owner.walletAccountId),
    ).toEqual({ availableBalance: 3_500n, heldBalance: 0n, postedBalance: 3_500n })
  })

  it('abandons a queued task when a newer same-terms mandate revision replaces its authorization', async () => {
    const owner = await fixture('queued-replaced', { balanceFen: 3_500 })
    const mandate = await seedMandate(owner)
    const write = writeProvider(owner.asset)
    const queued = await runAutomaticRenewalForAsset(
      await request('queued-replaced-create'),
      owner.asset.id,
      dependencies(owner.asset, { write }),
    )
    expect(queued.status).toBe('queued')
    await appendAuthorizedMandateRevision(owner, mandate)
    const result = await runCommerceFulfillment(
      await request('queued-replaced-job'),
      {
        operationKey: `commerce-fulfillment:${queued.orderId}`,
        orderId: Number(queued.orderId),
        traceId: `${fixturePrefix}-queued-replaced-job`,
      },
      fulfillmentDependencies(owner, write),
    )
    expect(result.status).toBe('refunded')
    expect(write.transport.requests.filter(({ operation }) => operation === 'renew')).toHaveLength(
      0,
    )
    expect(
      await readWalletBalance(await request('queued-replaced-balance'), owner.walletAccountId),
    ).toEqual({ availableBalance: 3_500n, heldBalance: 0n, postedBalance: 3_500n })
  })

  it('binds a queued automatic order to the rules version recorded at authorization', async () => {
    const owner = await fixture('queued-rules', { balanceFen: 3_500 })
    await seedMandate(owner)
    const write = writeProvider(owner.asset)
    const queued = await runAutomaticRenewalForAsset(
      await request('queued-rules-create'),
      owner.asset.id,
      dependencies(owner.asset, { write }),
    )
    expect(queued.status).toBe('queued')
    await payload.db.pool.query(
      "UPDATE orders SET automatic_renewal_rules_version = 'stale-rules' WHERE id = $1",
      [Number(queued.orderId)],
    )
    const result = await runCommerceFulfillment(
      await request('queued-rules-job'),
      {
        operationKey: `commerce-fulfillment:${queued.orderId}`,
        orderId: Number(queued.orderId),
        traceId: `${fixturePrefix}-queued-rules-job`,
      },
      fulfillmentDependencies(owner, write),
    )
    expect(result.status).toBe('refunded')
    expect(write.transport.requests.filter(({ operation }) => operation === 'renew')).toHaveLength(
      0,
    )
  })

  it('uses the latest reauthorization maximum at fulfillment instead of the queued price snapshot', async () => {
    const owner = await fixture('queued-lower-max', { balanceFen: 3_500 })
    const mandate = await seedMandate(owner, { maxDebitFen: 3_500 })
    const write = writeProvider(owner.asset)
    const queued = await runAutomaticRenewalForAsset(
      await request('queued-lower-max-create'),
      owner.asset.id,
      dependencies(owner.asset, { write }),
    )
    expect(queued.status).toBe('queued')
    const replacement = await appendAuthorizedMandateRevision(owner, mandate, {
      maxDebitFen: 3_499,
    })
    await payload.db.pool.query(
      'UPDATE orders SET automatic_renewal_mandate_id = $2 WHERE id = $1',
      [Number(queued.orderId), replacement.id],
    )
    const result = await runCommerceFulfillment(
      await request('queued-lower-max-job'),
      {
        operationKey: `commerce-fulfillment:${queued.orderId}`,
        orderId: Number(queued.orderId),
        traceId: `${fixturePrefix}-queued-lower-max-job`,
      },
      {
        preflight: {
          queryAvailability: vi.fn(async () =>
            mockSuccess(
              {
                available: true,
                currency: 'CNY' as const,
                domainAscii: owner.asset.domainAscii,
                premium: false,
              },
              `${fixturePrefix}-availability`,
            ),
          ),
          queryBalance: vi.fn(async () =>
            mockSuccess({ availableMinor: 1_000_000, frozenMinor: 0 }, `${fixturePrefix}-balance`),
          ),
        },
        write: write.provider,
      },
    )
    expect(result.status).toBe('refunded')
    expect(write.transport.requests.filter(({ operation }) => operation === 'renew')).toHaveLength(
      0,
    )
    expect(
      await readWalletBalance(await request('queued-lower-max-balance'), owner.walletAccountId),
    ).toEqual({ availableBalance: 3_500n, heldBalance: 0n, postedBalance: 3_500n })
  })

  it('checks local expiry state before generic D6 preflight and releases a queued hold', async () => {
    const owner = await fixture('queued-expired', { balanceFen: 3_500 })
    await seedMandate(owner)
    const write = writeProvider(owner.asset)
    const queued = await runAutomaticRenewalForAsset(
      await request('queued-expired-create'),
      owner.asset.id,
      dependencies(owner.asset, { write }),
    )
    expect(queued.status).toBe('queued')
    await payload.update({
      collection: 'domainAssets',
      data: { status: 'expired' },
      id: owner.asset.id,
      overrideAccess: true,
    })
    const queryBalance = vi.fn(async () =>
      mockSuccess({ availableMinor: 1_000_000, frozenMinor: 0 }, `${fixturePrefix}-balance`),
    )
    const result = await runCommerceFulfillment(
      await request('queued-expired-job'),
      {
        operationKey: `commerce-fulfillment:${queued.orderId}`,
        orderId: Number(queued.orderId),
        traceId: `${fixturePrefix}-queued-expired-job`,
      },
      {
        preflight: {
          queryAvailability: vi.fn(async () =>
            mockSuccess(
              {
                available: true,
                currency: 'CNY' as const,
                domainAscii: owner.asset.domainAscii,
                premium: false,
              },
              `${fixturePrefix}-availability`,
            ),
          ),
          queryBalance,
        },
        write: write.provider,
      },
    )
    expect(result.status).toBe('refunded')
    expect(queryBalance).not.toHaveBeenCalled()
    expect(write.transport.requests.filter(({ operation }) => operation === 'renew')).toHaveLength(
      0,
    )
    expect(
      await readWalletBalance(await request('queued-expired-balance'), owner.walletAccountId),
    ).toEqual({ availableBalance: 3_500n, heldBalance: 0n, postedBalance: 3_500n })
  })

  it('concurrent triggers produce exactly one wallet charge and one idempotent D6 upstream renewal', async () => {
    const owner = await fixture('concurrent', { balanceFen: 3_500 })
    await seedMandate(owner)
    const write = writeProvider(owner.asset)
    const triggerResults = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        runAutomaticRenewalForAsset(
          await request(`concurrent-trigger-${index}`),
          owner.asset.id,
          dependencies(owner.asset, { write }),
        ),
      ),
    )
    expect(triggerResults.filter(({ status }) => status === 'queued')).toHaveLength(1)
    const orderId = Number(triggerResults.find(({ orderId }) => orderId)?.orderId)
    expect(Number.isSafeInteger(orderId)).toBe(true)
    await expect(
      count('domainExpiryReminders', {
        and: [
          { asset: { equals: owner.asset.id } },
          { customer: { equals: owner.customer.id } },
          { noticeType: { equals: 'automatic_renewal_due' } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('payload-jobs', {
        and: [
          { workflowSlug: { equals: 'commerceFulfillment' } },
          { 'input.orderId': { equals: orderId } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('automaticRenewalEvents', {
        and: [
          { asset: { equals: owner.asset.id } },
          { order: { equals: orderId } },
          { eventType: { equals: 'order_queued' } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('auditLogs', {
        and: [
          { action: { equals: 'domain.automatic_renewal.queued' } },
          { targetId: { equals: String(owner.asset.id) } },
        ],
      }),
    ).resolves.toBe(1)
    const fulfillmentDependencies = {
      preflight: {
        queryAvailability: vi.fn(async () =>
          mockSuccess(
            {
              available: true,
              currency: 'CNY' as const,
              domainAscii: owner.asset.domainAscii,
              premium: false,
            },
            `${fixturePrefix}-availability`,
          ),
        ),
        queryBalance: vi.fn(async () =>
          mockSuccess({ availableMinor: 1_000_000, frozenMinor: 0 }, `${fixturePrefix}-balance`),
        ),
      },
      write: write.provider,
    }
    const fulfillmentResults = [
      await runCommerceFulfillment(
        await request('concurrent-job-first'),
        {
          operationKey: `commerce-fulfillment:${orderId}`,
          orderId,
          traceId: `${fixturePrefix}-concurrent-job-first`,
        },
        fulfillmentDependencies,
      ),
      await runCommerceFulfillment(
        await request('concurrent-job-replay'),
        {
          operationKey: `commerce-fulfillment:${orderId}`,
          orderId,
          traceId: `${fixturePrefix}-concurrent-job-replay`,
        },
        fulfillmentDependencies,
      ),
    ]
    expect(fulfillmentResults.every(({ status }) => status === 'succeeded')).toBe(true)
    expect(write.transport.requests.filter(({ operation }) => operation === 'renew')).toHaveLength(
      1,
    )
    await expect(
      count('walletEntries', {
        and: [
          { account: { equals: owner.walletAccountId } },
          { entryType: { equals: 'hold' } },
          { amountFen: { equals: 3_500 } },
        ],
      }),
    ).resolves.toBe(1)
    await expect(
      count('walletEntries', {
        and: [
          { account: { equals: owner.walletAccountId } },
          { entryType: { equals: 'capture' } },
          { amountFen: { equals: 3_500 } },
        ],
      }),
    ).resolves.toBe(1)
    expect(
      await readWalletBalance(await request('concurrent-balance'), owner.walletAccountId),
    ).toEqual({ availableBalance: 0n, heldBalance: 0n, postedBalance: 0n })
  })

  it('serializes mandate revocation ahead of a concurrent hold and never makes balance negative', async () => {
    const owner = await fixture('revoke-race', { balanceFen: 3_500 })
    await seedMandate(owner)
    const userReq = await request('revoke-race-user', owner.customer)
    const preview = await previewCustomerRenewalMandateChange(
      userReq,
      owner.asset.id,
      { action: 'revoke' },
      { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-revoke-preview` },
    )
    const grant = await issueStepUpGrantFixture(
      payload,
      userReq,
      owner.customer.id,
      'renewal_mandate_change',
    )
    if (preview.state !== 'ready') throw new Error('Expected renewal mandate revoke preview')
    const blocker = await payload.db.pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM domain_assets WHERE id = $1 FOR UPDATE', [owner.asset.id])
      const revocation = changeCustomerRenewalMandate(
        userReq,
        owner.asset.id,
        {
          confirmed: true,
          deviceId: grant.deviceId,
          previewToken: preview.data.previewToken,
          stepUpToken: grant.stepUpToken,
        },
        {
          customer: owner.customer,
          expectedAction: 'revoke',
          now: () => now,
          traceId: `${fixturePrefix}-revoke-race`,
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      const execution = runAutomaticRenewalForAsset(
        await request('revoke-race-worker'),
        owner.asset.id,
        dependencies(owner.asset),
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      await blocker.query('COMMIT')
      const [revoked, outcome] = await Promise.all([revocation, execution])
      if (revoked.state !== 'ready') throw new Error('Expected renewal mandate revocation')
      expect(revoked.data.mandate).toMatchObject({ eventType: 'revoked' })
      expect(outcome.status).toBe('skipped')
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
    }
    const balance = await readWalletBalance(
      await request('revoke-race-balance'),
      owner.walletAccountId,
    )
    expect(balance).toEqual({ availableBalance: 3_500n, heldBalance: 0n, postedBalance: 3_500n })
    expect(balance.availableBalance).toBeGreaterThanOrEqual(0n)
    await expect(
      count('walletEntries', {
        and: [{ account: { equals: owner.walletAccountId } }, { entryType: { equals: 'hold' } }],
      }),
    ).resolves.toBe(0)
  })

  it('holds the asset row across final mandate validation and the wallet hold', async () => {
    const owner = await fixture('hold-lock-wins', { balanceFen: 3_500 })
    await seedMandate(owner)
    const userReq = await request('hold-lock-wins-user', owner.customer)
    const preview = await previewCustomerRenewalMandateChange(
      userReq,
      owner.asset.id,
      { action: 'revoke' },
      { customer: owner.customer, now: () => now, traceId: `${fixturePrefix}-hold-lock-preview` },
    )
    if (preview.state !== 'ready') throw new Error('Expected hold-lock revoke preview')
    const grant = await issueStepUpGrantFixture(
      payload,
      userReq,
      owner.customer.id,
      'renewal_mandate_change',
    )
    const originalFind = payload.find.bind(payload)
    let mandateReads = 0
    let innerReached!: () => void
    let releaseInner!: () => void
    const reached = new Promise<void>((resolve) => (innerReached = resolve))
    const innerGate = new Promise<void>((resolve) => (releaseInner = resolve))
    const findSpy = vi.spyOn(payload, 'find').mockImplementation(async (input) => {
      if (input.collection === 'renewalMandates') {
        mandateReads += 1
        if (mandateReads === 4) {
          innerReached()
          await innerGate
        }
      }
      return originalFind(input as never) as never
    })
    try {
      const workerReq = await request('hold-lock-wins-worker')
      const execution = runAutomaticRenewalForAsset(
        workerReq,
        owner.asset.id,
        dependencies(owner.asset),
      )
      await reached
      const observer = await payload.db.pool.connect()
      try {
        await observer.query('BEGIN')
        await observer.query("SET LOCAL lock_timeout = '50ms'")
        await expect(
          observer.query('UPDATE domain_assets SET updated_at = NOW() WHERE id = $1', [
            owner.asset.id,
          ]),
        ).rejects.toThrow(/lock timeout/u)
      } finally {
        await observer.query('ROLLBACK').catch(() => undefined)
        observer.release()
      }
      const revocation = changeCustomerRenewalMandate(
        userReq,
        owner.asset.id,
        {
          confirmed: true,
          deviceId: grant.deviceId,
          previewToken: preview.data.previewToken,
          stepUpToken: grant.stepUpToken,
        },
        {
          customer: owner.customer,
          expectedAction: 'revoke',
          now: () => now,
          traceId: `${fixturePrefix}-hold-lock-revoke`,
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 75))
      releaseInner()
      const [outcome, revoked] = await Promise.all([execution, revocation])
      const events = await payload.find({
        collection: 'automaticRenewalEvents',
        limit: 10,
        overrideAccess: true,
        where: { asset: { equals: owner.asset.id } },
      })
      expect({
        outcome,
        reasons: events.docs.map(({ eventType, reasonCode }) => ({ eventType, reasonCode })),
      }).toMatchObject({ outcome: { status: 'queued' } })
      expect(revoked).toMatchObject({ data: { mandate: { eventType: 'revoked' } }, state: 'ready' })
    } finally {
      releaseInner?.()
      findSpy.mockRestore()
    }
    await expect(
      count('walletEntries', {
        and: [
          { account: { equals: owner.walletAccountId } },
          { entryType: { equals: 'hold' } },
          { amountFen: { equals: 3_500 } },
        ],
      }),
    ).resolves.toBe(1)
  })
})
