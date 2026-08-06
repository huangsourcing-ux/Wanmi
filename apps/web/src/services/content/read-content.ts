import type { Payload, PayloadRequest } from 'payload'

import type { Admin } from '@/payload-types'

import { sanitizeRichText, collectMediaIds } from './rich-text'
import { PUBLIC_TAXONOMY_CONTEXT, type ContentCollection, contentPublicPath } from './types'

type RelationValue = number | string | { id: number | string }

type RawContentDocument = {
  categories?: RelationValue[] | null
  content: unknown
  createdAt: string
  id: number | string
  publishedAt?: null | string
  slug: string
  source?: null | string
  summary?: null | string
  tags?: RelationValue[] | null
  title: string
  updatedAt: string
  workflowStatus?: null | string
}

export type PublicTaxonomyTerm = { id: string; slug: string; title: string }
export type ContentMedia = {
  alt: string
  height?: null | number
  id: string
  url: string
  width?: null | number
}

export type ContentViewModel = {
  categories: PublicTaxonomyTerm[]
  collection: ContentCollection
  content: Record<string, unknown>
  createdAt: string
  id: string
  media: Record<string, ContentMedia>
  path: string
  publishedAt?: string
  scheduledPublishAt?: string
  slug: string
  source: string
  status: string
  summary?: string
  tags: PublicTaxonomyTerm[]
  title: string
  updatedAt: string
}

function relationIds(values: RelationValue[] | null | undefined): Array<number | string> {
  return (values ?? []).flatMap((value) => {
    if (typeof value === 'number' || typeof value === 'string') return [value]
    return typeof value.id === 'number' || typeof value.id === 'string' ? [value.id] : []
  })
}

async function readTerms(
  payload: Payload,
  collection: 'categories' | 'tags',
  ids: Array<number | string>,
): Promise<PublicTaxonomyTerm[]> {
  if (!ids.length) return []
  const result = await payload.find({
    collection,
    context: { [PUBLIC_TAXONOMY_CONTEXT]: ids },
    depth: 0,
    limit: ids.length,
    overrideAccess: false,
    sort: 'title',
    where: { id: { in: ids } },
  })
  return result.docs.map((term) => ({
    id: String(term.id),
    slug: term.slug,
    title: term.title,
  }))
}

async function readMedia(
  payload: Payload,
  content: unknown,
): Promise<Record<string, ContentMedia>> {
  const ids = collectMediaIds(content)
  if (!ids.length) return {}
  const result = await payload.find({
    collection: 'media',
    depth: 0,
    limit: ids.length,
    overrideAccess: false,
    where: { id: { in: ids } },
  })
  return Object.fromEntries(
    result.docs.flatMap((item) =>
      item.url && (/^https?:\/\//iu.test(item.url) || item.url.startsWith('/'))
        ? [
            [
              String(item.id),
              {
                alt: item.alt,
                height: item.height,
                id: String(item.id),
                url: item.url,
                width: item.width,
              },
            ],
          ]
        : [],
    ),
  )
}

async function mapDocument(
  payload: Payload,
  collection: ContentCollection,
  document: RawContentDocument & { scheduledPublishAt?: null | string },
): Promise<ContentViewModel> {
  const content = sanitizeRichText(document.content)
  const [categories, tags, media] = await Promise.all([
    collection === 'articles'
      ? readTerms(payload, 'categories', relationIds(document.categories))
      : Promise.resolve([]),
    collection === 'articles'
      ? readTerms(payload, 'tags', relationIds(document.tags))
      : Promise.resolve([]),
    readMedia(payload, content),
  ])
  return {
    categories,
    collection,
    content,
    createdAt: document.createdAt,
    id: String(document.id),
    media,
    path: contentPublicPath(collection, document.slug),
    publishedAt: document.publishedAt ?? undefined,
    scheduledPublishAt: document.scheduledPublishAt ?? undefined,
    slug: document.slug,
    source: document.source?.trim() ?? '',
    status: document.workflowStatus ?? 'draft',
    summary: document.summary?.trim() || undefined,
    tags,
    title: document.title,
    updatedAt: document.updatedAt,
  }
}

export async function readPublicContentBySlug(
  payload: Payload,
  collection: ContentCollection,
  slug: string,
): Promise<ContentViewModel | null> {
  const result = await payload.find({
    collection,
    depth: 0,
    draft: false,
    limit: 1,
    overrideAccess: false,
    where: {
      and: [
        { slug: { equals: slug } },
        { _status: { equals: 'published' } },
        { workflowStatus: { equals: 'published' } },
      ],
    },
  })
  const document = result.docs[0] as RawContentDocument | undefined
  return document ? mapDocument(payload, collection, document) : null
}

export async function readPreviewContentBySlug(
  payload: Payload,
  req: PayloadRequest,
  user: Admin,
  collection: ContentCollection,
  slug: string,
): Promise<ContentViewModel | null> {
  const result = await payload.find({
    collection,
    depth: 0,
    draft: true,
    limit: 1,
    overrideAccess: false,
    req,
    user,
    where: { slug: { equals: slug } },
  })
  const document = result.docs[0] as RawContentDocument | undefined
  return document ? mapDocument(payload, collection, document) : null
}
