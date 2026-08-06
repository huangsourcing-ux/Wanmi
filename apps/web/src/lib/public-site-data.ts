import { cache } from 'react'

import config from '@payload-config'
import { getPayload, type Payload } from 'payload'

import { logger } from '@/lib/logging'
import { DEFAULT_NAVIGATION, type SiteNavigationItem } from '@/lib/site-config'

export type PublicContentItem = {
  href: string
  id: string
  slug: string
  summary?: string
  title: string
}

export type PublicSectionStatus = 'empty' | 'ready' | 'unavailable'

export type PublicContentSection = {
  href: '/articles' | '/help' | '/pricing' | '/topics'
  items: PublicContentItem[]
  status: PublicSectionStatus
  title: string
}

export type PublicSiteData = {
  articles: PublicContentSection
  helpPages: PublicContentSection
  navigation: {
    items: SiteNavigationItem[]
    status: PublicSectionStatus
  }
  tldPages: PublicContentSection
  topics: PublicContentSection
}

type PublicSitePayload = Pick<Payload, 'find'>

type ContentDocument = {
  id: number | string
  slug: string
  summary?: null | string
  title: string
}

type NavigationDocument = {
  enabled: boolean
  href: string
  id: number | string
  label: string
  order: number
}

export function isSafeInternalHref(href: string): boolean {
  return /^\/(?!\/)[^\s\\]*$/.test(href)
}

export function sanitizeNavigationItems(documents: NavigationDocument[]): SiteNavigationItem[] {
  const seen = new Set<string>()

  return documents
    .filter((document) => document.enabled)
    .sort((left, right) => left.order - right.order)
    .flatMap((document) => {
      const href = document.href.trim()
      const label = document.label.trim()
      if (!label || !isSafeInternalHref(href) || seen.has(href)) return []
      seen.add(href)
      return [{ href, id: String(document.id), label }]
    })
}

function mapContentItems(
  documents: ContentDocument[],
  pathForSlug: (slug: string) => string,
): PublicContentItem[] {
  return documents.map((document) => ({
    href: pathForSlug(document.slug),
    id: String(document.id),
    slug: document.slug,
    summary: document.summary?.trim() || undefined,
    title: document.title,
  }))
}

function makeContentSection(
  result: PromiseSettledResult<{ docs: ContentDocument[] }>,
  title: string,
  href: PublicContentSection['href'],
  pathForSlug: (slug: string) => string,
): PublicContentSection {
  if (result.status === 'rejected') return { href, items: [], status: 'unavailable', title }
  const items = mapContentItems(result.value.docs, pathForSlug)
  return { href, items, status: items.length ? 'ready' : 'empty', title }
}

export function createUnavailablePublicSiteData(): PublicSiteData {
  return {
    articles: { href: '/articles', items: [], status: 'unavailable', title: '最新实用内容' },
    helpPages: { href: '/help', items: [], status: 'unavailable', title: '帮助文章' },
    navigation: { items: DEFAULT_NAVIGATION, status: 'unavailable' },
    tldPages: { href: '/pricing', items: [], status: 'unavailable', title: 'TLD 页面' },
    topics: { href: '/topics', items: [], status: 'unavailable', title: '专题与指南' },
  }
}

export async function readPublicSiteData(payload: PublicSitePayload): Promise<PublicSiteData> {
  const results = await Promise.allSettled([
    payload.find({
      collection: 'navigation',
      depth: 0,
      limit: 20,
      overrideAccess: false,
      sort: 'order',
      where: { enabled: { equals: true } },
    }),
    payload.find({
      collection: 'articles',
      depth: 0,
      limit: 3,
      overrideAccess: false,
      sort: '-publishedAt',
    }),
    payload.find({
      collection: 'tldPages',
      depth: 0,
      limit: 3,
      overrideAccess: false,
      sort: '-publishedAt',
    }),
    payload.find({
      collection: 'topics',
      depth: 0,
      limit: 3,
      overrideAccess: false,
      sort: '-publishedAt',
    }),
    payload.find({
      collection: 'helpPages',
      depth: 0,
      limit: 6,
      overrideAccess: false,
      sort: '-publishedAt',
    }),
  ] as const)

  const [navigationResult, articlesResult, tldPagesResult, topicsResult, helpPagesResult] = results
  const navigationItems =
    navigationResult.status === 'fulfilled'
      ? sanitizeNavigationItems(navigationResult.value.docs as NavigationDocument[])
      : []
  const navigationStatus: PublicSectionStatus =
    navigationResult.status === 'rejected'
      ? 'unavailable'
      : navigationItems.length
        ? 'ready'
        : 'empty'

  return {
    articles: makeContentSection(
      articlesResult,
      '最新实用内容',
      '/articles',
      (slug) => `/articles/${encodeURIComponent(slug)}`,
    ),
    helpPages: makeContentSection(
      helpPagesResult,
      '帮助文章',
      '/help',
      (slug) => `/help/${encodeURIComponent(slug)}`,
    ),
    navigation: {
      items: navigationItems.length ? navigationItems : DEFAULT_NAVIGATION,
      status: navigationStatus,
    },
    tldPages: makeContentSection(
      tldPagesResult,
      'TLD 页面',
      '/pricing',
      (slug) => `/tld/${encodeURIComponent(slug)}`,
    ),
    topics: makeContentSection(
      topicsResult,
      '专题与指南',
      '/topics',
      (slug) => `/topics/${encodeURIComponent(slug)}`,
    ),
  }
}

async function loadPublicSiteData(): Promise<PublicSiteData> {
  try {
    const payload = await getPayload({ config })
    const data = await readPublicSiteData(payload)
    const unavailableSections = [
      data.navigation.status === 'unavailable' ? 'navigation' : undefined,
      data.articles.status === 'unavailable' ? 'articles' : undefined,
      data.helpPages.status === 'unavailable' ? 'helpPages' : undefined,
      data.tldPages.status === 'unavailable' ? 'tldPages' : undefined,
      data.topics.status === 'unavailable' ? 'topics' : undefined,
    ].filter(Boolean)

    if (unavailableSections.length) {
      logger.warn({
        msg: 'Public site data partially unavailable; rendering safe fallbacks',
        sections: unavailableSections,
      })
    }

    return data
  } catch (error) {
    logger.warn({
      errorName: error instanceof Error ? error.name : 'UnknownError',
      msg: 'Public site data unavailable; rendering safe fallbacks',
    })
    return createUnavailablePublicSiteData()
  }
}

export const getPublicSiteData = cache(loadPublicSiteData)
