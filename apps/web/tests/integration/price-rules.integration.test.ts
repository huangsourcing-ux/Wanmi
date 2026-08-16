import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import { assertQuoteAmountAndRuleUsableForOrder } from '@/services/commerce/order-creation'
import {
  createCustomerQuote,
  getUsableCustomerQuote,
  PayloadCustomerQuoteStore,
} from '@/services/pricing/customer-quotes'
import { calculateTldPrice } from '@/services/pricing/price-calculation'
import { loadEnabledPricingRules } from '@/services/pricing/price-rules'
import { PayloadPriceSnapshotStore } from '@/services/pricing/price-snapshots'

const fixturePrefix = `d5-price-rules-${randomUUID()}`
const fixtureTld = `${fixturePrefix}.com`
const created: Array<{
  collection: 'auditLogs' | 'customers' | 'priceRules' | 'priceSnapshots' | 'quotes'
  id: number | string
}> = []
let payload: Payload

const systemAdmin = {
  collection: 'admins' as const,
  email: `${fixturePrefix}@example.test`,
  id: 55_005,
  roles: ['system_admin' as const],
  status: 'active' as const,
}
const contentEditor = {
  ...systemAdmin,
  id: 55_006,
  roles: ['content_editor' as const],
}

async function requestFor(user: unknown, suffix: string): Promise<PayloadRequest> {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) } },
    payload,
  )
  req.user = user as never
  return req
}

async function createRule(
  req: PayloadRequest,
  data: {
    enabled: boolean
    fixedAmountMinor?: number | null
    mode: 'fixed' | 'percentage'
    percentageBasisPoints?: number | null
    tld: string
  },
) {
  const rule = await payload.create({
    collection: 'priceRules',
    data: { effectiveAt: '2000-01-01T00:00:00.000Z', ...data },
    overrideAccess: false,
    req,
    user: req.user,
  })
  created.push({ collection: 'priceRules', id: rule.id })
  return rule
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 100,
    overrideAccess: true,
    where: { traceId: { contains: fixturePrefix } },
  })
  for (const audit of audits.docs) created.push({ collection: 'auditLogs', id: audit.id })
  for (const item of created.reverse()) {
    await payload
      .delete({
        collection: item.collection,
        ...(item.collection === 'priceRules' ? { context: { skipPriceRuleAudit: true } } : {}),
        id: item.id,
        overrideAccess: true,
      } as never)
      .catch(() => undefined)
  }
  await payload.db.destroy?.()
})

