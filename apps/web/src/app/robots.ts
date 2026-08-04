import type { MetadataRoute } from 'next'

import { absoluteSiteUrl, getSiteOrigin } from '@/lib/seo'

export default function robots(): MetadataRoute.Robots {
  return {
    host: getSiteOrigin().origin,
    rules: {
      allow: '/',
      disallow: ['/account/', '/admin/', '/api/', '/healthz', '/login', '/readyz'],
      userAgent: '*',
    },
    sitemap: absoluteSiteUrl('/sitemap.xml'),
  }
}
