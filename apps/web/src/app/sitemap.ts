import type { MetadataRoute } from 'next'

import { absoluteSiteUrl, PUBLIC_SEO_ROUTES } from '@/lib/seo'

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_SEO_ROUTES.map(({ changeFrequency, path, priority }) => ({
    changeFrequency,
    priority,
    url: absoluteSiteUrl(path),
  }))
}
