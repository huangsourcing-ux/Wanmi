import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AdminRole } from '@/lib/domain'
import type { Article } from '@/payload-types'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

import { realnameTemplateFixture } from '../fixtures/realname'

type FixtureCollection =
  | 'advertisers'
  | 'articles'
  | 'auditLogs'
  | 'customers'
  | 'manualReviews'
  | 'orderEvents'
  | 'orders'
  | 'priceRules'
  | 'quotes'
  | 'realnameTemplates'
  | 'userFeedback'

const fixturePrefix = `d1-rbac-${randomUUID()}`
const created: Array<{ collection: FixtureCollection; id: number | string }> = []
let payload: Payload

const richText: Article['content'] = {
  root: {
    children: [
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'D1 RBAC fixture',
            type: 'text',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: '',
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
}

function admin(role: AdminRole, id: number) {
  return {
    collection: 'admins' as const,
    email: `${role}-${id}@example.test`,
    id,
    roles: [role],
    status: 'active' as const,
  }
}

async function remember<T extends { id: number | string }>(
  collection: FixtureCollection,
  operation: Promise<T>,
): Promise<T> {
  const document = await operation
  created.push({ collection, id: document.id })
  return document
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  for (const fixture of created.reverse()) {
    await payload
      .delete({
        collection: fixture.collection,
        ...(fixture.collection === 'priceRules' ? { context: { skipPriceRuleAudit: true } } : {}),
        id: fixture.id,
        overrideAccess: true,
      } as never)
      .catch(() => undefined)
  }
  await payload.db.destroy?.()
})

describe('D1 Payload role boundaries', () => {
  it('prevents content and advertising roles from crossing write boundaries', async () => {
    const contentEditor = admin('content_editor', 1101)
    const adOperator = admin('ad_operator', 1102)
    const analyst = admin('analyst', 1103)
    const systemAdmin = admin('system_admin', 1104)

    await remember(
      'articles',
      payload.create({
        collection: 'articles',
        data: {
          _status: 'draft',
          content: richText,
          slug: `${fixturePrefix}-content-role`,
          title: `${fixturePrefix} content role`,
        },
        draft: true,
        overrideAccess: false,
        user: contentEditor as never,
      }),
    )
    await expect(
      payload.create({
        collection: 'advertisers',
        data: { name: `${fixturePrefix}-content-cross-write`, status: 'active' },
        overrideAccess: false,
        user: contentEditor as never,
      }),
    ).rejects.toThrow()

    const advertiser = await remember(
      'advertisers',
      payload.create({
        collection: 'advertisers',
        data: {
          name: `${fixturePrefix}-ad-role`,
          notes: 'operator-only note',
          status: 'active',
        },
        overrideAccess: false,
        user: adOperator as never,
      }),
    )
    await expect(
      payload.create({
        collection: 'articles',
        data: {
          _status: 'draft',
          content: richText,
          slug: `${fixturePrefix}-ad-cross-write`,
          title: `${fixturePrefix} ad cross write`,
        },
        draft: true,
        overrideAccess: false,
        user: adOperator as never,
      }),
    ).rejects.toThrow()
    await expect(
      payload.update({
        collection: 'advertisers',
        data: { status: 'paused' },
        id: advertiser.id,
        overrideAccess: false,
        user: analyst as never,
      }),
    ).rejects.toThrow()
    await remember(
      'priceRules',
      payload.create({
        collection: 'priceRules',
        data: {
          effectiveAt: new Date().toISOString(),
          enabled: false,
          fixedAmountMinor: 100,
          mode: 'fixed',
          tld: `${fixturePrefix}.test`,
        },
        overrideAccess: false,
        user: systemAdmin as never,
      }),
    )
    await expect(
      payload.create({
        collection: 'priceRules',
        data: {
          effectiveAt: new Date().toISOString(),
          enabled: false,
          fixedAmountMinor: 100,
          mode: 'fixed',
          tld: `${fixturePrefix}-forbidden.test`,
        },
        overrideAccess: false,
        user: contentEditor as never,
      }),
    ).rejects.toThrow()
  })

  it('gives analysts only safe advertising and feedback fields', async () => {
    const adOperator = admin('ad_operator', 1201)
    const analyst = admin('analyst', 1202)
    const systemAdmin = admin('system_admin', 1203)
    const customer = await remember(
      'customers',
      payload.create({
        collection: 'customers',
        data: {
          phone: `${fixturePrefix}-feedback-phone`,
          phoneMasked: '***1203',
          status: 'active',
        },
        overrideAccess: true,
      }),
    )
    const advertiser = await remember(
      'advertisers',
      payload.create({
        collection: 'advertisers',
        data: {
          name: `${fixturePrefix}-analyst-read`,
          notes: 'commercially sensitive note',
          status: 'active',
        },
        overrideAccess: true,
      }),
    )
    const feedback = await remember(
      'userFeedback',
      payload.create({
        collection: 'userFeedback',
        data: {
          category: 'feedback',
          customer: customer.id,
          message: 'operator-visible feedback body',
          status: 'new',
        },
        overrideAccess: true,
      }),
    )

    const analystAdvertiser = await payload.findByID({
      collection: 'advertisers',
      id: advertiser.id,
      overrideAccess: false,
      user: analyst as never,
    })
    expect(analystAdvertiser).not.toHaveProperty('notes')
    expect(
      await payload.findByID({
        collection: 'advertisers',
        id: advertiser.id,
        overrideAccess: false,
        user: adOperator as never,
      }),
    ).toHaveProperty('notes', 'commercially sensitive note')

    const analystFeedback = await payload.findByID({
      collection: 'userFeedback',
      id: feedback.id,
      overrideAccess: false,
      user: analyst as never,
    })
    expect(analystFeedback).not.toHaveProperty('customer')
    expect(analystFeedback).not.toHaveProperty('message')
    const operatorFeedback = await payload.findByID({
      collection: 'userFeedback',
      id: feedback.id,
      overrideAccess: false,
      user: adOperator as never,
    })
    expect(operatorFeedback).not.toHaveProperty('customer')
    expect(operatorFeedback).toHaveProperty('message', 'operator-visible feedback body')
    const systemFeedback = await payload.findByID({
      collection: 'userFeedback',
      id: feedback.id,
      overrideAccess: false,
      user: systemAdmin as never,
    })
    expect(systemFeedback).toHaveProperty('customer')
    expect(systemFeedback).toHaveProperty('message', 'operator-visible feedback body')
  })

  it('confines customers to their rows and redacts internal commerce fields', async () => {
    const owner = await remember(
      'customers',
      payload.create({
        collection: 'customers',
        data: {
          phone: `${fixturePrefix}-owner-phone`,
          phoneMasked: '***1301',
          status: 'active',
        },
        overrideAccess: true,
      }),
    )
    const other = await remember(
      'customers',
      payload.create({
        collection: 'customers',
        data: {
          phone: `${fixturePrefix}-other-phone`,
          phoneMasked: '***1302',
          status: 'active',
        },
        overrideAccess: true,
      }),
    )
    const ownerUser = { ...owner, collection: 'customers' as const }
    const otherUser = { ...other, collection: 'customers' as const }
    const template = await remember(
      'realnameTemplates',
      payload.create({
        collection: 'realnameTemplates',
        data: {
          ...realnameTemplateFixture(),
          customer: owner.id,
          displayName: `${fixturePrefix}-template`,
        },
        overrideAccess: true,
      }),
    )
    const quote = await remember(
      'quotes',
      payload.create({
        collection: 'quotes',
        data: {
          availabilityObservedAt: new Date().toISOString(),
          availabilityRequestId: `${fixturePrefix}-availability`,
          calculationFormula: 'registration_price_plus_annual_renewal_price',
          calculationVersion: 1,
          createdTraceId: `${fixturePrefix}-trace`,
          currency: 'CNY',
          customer: owner.id,
          domainAscii: `${fixturePrefix}.test`,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          priceClass: 'standard',
          provider: 'westdigital_fixture',
          providerCacheStatus: 'miss',
          providerObservedAt: new Date().toISOString(),
          providerProductId: `${fixturePrefix}-product`,
          providerRequestId: `${fixturePrefix}-price`,
          quotedAt: new Date().toISOString(),
          quoteIntegrityHash: '0'.repeat(64),
          quoteRef: randomUUID(),
          registrationPriceMinor: 120,
          renewalPriceMinor: 120,
          ruleFixedAmountMinor: 20,
          ruleKey: `${fixturePrefix}-rule`,
          ruleMode: 'fixed',
          ruleSource: 'wanmi_fixture',
          ruleVersion: 1,
          roundingMode: 'half_up_to_fen',
          schemaVersion: 1,
          sourceCalculationHash: '1'.repeat(64),
          sourcePriceSnapshotRef: randomUUID(),
          tld: 'test',
          upstreamCostMinor: 100,
          upstreamRegistrationPriceMinor: 100,
          upstreamRenewalPriceMinor: 100,
          userPriceMinor: 120,
          years: 1,
        },
        overrideAccess: true,
      }),
    )
    const order = await remember(
      'orders',
      payload.create({
        collection: 'orders',
        data: {
          amountMinor: 120,
          currency: 'CNY',
          customer: owner.id,
          domainAscii: `${fixturePrefix}.test`,
          orderNumber: `${fixturePrefix}-order`,
          quote: quote.id,
          quoteSnapshot: { upstreamCostMinor: 100 },
          realnameTemplate: template.id,
          status: 'pending_payment',
        },
        overrideAccess: true,
      }),
    )
    const event = await remember(
      'orderEvents',
      payload.create({
        collection: 'orderEvents',
        data: {
          actorId: 'internal-actor',
          actorType: 'system',
          customer: owner.id,
          evidence: { provider: 'internal' },
          note: 'internal note',
          order: order.id,
          reasonCode: 'fixture.created',
          toStatus: 'pending_payment',
        },
        overrideAccess: true,
      }),
    )

    const ownerQuote = await payload.findByID({
      collection: 'quotes',
      id: quote.id,
      overrideAccess: false,
      user: ownerUser as never,
    })
    expect(ownerQuote).not.toHaveProperty('upstreamCostMinor')
    expect(ownerQuote).not.toHaveProperty('ruleKey')
    expect(ownerQuote).not.toHaveProperty('upstreamRegistrationPriceMinor')
    expect(ownerQuote).toHaveProperty('userPriceMinor', 120)

    const ownerOrder = await payload.findByID({
      collection: 'orders',
      id: order.id,
      overrideAccess: false,
      user: ownerUser as never,
    })
    expect(ownerOrder).not.toHaveProperty('quoteSnapshot')
    const ownerEvent = await payload.findByID({
      collection: 'orderEvents',
      id: event.id,
      overrideAccess: false,
      user: ownerUser as never,
    })
    expect(ownerEvent).not.toHaveProperty('actorId')
    expect(ownerEvent).not.toHaveProperty('evidence')
    expect(ownerEvent).not.toHaveProperty('note')

    const foreignQuotes = await payload.find({
      collection: 'quotes',
      overrideAccess: false,
      user: otherUser as never,
      where: { id: { equals: quote.id } },
    })
    expect(foreignQuotes.totalDocs).toBe(0)
  })

  it('limits ad operator audit reads and keeps metadata system-only', async () => {
    const adOperator = admin('ad_operator', 1401)
    const analyst = admin('analyst', 1402)
    const systemAdmin = admin('system_admin', 1403)
    for (const actorId of [String(adOperator.id), 'another-admin']) {
      await remember(
        'auditLogs',
        payload.create({
          collection: 'auditLogs',
          data: {
            action: 'advertiser.update',
            actorId,
            actorType: 'admin',
            metadata: { before: 'private' },
            targetId: `${fixturePrefix}-${actorId}`,
            targetType: fixturePrefix,
            traceId: `${fixturePrefix}-${actorId}`,
          },
          overrideAccess: true,
        }),
      )
    }

    const operatorLogs = await payload.find({
      collection: 'auditLogs',
      overrideAccess: false,
      user: adOperator as never,
      where: { targetType: { equals: fixturePrefix } },
    })
    expect(operatorLogs.docs).toHaveLength(1)
    expect(operatorLogs.docs[0]).toHaveProperty('actorId', String(adOperator.id))
    expect(operatorLogs.docs[0]).not.toHaveProperty('metadata')

    await expect(
      payload.find({
        collection: 'auditLogs',
        overrideAccess: false,
        user: analyst as never,
        where: { targetType: { equals: fixturePrefix } },
      }),
    ).rejects.toThrow()

    const systemLogs = await payload.find({
      collection: 'auditLogs',
      overrideAccess: false,
      user: systemAdmin as never,
      where: { targetType: { equals: fixturePrefix } },
    })
    expect(systemLogs.docs).toHaveLength(2)
    expect(systemLogs.docs.every((document) => document.metadata)).toBe(true)
  })

  it('stores common audit events with normalized attribution and redacted metadata', async () => {
    const adOperator = admin('ad_operator', 1451)
    const analyst = admin('analyst', 1452)
    const systemAdmin = admin('system_admin', 1453)
    const traceId = `${fixturePrefix}-shared-audit`
    const req = await createLocalReq(
      { req: { headers: new Headers({ 'x-request-id': traceId }) } },
      payload,
    )
    req.user = adOperator as never
    await recordAuditEvent(req, {
      action: 'admin.account.changed',
      metadata: {
        identityNumber: '11010519491231002X',
        phone: '13812345678',
        phoneMasked: '138****5678',
        tokenHash: 'safe-token-hash',
      },
      targetId: adOperator.id,
    })

    const stored = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: { traceId: { equals: traceId } },
    })
    expect(stored.docs).toHaveLength(1)
    created.push({ collection: 'auditLogs', id: stored.docs[0]!.id })
    expect(stored.docs[0]).toMatchObject({
      action: 'admin.account.changed',
      actorId: String(adOperator.id),
      actorType: 'admin',
      metadata: {
        identityNumber: '[REDACTED]',
        phone: '[REDACTED]',
        phoneMasked: '138****5678',
        tokenHash: 'safe-token-hash',
      },
      targetId: String(adOperator.id),
      targetType: 'admin',
    })

    const ownView = await payload.find({
      collection: 'auditLogs',
      overrideAccess: false,
      user: adOperator as never,
      where: { traceId: { equals: traceId } },
    })
    expect(ownView.docs).toHaveLength(1)
    expect(ownView.docs[0]).not.toHaveProperty('metadata')
    await expect(
      payload.find({
        collection: 'auditLogs',
        overrideAccess: false,
        user: analyst as never,
        where: { traceId: { equals: traceId } },
      }),
    ).rejects.toThrow()
    const systemView = await payload.find({
      collection: 'auditLogs',
      overrideAccess: false,
      user: systemAdmin as never,
      where: { traceId: { equals: traceId } },
    })
    expect(systemView.docs[0]?.metadata).toEqual(stored.docs[0]?.metadata)
  })

  it('rejects generic sensitive mutations while trusted system operations remain available', async () => {
    const customer = await remember(
      'customers',
      payload.create({
        collection: 'customers',
        data: {
          phone: `${fixturePrefix}-sensitive-phone`,
          phoneMasked: '***1501',
          status: 'active',
        },
        overrideAccess: true,
      }),
    )
    const customerUser = { ...customer, collection: 'customers' as const }
    const systemAdmin = admin('system_admin', 1502)

    await expect(
      payload.create({
        collection: 'realnameTemplates',
        data: {
          ...realnameTemplateFixture(),
          customer: customer.id,
          displayName: `${fixturePrefix}-generic-write`,
          status: 'draft',
        } as never,
        overrideAccess: false,
        user: customerUser as never,
      }),
    ).rejects.toThrow()

    const trustedTemplate = await remember(
      'realnameTemplates',
      payload.create({
        collection: 'realnameTemplates',
        data: {
          ...realnameTemplateFixture(),
          customer: customer.id,
          displayName: `${fixturePrefix}-trusted-write`,
        },
        overrideAccess: true,
      }),
    )
    await expect(
      payload.update({
        collection: 'realnameTemplates',
        data: { status: 'approved' },
        id: trustedTemplate.id,
        overrideAccess: false,
        user: systemAdmin as never,
      }),
    ).rejects.toThrow()
    await expect(
      payload.update({
        collection: 'realnameTemplates',
        data: { status: 'approved' },
        id: trustedTemplate.id,
        overrideAccess: true,
      }),
    ).rejects.toThrow(/只能通过实名服务变更/u)
  })
})
