import config from '@payload-config'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { ContentDetail } from '@/components/content/content-detail'
import type { Admin } from '@/payload-types'
import { authenticatedAdminRequest } from '@/services/auth/admin-session'
import { readPreviewContentBySlug } from '@/services/content/read-content'
import { isContentCollection } from '@/services/content/types'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: '内容预览',
}

export default async function ContentPreviewPage({
  params,
}: {
  params: Promise<{ collection: string; slug: string }>
}) {
  const { collection, slug } = await params
  if (!isContentCollection(collection)) notFound()
  let content
  try {
    const payload = await getPayload({ config })
    const request = new Request('http://wanmi.internal/content-preview', {
      headers: await headers(),
    })
    const { req, user } = await authenticatedAdminRequest(payload, request)
    content = await readPreviewContentBySlug(payload, req, user as Admin, collection, slug)
  } catch {
    notFound()
  }
  if (!content) notFound()
  return <ContentDetail content={content} preview />
}
