import { randomInt, randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MockRealnameObjectProvider } from '@/providers/oss-realname'
import type { Admin } from '@/payload-types'
import { executeAccountClosure } from '@/services/auth/account-closure'
import { requestCustomerDeletion } from '@/services/auth/otp'
import { uploadRealnameDocument } from '@/services/realname/documents'
import { realnameCleanupDeadline, runRealnameCleanup } from '@/services/realname/lifecycle'
import { createRealnameTemplate } from '@/services/realname/templates'

import { realnameTemplateFixture } from '../fixtures/realname'
import { createTestRealnameDocumentMasterKeyring } from '../fixtures/realname-master-key'
import { grantSensitivePersonalInformationConsent } from '../fixtures/consents'
import { issueStepUpGrantFixture } from '../fixtures/step-up'

const fixturePrefix = `d4-lifecycle-${randomUUID()}`
const created: Array<{ collection: 'admins' | 'customers'; id: number | string }> = []
let administrator: Admin
let payload: Payload

class TrackingObjectProvider extends MockRealnameObjectProvider {
  readonly deleteCalls: string[] = []

  override async deleteObject(input: { key: string; traceId: string }) {
    this.deleteCalls.push(input.key)
    return super.deleteObject(input)
  }
}

async function requestFor(user: unknown, suffix: string) {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) } },
    payload,
  )
  req.user = user as never
  return req
}

beforeAll(async () => {
  payload = await getPayload({ config })
  administrator = await payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap' },
    data: {
      email: `${fixturePrefix}@example.test`,
      operationalScopes: ['funds_operations', 'system_configuration'],
      password: `D4-lifecycle-${randomUUID()}`,
      roles: ['system_admin'],
      status: 'active',
    },
    overrideAccess: true,
  })
  created.push({ collection: 'admins', id: administrator.id })
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

describe('D4 real-name retention lifecycle', () => {
  it('disables on account deletion and idempotently removes primary, backup and database rows after 30 days', async () => {
    const phone = `139${randomInt(10_000_000, 99_999_999)}`
    const customer = await payload.create({
      collection: 'customers',
      data: {
        capabilityRestrictions: [],
        phone,
        phoneMasked: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
        status: 'active',
      },
      overrideAccess: true,
    })
    created.push({ collection: 'customers', id: customer.id })
    await grantSensitivePersonalInformationConsent(
      payload,
      Number(customer.id),
      `${fixturePrefix}-sensitive-consent`,
    )
    const user = { ...customer, collection: 'customers' as const }
    const req = await requestFor(user, 'owner')
    const template = await createRealnameTemplate(
      req,
      realnameTemplateFixture({ displayName: `${fixturePrefix}-template` }),
    )
    const providers = {
      keyring: createTestRealnameDocumentMasterKeyring(),
      objects: new TrackingObjectProvider(),
    }
    const body = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'utf8')
    const uploaded = await uploadRealnameDocument(req, { body, templateId: template.id }, providers)
    const document = await payload.findByID({
      collection: 'realnameDocuments',
      id: uploaded.id,
      overrideAccess: true,
    })
    const primaryKey = document.objectKey
    const backupKey = `private/realname/${randomUUID()}-backup.wrn`
    await providers.objects.upload({
      body: Buffer.from('encrypted-backup'),
      key: backupKey,
      traceId: fixturePrefix,
    })
    await payload.update({
      collection: 'realnameDocuments',
      data: { backupObjects: [{ objectKey: backupKey }] },
      id: document.id,
      overrideAccess: true,
    })

    const deletion = await requestCustomerDeletion(
      req,
      user,
      await issueStepUpGrantFixture(payload, req, customer.id, 'account_deletion'),
    )
    await payload.db.pool.query(
      `UPDATE account_closure_requests
       SET cooldown_ends_at = NOW() - INTERVAL '1 second'
       WHERE request_key = $1 AND event_type = 'requested'`,
      [deletion.requestId],
    )
    const adminReq = await requestFor(
      { ...administrator, collection: 'admins' as const },
      'execute-closure',
    )
    const executed = await executeAccountClosure(adminReq, {
      actorId: administrator.id,
      note: 'D4 retention lifecycle fixture',
      requestId: deletion.requestId,
    })
    expect(executed).toMatchObject({ status: 'closed' })
    if (executed.status !== 'closed') throw new Error('fixture account closure was blocked')
    const disabled = await payload.findByID({
      collection: 'realnameTemplates',
      id: template.id,
      overrideAccess: true,
    })
    expect(disabled).toMatchObject({
      cleanupDueAt: realnameCleanupDeadline(executed.executedAt),
      disabledAt: executed.executedAt,
      status: 'disabled',
    })

    const systemReq = await createLocalReq(
      { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-cleanup` }) } },
      payload,
    )
    await expect(
      runRealnameCleanup(systemReq, {
        now: new Date(new Date(executed.executedAt).getTime() + 29 * 86_400_000),
        provider: providers.objects,
        templateId: template.id,
      }),
    ).resolves.toEqual({ cleaned: 0, failed: 0 })
    await expect(
      runRealnameCleanup(systemReq, {
        now: new Date(new Date(executed.executedAt).getTime() + 30 * 86_400_000),
        provider: providers.objects,
        templateId: template.id,
      }),
    ).resolves.toEqual({ cleaned: 1, failed: 0 })
    await expect(
      payload.findByID({ collection: 'realnameTemplates', id: template.id, overrideAccess: true }),
    ).rejects.toThrow()
    await expect(
      payload.findByID({ collection: 'realnameDocuments', id: document.id, overrideAccess: true }),
    ).rejects.toThrow()
    await expect(
      providers.objects.read({ key: primaryKey, traceId: fixturePrefix }),
    ).resolves.toMatchObject({ ok: false })
    await expect(
      providers.objects.read({ key: backupKey, traceId: fixturePrefix }),
    ).resolves.toMatchObject({ ok: false })
    expect(providers.objects.deleteCalls).toEqual([primaryKey, backupKey])

    await expect(
      runRealnameCleanup(systemReq, {
        now: new Date(new Date(deletion.deletionRequestedAt).getTime() + 31 * 86_400_000),
        provider: providers.objects,
        templateId: template.id,
      }),
    ).resolves.toEqual({ cleaned: 0, failed: 0 })
    expect(providers.objects.deleteCalls).toEqual([primaryKey, backupKey])
    const cleanupAudits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'realname.template.cleaned' } },
          { targetId: { equals: String(template.id) } },
        ],
      },
    })
    expect(cleanupAudits.totalDocs).toBe(1)
  })
})
