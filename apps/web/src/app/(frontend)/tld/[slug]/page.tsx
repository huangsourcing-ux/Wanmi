import config from '@payload-config'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { ContentDetail } from '@/components/content/content-detail'
import { createCmsPageMetadata } from '@/lib/seo'
import { readPublicContentBySlug } from '@/services/content/read-content'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const content = await readPublicContentBySlug(await getPayload({ config }), 'tldPages', slug)
  if (!content) notFound()
  return createCmsPageMetadata({
    defaultDescription: content.summary ?? content.title,
    defaultPath: content.path,
    defaultTitle: content.title,
    seo: content.seo,
  })
}

export default async function TldDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const content = await readPublicContentBySlug(await getPayload({ config }), 'tldPages', slug)
  if (!content) notFound()
  return <ContentDetail content={content} />
}
