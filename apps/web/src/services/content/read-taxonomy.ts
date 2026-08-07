import type { Payload } from 'payload'

import type { CmsSeoMetadata } from '@/lib/seo'

import { readPublicSeoImage, type PublicRelatedItem } from './read-content'
import { PUBLIC_TAXONOMY_ROUTE_CONTEXT, contentPublicPath } from './types'

type TaxonomyCollection = 'categories' | 'tags'
type RelationValue = number | string | { id: number | string }

type RawTaxonomyTerm = {
  description?: null | string
  id: number | string
  meta?: {
    canonical?: null | string
    description?: null | string
    image?: null | RelationValue
    noIndex?: null | boolean
    title?: null | string
  }
  slug: string
  title: string
  updatedAt: string
}

export type PublicTaxonomyViewModel = {
  articles: PublicRelatedItem[]
  description?: string
  id: string
  path: string
  seo: CmsSeoMetadata
  slug: string
  title: string
  updatedAt: string
}

export async function readPublicTaxonomyBySlug(
  payload: Payload,
  collection: TaxonomyCollection,
  slug: string,
): Promise<PublicTaxonomyViewModel | null> {
  const termResult = await payload.find({
    collection,
    context: { [PUBLIC_TAXONOMY_ROUTE_CONTEXT]: slug },
    depth: 0,
    limit: 1,
    overrideAccess: false,
    where: { slug: { equals: slug } },
  })
  const term = termResult.docs[0] as RawTaxonomyTerm | undefined
  if (!term) return null

  const relationField = collection === 'categories' ? 'categories' : 'tags'
  const articles = await payload.find({
    collection: 'articles',
    depth: 0,
    draft: false,
    limit: 24,
    overrideAccess: false,
    sort: '-publishedAt',
    where: {
      and: [
        { [relationField]: { equals: term.id } },
        { _status: { equals: 'published' } },
        { workflowStatus: { equals: 'published' } },
      ],
    },
  })
  if (!articles.totalDocs) return null

  const image = await readPublicSeoImage(payload, term.meta?.image)
  return {
    articles: articles.docs.map((article) => ({
      description: article.summary?.trim() || undefined,
      href: contentPublicPath('articles', article.slug),
      id: String(article.id),
      title: article.title,
    })),
    description: term.description?.trim() || undefined,
    id: String(term.id),
    path:
      collection === 'categories'
        ? `/articles/category/${encodeURIComponent(term.slug)}`
        : `/articles/tag/${encodeURIComponent(term.slug)}`,
    seo: {
      canonical: term.meta?.canonical?.trim() || undefined,
      description: term.meta?.description?.trim() || undefined,
      image,
      noIndex: term.meta?.noIndex === true,
      title: term.meta?.title?.trim() || undefined,
    },
    slug: term.slug,
    title: term.title,
    updatedAt: term.updatedAt,
  }
}
