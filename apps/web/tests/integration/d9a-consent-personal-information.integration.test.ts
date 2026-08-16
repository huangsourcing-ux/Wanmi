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

import { CONSENT_TYPES } from '@/lib/domain'
import type { Customer } from '@/payload-types'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import { createCustomerOrder } from '@/services/commerce/order-creation'
import { authenticateVerifiedPhone } from '@/services/auth/customer-identities'
import { authTransactionDatabase } from '@/services/auth/atomic'
import {
  appendConsentAcceptance,
  registrationConsentDocument,
} from '@/services/auth/registration-consents'
import { listCustomerDomainAssets } from '@/services/domains/domain-assets'
import { calculateTldPrice } from '@/services/pricing/price-calculation'
import {
  createQuoteIntegrityHash,
  type CustomerQuoteStore,
  type QuoteSnapshotInput,
  type StoredCustomerQuote,
} from '@/services/pricing/customer-quotes'
import {
  assertCustomerConsentActive,
  assertLegacyRegistrationPurchaseAllowed,
  commercialSmsOptedIn,
  completeLegacyCustomerProfile,
  customerNeedsLegacyProfileCompletion,
  recordCustomerConsentDecision,
} from '@/services/privacy/customer-consents'
import { readPersonalInformation } from '@/services/privacy/personal-information'
import { createRealnameTemplate } from '@/services/realname/templates'

import { PRICING_RULE_FIXTURES } from '../fixtures/pricing'
import { realnameTemplateFixture } from '../fixtures/realname'
import { down as rollBackA7Migration } from '../../migrations/20260816_121523_d9a_consent_personal_information'

let payload: Payload

