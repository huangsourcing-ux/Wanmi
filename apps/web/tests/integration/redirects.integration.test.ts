import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Admin, Article, Customer } from '@/payload-types'

import { ensureAnchorSystemAdmin } from '../test-cleanup'

let payload: Payload
let cleanupAdmin: Admin
const fixturePrefix = `d1-redirect-${randomUUID()}`
const createdAdmins: number[] = []
const createdContent: Array<{
  collection: 'articles' | 'helpPages' | 'tldPages'
  id: number | string
}> = []
const createdCustomers: number[] = []
const redirectIdsForCleanup = new Set<string>()

const content: Article['content'] = {
  root: {
    children: [
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'D1 redirect fixture',
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

async function createAdmin(role: Admin['roles'][number]) {
  const admin = await payload.create({
    collection: 'admins',
    context: { adminAccountOperation: 'bootstrap' },
    data: {
      email: `${fixturePrefix}-${role}-${randomUUID()}@example.test`,
      operationalScopes:
        role === 'system_admin' ? ['funds_operations', 'system_configuration'] : [],
      password: `D1-${randomUUID()}-test-password`,
      roles: [role],
      status: 'active',
    },
    overrideAccess: true,
  })
  createdAdmins.push(admin.id)
  return { ...admin, collection: 'admins' as const }
}

async function requestFor(user: Admin | Customer | undefined, traceId: string = randomUUID()) {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': traceId }) } },
    payload,
  )
  req.user = user ?? null
  return req
}

beforeAll(async () => {
  payload = await getPayload({ config })
  cleanupAdmin = await ensureAnchorSystemAdmin(payload)
})

afterAll(async () => {
  const cleanupTraceId = `${fixturePrefix}-cleanup`
  const cleanupReq = await requestFor(cleanupAdmin, cleanupTraceId)
  const redirects = await payload.find({
    collection: 'redirects',
    limit: 100,
    overrideAccess: true,
    where: { from: { contains: fixturePrefix } },
  })
  const redirectIds = [
    ...redirectIdsForCleanup,
    ...redirects.docs.map((document) => String(document.id)),
  ]
  for (const redirect of redirects.docs) {
    await payload.delete({
      collection: 'redirects',
      id: redirect.id,
      overrideAccess: true,
      req: cleanupReq,
    })
  }
  if (redirectIds.length) {
    const audits = await payload.find({
      collection: 'auditLogs',
      limit: 1_000,
      overrideAccess: true,
      where: {
        and: [{ targetType: { equals: 'redirect' } }, { targetId: { in: redirectIds } }],
      },
    })
    for (const audit of audits.docs) {
      await payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true })
    }
  }
  for (const document of createdContent.reverse()) {
    await payload.delete({
      collection: document.collection,
      id: document.id,
      overrideAccess: true,
    })
  }
  for (const id of createdCustomers) {
    await payload.delete({ collection: 'customers', id, overrideAccess: true })
  }
  for (const id of createdAdmins) {
    await payload.delete({ collection: 'admins', id, overrideAccess: true, req: cleanupReq })
  }
  const cleanupAudits = await payload.find({
    collection: 'auditLogs',
    limit: 1_000,
    overrideAccess: true,
    where: { traceId: { equals: cleanupTraceId } },
  })
  for (const audit of cleanupAudits.docs) {
    await payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true })
  }
  await payload.db.destroy?.()
}, 60_000)

