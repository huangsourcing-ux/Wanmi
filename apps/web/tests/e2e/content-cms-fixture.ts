import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { createLocalReq } from 'payload'

import type { Article } from '../../src/payload-types'
import { getFixturePayload } from './redirect-fixture'
import { readAdminAuthFixture } from './admin-auth-fixture'

const statePath = resolve(process.cwd(), 'test-results/content-cms-fixture.json')
const fixturePrefix = 'e2e-d3-content'

export type ContentCmsFixtureState = {
  articleId: number
  articleSlug: string
  publishedRoutes: string[]
}

const richText: Article['content'] = {
  root: {
    children: [
      {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 1,
                mode: 'normal',
                style: 'color:red',
                text: '外部安全来源',
                type: 'text',
                version: 1,
              },
            ],
            direction: null,
            fields: {
              linkType: 'custom',
              newTab: false,
              onmouseover: 'alert(1)',
              url: 'https://example.com/source',
            },
            format: '',
            indent: 0,
            type: 'link',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: 'background:url(javascript:alert(1))',
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

export async function createContentCmsFixture() {
  const payload = await getFixturePayload()
  const adminState = await readAdminAuthFixture()
  const editor = (
    await payload.find({
      collection: 'admins',
      limit: 1,
      overrideAccess: true,
      where: { email: { equals: adminState.roleAccounts.content_editor.email } },
    })
  ).docs[0]
  if (!editor) throw new Error('D3 E2E content editor fixture is missing')

  for (const collection of ['articles', 'topics', 'tldPages', 'helpPages'] as const) {
    const stale = await payload.find({
      collection,
      limit: 20,
      overrideAccess: true,
      where: { slug: { contains: fixturePrefix } },
    })
    for (const document of stale.docs) {
      await payload.delete({ collection, id: document.id, overrideAccess: true })
    }
  }

  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': 'e2e-d3-content-create' }) } },
    payload,
  )
  req.user = { ...editor, collection: 'admins' }
  const article = await payload.create({
    collection: 'articles',
    data: {
      _status: 'draft',
      content: richText,
      slug: `${fixturePrefix}-article`,
      source: 'Wanmi E2E 来源',
      summary: '用于验证审核、预览、发布、下线和归档。',
      title: 'D3 内容工作流文章',
      workflowStatus: 'draft',
    },
    draft: true,
    overrideAccess: false,
    req,
    user: editor,
  })

  const publishedRoutes: string[] = []
  for (const item of [
    { collection: 'topics' as const, path: '/topics', suffix: 'topic', title: 'D3 公开专题' },
    { collection: 'tldPages' as const, path: '/tld', suffix: 'tld', title: 'D3 公开 TLD' },
    { collection: 'helpPages' as const, path: '/help', suffix: 'help', title: 'D3 公开帮助' },
  ]) {
    const document = await payload.create({
      collection: item.collection,
      data: {
        _status: 'published',
        content: richText,
        publishedAt: new Date().toISOString(),
        slug: `${fixturePrefix}-${item.suffix}`,
        source: 'Wanmi E2E 来源',
        summary: 'D3 公开详情路由验证',
        title: item.title,
        workflowStatus: 'published',
      },
      draft: false,
      overrideAccess: true,
    })
    publishedRoutes.push(`${item.path}/${document.slug}`)
  }

  const state: ContentCmsFixtureState = {
    articleId: article.id,
    articleSlug: article.slug,
    publishedRoutes,
  }
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
}

export async function readContentCmsFixture(): Promise<ContentCmsFixtureState> {
  return JSON.parse(await readFile(statePath, 'utf8')) as ContentCmsFixtureState
}

export async function removeContentCmsFixture() {
  const payload = await getFixturePayload()
  for (const collection of ['articles', 'topics', 'tldPages', 'helpPages'] as const) {
    const documents = await payload.find({
      collection,
      limit: 20,
      overrideAccess: true,
      where: { slug: { contains: fixturePrefix } },
    })
    for (const document of documents.docs) {
      const jobs = await payload.find({
        collection: 'payload-jobs',
        overrideAccess: true,
        where: { concurrencyKey: { equals: `content:${collection}:${document.id}` } },
      })
      for (const job of jobs.docs) {
        await payload.delete({ collection: 'payload-jobs', id: job.id, overrideAccess: true })
      }
      const audits = await payload.find({
        collection: 'auditLogs',
        overrideAccess: true,
        where: { targetId: { equals: String(document.id) } },
      })
      for (const audit of audits.docs) {
        await payload.delete({ collection: 'auditLogs', id: audit.id, overrideAccess: true })
      }
      await payload.delete({ collection, id: document.id, overrideAccess: true })
    }
  }
  await unlink(statePath).catch(() => undefined)
}
