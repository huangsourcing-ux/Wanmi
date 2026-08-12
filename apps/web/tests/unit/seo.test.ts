import { describe, expect, it } from 'vitest'

import robots from '@/app/robots'
import {
  absoluteSiteUrl,
  contentPath,
  createCmsPageMetadata,
  createPageMetadata,
  createStaticPageMetadata,
  PUBLIC_SEO_ROUTES,
  validateSameOriginCanonical,
} from '@/lib/seo'
import { appendSeoFields, generateSeoPreviewUrl } from '@/plugins/seo'
import { staticSitemapEntries } from '@/services/content/sitemap'

describe('D1 SEO foundation', () => {
  it('uses the configured origin for absolute canonical and social metadata', () => {
    const metadata = createStaticPageMetadata('/tools')

    expect(metadata).toMatchObject({
      alternates: { canonical: 'http://127.0.0.1:3000/tools' },
      openGraph: {
        images: [
          {
            height: 630,
            url: 'http://127.0.0.1:3000/opengraph-image',
            width: 1200,
          },
        ],
        url: 'http://127.0.0.1:3000/tools',
      },
      robots: { follow: true, index: true },
      title: '域名工具中心',
      twitter: {
        card: 'summary_large_image',
        images: ['http://127.0.0.1:3000/opengraph-image'],
      },
    })
    expect(absoluteSiteUrl('/help')).toBe('http://127.0.0.1:3000/help')
    expect(() => absoluteSiteUrl('//outside.test/path')).toThrow(/root-relative/)
  })

  it('marks parameterized tool results noindex while retaining the clean canonical', () => {
    const metadata = createPageMetadata({
      description: '查询结果',
      noIndex: true,
      path: '/tools/whois',
      title: 'WHOIS / RDAP',
    })

    expect(metadata.alternates?.canonical).toBe('http://127.0.0.1:3000/tools/whois')
    expect(metadata.robots).toMatchObject({
      follow: false,
      googleBot: { follow: false, index: false },
      index: false,
    })
  })

  it('uses Payload SEO overrides for title, description, OG image, canonical and noindex', () => {
    const metadata = createCmsPageMetadata({
      defaultDescription: '默认描述',
      defaultPath: '/help/default',
      defaultTitle: '默认标题',
      seo: {
        canonical: '/help/canonical',
        description: 'SEO 描述',
        image: {
          alt: 'SEO 图片',
          height: 630,
          url: 'http://127.0.0.1:3000/media/seo.png',
          width: 1200,
        },
        noIndex: true,
        title: 'SEO 标题',
      },
    })

    expect(metadata).toMatchObject({
      alternates: { canonical: 'http://127.0.0.1:3000/help/canonical' },
      description: 'SEO 描述',
      openGraph: {
        images: [{ alt: 'SEO 图片', url: 'http://127.0.0.1:3000/media/seo.png' }],
        title: 'SEO 标题｜Wanmi.net',
        url: 'http://127.0.0.1:3000/help/canonical',
      },
      robots: { follow: false, index: false },
      title: 'SEO 标题',
    })
  })

  it('publishes only the current stable public routes in robots and fixed sitemap entries', () => {
    const routes = PUBLIC_SEO_ROUTES.map((route) => route.path)
    const sitemapEntries = staticSitemapEntries()

    expect(new Set(routes).size).toBe(routes.length)
    expect(routes).toEqual(
      expect.arrayContaining([
        '/',
        '/tools/domain-search',
        '/tools/whois',
        '/pricing',
        '/articles',
        '/topics',
        '/legal/privacy',
        '/legal/realname',
        '/legal/payment',
      ]),
    )
    expect(sitemapEntries).toHaveLength(routes.length)
    expect(sitemapEntries.every((entry) => !entry.url.includes('?'))).toBe(true)
    expect(sitemapEntries.some((entry) => /\/articles\/.+/.test(new URL(entry.url).pathname))).toBe(
      false,
    )
    expect(sitemapEntries.some((entry) => new URL(entry.url).pathname.startsWith('/admin'))).toBe(
      false,
    )
    expect(robots()).toEqual({
      host: 'http://127.0.0.1:3000',
      rules: {
        allow: '/',
        disallow: ['/account/', '/admin/', '/api/', '/healthz', '/login', '/readyz'],
        userAgent: '*',
      },
      sitemap: 'http://127.0.0.1:3000/sitemap.xml',
    })
  })

  it('restricts custom canonical values to clean URLs on the configured origin', () => {
    expect(validateSameOriginCanonical(undefined)).toBe(true)
    expect(validateSameOriginCanonical('/articles/wanmi')).toBe(true)
    expect(validateSameOriginCanonical('http://127.0.0.1:3000/topics/guide')).toBe(true)
    expect(validateSameOriginCanonical('//outside.test/path')).not.toBe(true)
    expect(validateSameOriginCanonical('https://outside.test/path')).not.toBe(true)
    expect(validateSameOriginCanonical('http://user:pass@127.0.0.1:3000/path')).not.toBe(true)
    expect(validateSameOriginCanonical('/path?q=domain')).not.toBe(true)
    expect(validateSameOriginCanonical('/path#result')).not.toBe(true)
  })

  it('adds shared Payload fields and maps SEO previews to product URLs', () => {
    const fields = appendSeoFields({ defaultFields: [{ name: 'title', type: 'text' }] })
    const namedFields = fields.flatMap((field) => ('name' in field ? [field.name] : []))

    expect(namedFields).toEqual(['title', 'canonical', 'noIndex'])
    expect(generateSeoPreviewUrl('articles', 'domain guide')).toBe(
      'http://127.0.0.1:3000/articles/domain%20guide',
    )
    expect(generateSeoPreviewUrl('topics', 'dns')).toBe('http://127.0.0.1:3000/topics/dns')
    expect(generateSeoPreviewUrl('tldPages', 'com')).toBe('http://127.0.0.1:3000/tld/com')
    expect(generateSeoPreviewUrl('helpPages', 'dns')).toBe('http://127.0.0.1:3000/help/dns')
    expect(generateSeoPreviewUrl('categories', 'guide')).toBe(
      'http://127.0.0.1:3000/articles/category/guide',
    )
    expect(generateSeoPreviewUrl('tags', 'idn')).toBe('http://127.0.0.1:3000/articles/tag/idn')
    expect(generateSeoPreviewUrl('unknown', 'ignored')).toBe('http://127.0.0.1:3000/')
    expect(contentPath('articles', '')).toBe('/articles')
    expect(contentPath('tldPages', '')).toBe('/pricing')
  })
})
