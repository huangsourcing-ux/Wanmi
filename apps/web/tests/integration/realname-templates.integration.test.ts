import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MockWestDigitalRealnameAdapter } from '@/providers/westdigital-realname'
import {
  assertRealnameTemplateUsableForRegistration,
  createRealnameTemplate,
  disableRealnameTemplate,
  submitRealnameTemplate,
  syncRealnameTemplateStatus,
} from '@/services/realname/templates'

import { realnameTemplateFixture } from '../fixtures/realname'

const fixturePrefix = `d4-realname-${randomUUID()}`
const created: Array<{ collection: 'customers' | 'realnameTemplates'; id: number | string }> = []
let payload: Payload

async function requestFor(user: unknown, suffix: string) {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) } },
    payload,
  )
  req.user = user as never
  return req
}

async function systemRequest(suffix: string) {
  return createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) } },
    payload,
  )
}

async function customer(last4: string) {
  const document = await payload.create({
    collection: 'customers',
    data: { phone: `1380000${last4}`, phoneMasked: `138****${last4}`, status: 'active' },
    overrideAccess: true,
  })
  created.push({ collection: 'customers', id: document.id })
  return { ...document, collection: 'customers' as const }
}

async function createTemplate(user: Awaited<ReturnType<typeof customer>>, suffix: string) {
  const template = await createRealnameTemplate(
    await requestFor(user, `${suffix}-create`),
    realnameTemplateFixture({ displayName: `${fixturePrefix}-${suffix}` }),
  )
  created.push({ collection: 'realnameTemplates', id: template.id })
  return template
}

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  for (const item of created.reverse()) {
    await payload
      .delete({ collection: item.collection, id: item.id, overrideAccess: true })
      .catch(() => undefined)
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 100,
    overrideAccess: true,
    where: { traceId: { contains: fixturePrefix } },
  })
  for (const audit of audits.docs) {
    await payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true })
  }
  await payload.db.destroy?.()
})

describe('D4 real-name templates', () => {
  it('isolates rows, accepts only provider-confirmed approval, audits transitions and disables use', async () => {
    const owner = await customer('4101')
    const other = await customer('4102')
    const draft = await createTemplate(owner, 'approved')

    await expect(
      assertRealnameTemplateUsableForRegistration(await requestFor(owner, 'draft-use'), {
        customerId: owner.id,
        templateId: draft.id,
      }),
    ).rejects.toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_USABLE' })
    await expect(
      payload.findByID({
        collection: 'realnameTemplates',
        id: draft.id,
        overrideAccess: false,
        user: other as never,
      }),
    ).rejects.toThrow()

    await expect(
      payload.update({
        collection: 'realnameTemplates',
        data: {
          providerConfirmedAt: new Date().toISOString(),
          providerReviewState: 'approved',
          providerTemplateId: 'forged-template',
          status: 'approved',
        },
        id: draft.id,
        overrideAccess: true,
      }),
    ).rejects.toThrow(/只能通过实名服务变更/u)

    const provider = new MockWestDigitalRealnameAdapter({
      'mock-realname-1': { reviewState: 'approved' },
    })
    const pending = await submitRealnameTemplate(
      await requestFor(owner, 'submit'),
      draft.id,
      provider,
    )
    expect(pending).toMatchObject({ providerReviewState: 'pending', status: 'pending_review' })
    await expect(
      assertRealnameTemplateUsableForRegistration(await requestFor(owner, 'pending-use'), {
        customerId: owner.id,
        templateId: draft.id,
      }),
    ).rejects.toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_USABLE' })

    const approved = await syncRealnameTemplateStatus(
      await systemRequest('sync-approved'),
      draft.id,
      provider,
    )
    expect(approved).toMatchObject({ providerReviewState: 'approved', status: 'approved' })
    await expect(
      syncRealnameTemplateStatus(await requestFor(owner, 'customer-sync'), draft.id, provider),
    ).rejects.toMatchObject({ code: 'REALNAME_STATUS_SYNC_FORBIDDEN' })

    await expect(
      assertRealnameTemplateUsableForRegistration(await requestFor(owner, 'approved-use'), {
        customerId: owner.id,
        templateId: draft.id,
      }),
    ).resolves.toMatchObject({
      id: draft.id,
      providerTemplateId: 'mock-realname-1',
      type: 'individual',
    })
    await expect(
      assertRealnameTemplateUsableForRegistration(await requestFor(other, 'other-use'), {
        customerId: other.id,
        templateId: draft.id,
      }),
    ).rejects.toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_USABLE' })

    const disabled = await disableRealnameTemplate(await requestFor(owner, 'disable'), draft.id)
    expect(disabled.status).toBe('disabled')
    await expect(
      assertRealnameTemplateUsableForRegistration(await requestFor(owner, 'disabled-use'), {
        customerId: owner.id,
        templateId: draft.id,
      }),
    ).rejects.toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_USABLE' })

    const audits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      sort: 'createdAt',
      where: {
        and: [
          { targetId: { equals: String(draft.id) } },
          { targetType: { equals: 'realname-template' } },
        ],
      },
    })
    expect(audits.docs.map((audit) => audit.action)).toEqual([
      'realname.template.status_changed',
      'realname.template.status_changed',
      'realname.template.status_changed',
    ])
    expect(audits.docs.map((audit) => audit.actorType)).toEqual([
      'customer',
      'provider',
      'customer',
    ])
    const serializedAudits = JSON.stringify(audits.docs)
    expect(serializedAudits).not.toContain('13812345678')
    expect(serializedAudits).not.toContain('11010519491231002X')
  })

  it('keeps rejected, unknown and unavailable provider outcomes unusable and explicit', async () => {
    const owner = await customer('4201')

    const rejectedDraft = await createTemplate(owner, 'rejected')
    const rejectedProvider = new MockWestDigitalRealnameAdapter({
      'mock-realname-1': { reviewState: 'rejected', safeFailureReason: 'identity_mismatch' },
    })
    await submitRealnameTemplate(
      await requestFor(owner, 'rejected-submit'),
      rejectedDraft.id,
      rejectedProvider,
    )
    const rejected = await syncRealnameTemplateStatus(
      await systemRequest('sync-rejected'),
      rejectedDraft.id,
      rejectedProvider,
    )
    expect(rejected).toMatchObject({
      providerReviewState: 'rejected',
      safeFailureReason: 'identity_mismatch',
      status: 'rejected',
    })

    const unavailableDraft = await createTemplate(owner, 'unavailable')
    const unavailable = await submitRealnameTemplate(
      await requestFor(owner, 'unavailable-submit'),
      unavailableDraft.id,
      new MockWestDigitalRealnameAdapter({}, true),
    )
    expect(unavailable).toMatchObject({
      providerReviewState: 'unknown',
      safeFailureReason: 'provider_unavailable',
      status: 'manual_review',
    })

    for (const template of [rejected, unavailable]) {
      await expect(
        assertRealnameTemplateUsableForRegistration(
          await requestFor(owner, `blocked-${template.id}`),
          { customerId: owner.id, templateId: template.id },
        ),
      ).rejects.toMatchObject({ code: 'REALNAME_TEMPLATE_NOT_USABLE' })
    }
  })
})
