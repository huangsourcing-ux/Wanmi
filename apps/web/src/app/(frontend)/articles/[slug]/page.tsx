import config from '@payload-config'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { ContentDetail } from '@/components/content/content-detail'
import { createPageMetadata } from '@/lib/seo'
import { readPublicContentBySlug } from '@/services/content/read-content'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const content = await readPublicContentBySlug(await getPayload({ config }), 'articles', slug)
  if (!content) notFound()
  return createPageMetadata({
    description: content.summary ?? content.title,
    path: content.path,
    title: content.title,
  })
}

export default async function ArticleDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const content = await readPublicContentBySlug(await getPayload({ config }), 'articles', slug)
  if (!content) notFound()
  return <ContentDetail content={content} />
}
