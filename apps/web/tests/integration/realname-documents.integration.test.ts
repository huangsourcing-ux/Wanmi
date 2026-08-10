import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MockRealnameObjectProvider } from '@/providers/oss-realname'
import {
  createAdminRealnameDocumentAccess,
  createRealnameDocumentAccess,
  deleteRealnameDocument,
  readAdminRealnameDocument,
  readRealnameDocument,
  submitRealnameDocument,
  uploadRealnameDocument,
} from '@/services/realname/documents'
import { createRealnameTemplate } from '@/services/realname/templates'

import { realnameTemplateFixture } from '../fixtures/realname'
import { createTestRealnameDocumentMasterKeyring } from '../fixtures/realname-master-key'

const fixturePrefix = `d4-documents-${randomUUID()}`
const marker = `PRIVATE-DOCUMENT-CONTENT-${randomUUID()}`
const created: Array<{
  collection: 'customers' | 'realnameDocuments' | 'realnameTemplates'
  id: number | string
}> = []
const providers = {
  keyring: createTestRealnameDocumentMasterKeyring(),
  objects: new MockRealnameObjectProvider(),
}
let payload: Payload

async function requestFor(user: unknown, suffix: string) {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixturePrefix}-${suffix}` }) } },
    payload,
  )
  req.user = user as never
  return req
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

describe('D4 private real-name documents', () => {
  it('encrypts private uploads, isolates ownership, signs short access and audits every action', async () => {
    const owner = await customer('4301')
    const other = await customer('4302')
    const ownerReq = await requestFor(owner, 'owner')
    const template = await createRealnameTemplate(
      ownerReq,
      realnameTemplateFixture({ displayName: `${fixturePrefix}-template` }),
    )
    created.push({ collection: 'realnameTemplates', id: template.id })
    const plaintext = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${marker}\n%%EOF\n`,
      'utf8',
    )

    const uploaded = await uploadRealnameDocument(
      ownerReq,
      { body: plaintext, templateId: template.id },
      providers,
    )
    created.push({ collection: 'realnameDocuments', id: uploaded.id })
    expect(uploaded).toMatchObject({
      contentType: 'application/pdf',
      fileKind: 'pdf',
      sizeBytes: plaintext.byteLength,
      status: 'active',
    })

    const protectedDocument = await payload.findByID({
      collection: 'realnameDocuments',
      id: uploaded.id,
      overrideAccess: true,
    })
    expect(protectedDocument.objectKey).toMatch(/^private\/realname\//u)
    expect(protectedDocument.objectKey).toMatch(
      /^private\/realname\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{32}\.wrn$/u,
    )
    const stored = await providers.objects.read({
      key: protectedDocument.objectKey,
      traceId: `${fixturePrefix}-stored`,
    })
    expect(stored.ok).toBe(true)
    if (!stored.ok) throw new Error('mock private object missing')
    expect(Buffer.from(stored.data.body).includes(Buffer.from(marker))).toBe(false)
    expect(Buffer.from(stored.data.body).toString('utf8')).not.toContain(marker)

    const ownerVisible = await payload.findByID({
      collection: 'realnameDocuments',
      id: uploaded.id,
      overrideAccess: false,
      req: ownerReq,
      user: owner as never,
    })
    expect(ownerVisible.objectKey).toBeUndefined()
    expect(ownerVisible.encryptedDataKey).toBeUndefined()
    expect(ownerVisible.masterKeyVersion).toBeUndefined()
    await expect(
      payload.findByID({
        collection: 'realnameDocuments',
        id: uploaded.id,
        overrideAccess: false,
        user: other as never,
      }),
    ).rejects.toThrow()

    const viewAccess = await createRealnameDocumentAccess(ownerReq, uploaded.id, 'view')
    const viewTicket = new URL(viewAccess.url).searchParams.get('ticket')
    expect(viewTicket).toBeTruthy()
    expect(viewAccess.url).not.toContain(protectedDocument.objectKey)
    const viewed = await readRealnameDocument(ownerReq, viewTicket!, providers)
    expect(viewed).toMatchObject({ contentType: 'application/pdf', mode: 'view' })
    expect(Buffer.from(viewed.body)).toEqual(plaintext)

    const downloadAccess = await createRealnameDocumentAccess(ownerReq, uploaded.id, 'download')
    const downloadTicket = new URL(downloadAccess.url).searchParams.get('ticket')!
    const downloaded = await readRealnameDocument(ownerReq, downloadTicket, providers)
    expect(downloaded.mode).toBe('download')
    expect(Buffer.from(downloaded.body)).toEqual(plaintext)

    const adminReq = await requestFor(
      {
        collection: 'admins',
        id: 'd4-system-admin',
        roles: ['system_admin'],
        status: 'active',
      },
      'admin-view',
    )
    const adminAccess = await createAdminRealnameDocumentAccess(adminReq, uploaded.id, 'view')
    const adminTicket = new URL(adminAccess.url).searchParams.get('ticket')!
    const adminViewed = await readAdminRealnameDocument(adminReq, adminTicket, providers)
    expect(Buffer.from(adminViewed.body)).toEqual(plaintext)
    await expect(readRealnameDocument(ownerReq, adminTicket, providers)).rejects.toMatchObject({
      code: 'REALNAME_DOCUMENT_NOT_AVAILABLE',
    })

    await expect(
      readRealnameDocument(await requestFor(other, 'other-ticket'), downloadTicket, providers),
    ).rejects.toMatchObject({ code: 'REALNAME_DOCUMENT_NOT_AVAILABLE' })
    await expect(
      readRealnameDocument(ownerReq, `${downloadTicket.slice(0, -1)}x`, providers),
    ).rejects.toMatchObject({ code: 'REALNAME_DOCUMENT_NOT_AVAILABLE' })

    await expect(submitRealnameDocument(ownerReq, uploaded.id)).resolves.toMatchObject({
      status: 'submitted',
    })
    await expect(deleteRealnameDocument(ownerReq, uploaded.id, providers)).resolves.toMatchObject({
      status: 'deleted',
    })
    await expect(readRealnameDocument(ownerReq, viewTicket!, providers)).rejects.toMatchObject({
      code: 'REALNAME_DOCUMENT_NOT_AVAILABLE',
    })
    await expect(
      providers.objects.read({
        key: protectedDocument.objectKey,
        traceId: `${fixturePrefix}-after-delete`,
      }),
    ).resolves.toMatchObject({ error: { code: 'OSS_OBJECT_NOT_FOUND' }, ok: false })

    const audits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      sort: 'createdAt',
      where: {
        and: [
          { targetId: { equals: String(uploaded.id) } },
          { targetType: { equals: 'realname-document' } },
        ],
      },
    })
    expect(audits.docs.map((audit) => audit.action)).toEqual([
      'realname.document.uploaded',
      'realname.document.viewed',
      'realname.document.downloaded',
      'realname.document.viewed',
      'realname.document.submitted',
      'realname.document.deleted',
    ])
    const serializedAudits = JSON.stringify(audits.docs)
    expect(serializedAudits).not.toContain(marker)
    expect(serializedAudits).not.toContain(protectedDocument.objectKey)
    expect(serializedAudits).not.toContain(protectedDocument.encryptedDataKey)
    expect(audits.docs.map((audit) => audit.actorType)).toEqual([
      'customer',
      'customer',
      'customer',
      'admin',
      'customer',
      'customer',
    ])
  })
})
