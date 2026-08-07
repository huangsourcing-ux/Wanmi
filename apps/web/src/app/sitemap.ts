import config from '@payload-config'
import type { MetadataRoute } from 'next'
import { getPayload } from 'payload'

import { logger } from '@/lib/logging'
import { readPublicSitemap, staticSitemapEntries } from '@/services/content/sitemap'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  try {
    return await readPublicSitemap(await getPayload({ config }))
  } catch (error) {
    logger.warn({
      errorName: error instanceof Error ? error.name : 'UnknownError',
      msg: 'Dynamic sitemap read failed; serving fixed public routes only',
    })
    return staticSitemapEntries()
  }
}
