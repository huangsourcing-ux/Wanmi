import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Admin, Article } from '@/payload-types'
import { readPublicContentBySlug } from '@/services/content/read-content'
import { executeContentWorkflow, runScheduledContentPublish } from '@/services/content/workflow'

import {
  ensureAnchorSystemAdmin,
  findOrCreateUniqueFixture,
  ignorePayloadNotFound,
} from '../test-cleanup'

const fixture = `d3-content-${randomUUID()}`
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
            text: 'D3 content workflow fixture',
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

let payload: Payload
let editor: Admin
let editorCreated = false
let req: PayloadRequest
const cleanup: Array<{
  collection: 'articles' | 'categories' | 'helpPages' | 'tags'
  id: number | string
}> = []
const cleanupJobIds: Array<number | string> = []

beforeAll(async () => {
  payload = await getPayload({ config })
  await ensureAnchorSystemAdmin(payload)
  const editorFixture = await findOrCreateUniqueFixture({
    create: () =>
      payload.create({
        collection: 'admins',
        context: { adminAccountOperation: 'bootstrap' },
        data: {
          email: `${fixture}@example.test`,
          password: `D3-${randomUUID()}-safe-password`,
          roles: ['content_editor'],
          status: 'active',
        },
        overrideAccess: true,
      }),
    find: async () => {
      const found = await payload.find({
        collection: 'admins',
        limit: 1,
        overrideAccess: true,
        where: { email: { equals: `${fixture}@example.test` } },
      })
      return found.docs[0]
    },
    path: 'email',
    tableName: 'admins',
  })
  editor = editorFixture.value
  editorCreated = editorFixture.created
  req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': `${fixture}-trace` }) } },
    payload,
  )
  req.user = { ...editor, collection: 'admins' }
})

afterAll(async () => {
  for (const id of cleanupJobIds) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'payload-jobs', id, overrideAccess: true }),
    )
  }
  const audits = await payload.find({
    collection: 'auditLogs',
    limit: 100,
    overrideAccess: true,
    where: {
      and: [{ targetType: { equals: 'content' } }, { traceId: { equals: `${fixture}-trace` } }],
    },
  })
  for (const audit of audits.docs) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true }),
    )
  }
  for (const item of cleanup.reverse()) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: item.collection, id: item.id, overrideAccess: true }),
    )
  }
  if (editorCreated) {
    await ignorePayloadNotFound(() =>
      payload.delete({ collection: 'admins', id: editor.id, overrideAccess: true, req }),
    )
  }
  await payload.db.destroy?.()
})

