import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readPublicSiteData } from '@/lib/public-site-data'
import type { Article } from '@/payload-types'

let payload: Payload
const fixturePrefix = `d1-public-${randomUUID()}`
const created: Array<{
  collection: 'articles' | 'helpPages' | 'tldPages' | 'topics'
  id: number | string
}> = []

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
            text: 'D1 public content fixture',
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

beforeAll(async () => {
  payload = await getPayload({ config })
})

afterAll(async () => {
  for (const document of created.reverse()) {
    await payload.delete({
      collection: document.collection,
      id: document.id,
      overrideAccess: true,
    })
  }
  await payload.db.destroy?.()
})

describe('D1 public content access', () => {
  it('shows published content, excludes drafts and keeps all content sections independent', async () => {
    const draft = await payload.create({
      collection: 'articles',
      data: {
        _status: 'draft',
        content,
        meta: { canonical: `/articles/${fixturePrefix}-draft`, noIndex: false },
        publishedAt: '2099-01-02T00:00:00.000Z',
        slug: `${fixturePrefix}-draft`,
        summary: '不应公开',
        title: `${fixturePrefix} draft`,
      },
      draft: true,
      overrideAccess: true,
    })
    created.push({ collection: 'articles', id: draft.id })

    for (const fixture of [
      { collection: 'articles' as const, suffix: 'article', title: '公开文章' },
      { collection: 'tldPages' as const, suffix: 'tld', title: '公开 TLD' },
      { collection: 'topics' as const, suffix: 'topic', title: '公开专题' },
      { collection: 'helpPages' as const, suffix: 'help', title: '公开帮助' },
    ]) {
      const document = await payload.create({
        collection: fixture.collection,
        data: {
          _status: 'published',
          content,
          meta: {
            canonical:
              fixture.collection === 'tldPages'
                ? `/tld/${fixturePrefix}-${fixture.suffix}`
                : `/${fixture.collection}/${fixturePrefix}-${fixture.suffix}`,
            noIndex: false,
          },
          publishedAt: '2099-01-01T00:00:00.000Z',
          source: 'D3 test fixture',
          slug: `${fixturePrefix}-${fixture.suffix}`,
          summary: '公开摘要',
          title: `${fixturePrefix} ${fixture.title}`,
          workflowStatus: 'published',
        },
        draft: false,
        overrideAccess: true,
      })
      created.push({ collection: fixture.collection, id: document.id })
    }

    const data = await readPublicSiteData(payload)

    expect(data.articles.items.map((item) => item.title)).toContain(`${fixturePrefix} 公开文章`)
    expect(data.helpPages.items.map((item) => item.title)).toContain(`${fixturePrefix} 公开帮助`)
    expect(data.articles.items.map((item) => item.title)).not.toContain(`${fixturePrefix} draft`)
    expect(data.tldPages.items.map((item) => item.title)).toContain(`${fixturePrefix} 公开 TLD`)
    expect(data.topics.items.map((item) => item.title)).toContain(`${fixturePrefix} 公开专题`)

    const anonymousArticles = await payload.find({
      collection: 'articles',
      depth: 0,
      limit: 10,
      overrideAccess: false,
      where: { slug: { contains: fixturePrefix } },
    })
    expect(anonymousArticles.docs.map((document) => document.title)).not.toContain(
      `${fixturePrefix} draft`,
    )
    expect(anonymousArticles.docs).toContainEqual(
      expect.objectContaining({
        meta: expect.objectContaining({
          canonical: `/articles/${fixturePrefix}-article`,
          noIndex: false,
        }),
        title: `${fixturePrefix} 公开文章`,
      }),
    )
  })

  it('keeps healthy database-backed sections visible when one collection read fails', async () => {
    const partiallyUnavailablePayload: Pick<Payload, 'find'> = {
      find: ((args: Parameters<Payload['find']>[0]) => {
        if (args.collection === 'articles') return Promise.reject(new Error('articles unavailable'))
        return payload.find(args)
      }) as Payload['find'],
    }

    const data = await readPublicSiteData(partiallyUnavailablePayload)

    expect(data.articles.status).toBe('unavailable')
    expect(data.tldPages.items.map((item) => item.title)).toContain(`${fixturePrefix} 公开 TLD`)
    expect(data.topics.items.map((item) => item.title)).toContain(`${fixturePrefix} 公开专题`)
  })
})
