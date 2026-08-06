import config from '@payload-config'
import { getPayload } from 'payload'

import type { ContentCollection } from './types'

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

export async function isPublishedPublicContentPath(pathname: string): Promise<boolean | undefined> {
  const target = parsePublicContentPath(pathname)
  if (!target) return undefined
  const payload = await getPayload({ config })
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
