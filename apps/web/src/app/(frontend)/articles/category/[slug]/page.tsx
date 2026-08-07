import config from '@payload-config'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { TaxonomyLanding } from '@/components/content/taxonomy-landing'
import { createCmsPageMetadata } from '@/lib/seo'
import { readPublicTaxonomyBySlug } from '@/services/content/read-taxonomy'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const taxonomy = await readPublicTaxonomyBySlug(await getPayload({ config }), 'categories', slug)
  if (!taxonomy) notFound()
  return createCmsPageMetadata({
    defaultDescription: taxonomy.description ?? `浏览“${taxonomy.title}”分类下的已发布文章。`,
    defaultPath: taxonomy.path,
    defaultTitle: taxonomy.title,
    seo: taxonomy.seo,
  })
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const taxonomy = await readPublicTaxonomyBySlug(await getPayload({ config }), 'categories', slug)
  if (!taxonomy) notFound()
  return <TaxonomyLanding kind="分类" taxonomy={taxonomy} />
}