describe('D1 controlled redirects', () => {
  it('enforces CRUD access for every supported identity and records safe audit snapshots', async () => {
    const contentEditor = await createAdmin('content_editor')
    const systemAdmin = await createAdmin('system_admin')
    const adOperator = await createAdmin('ad_operator')
    const analyst = await createAdmin('analyst')
    const customer = await payload.create({
      collection: 'customers',
      data: {
        capabilityRestrictions: [],
        phone: `${fixturePrefix}-customer`,
        phoneMasked: 'fixture-only',
        status: 'active',
      },
      overrideAccess: true,
    })
    createdCustomers.push(customer.id)
    const customerUser = { ...customer, collection: 'customers' as const }

    const traceId = `${fixturePrefix}-create-trace`
    const redirect = await payload.create({
      collection: 'redirects',
      data: {
        from: `//${fixturePrefix}-old//`.replace('//', '/'),
        to: { type: 'custom', url: '/help/' },
        type: '301',
      },
      overrideAccess: false,
      req: await requestFor(contentEditor, traceId),
      user: contentEditor,
    })
    redirectIdsForCleanup.add(String(redirect.id))
    expect(redirect.from).toBe(`/${fixturePrefix}-old`)
    expect(redirect.to?.url).toBe('/help')

    for (const user of [adOperator, analyst, customerUser, undefined]) {
      const req = await requestFor(user)
      await expect(
        payload.create({
          collection: 'redirects',
          data: {
            from: `/${fixturePrefix}-denied-${user?.id ?? 'anonymous'}`,
            to: { type: 'custom', url: '/help' },
            type: '301',
          },
          overrideAccess: false,
          req,
          user,
        }),
      ).rejects.toThrow()
      await expect(
        payload.update({
          collection: 'redirects',
          data: { to: { type: 'custom', url: '/pricing' } },
          id: redirect.id,
          overrideAccess: false,
          req: await requestFor(user),
          user,
        }),
      ).rejects.toThrow()
      await expect(
        payload.delete({
          collection: 'redirects',
          id: redirect.id,
          overrideAccess: false,
          req: await requestFor(user),
          user,
        }),
      ).rejects.toThrow()
    }

    const updated = await payload.update({
      collection: 'redirects',
      data: { to: { type: 'custom', url: '/pricing' } },
      id: redirect.id,
      overrideAccess: false,
      req: await requestFor(contentEditor, `${fixturePrefix}-update-trace`),
      user: contentEditor,
    })
    expect(updated.to?.url).toBe('/pricing')
    await expect(
      payload.delete({
        collection: 'redirects',
        id: redirect.id,
        overrideAccess: false,
        req: await requestFor(contentEditor),
        user: contentEditor,
      }),
    ).rejects.toThrow()

    for (const user of [contentEditor, systemAdmin, adOperator, analyst, customerUser, undefined]) {
      const result = await payload.find({
        collection: 'redirects',
        overrideAccess: false,
        req: await requestFor(user),
        user,
        where: { id: { equals: redirect.id } },
      })
      expect(result.totalDocs).toBe(1)
    }

    const audits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      sort: 'createdAt',
      where: {
        and: [
          { targetId: { equals: String(redirect.id) } },
          { targetType: { equals: 'redirect' } },
        ],
      },
    })
    expect(audits.docs.map((audit) => audit.action)).toEqual(['redirect.create', 'redirect.update'])
    expect(audits.docs[0]).toMatchObject({
      actorId: String(contentEditor.id),
      actorType: 'admin',
      metadata: {
        after: {
          from: `/${fixturePrefix}-old`,
          to: { type: 'custom', url: '/help' },
          type: '301',
        },
      },
      traceId,
    })

    await payload.delete({
      collection: 'redirects',
      id: redirect.id,
      overrideAccess: false,
      req: await requestFor(systemAdmin, `${fixturePrefix}-delete-trace`),
      user: systemAdmin,
    })
    const deleteAudit = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'redirect.delete' } },
          { targetId: { equals: String(redirect.id) } },
        ],
      },
    })
    expect(deleteAudit.docs[0]).toMatchObject({
      actorId: String(systemAdmin.id),
      actorType: 'admin',
      metadata: { before: { from: `/${fixturePrefix}-old`, type: '301' } },
    })
  })

  it('rejects draft references and real multi-hop loops while accepting published targets', async () => {
    const contentEditor = await createAdmin('content_editor')
    const published = await payload.create({
      collection: 'articles',
      data: {
        _status: 'published',
        content,
        source: 'D3 test fixture',
        slug: `${fixturePrefix}-published`,
        title: `${fixturePrefix} published`,
        workflowStatus: 'published',
      },
      draft: false,
      overrideAccess: true,
    })
    const draft = await payload.create({
      collection: 'articles',
      data: {
        _status: 'draft',
        content,
        slug: `${fixturePrefix}-draft`,
        title: `${fixturePrefix} draft`,
      },
      draft: true,
      overrideAccess: true,
    })
    createdContent.push(
      { collection: 'articles', id: published.id },
      { collection: 'articles', id: draft.id },
    )

    await expect(
      payload.create({
        collection: 'redirects',
        data: {
          from: `/${fixturePrefix}-draft-source`,
          to: { reference: { relationTo: 'articles', value: draft.id }, type: 'reference' },
          type: '301',
        },
        overrideAccess: false,
        req: await requestFor(contentEditor),
        user: contentEditor,
      }),
    ).rejects.toThrow(/必须已发布/)

    const referenceRedirect = await payload.create({
      collection: 'redirects',
      data: {
        from: `/${fixturePrefix}-published-source`,
        to: { reference: { relationTo: 'articles', value: published.id }, type: 'reference' },
        type: '301',
      },
      overrideAccess: false,
      req: await requestFor(contentEditor),
      user: contentEditor,
    })
    redirectIdsForCleanup.add(String(referenceRedirect.id))
    expect(referenceRedirect.to?.type).toBe('reference')

    for (const target of [
      { collection: 'tldPages' as const, path: 'tld', slug: `${fixturePrefix}-redirect-tld` },
      { collection: 'helpPages' as const, path: 'help', slug: `${fixturePrefix}-redirect-help` },
    ]) {
      const document = await payload.create({
        collection: target.collection,
        data: {
          _status: 'published',
          content,
          source: 'D3 test fixture',
          slug: target.slug,
          title: target.slug,
          workflowStatus: 'published',
        },
        draft: false,
        overrideAccess: true,
      })
      createdContent.push({ collection: target.collection, id: document.id })
      const redirect = await payload.create({
        collection: 'redirects',
        data: {
          from: `/${fixturePrefix}-old-${target.path}`,
          to: {
            reference: { relationTo: target.collection, value: document.id },
            type: 'reference',
          },
          type: '301',
        },
        overrideAccess: false,
        req: await requestFor(contentEditor),
        user: contentEditor,
      })
      redirectIdsForCleanup.add(String(redirect.id))
      expect(redirect.to?.type).toBe('reference')
    }

    const whoisTool = (
      await payload.find({
        collection: 'toolPages',
        depth: 0,
        limit: 1,
        overrideAccess: false,
        where: { slug: { equals: 'whois' } },
      })
    ).docs[0]
    expect(whoisTool).toBeTruthy()
    const toolRedirect = await payload.create({
      collection: 'redirects',
      data: {
        from: `/${fixturePrefix}-old-tool`,
        to: {
          reference: { relationTo: 'toolPages', value: whoisTool!.id },
          type: 'reference',
        },
        type: '301',
      },
      overrideAccess: false,
      req: await requestFor(contentEditor),
      user: contentEditor,
    })
    redirectIdsForCleanup.add(String(toolRedirect.id))
    expect(toolRedirect.to?.type).toBe('reference')

    const loopStart = await payload.create({
      collection: 'redirects',
      data: {
        from: `/${fixturePrefix}-loop-a`,
        to: { type: 'custom', url: `/${fixturePrefix}-loop-b` },
        type: '301',
      },
      overrideAccess: false,
      req: await requestFor(contentEditor),
      user: contentEditor,
    })
    redirectIdsForCleanup.add(String(loopStart.id))
    await expect(
      payload.create({
        collection: 'redirects',
        data: {
          from: `/${fixturePrefix}-loop-b`,
          to: { type: 'custom', url: `/${fixturePrefix}-loop-a` },
          type: '301',
        },
        overrideAccess: false,
        req: await requestFor(contentEditor),
        user: contentEditor,
      }),
    ).rejects.toThrow(/循环/)
  })

  it('rolls back the redirect when its same-request audit write fails', async () => {
    const systemAdmin = await createAdmin('system_admin')
    const originalCreate = payload.create.bind(payload)
    const mutablePayload = payload as Payload & {
      create: Payload['create']
    }
    mutablePayload.create = ((args: Parameters<Payload['create']>[0]) => {
      if (args.collection === 'auditLogs') return Promise.reject(new Error('forced audit failure'))
      return originalCreate(args)
    }) as Payload['create']

    const from = `/${fixturePrefix}-audit-rollback`
    try {
      await expect(
        mutablePayload.create({
          collection: 'redirects',
          data: { from, to: { type: 'custom', url: '/help' }, type: '301' },
          overrideAccess: false,
          req: await requestFor(systemAdmin),
          user: systemAdmin,
        }),
      ).rejects.toThrow(/forced audit failure/)
    } finally {
      mutablePayload.create = originalCreate as Payload['create']
    }

    expect(
      (
        await payload.find({
          collection: 'redirects',
          overrideAccess: true,
          where: { from: { equals: from } },
        })
      ).totalDocs,
    ).toBe(0)
  })
})
