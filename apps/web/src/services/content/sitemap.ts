import type { MetadataRoute } from 'next'
import type { Payload } from 'payload'

import { absoluteSiteUrl, canonicalPath, contentPath, PUBLIC_SEO_ROUTES } from '@/lib/seo'

import { PUBLIC_TAXONOMY_CONTEXT } from './types'

export const SITEMAP_PAGE_SIZE = 200
export const DYNAMIC_SITEMAP_LIMIT = 5_000
export const SITEMAP_RELATION_SCAN_LIMIT = 10_000

type RelationValue = number | string | { id: number | string }
type SitemapContentCollection = 'articles' | 'helpPages' | 'tldPages' | 'topics'
type SitemapTaxonomyCollection = 'categories' | 'tags'

type SitemapDocument = {
  categories?: RelationValue[] | null
  meta?: { canonical?: null | string; noIndex?: null | boolean }
  slug: string
  tags?: RelationValue[] | null
  updatedAt: string
  workflowStatus?: null | string
  _status?: null | string
}

function relationIds(values: RelationValue[] | null | undefined): Array<number | string> {
  return (values ?? []).flatMap((value) => {
    if (typeof value === 'number' || typeof value === 'string') return [value]
    return typeof value.id === 'number' || typeof value.id === 'string' ? [value.id] : []
  })
}

export function staticSitemapEntries(): MetadataRoute.Sitemap {
  return PUBLIC_SEO_ROUTES.map(({ changeFrequency, path, priority }) => ({
    changeFrequency,
    priority,
    url: absoluteSiteUrl(path),
  }))
}

function dynamicEntry(
  collection: SitemapContentCollection | SitemapTaxonomyCollection,
  document: SitemapDocument,
): MetadataRoute.Sitemap[number] | undefined {
  if (!document.slug || document.meta?.noIndex === true) return undefined
  if (
    collection !== 'categories' &&
    collection !== 'tags' &&
    (document._status !== 'published' || document.workflowStatus !== 'published')
  ) {
    return undefined
  }
  const defaultPath = contentPath(collection, document.slug)
  const resolvedCanonicalPath = canonicalPath(defaultPath, document.meta?.canonical ?? undefined)
  if (resolvedCanonicalPath !== defaultPath) return undefined
  return {
    changeFrequency: collection === 'tldPages' ? 'weekly' : 'monthly',
    lastModified: document.updatedAt,
    priority: collection === 'tldPages' ? 0.8 : 0.6,
    url: absoluteSiteUrl(defaultPath),
  }
}

async function readContentEntries(
  payload: Pick<Payload, 'find'>,
  remaining: number,
): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = []
  const collections = ['articles', 'topics', 'tldPages', 'helpPages'] as const
  for (const collection of collections) {
    let page = 1
    let hasNextPage = true
    while (hasNextPage && entries.length < remaining) {
      const result = await payload.find({
        collection,
        depth: 0,
        draft: false,
        limit: Math.min(SITEMAP_PAGE_SIZE, remaining - entries.length),
        overrideAccess: false,
        page,
        sort: 'id',
        where: {
          and: [
            { _status: { equals: 'published' } },
            { workflowStatus: { equals: 'published' } },
            { 'meta.noIndex': { not_equals: true } },
          ],
        },
      })
      for (const document of result.docs as SitemapDocument[]) {
        if (entries.length >= remaining) break
        const entry = dynamicEntry(collection, document)
        if (entry) entries.push(entry)
      }
      hasNextPage = result.hasNextPage
      page += 1
    }
    if (entries.length >= remaining) break
  }
  return entries
}

async function readPublishedTaxonomyIds(
  payload: Pick<Payload, 'find'>,
): Promise<{ categories: Array<number | string>; tags: Array<number | string> }> {
  const categories = new Set<number | string>()
  const tags = new Set<number | string>()
  let page = 1
  let scanned = 0
  let hasNextPage = true
  while (hasNextPage && scanned < SITEMAP_RELATION_SCAN_LIMIT) {
    const result = await payload.find({
      collection: 'articles',
      depth: 0,
      draft: false,
      limit: Math.min(SITEMAP_PAGE_SIZE, SITEMAP_RELATION_SCAN_LIMIT - scanned),
      overrideAccess: false,
      page,
      sort: 'id',
      where: {
        and: [{ _status: { equals: 'published' } }, { workflowStatus: { equals: 'published' } }],
      },
    })
    for (const document of result.docs as SitemapDocument[]) {
      relationIds(document.categories).forEach((id) => categories.add(id))
      relationIds(document.tags).forEach((id) => tags.add(id))
    }
    scanned += result.docs.length
    hasNextPage = result.hasNextPage
    page += 1
  }
  return { categories: [...categories], tags: [...tags] }
}

async function readTaxonomyEntries(
  payload: Pick<Payload, 'find'>,
  remaining: number,
): Promise<MetadataRoute.Sitemap> {
  const ids = await readPublishedTaxonomyIds(payload)
  const entries: MetadataRoute.Sitemap = []
  for (const collection of ['categories', 'tags'] as const) {
    const collectionIds = ids[collection]
    for (
      let offset = 0;
      offset < collectionIds.length && entries.length < remaining;
      offset += SITEMAP_PAGE_SIZE
    ) {
      const chunk = collectionIds.slice(offset, offset + SITEMAP_PAGE_SIZE)
      const result = await payload.find({
        collection,
        context: { [PUBLIC_TAXONOMY_CONTEXT]: chunk },
        depth: 0,
        limit: Math.min(chunk.length, remaining - entries.length),
        overrideAccess: false,
        sort: 'id',
        where: {
          and: [{ id: { in: chunk } }, { 'meta.noIndex': { not_equals: true } }],
        },
      })
      for (const document of result.docs as SitemapDocument[]) {
        if (entries.length >= remaining) break
        const entry = dynamicEntry(collection, document)
        if (entry) entries.push(entry)
      }
    }
  }
  return entries
}

export async function readPublicSitemap(
  payload: Pick<Payload, 'find'>,
): Promise<MetadataRoute.Sitemap> {
  const fixed = staticSitemapEntries()
  const dynamicContent = await readContentEntries(payload, DYNAMIC_SITEMAP_LIMIT)
  const remaining = DYNAMIC_SITEMAP_LIMIT - dynamicContent.length
  const taxonomy = remaining > 0 ? await readTaxonomyEntries(payload, remaining) : []
  const seen = new Set<string>()
  return [...fixed, ...dynamicContent, ...taxonomy].filter((entry) => {
    if (seen.has(entry.url)) return false
    seen.add(entry.url)
    return true
  })
}
