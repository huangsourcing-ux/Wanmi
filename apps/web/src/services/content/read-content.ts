import type { Payload, PayloadRequest } from 'payload'

import type { Admin } from '@/payload-types'
import { absoluteSiteUrl, type CmsSeoMetadata } from '@/lib/seo'
import { getPublicToolDefinition, type PublicToolSlug } from '@/lib/site-config'

import { sanitizeRichText, collectMediaIds } from './rich-text'
import {
  PUBLIC_CONTENT_RELATIONS_CONTEXT,
  PUBLIC_TAXONOMY_CONTEXT,
  type ContentCollection,
  contentPublicPath,
} from './types'

type RelationValue = number | string | { id: number | string }

type RawContentDocument = {
  categories?: RelationValue[] | null
  content: unknown
  createdAt: string
  id: number | string
  meta?: {
    canonical?: null | string
    description?: null | string
    image?: null | RelationValue
    noIndex?: null | boolean
    title?: null | string
  }
  publishedAt?: null | string
  relatedTldPages?: RelationValue[] | null
  relatedTools?: RelationValue[] | null
  slug: string
  source?: null | string
  summary?: null | string
  tags?: RelationValue[] | null
  title: string
  updatedAt: string
  workflowStatus?: null | string
}

export type PublicTaxonomyTerm = { id: string; slug: string; title: string }
export type PublicRelatedItem = {
  description?: string
  href: string
  id: string
  title: string
}
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
  seo: CmsSeoMetadata
  slug: string
  source: string
  status: string
  summary?: string
  tags: PublicTaxonomyTerm[]
  title: string
  updatedAt: string
  relatedContent: PublicRelatedItem[]
  relatedTldPages: PublicRelatedItem[]
  relatedTools: PublicRelatedItem[]
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

function relationId(value: RelationValue | null | undefined): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return value
  return value && (typeof value.id === 'number' || typeof value.id === 'string')
    ? value.id
    : undefined
}

export async function readPublicSeoImage(
  payload: Payload,
  value: RelationValue | null | undefined,
): Promise<CmsSeoMetadata['image'] | undefined> {
  const id = relationId(value)
  if (id === undefined) return undefined
  try {
    const image = await payload.findByID({
      collection: 'media',
      depth: 0,
      id,
      overrideAccess: false,
    })
    if (!image.url || (!/^https?:\/\//iu.test(image.url) && !image.url.startsWith('/'))) {
      return undefined
    }
    return {
      alt: image.alt,
      height: image.height,
      url: image.url.startsWith('/') ? absoluteSiteUrl(image.url) : image.url,
      width: image.width,
    }
  } catch {
    return undefined
  }
}

async function readRelatedTools(
  payload: Payload,
  ids: Array<number | string>,
): Promise<PublicRelatedItem[]> {
  if (!ids.length) return []
  const result = await payload.find({
    collection: 'toolPages',
    depth: 0,
    limit: ids.length,
    overrideAccess: false,
    where: { id: { in: ids } },
  })
  return result.docs.flatMap((document) => {
    try {
      const tool = getPublicToolDefinition(document.slug as PublicToolSlug)
      return [
        {
          description: tool.description,
          href: tool.href,
          id: String(document.id),
          title: tool.title,
        },
      ]
    } catch {
      return []
    }
  })
}

async function readRelatedTldPages(
  payload: Payload,
  ids: Array<number | string>,
): Promise<PublicRelatedItem[]> {
  if (!ids.length) return []
  const result = await payload.find({
    collection: 'tldPages',
    depth: 0,
    draft: false,
    limit: ids.length,
    overrideAccess: false,
    where: {
      and: [
        { id: { in: ids } },
        { _status: { equals: 'published' } },
        { workflowStatus: { equals: 'published' } },
      ],
    },
  })
  return result.docs.map((document) => ({
    description: document.summary?.trim() || undefined,
    href: contentPublicPath('tldPages', document.slug),
    id: String(document.id),
    title: document.title,
  }))
}

async function readTldRelatedContent(
  payload: Payload,
  tldPageId: number | string,
): Promise<PublicRelatedItem[]> {
  const collections = ['articles', 'topics', 'helpPages'] as const
  const results = await Promise.all(
    collections.map((collection) =>
      payload.find({
        collection,
        context: { [PUBLIC_CONTENT_RELATIONS_CONTEXT]: true },
        depth: 0,
        draft: false,
        limit: 8,
        overrideAccess: false,
        sort: '-updatedAt',
        where: {
          and: [
            { relatedTldPages: { equals: tldPageId } },
            { _status: { equals: 'published' } },
            { workflowStatus: { equals: 'published' } },
          ],
        },
      }),
    ),
  )
  return results.flatMap((result, index) => {
    const collection = collections[index] as (typeof collections)[number]
    return result.docs.map((document) => ({
      description: document.summary?.trim() || undefined,
      href: contentPublicPath(collection, document.slug),
      id: `${collection}:${document.id}`,
      title: document.title,
    }))
  })
}

async function mapDocument(
  payload: Payload,
  collection: ContentCollection,
  document: RawContentDocument & { scheduledPublishAt?: null | string },
): Promise<ContentViewModel> {
  const content = sanitizeRichText(document.content)
  const [categories, tags, media, seoImage, relatedTools, relatedTldPages, relatedContent] =
    await Promise.all([
      collection === 'articles'
        ? readTerms(payload, 'categories', relationIds(document.categories))
        : Promise.resolve([]),
      collection === 'articles'
        ? readTerms(payload, 'tags', relationIds(document.tags))
        : Promise.resolve([]),
      readMedia(payload, content),
      readPublicSeoImage(payload, document.meta?.image),
      readRelatedTools(payload, relationIds(document.relatedTools)),
      collection === 'tldPages'
        ? Promise.resolve([])
        : readRelatedTldPages(payload, relationIds(document.relatedTldPages)),
      collection === 'tldPages' ? readTldRelatedContent(payload, document.id) : Promise.resolve([]),
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
    relatedContent,
    relatedTldPages,
    relatedTools,
    scheduledPublishAt: document.scheduledPublishAt ?? undefined,
    seo: {
      canonical: document.meta?.canonical?.trim() || undefined,
      description: document.meta?.description?.trim() || undefined,
      image: seoImage,
      noIndex: document.meta?.noIndex === true,
      title: document.meta?.title?.trim() || undefined,
    },
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
    context: { [PUBLIC_CONTENT_RELATIONS_CONTEXT]: true },
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
    context: { [PUBLIC_CONTENT_RELATIONS_CONTEXT]: true },
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