function headers(suffix: string = randomUUID()): Headers {
  return new Headers({
    'user-agent': `Wanmi-D9A-A7/${suffix}`,
    'x-forwarded-for': `198.51.100.${randomInt(1, 250)}`,
    'x-request-id': `d9a-a7-${suffix}`,
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

async function customer(
  input: Partial<Customer> & {
    accountType?: 'legacy_unknown' | 'registered'
    registrationSource?: 'legacy_unknown' | 'phone' | 'wechat_oauth' | 'wechat_qrcode'
    status?: Customer['status']
  } = {},
): Promise<Customer> {
  const suffix = randomUUID()
  return payload.create({
    collection: 'customers',
    data: {
      accountType: input.accountType ?? 'registered',
      capabilityRestrictions: input.capabilityRestrictions ?? [],
      consentStateVersion: input.consentStateVersion ?? 0,
      defaultCustomerProfileType:
        input.defaultCustomerProfileType ??
        (input.accountType === 'legacy_unknown' ? undefined : 'individual'),
      legacyProfileCompletedAt: input.legacyProfileCompletedAt,
      phone: input.phone ?? `a7-${suffix}`,
      phoneMasked: input.phoneMasked ?? `a7-***${suffix.slice(-4)}`,
      registrationSource:
        input.registrationSource ??
        (input.accountType === 'legacy_unknown' ? 'legacy_unknown' : 'phone'),
      status: input.status ?? 'active',
    },
    overrideAccess: true,
  })
}

async function storedCustomer(id: number): Promise<Customer> {
  return payload.findByID({ collection: 'customers', depth: 0, id, overrideAccess: true })
}

async function consentCount(customerId: number, consentType?: string) {
  return payload.count({
    collection: 'consentRecords',
    overrideAccess: true,
    where: consentType
      ? {
          and: [{ customer: { equals: customerId } }, { consentType: { equals: consentType } }],
        }
      : { customer: { equals: customerId } },
  })
}

async function accept(
  account: Customer,
  consentType:
    | 'commercial_sms'
    | 'device_identifier_notice'
    | 'invitation_attribution'
    | 'sensitive_personal_information'
    | 'wechat_profile',
) {
  return recordCustomerConsentDecision(await requestFor(customerUser(account)), account, {
    consentType,
    decision: 'accept',
  })
}

function quoteFor(
  customerId: number,
  operation: 'registration' | 'renewal',
): { quote: StoredCustomerQuote; store: CustomerQuoteStore } {
  const now = new Date().toISOString()
  const rule = PRICING_RULE_FIXTURES.com!
  const calculation = calculateTldPrice({
    registrationPriceFen: 2_500,
    renewalPriceFen: 2_750,
    rule,
  })
  const input: QuoteSnapshotInput = {
    ...(operation === 'renewal'
      ? { assetExpiresAt: '2027-08-16T00:00:00.000Z', domainAssetId: 2_147_000_000 }
      : {}),
    availabilityObservedAt: now,
    availabilityRequestId: randomUUID(),
    calculation,
    customerId,
    domainAscii: `${randomUUID()}.com`,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    operation,
    providerCacheStatus: 'miss',
    providerObservedAt: now,
    providerProductId: 'domcom',
    providerRequestId: randomUUID(),
    quotedAt: now,
    sourceCalculationHash: '1'.repeat(64),
    sourcePriceSnapshotRef: randomUUID(),
    tld: 'com',
    traceId: `d9a-a7-quote-${randomUUID()}`,
    upstreamCostMinor: operation === 'renewal' ? calculation.upstreamRenewalPriceFen : 2_500,
    userPriceMinor: operation === 'renewal' ? calculation.renewalPriceFen : 3_000,
    years: 1,
  }
  const quote: StoredCustomerQuote = {
    ...input,
    quoteId: randomInt(1, 1_000_000),
    quoteIntegrityHash: createQuoteIntegrityHash(input),
    quoteRef: randomUUID(),
  }
  return {
    quote,
    store: {
      findOwnedByRef: async (quoteRef) => (quoteRef === quote.quoteRef ? quote : undefined),
      record: async () => {
        throw new Error('A7 quote store is read-only')
      },
    },
  }
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe('D9-A A7 consent and personal information', () => {
  it('defines exactly eight independently versioned and hashed consent documents', () => {
    expect(CONSENT_TYPES).toEqual([
      'service_terms',
      'privacy_policy',
      'sensitive_personal_information',
      'wechat_profile',
      'commercial_sms',
      'automatic_renewal',
      'invitation_attribution',
      'device_identifier_notice',
    ])
    for (const consentType of CONSENT_TYPES) {
      expect(registrationConsentDocument(consentType)).toMatchObject({
        documentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        documentVersion: expect.stringContaining('2026-08'),
      })
    }
    expect(
      new Set(CONSENT_TYPES.map((type) => registrationConsentDocument(type).documentHash)).size,
    ).toBe(CONSENT_TYPES.length)
    expect(
      new Set(CONSENT_TYPES.map((type) => registrationConsentDocument(type).documentVersion)).size,
    ).toBe(CONSENT_TYPES.length)
  })

  it('keeps consent records append-only even for overrideAccess system calls', async () => {
    const account = await customer()
    const req = await requestFor(customerUser(account), 'append-only')
    const record = await appendConsentAcceptance(req, {
      acceptedAt: new Date().toISOString(),
      consentType: 'commercial_sms',
      customerId: Number(account.id),
      headers: req.headers,
      source: 'account_privacy_center',
    })
    await expect(
      payload.update({
        collection: 'consentRecords',
        data: { revokedAt: new Date().toISOString() },
        id: record.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_RECORD_APPEND_ONLY' })
    await expect(
      payload.delete({ collection: 'consentRecords', id: record.id, overrideAccess: true }),
    ).rejects.toMatchObject({ code: 'CONSENT_RECORD_APPEND_ONLY' })
    await expect(consentCount(Number(account.id), 'commercial_sms')).resolves.toEqual({
      totalDocs: 1,
    })
  })

  it('refuses migration rollback instead of deleting or relabeling append-only A7 history', async () => {
    const account = await customer()
    await accept(account, 'commercial_sms')
    const req = await requestFor()
    await initTransaction(req)
    try {
      const db = await authTransactionDatabase(req)
      await expect(rollBackA7Migration({ db, payload, req } as never)).rejects.toThrow()
    } finally {
      await killTransaction(req)
    }
    await expect(consentCount(Number(account.id), 'commercial_sms')).resolves.toEqual({
      totalDocs: 1,
    })
  })

  it('defaults commercial SMS to off, appends acceptance and revocation, and unsubscribes immediately', async () => {
    const account = await customer()
    const firstReq = await requestFor(customerUser(account), 'commercial-default')
    await expect(commercialSmsOptedIn(firstReq, account.id)).resolves.toBe(false)
    await expect(accept(account, 'commercial_sms')).resolves.toMatchObject({
      active: true,
      changed: true,
    })
    const accepted = await payload.find({
      collection: 'consentRecords',
      overrideAccess: true,
      where: {
        and: [{ customer: { equals: account.id } }, { consentType: { equals: 'commercial_sms' } }],
      },
    })
    expect(accepted.docs).toHaveLength(1)
    expect(accepted.docs[0]).toMatchObject({
      revokedAt: null,
      source: 'account_privacy_center',
      ...registrationConsentDocument('commercial_sms'),
    })
    await expect(
      commercialSmsOptedIn(await requestFor(customerUser(account)), account.id),
    ).resolves.toBe(true)

    const refreshed = await storedCustomer(Number(account.id))
    await expect(
      recordCustomerConsentDecision(await requestFor(customerUser(refreshed)), refreshed, {
        consentType: 'commercial_sms',
        decision: 'revoke',
      }),
    ).resolves.toMatchObject({ active: false, changed: true })
    const history = await payload.find({
      collection: 'consentRecords',
      overrideAccess: true,
      sort: 'id',
      where: {
        and: [{ customer: { equals: account.id } }, { consentType: { equals: 'commercial_sms' } }],
      },
    })
    expect(history.docs).toHaveLength(2)
    expect(history.docs[0]).toMatchObject({ revokedAt: null })
    expect(history.docs[1]).toMatchObject({
      acceptedAt: history.docs[0]!.acceptedAt,
      documentHash: history.docs[0]!.documentHash,
      documentVersion: history.docs[0]!.documentVersion,
      revokedAt: expect.any(String),
    })
    await expect(
      commercialSmsOptedIn(await requestFor(customerUser(refreshed)), account.id),
    ).resolves.toBe(false)
    const audits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      sort: 'action',
      where: {
        and: [
          { targetId: { equals: String(account.id) } },
          { action: { in: ['customer.consent.accepted', 'customer.consent.revoked'] } },
        ],
      },
    })
    expect(audits.docs.map((audit) => audit.action).sort()).toEqual([
      'customer.consent.accepted',
      'customer.consent.revoked',
    ])
  })

  it('makes already-active acceptance and already-inactive revocation write-free no-ops', async () => {
    const account = await customer()
    await accept(account, 'wechat_profile')
    const refreshed = await storedCustomer(Number(account.id))
    await expect(
      recordCustomerConsentDecision(await requestFor(customerUser(refreshed)), refreshed, {
        consentType: 'wechat_profile',
        decision: 'accept',
      }),
    ).resolves.toMatchObject({ active: true, changed: false })
    await expect(consentCount(Number(account.id), 'wechat_profile')).resolves.toEqual({
      totalDocs: 1,
    })

    const inactive = await customer()
    await expect(
      recordCustomerConsentDecision(await requestFor(customerUser(inactive)), inactive, {
        consentType: 'wechat_profile',
        decision: 'revoke',
      }),
    ).resolves.toMatchObject({ active: false, changed: false })
    await expect(consentCount(Number(inactive.id), 'wechat_profile')).resolves.toEqual({
      totalDocs: 0,
    })
  })

  it('allows exactly one of 8 concurrent consent writes', async () => {
    const account = await customer()
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        recordCustomerConsentDecision(
          await requestFor(customerUser(account), `consent-concurrent-${index}`),
          account,
          { consentType: 'commercial_sms', decision: 'accept' },
        ),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(7)
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'CONSENT_STATE_CONFLICT', status: 409 })
      }
    }
    await expect(consentCount(Number(account.id), 'commercial_sms')).resolves.toEqual({
      totalDocs: 1,
    })
  })

  it('rejects anonymous, cross-customer, non-managed, and malformed-version consent changes', async () => {
    const account = await customer()
    const other = await customer()
    await expect(
      recordCustomerConsentDecision(await requestFor(), account, {
        consentType: 'commercial_sms',
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_CHANGE_FORBIDDEN', status: 403 })
    await expect(
      recordCustomerConsentDecision(
        await requestFor({ collection: 'admins', id: account.id, roles: [], status: 'active' }),
        account,
        { consentType: 'commercial_sms', decision: 'accept' },
      ),
    ).rejects.toMatchObject({ code: 'CONSENT_CHANGE_FORBIDDEN', status: 403 })
    await expect(
      recordCustomerConsentDecision(await requestFor(customerUser(other)), account, {
        consentType: 'commercial_sms',
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_CHANGE_FORBIDDEN', status: 403 })
    await expect(
      recordCustomerConsentDecision(await requestFor(customerUser(account)), account, {
        consentType: 'service_terms' as never,
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_TYPE_NOT_CUSTOMER_MANAGED', status: 400 })
    for (const invalidVersion of [null, -1, 0.5]) {
      await expect(
        recordCustomerConsentDecision(
          await requestFor(customerUser(account)),
          { ...account, consentStateVersion: invalidVersion } as Customer,
          { consentType: 'commercial_sms', decision: 'accept' },
        ),
      ).rejects.toMatchObject({ code: 'CONSENT_STATE_INVALID', status: 500 })
    }
    await expect(consentCount(Number(account.id))).resolves.toEqual({ totalDocs: 0 })
  })

  it('CAS consent writes constrain customer id, expected version, allowed status, and returned claim', async () => {
    const target = await customer()
    const neighbor = await customer()
    await accept(target, 'device_identifier_notice')
    await expect(storedCustomer(Number(neighbor.id))).resolves.toMatchObject({
      consentStateVersion: 0,
    })

    const staleVersion = await customer({ consentStateVersion: 1 })
    await expect(
      recordCustomerConsentDecision(
        await requestFor(customerUser(staleVersion)),
        { ...staleVersion, consentStateVersion: 0 } as Customer,
        { consentType: 'commercial_sms', decision: 'accept' },
      ),
    ).rejects.toMatchObject({ code: 'CONSENT_STATE_CONFLICT' })

    const suspended = await customer({ status: 'suspended' })
    await expect(
      recordCustomerConsentDecision(await requestFor(customerUser(suspended)), suspended, {
        consentType: 'commercial_sms',
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_STATE_CONFLICT' })
    await expect(consentCount(Number(staleVersion.id), 'commercial_sms')).resolves.toEqual({
      totalDocs: 0,
    })
    await expect(consentCount(Number(suspended.id), 'commercial_sms')).resolves.toEqual({
      totalDocs: 0,
    })
  })

  it('validates no-op consent reads against the same customer id, version, and allowed status', async () => {
    const qualifyingNeighbor = await customer()
    const nonexistent = {
      ...qualifyingNeighbor,
      id: 2_146_999_999,
      phone: 'a7-nonexistent',
      phoneMasked: '***none',
    } as Customer
    await expect(
      recordCustomerConsentDecision(await requestFor(customerUser(nonexistent)), nonexistent, {
        consentType: 'commercial_sms',
        decision: 'revoke',
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_STATE_CONFLICT' })

    const accepted = await customer()
    await accept(accepted, 'commercial_sms')
    await expect(
      recordCustomerConsentDecision(await requestFor(customerUser(accepted)), accepted, {
        consentType: 'commercial_sms',
        decision: 'accept',
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_STATE_CONFLICT' })

    const suspended = await customer({ consentStateVersion: 1, status: 'suspended' })
    const req = await requestFor(customerUser(suspended))
    await appendConsentAcceptance(req, {
      acceptedAt: new Date().toISOString(),
      consentType: 'commercial_sms',
      customerId: Number(suspended.id),
      headers: req.headers,
      source: 'account_privacy_center',
    })
    await expect(
      recordCustomerConsentDecision(
        await requestFor(customerUser({ ...suspended, status: 'active' })),
        { ...suspended, status: 'active' },
        { consentType: 'commercial_sms', decision: 'accept' },
      ),
    ).rejects.toMatchObject({ code: 'CONSENT_STATE_CONFLICT' })
  })

  it.each([
    ['missing record', undefined, undefined],
    ['revoked record', 'current', new Date().toISOString()],
    ['wrong document hash', 'wrong-hash', undefined],
    ['wrong document version', 'wrong-version', undefined],
  ])(
    'fails closed for %s when checking a required separate consent',
    async (_, variant, revokedAt) => {
      const account = await customer()
      if (variant) {
        const current = registrationConsentDocument('sensitive_personal_information')
        await payload.create({
          collection: 'consentRecords',
          data: {
            acceptedAt: new Date().toISOString(),
            consentType: 'sensitive_personal_information',
            customer: account.id,
            documentHash: variant === 'wrong-hash' ? '0'.repeat(64) : current.documentHash,
            documentVersion:
              variant === 'wrong-version' ? 'obsolete-sensitive-consent' : current.documentVersion,
            ipMasked: '198.51.100.0/24',
            revokedAt,
            source: 'account_privacy_center',
            userAgentSummary: 'A7 fixture',
          },
          overrideAccess: true,
        })
      }
      await expect(
        assertCustomerConsentActive(
          await requestFor(customerUser(account)),
          account.id,
          'sensitive_personal_information',
        ),
      ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED', status: 403 })
    },
  )

  it('never reuses another customer or another consent type when resolving current consent', async () => {
    const account = await customer()
    const other = await customer()
    await accept(other, 'sensitive_personal_information')
    await accept(account, 'commercial_sms')
    await expect(
      assertCustomerConsentActive(
        await requestFor(customerUser(account)),
        account.id,
        'sensitive_personal_information',
      ),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' })
    await expect(
      assertCustomerConsentActive(
        await requestFor(customerUser(account)),
        other.id,
        'sensitive_personal_information',
      ),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' })
  })

  it('requires sensitive-personal-information consent before creating a real-name template', async () => {
    const account = await customer()
    const req = await requestFor(customerUser(account), 'realname-consent')
    await expect(
      createRealnameTemplate(req, realnameTemplateFixture({ displayName: `a7-${randomUUID()}` })),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED', status: 403 })
    await accept(account, 'sensitive_personal_information')
    await expect(
      createRealnameTemplate(
        await requestFor(customerUser(account), 'realname-consented'),
        realnameTemplateFixture({ displayName: `a7-${randomUUID()}` }),
      ),
    ).resolves.toMatchObject({ customer: account.id, status: 'draft' })
  })

  it('flags a legacy account at login without inventing consent records', async () => {
    const rawPhone = `139${randomInt(10_000_000, 99_999_999)}`
    const account = await customer({
      accountType: 'legacy_unknown',
      defaultCustomerProfileType: undefined,
      phone: `+86${rawPhone}`,
      phoneMasked: `${rawPhone.slice(0, 3)}****${rawPhone.slice(-4)}`,
      registrationSource: 'legacy_unknown',
    })
    const result = await authenticateVerifiedPhone(await requestFor(), {
      deviceHash: 'a'.repeat(64),
      ipHash: 'b'.repeat(64),
      phone: rawPhone,
    })
    expect(result).toMatchObject({
      customer: { id: account.id, profileCompletionRequired: true },
      kind: 'authenticated',
    })
    await expect(consentCount(Number(account.id))).resolves.toEqual({ totalDocs: 0 })
  })

  it('allows exactly one of 8 legacy completions and records real evidence without rewriting provenance', async () => {
    const account = await customer({ accountType: 'legacy_unknown' })
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) =>
        completeLegacyCustomerProfile(
          await requestFor(customerUser(account), `legacy-concurrent-${index}`),
          account,
          { defaultCustomerProfileType: 'organization' },
        ),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(7)
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'LEGACY_PROFILE_COMPLETION_CONFLICT' })
      }
    }
    const stored = await storedCustomer(Number(account.id))
    expect(stored).toMatchObject({
      accountType: 'legacy_unknown',
      consentStateVersion: 1,
      defaultCustomerProfileType: 'organization',
      legacyProfileCompletedAt: expect.any(String),
      registrationSource: 'legacy_unknown',
    })
    const consents = await payload.find({
      collection: 'consentRecords',
      overrideAccess: true,
      sort: 'consentType',
      where: { customer: { equals: account.id } },
    })
    expect(consents.docs).toHaveLength(2)
    expect(consents.docs.map((record) => record.consentType).sort()).toEqual([
      'privacy_policy',
      'service_terms',
    ])
    for (const record of consents.docs) {
      expect(record).toMatchObject({
        acceptedAt: stored.legacyProfileCompletedAt,
        source: 'legacy_profile_completion',
        ...registrationConsentDocument(record.consentType as 'privacy_policy' | 'service_terms'),
      })
    }
    await expect(
      customerNeedsLegacyProfileCompletion(await requestFor(customerUser(stored)), stored),
    ).resolves.toBe(false)
    const audit = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'customer.legacy_profile.completed' } },
          { targetId: { equals: String(account.id) } },
        ],
      },
    })
    expect(audit.docs).toHaveLength(1)
    expect(audit.docs[0]?.metadata).toMatchObject({
      defaultCustomerProfileType: 'organization',
      registrationSource: 'legacy_unknown',
    })
  })

  it('rejects legacy completion for the wrong actor, non-legacy provenance, and completed snapshots', async () => {
    const account = await customer({ accountType: 'legacy_unknown' })
    const other = await customer()
    await expect(
      completeLegacyCustomerProfile(await requestFor(customerUser(other)), account, {
        defaultCustomerProfileType: 'individual',
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_CHANGE_FORBIDDEN' })
    for (const snapshot of [
      { ...account, accountType: 'registered' as const },
      { ...account, registrationSource: 'phone' as const },
    ]) {
      await expect(
        completeLegacyCustomerProfile(await requestFor(customerUser(snapshot)), snapshot, {
          defaultCustomerProfileType: 'individual',
        }),
      ).rejects.toMatchObject({ code: 'LEGACY_PROFILE_NOT_REQUIRED' })
    }
    await expect(
      completeLegacyCustomerProfile(
        await requestFor(customerUser(account)),
        { ...account, legacyProfileCompletedAt: new Date().toISOString() },
        { defaultCustomerProfileType: 'individual' },
      ),
    ).rejects.toMatchObject({ code: 'LEGACY_PROFILE_ALREADY_COMPLETED' })
    await expect(consentCount(Number(account.id))).resolves.toEqual({ totalDocs: 0 })
  })

  it.each([
    [
      'default customer type',
      {
        defaultCustomerProfileType: undefined,
        legacyProfileCompletedAt: '2026-08-16T00:00:00.000Z',
      },
    ],
    [
      'completion timestamp',
      { defaultCustomerProfileType: 'individual', legacyProfileCompletedAt: undefined },
    ],
    [
      'current service-terms evidence',
      {
        defaultCustomerProfileType: 'individual',
        legacyProfileCompletedAt: '2026-08-16T00:00:00.000Z',
      },
    ],
    [
      'current privacy-policy evidence',
      {
        defaultCustomerProfileType: 'individual',
        legacyProfileCompletedAt: '2026-08-16T00:00:00.000Z',
      },
    ],
  ])('keeps legacy completion required when only %s is missing', async (missingPart, overrides) => {
    const account = await customer({
      accountType: 'legacy_unknown',
      ...overrides,
    } as Parameters<typeof customer>[0])
    const presentConsentTypes =
      missingPart === 'current service-terms evidence'
        ? (['privacy_policy'] as const)
        : missingPart === 'current privacy-policy evidence'
          ? (['service_terms'] as const)
          : (['service_terms', 'privacy_policy'] as const)
    const req = await requestFor(customerUser(account))
    for (const consentType of presentConsentTypes) {
      await appendConsentAcceptance(req, {
        acceptedAt: new Date().toISOString(),
        consentType,
        customerId: Number(account.id),
        headers: req.headers,
        source: 'legacy_profile_completion',
      })
    }
    await expect(
      customerNeedsLegacyProfileCompletion(await requestFor(customerUser(account)), account),
    ).resolves.toBe(true)
  })

  it.each([
    ['account type', { accountType: 'registered', registrationSource: 'legacy_unknown' }],
    ['registration source', { accountType: 'legacy_unknown', registrationSource: 'phone' }],
    [
      'completion timestamp',
      {
        accountType: 'legacy_unknown',
        legacyProfileCompletedAt: '2026-08-16T00:00:00.000Z',
        registrationSource: 'legacy_unknown',
      },
    ],
    [
      'consent version',
      {
        accountType: 'legacy_unknown',
        consentStateVersion: 1,
        registrationSource: 'legacy_unknown',
      },
    ],
    [
      'allowed status',
      { accountType: 'legacy_unknown', registrationSource: 'legacy_unknown', status: 'suspended' },
    ],
  ])('completion CAS rejects a stale %s database predicate', async (_, storedOverrides) => {
    const stored = await customer(storedOverrides as Parameters<typeof customer>[0])
    const stale = {
      ...stored,
      accountType: 'legacy_unknown' as const,
      consentStateVersion: 0,
      legacyProfileCompletedAt: null,
      registrationSource: 'legacy_unknown' as const,
      status: 'active' as const,
    }
    await expect(
      completeLegacyCustomerProfile(await requestFor(customerUser(stale)), stale, {
        defaultCustomerProfileType: 'individual',
      }),
    ).rejects.toMatchObject({ code: 'LEGACY_PROFILE_COMPLETION_CONFLICT' })
    await expect(consentCount(Number(stored.id))).resolves.toEqual({ totalDocs: 0 })
  })

  it('completion CAS updates only the target customer id', async () => {
    const target = await customer({ accountType: 'legacy_unknown' })
    const neighbor = await customer({ accountType: 'legacy_unknown' })
    await completeLegacyCustomerProfile(await requestFor(customerUser(target)), target, {
      defaultCustomerProfileType: 'individual',
    })
    await expect(storedCustomer(Number(neighbor.id))).resolves.toMatchObject({
      consentStateVersion: 0,
      legacyProfileCompletedAt: null,
    })
  })

  it('blocks only new registration orders while a legacy profile is incomplete', async () => {
    const account = await customer({ accountType: 'legacy_unknown' })
    const req = await requestFor(customerUser(account), 'legacy-purchase')
    const registration = quoteFor(Number(account.id), 'registration')
    await expect(
      createCustomerOrder(
        req,
        { quoteRef: registration.quote.quoteRef, realnameTemplateId: 1 },
        {
          customer: customerUser(account),
          provider: new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() }),
          quoteStore: registration.store,
          rules: PRICING_RULE_FIXTURES,
          traceId: 'd9a-a7-registration-block',
        },
      ),
    ).rejects.toMatchObject({ code: 'LEGACY_PROFILE_COMPLETION_REQUIRED', status: 403 })

    const renewal = quoteFor(Number(account.id), 'renewal')
    await expect(
      createCustomerOrder(
        await requestFor(customerUser(account), 'legacy-renewal'),
        { quoteRef: renewal.quote.quoteRef },
        {
          customer: customerUser(account),
          provider: new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() }),
          quoteStore: renewal.store,
          rules: PRICING_RULE_FIXTURES,
          traceId: 'd9a-a7-renewal-allowed',
        },
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_ASSET_NOT_FOUND', status: 404 })
    await expect(
      listCustomerDomainAssets(await requestFor(customerUser(account)), customerUser(account)),
    ).resolves.toMatchObject({ state: 'empty' })
  })

  it('allows registration after legacy completion has current terms and privacy evidence', async () => {
    const registered = await customer()
    await expect(
      customerNeedsLegacyProfileCompletion(await requestFor(customerUser(registered)), registered),
    ).resolves.toBe(false)
    const account = await customer({ accountType: 'legacy_unknown' })
    await expect(
      assertLegacyRegistrationPurchaseAllowed(
        await requestFor(customerUser(account)),
        Number(account.id),
      ),
    ).rejects.toMatchObject({ code: 'LEGACY_PROFILE_COMPLETION_REQUIRED' })
    await completeLegacyCustomerProfile(await requestFor(customerUser(account)), account, {
      defaultCustomerProfileType: 'individual',
    })
    await expect(
      assertLegacyRegistrationPurchaseAllowed(
        await requestFor(customerUser(account)),
        Number(account.id),
      ),
    ).resolves.toBeUndefined()

    const other = await customer()
    await expect(
      assertLegacyRegistrationPurchaseAllowed(
        await requestFor(customerUser(other)),
        Number(account.id),
      ),
    ).rejects.toThrow()
  })

  it('isolates personal-information reads, excludes internal identity secrets, and audits customer/admin access', async () => {
    const account = await customer()
    const other = await customer()
    const identitySuffix = randomUUID()
    await payload.create({
      collection: 'customerIdentities',
      data: {
        boundAt: new Date().toISOString(),
        customer: account.id,
        identifierEncrypted: 'secret-encrypted-identifier',
        identifierHash: `secret-identifier-hash-${identitySuffix}`,
        provider: 'phone',
        providerInstanceId: `a7-provider-instance-${identitySuffix}`,
        status: 'active',
        unionid: 'secret-unionid',
        verifiedAt: new Date().toISOString(),
      },
      overrideAccess: true,
    })
    const selfReq = await requestFor(customerUser(account), 'personal-self')
    const selfView = await readPersonalInformation(selfReq, {
      customerId: account.id,
      mode: 'export',
    })
    expect(selfView.profile).toMatchObject({ id: account.id, phone: account.phone })
    expect(selfView.identities).toHaveLength(1)
    expect(selfView.identities[0]).not.toHaveProperty('identifierEncrypted')
    expect(selfView.identities[0]).not.toHaveProperty('identifierHash')
    expect(selfView.identities[0]).not.toHaveProperty('providerInstanceId')
    expect(selfView.identities[0]).not.toHaveProperty('unionid')
    expect(selfView.retention).toEqual({
      accountAndTransactionSchedule: 'pending_external_legal_review',
      consentHistory: 'append_only_evidence',
      exportPersistence: 'not_persisted',
      realnameDeletionDeadlineDays: 30,
    })
    const selfAudit = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'customer.personal_information.exported' } },
          { targetId: { equals: String(account.id) } },
          { traceId: { equals: 'd9a-a7-personal-self' } },
        ],
      },
    })
    expect(selfAudit.docs).toHaveLength(1)
    expect(selfAudit.docs[0]?.metadata).toMatchObject({ purpose: 'customer_self_service' })
    await expect(
      readPersonalInformation(await requestFor(customerUser(other)), {
        customerId: account.id,
        mode: 'view',
      }),
    ).rejects.toThrow()
    await expect(
      readPersonalInformation(await requestFor(), { customerId: account.id, mode: 'view' }),
    ).rejects.toMatchObject({ code: 'PERSONAL_INFORMATION_ACCESS_FORBIDDEN' })
    await expect(
      readPersonalInformation(
        await requestFor({ collection: 'unexpected-principal', id: account.id }),
        { customerId: account.id, mode: 'view' },
      ),
    ).rejects.toMatchObject({ code: 'PERSONAL_INFORMATION_ACCESS_FORBIDDEN' })

    const adminReq = await requestFor(
      {
        collection: 'admins',
        id: `a7-admin-${randomUUID()}`,
        roles: ['system_admin'],
        status: 'active',
      },
      'personal-admin',
    )
    await expect(
      readPersonalInformation(adminReq, {
        customerId: account.id,
        mode: 'view',
        purpose: 'handle verified customer privacy request',
      }),
    ).resolves.toMatchObject({ profile: { id: account.id } })
    const audits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { targetId: { equals: String(account.id) } },
          {
            action: {
              in: [
                'customer.personal_information.exported',
                'customer.personal_information.viewed',
              ],
            },
          },
        ],
      },
    })
    expect(audits.docs).toHaveLength(2)
    expect(audits.docs.map((audit) => audit.actorType).sort()).toEqual(['admin', 'customer'])
    expect(audits.docs.find((audit) => audit.actorType === 'admin')?.metadata).toMatchObject({
      purpose: 'handle verified customer privacy request',
    })
  })
})
