import type { Metadata, MetadataRoute } from 'next'

import { LEGAL_DOCUMENTS } from '@/lib/legal-config'
import { getEnv } from '@/lib/env'
import { PRICING_TOOL, TOOL_DEFINITIONS } from '@/lib/site-config'

export const SITE_NAME = 'Wanmi.net'
export const SITE_TITLE = 'Wanmi.net｜中文域名工具与服务入口'
export const SITE_DESCRIPTION = '面向中文用户的域名查询、WHOIS、DNS、SSL、IDN 与 TLD 价格工具入口。'
export const DEFAULT_OG_IMAGE_PATH = '/opengraph-image'

export type SeoContentCollection =
  | 'articles'
  | 'categories'
  | 'helpPages'
  | 'tags'
  | 'tldPages'
  | 'topics'

export type CmsSeoMetadata = {
  canonical?: string
  description?: string
  image?: {
    alt: string
    height?: null | number
    url: string
    width?: null | number
  }
  noIndex?: boolean
  title?: string
}

export type PublicSeoRoute = {
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]['changeFrequency']>
  description: string
  path: string
  priority: number
  title: string
}

const fixedRoutes: PublicSeoRoute[] = [
  {
    changeFrequency: 'weekly',
    description: SITE_DESCRIPTION,
    path: '/',
    priority: 1,
    title: SITE_TITLE,
  },
  {
    changeFrequency: 'weekly',
    description: '浏览 Wanmi.net 的域名可注册、WHOIS、DNS、价格、IDN 和 SSL/CAA 工具入口。',
    path: '/tools',
    priority: 0.9,
    title: '域名工具中心',
  },
  {
    changeFrequency: 'weekly',
    description: '查看 Wanmi.net 计划提供的 TLD 注册、续费和多年成本入口。',
    path: '/pricing',
    priority: 0.8,
    title: PRICING_TOOL.title,
  },
  {
    changeFrequency: 'weekly',
    description: '域名选择、注册规则、DNS、WHOIS、SSL 与建站相关的中文实用内容入口。',
    path: '/articles',
    priority: 0.8,
    title: '实用内容',
  },
  {
    changeFrequency: 'weekly',
    description: '串联 Wanmi.net 域名工具、TLD 页面与实用内容的专题和指南入口。',
    path: '/topics',
    priority: 0.7,
    title: '专题与指南',
  },
  {
    changeFrequency: 'monthly',
    description: '了解 Wanmi.net 域名工具的数据来源、更新时间、结果限制和当前服务边界。',
    path: '/help',
    priority: 0.6,
    title: '帮助与数据来源',
  },
  {
    changeFrequency: 'monthly',
    description: 'Wanmi.net 隐私、使用条款、Cookie 和广告说明的开发期入口。',
    path: '/legal',
    priority: 0.4,
    title: '帮助与合规',
  },
  {
    changeFrequency: 'yearly',
    description: '联系 Wanmi.net，提交一般咨询、内容合作、广告合作和其他非交易事项。',
    path: '/contact',
    priority: 0.4,
    title: '联系我们',
  },
  {
    changeFrequency: 'yearly',
    description: '向 Wanmi.net 提交工具结果、内容问题或使用体验反馈。',
    path: '/feedback',
    priority: 0.4,
    title: '提交反馈',
  },
  {
    changeFrequency: 'yearly',
    description: '向 Wanmi.net 提交工具、TLD 信息、内容选题或合作需求。',
    path: '/requests',
    priority: 0.4,
    title: '提交需求',
  },
]

const toolRoutes: PublicSeoRoute[] = TOOL_DEFINITIONS.map((tool) => ({
  changeFrequency: 'weekly',
  description: tool.description,
  path: tool.href,
  priority: tool.slug === 'domain-search' ? 0.9 : 0.8,
  title: tool.title,
}))

const legalRoutes: PublicSeoRoute[] = LEGAL_DOCUMENTS.map((document) => ({
  changeFrequency: 'yearly',
  description: document.description,
  path: `/legal/${document.slug}`,
  priority: 0.3,
  title: document.title,
}))

export const PUBLIC_SEO_ROUTES = [...fixedRoutes, ...toolRoutes, ...legalRoutes] as const

const routeByPath = new Map(PUBLIC_SEO_ROUTES.map((route) => [route.path, route]))

export function getSiteOrigin(): URL {
  return new URL(new URL(getEnv().NEXT_PUBLIC_SERVER_URL).origin)
}

export function absoluteSiteUrl(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('Site URL path must be a root-relative path')
  }
  return new URL(path, getSiteOrigin()).toString()
}

