import config from '@payload-config'
import { getPayload } from 'payload'

import { PUBLIC_TAXONOMY_ROUTE_CONTEXT, type ContentCollection } from './types'

const publicContentPrefixes: Record<string, ContentCollection> = {
  articles: 'articles',
  help: 'helpPages',
  tld: 'tldPages',
  topics: 'topics',
}

export function parsePublicContentPath(
  pathname: string,
): { collection: ContentCollection; slug: string } | undefined {
  const match = /^\/(articles|help|tld|topics)\/([^/]+)$/u.exec(pathname)
  if (!match?.[1] || !match[2]) return undefined
  try {
    const slug = decodeURIComponent(match[2])
    if (!slug || slug.includes('/') || slug.includes('\\')) return undefined
    return { collection: publicContentPrefixes[match[1]] as ContentCollection, slug }
  } catch {
    return undefined
  }
}

export function parsePublicTaxonomyPath(
  pathname: string,
): { collection: 'categories' | 'tags'; slug: string } | undefined {
  const match = /^\/articles\/(category|tag)\/([^/]+)$/u.exec(pathname)
  if (!match?.[1] || !match[2]) return undefined
  try {
    const slug = decodeURIComponent(match[2])
    if (!slug || slug.includes('/') || slug.includes('\\')) return undefined
    return { collection: match[1] === 'category' ? 'categories' : 'tags', slug }
  } catch {
    return undefined
  }
}

export async function isPublishedPublicContentPath(pathname: string): Promise<boolean | undefined> {
  const target = parsePublicContentPath(pathname)
  const taxonomyTarget = parsePublicTaxonomyPath(pathname)
  if (!target && !taxonomyTarget) return undefined
  const payload = await getPayload({ config })
  if (target) {
    const result = await payload.find({
      collection: target.collection,
      depth: 0,
      draft: false,
      limit: 1,
      overrideAccess: false,
      where: {
        and: [
          { slug: { equals: target.slug } },
          { _status: { equals: 'published' } },
          { workflowStatus: { equals: 'published' } },
        ],
      },
    })
    return result.totalDocs > 0
  }

  if (!taxonomyTarget) return undefined
  const termResult = await payload.find({
    collection: taxonomyTarget.collection,
    context: { [PUBLIC_TAXONOMY_ROUTE_CONTEXT]: taxonomyTarget.slug },
    depth: 0,
    limit: 1,
    overrideAccess: false,
    where: { slug: { equals: taxonomyTarget.slug } },
  })
  const term = termResult.docs[0]
  if (!term) return false
  const relationField = taxonomyTarget.collection === 'categories' ? 'categories' : 'tags'
  const articleResult = await payload.find({
    collection: 'articles',
    depth: 0,
    draft: false,
    limit: 1,
    overrideAccess: false,
    where: {
      and: [
        { [relationField]: { equals: term.id } },
        { _status: { equals: 'published' } },
        { workflowStatus: { equals: 'published' } },
      ],
    },
  })
  return articleResult.totalDocs > 0
}
