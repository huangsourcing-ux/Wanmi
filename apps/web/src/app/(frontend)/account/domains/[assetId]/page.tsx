import type { Metadata } from 'next'

import { DomainAssetDetailPanel } from '@/components/domains/domain-assets'
import { PageIntro } from '@/components/site/page-intro'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: '域名详情',
}

export default async function DomainDetailPage({
  params,
}: {
  params: Promise<{ assetId: string }>
}) {
  const { assetId } = await params
  return (
    <>
      <PageIntro
        badge="域名详情"
        description="查看到期时间、同步状态、到期提醒与 Name Server 变更历史。"
        title="域名资产详情"
      />
      <section className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <DomainAssetDetailPanel assetId={assetId} />
      </section>
    </>
  )
}