describe('D5-05 managed TLD price rules', () => {
  it('enforces system-admin writes, validates amounts at write time and audits every publication', async () => {
    const adminReq = await requestFor(systemAdmin, 'manage')
    const editorReq = await requestFor(contentEditor, 'forbidden')
    await expect(
      createRule(editorReq, {
        enabled: true,
        fixedAmountMinor: 500,
        mode: 'fixed',
        tld: `${fixturePrefix}-forbidden.com`,
      }),
    ).rejects.toThrow()

    const invalidRules = [
      { enabled: true, fixedAmountMinor: -1, mode: 'fixed' as const, tld: fixtureTld },
      { enabled: true, mode: 'percentage' as const, percentageBasisPoints: 1.5, tld: fixtureTld },
      {
        enabled: true,
        fixedAmountMinor: 500,
        mode: 'percentage' as const,
        percentageBasisPoints: 1_000,
        tld: fixtureTld,
      },
    ]
    for (const invalid of invalidRules) {
      await expect(createRule(adminReq, invalid)).rejects.toThrow()
    }

    const percentageReq = await requestFor(systemAdmin, 'percentage')
    const percentageRule = await createRule(percentageReq, {
      enabled: true,
      mode: 'percentage',
      percentageBasisPoints: 1_000,
      tld: `${fixturePrefix}-percentage.com`,
    })
    expect(percentageRule.fixedAmountMinor).toBeNull()
    expect(await loadEnabledPricingRules(payload, percentageReq)).toHaveProperty(percentageRule.tld)
    await payload.delete({
      collection: 'priceRules',
      id: percentageRule.id,
      overrideAccess: false,
      req: percentageReq,
      user: systemAdmin,
    })
    const percentageAudits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      sort: 'createdAt',
      where: { traceId: { equals: `${fixturePrefix}-percentage` } },
    })
    expect(percentageAudits.docs.map((audit) => audit.action)).toEqual([
      'pricing.rule.created',
      'pricing.rule.deleted',
    ])

    const rule = await createRule(adminReq, {
      enabled: true,
      fixedAmountMinor: 500,
      mode: 'fixed',
      tld: `.${fixtureTld.toUpperCase()}`,
    })
    expect(rule.tld).toBe(fixtureTld)
    expect(rule.effectiveAt).not.toBe('2000-01-01T00:00:00.000Z')
    expect(await loadEnabledPricingRules(payload, adminReq)).toHaveProperty(fixtureTld)

    const updated = await payload.update({
      collection: 'priceRules',
      data: { fixedAmountMinor: 600 },
      id: rule.id,
      overrideAccess: false,
      req: adminReq,
      user: systemAdmin,
    })
    expect(updated.fixedAmountMinor).toBe(600)
    await payload.update({
      collection: 'priceRules',
      data: { enabled: false },
      id: rule.id,
      overrideAccess: false,
      req: adminReq,
      user: systemAdmin,
    })
    expect(await loadEnabledPricingRules(payload, adminReq)).not.toHaveProperty(fixtureTld)
    await payload.update({
      collection: 'priceRules',
      data: { enabled: true },
      id: rule.id,
      overrideAccess: false,
      req: adminReq,
      user: systemAdmin,
    })

    const audits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      sort: 'createdAt',
      where: { traceId: { equals: `${fixturePrefix}-manage` } },
    })
    expect(audits.docs.map((audit) => audit.action)).toEqual([
      'pricing.rule.created',
      'pricing.rule.updated',
      'pricing.rule.disabled',
      'pricing.rule.enabled',
    ])
    expect(audits.docs.every((audit) => audit.actorId === String(systemAdmin.id))).toBe(true)
    expect(audits.docs[1]).toMatchObject({
      actorType: 'admin',
      metadata: {
        after: expect.objectContaining({ fixedAmountMinor: 600, mode: 'fixed', tld: fixtureTld }),
        before: expect.objectContaining({ fixedAmountMinor: 500, mode: 'fixed', tld: fixtureTld }),
        effectiveAt: expect.any(String),
      },
      targetType: 'price-rule',
    })
  })

  it('keeps an old quote replayable after a rule revision while blocking old-price ordering', async () => {
    const adminReq = await requestFor(systemAdmin, 'snapshot-admin')
    const rule = await createRule(adminReq, {
      enabled: true,
      fixedAmountMinor: 500,
      mode: 'fixed',
      tld: `${fixturePrefix}-snapshot.com`,
    })
    const oldRules = await loadEnabledPricingRules(payload, adminReq)
    const customer = await payload.create({
      collection: 'customers',
      data: {
        capabilityRestrictions: [],
        phone: `${fixturePrefix}-customer`,
        phoneMasked: '***5005',
        status: 'active',
      },
      overrideAccess: true,
    })
    created.push({ collection: 'customers', id: customer.id })
    const customerIdentity = { ...customer, collection: 'customers' as const }
    const customerReq = await requestFor(customerIdentity, 'snapshot-customer')
    const quoteStore = new PayloadCustomerQuoteStore(customerReq, customerIdentity)
    const quoteResult = await createCustomerQuote(
      { domain: `example.${rule.tld}`, years: 3 },
      {
        customer: customerIdentity,
        now: () => Date.parse('2026-08-08T12:00:00.000Z'),
        provider: new WestDigitalReadAdapter({ transport: new FixtureWestDigitalTransport() }),
        quoteStore,
        rules: oldRules,
        snapshots: new PayloadPriceSnapshotStore(payload),
        supportedTlds: new Set([rule.tld]),
        traceId: `${fixturePrefix}-quote`,
      },
    )
    if (!('data' in quoteResult) || !quoteResult.data.quote) throw new Error('Expected quote')
    const quoteRows = await payload.find({
      collection: 'quotes',
      overrideAccess: true,
      where: { quoteRef: { equals: quoteResult.data.quote.quoteRef } },
    })
    const quoteDocument = quoteRows.docs[0]!
    created.push({ collection: 'quotes', id: quoteDocument.id })
    const snapshots = await payload.find({
      collection: 'priceSnapshots',
      overrideAccess: true,
      where: { snapshotRef: { equals: quoteDocument.sourcePriceSnapshotRef } },
    })
    created.push({ collection: 'priceSnapshots', id: snapshots.docs[0]!.id })

    const oldQuote = await getUsableCustomerQuote({
      customer: customerIdentity,
      now: () => Date.parse('2026-08-08T12:04:00.000Z'),
      quoteRef: quoteDocument.quoteRef,
      store: quoteStore,
    })
    const replayBefore = calculateTldPrice({
      registrationPriceFen: oldQuote.calculation.upstreamRegistrationPriceFen,
      renewalPriceFen: oldQuote.calculation.upstreamRenewalPriceFen,
      rule: oldQuote.calculation.rule,
    })
    expect(replayBefore).toEqual(oldQuote.calculation)

    await payload.update({
      collection: 'priceRules',
      data: { fixedAmountMinor: 900 },
      id: rule.id,
      overrideAccess: false,
      req: adminReq,
      user: systemAdmin,
    })
    const newRules = await loadEnabledPricingRules(payload, adminReq)
    const oldQuoteAfterChange = await getUsableCustomerQuote({
      customer: customerIdentity,
      now: () => Date.parse('2026-08-08T12:04:00.000Z'),
      quoteRef: quoteDocument.quoteRef,
      store: quoteStore,
    })
    expect(oldQuoteAfterChange.calculation).toEqual(oldQuote.calculation)
    expect(oldQuoteAfterChange.quoteIntegrityHash).toBe(oldQuote.quoteIntegrityHash)
    expect(() =>
      assertQuoteAmountAndRuleUsableForOrder(oldQuoteAfterChange, {
        rules: newRules,
        supportedTlds: new Set([rule.tld]),
      }),
    ).toThrowError(expect.objectContaining({ code: 'QUOTE_PRICE_CHANGED' }))
  })
})