export function getPublicSeoRoute(path: string): PublicSeoRoute {
  const route = routeByPath.get(path)
  if (!route) throw new Error(`Unknown public SEO route: ${path}`)
  return route
}

function displayTitle(title: string, path: string): string {
  return path === '/' ? SITE_TITLE : `${title}｜${SITE_NAME}`
}

export function createPageMetadata({
  canonical: customCanonical,
  description,
  image: customImage,
  noIndex = false,
  path,
  title,
}: {
  canonical?: string
  description: string
  image?: CmsSeoMetadata['image']
  noIndex?: boolean
  path: string
  title: string
}): Metadata {
  const canonical = resolveCanonicalUrl(path, customCanonical)
  const socialTitle = displayTitle(title, path)
  const image = customImage?.url ?? absoluteSiteUrl(DEFAULT_OG_IMAGE_PATH)
  const imageAlt = customImage?.alt ?? `${SITE_NAME} 中文域名工具与服务入口`

  return {
    alternates: { canonical },
    description,
    openGraph: {
      description,
      images: [
        {
          alt: imageAlt,
          height: customImage?.height ?? 630,
          url: image,
          width: customImage?.width ?? 1200,
        },
      ],
      locale: 'zh_CN',
      siteName: SITE_NAME,
      title: socialTitle,
      type: 'website',
      url: canonical,
    },
    robots: noIndex
      ? {
          follow: false,
          googleBot: { follow: false, index: false },
          index: false,
        }
      : { follow: true, index: true },
    title: path === '/' ? { absolute: SITE_TITLE } : title,
    twitter: {
      card: 'summary_large_image',
      description,
      images: [image],
      title: socialTitle,
    },
  }
}

export function createCmsPageMetadata({
  defaultDescription,
  defaultPath,
  defaultTitle,
  seo,
}: {
  defaultDescription: string
  defaultPath: string
  defaultTitle: string
  seo?: CmsSeoMetadata
}): Metadata {
  return createPageMetadata({
    canonical: seo?.canonical,
    description: seo?.description?.trim() || defaultDescription,
    image: seo?.image,
    noIndex: seo?.noIndex === true,
    path: defaultPath,
    title: seo?.title?.trim() || defaultTitle,
  })
}

export function createStaticPageMetadata(path: string): Metadata {
  const route = getPublicSeoRoute(path)
  return createPageMetadata(route)
}

export function contentPath(collection: SeoContentCollection, slug: unknown): string {
  const value = typeof slug === 'string' ? slug.trim() : ''
  if (!value) {
    if (collection === 'articles') return '/articles'
    if (collection === 'topics') return '/topics'
    if (collection === 'helpPages') return '/help'
    if (collection === 'categories' || collection === 'tags') return '/articles'
    return '/pricing'
  }

  const encodedSlug = encodeURIComponent(value)
  if (collection === 'articles') return `/articles/${encodedSlug}`
  if (collection === 'topics') return `/topics/${encodedSlug}`
  if (collection === 'helpPages') return `/help/${encodedSlug}`
  if (collection === 'categories') return `/articles/category/${encodedSlug}`
  if (collection === 'tags') return `/articles/tag/${encodedSlug}`
  return `/tld/${encodedSlug}`
}

export function resolveCanonicalUrl(path: string, canonical?: string): string {
  if (!canonical || validateSameOriginCanonical(canonical) !== true) return absoluteSiteUrl(path)
  return new URL(canonical, getSiteOrigin()).toString()
}

export function canonicalPath(path: string, canonical?: string): string {
  return new URL(resolveCanonicalUrl(path, canonical)).pathname
}

export function validateSameOriginCanonical(value: unknown): true | string {
  if (value === undefined || value === null || value === '') return true
  if (typeof value !== 'string') return 'Canonical 必须是站内路径或同源 URL'

  const canonical = value.trim()
  if (!canonical) return true
  if (!canonical.startsWith('/') && !URL.canParse(canonical)) {
    return 'Canonical URL 格式无效'
  }
  if (canonical.startsWith('//') || canonical.includes('\\')) {
    return 'Canonical 不允许协议相对地址或反斜杠'
  }

  try {
    const url = new URL(canonical, getSiteOrigin())
    if (url.origin !== getSiteOrigin().origin) return 'Canonical 只能指向 Wanmi 主域'
    if (url.username || url.password) return 'Canonical 不允许包含用户凭据'
    if (url.search || url.hash) return 'Canonical 不允许包含查询参数或片段'
    return true
  } catch {
    return 'Canonical URL 格式无效'
  }
}