describe('D3 lightweight content CMS', () => {
  it('enforces the complete workflow, audit trail, revisions and public taxonomy boundary', async () => {
    const category = await payload.create({
      collection: 'categories',
      data: { slug: `${fixture}-category`, title: `${fixture} category` },
      overrideAccess: false,
      req,
      user: editor,
    })
    const tag = await payload.create({
      collection: 'tags',
      data: { slug: `${fixture}-tag`, title: `${fixture} tag` },
      overrideAccess: false,
      req,
      user: editor,
    })
    cleanup.push({ collection: 'categories', id: category.id }, { collection: 'tags', id: tag.id })

    const article = await payload.create({
      collection: 'articles',
      data: {
        _status: 'draft',
        categories: [category.id],
        content: richText,
        slug: `${fixture}-article`,
        tags: [tag.id],
        title: `${fixture} article`,
        workflowStatus: 'draft',
      },
      draft: true,
      overrideAccess: false,
      req,
      user: editor,
    })
    cleanup.push({ collection: 'articles', id: article.id })
    expect(article.workflowStatus).toBe('draft')
    expect(article.revisionBy).toBe(String(editor.id))

    await executeContentWorkflow(req, 'articles', article.id, { action: 'submit_review' })
    await expect(
      executeContentWorkflow(req, 'articles', article.id, { action: 'publish' }),
    ).rejects.toMatchObject({ code: 'CONTENT_SOURCE_REQUIRED' })

    await payload.update({
      collection: 'articles',
      data: { source: 'Wanmi 编辑部' },
      draft: true,
      id: article.id,
      overrideAccess: false,
      req,
      user: editor,
    })
    await executeContentWorkflow(req, 'articles', article.id, { action: 'publish' })
    await expect(
      executeContentWorkflow(req, 'articles', article.id, { action: 'archive' }),
    ).rejects.toMatchObject({ code: 'CONTENT_WORKFLOW_INVALID_TRANSITION' })

    const publicArticle = await readPublicContentBySlug(payload, 'articles', article.slug)
    expect(publicArticle).toMatchObject({
      categories: [{ title: category.title }],
      source: 'Wanmi 编辑部',
      status: 'published',
      tags: [{ title: tag.title }],
    })
    await expect(
      payload.find({
        collection: 'categories',
        overrideAccess: false,
      }),
    ).rejects.toThrow()

    await payload.update({
      collection: 'articles',
      data: { summary: '待发布修订' },
      draft: true,
      id: article.id,
      overrideAccess: false,
      req,
      user: editor,
    })
    await executeContentWorkflow(req, 'articles', article.id, { action: 'publish_revision' })
    await executeContentWorkflow(req, 'articles', article.id, { action: 'unpublish' })
    expect(await readPublicContentBySlug(payload, 'articles', article.slug)).toBeNull()
    await executeContentWorkflow(req, 'articles', article.id, { action: 'archive' })
    await expect(
      payload.update({
        collection: 'articles',
        data: { title: '不得修改' },
        draft: true,
        id: article.id,
        overrideAccess: false,
        req,
        user: editor,
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_ARCHIVED_READ_ONLY' })

    const versions = await payload.findVersions({
      collection: 'articles',
      limit: 50,
      overrideAccess: false,
      req,
      sort: '-createdAt',
      user: editor,
      where: { parent: { equals: article.id } },
    })
    expect(versions.docs.some((version) => Boolean(version.version.revisionBy))).toBe(true)
    const audits = await payload.find({
      collection: 'auditLogs',
      overrideAccess: true,
      where: {
        and: [{ targetId: { equals: String(article.id) } }, { targetType: { equals: 'content' } }],
      },
    })
    expect(audits.docs.map((audit) => audit.action)).toEqual(
      expect.arrayContaining(['content.status.changed', 'content.revision.published']),
    )
    expect(audits.docs).toContainEqual(
      expect.objectContaining({
        actorId: String(editor.id),
        metadata: expect.objectContaining({ fromStatus: 'draft', toStatus: 'in_review' }),
      }),
    )
  })

  it('queues only the latest publishing job and ignores cancelled schedules', async () => {
    const help = await payload.create({
      collection: 'helpPages',
      data: {
        _status: 'draft',
        content: richText,
        slug: `${fixture}-scheduled-help`,
        source: 'Wanmi 编辑部',
        title: `${fixture} scheduled help`,
        workflowStatus: 'draft',
      },
      draft: true,
      overrideAccess: false,
      req,
      user: editor,
    })
    cleanup.push({ collection: 'helpPages', id: help.id })
    await executeContentWorkflow(req, 'helpPages', help.id, { action: 'submit_review' })
    const firstPublishAt = new Date(Date.now() + 3_600_000).toISOString()
    const latestPublishAt = new Date(Date.now() + 7_200_000).toISOString()
    await executeContentWorkflow(req, 'helpPages', help.id, {
      action: 'schedule_publish',
      publishAt: firstPublishAt,
    })
    await executeContentWorkflow(req, 'helpPages', help.id, {
      action: 'schedule_publish',
      publishAt: latestPublishAt,
    })
    const jobs = await payload.find({
      collection: 'payload-jobs',
      overrideAccess: true,
      where: { concurrencyKey: { equals: `content:helpPages:${help.id}` } },
    })
    expect(jobs.totalDocs).toBe(1)
    cleanupJobIds.push(...jobs.docs.map((job) => job.id))
    expect(jobs.docs[0]?.queue).toBe('publishing')
    expect(jobs.docs[0]?.workflowSlug).toBe('contentScheduledPublish')

    await executeContentWorkflow(req, 'helpPages', help.id, {
      action: 'cancel_scheduled_publish',
    })
    const ignored = await runScheduledContentPublish(req, {
      collection: 'helpPages',
      documentId: String(help.id),
      publishAt: latestPublishAt,
      scheduledBy: String(editor.id),
    })
    expect(ignored).toMatchObject({ ignored: true, status: 'in_review' })
  })
})
