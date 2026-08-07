import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createCmsPageMetadata } from '@/lib/seo'
import type { Article } from '@/payload-types'
import { readPublicContentBySlug } from '@/services/content/read-content'
import { readPublicSitemap } from '@/services/content/sitemap'
import { readPublicTaxonomyBySlug } from '@/services/content/read-taxonomy'
import { readPublicToolRelations } from '@/services/content/read-tool-relations'

let payload: Payload
const prefix = `d3-seo-rel-${randomUUID()}`
const created: Array<{
  collection: 'articles' | 'categories' | 'helpPages' | 'tags' | 'tldPages'
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
            text: 'D3 content relation fixture',
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
    await payload.delete({ collection: document.collection, id: document.id, overrideAccess: true })
  }
  await payload.db.destroy?.()
})

describe('D3 content relations and SEO publication boundaries', () => {
  it('keeps bidirectional relations public only when every target is published', async () => {
    const tools = await payload.find({
      collection: 'toolPages',
      depth: 0,
      limit: 10,
      overrideAccess: false,
    })
    const dnsTool = tools.docs.find((tool) => tool.slug === 'dns')
    expect(tools.docs.map((tool) => tool.slug).sort()).toEqual([
      'dns',
      'domain-search',
      'idn',
      'pricing',
      'ssl-check',
      'whois',
    ])
    expect(dnsTool).toBeTruthy()

    const category = await payload.create({
      collection: 'categories',
      data: {
        description: '公开分类说明',
        meta: { noIndex: false, title: '分类 SEO 标题' },
        slug: `${prefix}-category`,
        title: `${prefix} category`,
      },
      overrideAccess: true,
    })
    const tag = await payload.create({
      collection: 'tags',
      data: {
        meta: { noIndex: true },
        slug: `${prefix}-tag`,
        title: `${prefix} tag`,
      },
      overrideAccess: true,
    })
    created.push({ collection: 'categories', id: category.id }, { collection: 'tags', id: tag.id })

    const publishedTld = await payload.create({
      collection: 'tldPages',
      data: {
        _status: 'published',
        content,
        publishedAt: new Date().toISOString(),
        relatedTools: [dnsTool!.id],
        slug: `${prefix}-published-tld`,
        source: 'D3 integration source',
        title: `${prefix} published TLD`,
        workflowStatus: 'published',
      },
      draft: false,
      overrideAccess: true,
    })
    const draftTld = await payload.create({
      collection: 'tldPages',
      data: {
        _status: 'draft',
        content,
        relatedTools: [dnsTool!.id],
        slug: `${prefix}-draft-tld`,
        title: `${prefix} draft TLD`,
        workflowStatus: 'draft',
      },
      draft: true,
      overrideAccess: true,
    })
    created.push(
      { collection: 'tldPages', id: publishedTld.id },
      { collection: 'tldPages', id: draftTld.id },
    )

    const publishedArticle = await payload.create({
      collection: 'articles',
      data: {
        _status: 'published',
        categories: [category.id],
        content,
        meta: {
          canonical: `/articles/${prefix}-canonical`,
          description: '文章 SEO 描述',
          noIndex: false,
          title: '文章 SEO 标题',
        },
        publishedAt: new Date().toISOString(),
        relatedTldPages: [publishedTld.id, draftTld.id],
        relatedTools: [dnsTool!.id],
        slug: `${prefix}-published-article`,
        source: 'D3 integration source',
        tags: [tag.id],
        title: `${prefix} published article`,
        workflowStatus: 'published',
      },
      draft: false,
      overrideAccess: true,
    })
    const draftArticle = await payload.create({
      collection: 'articles',
      data: {
        _status: 'draft',
        categories: [category.id],
        content,
        relatedTldPages: [publishedTld.id],
        relatedTools: [dnsTool!.id],
        slug: `${prefix}-draft-article`,
        tags: [tag.id],
        title: `${prefix} draft article`,
        workflowStatus: 'draft',
      },
      draft: true,
      overrideAccess: true,
    })
    const archivedArticle = await payload.create({
      collection: 'articles',
      data: {
        _status: 'published',
        categories: [category.id],
        content,
        relatedTldPages: [publishedTld.id],
        relatedTools: [dnsTool!.id],
        slug: `${prefix}-archived-article`,
        source: 'D3 integration source',
        tags: [tag.id],
        title: `${prefix} archived article`,
        workflowStatus: 'archived',
      },
      draft: false,
      overrideAccess: true,
    })
    created.push(
      { collection: 'articles', id: publishedArticle.id },
      { collection: 'articles', id: draftArticle.id },
      { collection: 'articles', id: archivedArticle.id },
    )

    const noIndexHelp = await payload.create({
      collection: 'helpPages',
      data: {
        _status: 'published',
        content,
        meta: { noIndex: true },
        publishedAt: new Date().toISOString(),
        slug: `${prefix}-noindex-help`,
        source: 'D3 integration source',
        title: `${prefix} noindex help`,
        workflowStatus: 'published',
      },
      draft: false,
      overrideAccess: true,
    })
    created.push({ collection: 'helpPages', id: noIndexHelp.id })

    const articleView = await readPublicContentBySlug(payload, 'articles', publishedArticle.slug)
    expect(articleView?.relatedTools.map((item) => item.href)).toEqual(['/tools/dns'])
    expect(articleView?.relatedTldPages.map((item) => item.href)).toEqual([
      `/tld/${publishedTld.slug}`,
    ])
    expect(articleView?.relatedTldPages.some((item) => item.href.includes('draft'))).toBe(false)

    const tldView = await readPublicContentBySlug(payload, 'tldPages', publishedTld.slug)
    expect(tldView?.relatedContent.map((item) => item.href)).toContain(
      `/articles/${publishedArticle.slug}`,
    )
    expect(tldView?.relatedContent.some((item) => item.href.includes('draft'))).toBe(false)
    expect(tldView?.relatedContent.some((item) => item.href.includes('archived'))).toBe(false)

    const anonymousArticle = await payload.find({
      collection: 'articles',
      depth: 0,
      draft: false,
      limit: 1,
      overrideAccess: false,
      where: { id: { equals: publishedArticle.id } },
    })
    expect(anonymousArticle.docs[0]).not.toHaveProperty('relatedTools')
    expect(anonymousArticle.docs[0]).not.toHaveProperty('relatedTldPages')

    const toolRelations = await readPublicToolRelations(payload, 'dns')
    expect(toolRelations.content.map((item) => item.href)).toContain(
      `/articles/${publishedArticle.slug}`,
    )
    expect(toolRelations.content.some((item) => item.href.includes('draft'))).toBe(false)
    expect(toolRelations.content.some((item) => item.href.includes('archived'))).toBe(false)
    expect(toolRelations.tldPages.map((item) => item.href)).toEqual([`/tld/${publishedTld.slug}`])

    const taxonomy = await readPublicTaxonomyBySlug(payload, 'categories', category.slug)
    expect(taxonomy?.articles.map((item) => item.href)).toEqual([
      `/articles/${publishedArticle.slug}`,
    ])
    expect(taxonomy?.seo.title).toBe('分类 SEO 标题')

    const metadata = createCmsPageMetadata({
      defaultDescription: articleView?.summary ?? articleView!.title,
      defaultPath: articleView!.path,
      defaultTitle: articleView!.title,
      seo: articleView!.seo,
    })
    expect(metadata).toMatchObject({
      alternates: { canonical: `http://127.0.0.1:3000/articles/${prefix}-canonical` },
      description: '文章 SEO 描述',
      robots: { follow: true, index: true },
      title: '文章 SEO 标题',
    })

    const sitemap = await readPublicSitemap(payload)
    const sitemapPaths = sitemap.map((entry) => new URL(entry.url).pathname)
    expect(sitemapPaths).not.toContain(`/articles/${prefix}-canonical`)
    expect(sitemapPaths).not.toContain(`/articles/${publishedArticle.slug}`)
    expect(sitemapPaths).toContain(`/tld/${publishedTld.slug}`)
    expect(sitemapPaths).toContain(`/articles/category/${category.slug}`)
    expect(sitemapPaths).not.toContain(`/articles/${draftArticle.slug}`)
    expect(sitemapPaths).not.toContain(`/articles/${archivedArticle.slug}`)
    expect(sitemapPaths).not.toContain(`/tld/${draftTld.slug}`)
    expect(sitemapPaths).not.toContain(`/help/${noIndexHelp.slug}`)
    expect(sitemapPaths).not.toContain(`/articles/tag/${tag.slug}`)
  })
})
