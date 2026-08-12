import type { Metadata } from 'next'

import { RegistrarDisclosure } from '@/components/compliance/registrar-disclosure'
import { DomainAssetDetailPanel } from '@/components/domains/domain-assets'
import { PageIntro } from '@/components/site/page-intro'
import { getPublicComplianceConfig } from '@/lib/public-compliance'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: '域名详情',
}

export default async function DomainDetailPage({
  params,
}: {
  params: Promise<{ assetId: string }>
}) {
  const [{ assetId }, compliance] = await Promise.all([params, getPublicComplianceConfig()])
  return (
    <>
      <PageIntro
        badge="域名详情"
        description="查看到期时间、同步状态、到期提醒与 Name Server 变更历史。"
        title="域名资产详情"
      />
      <section className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        {compliance.registrarName ? (
          <div className="mb-6">
            <RegistrarDisclosure registrarName={compliance.registrarName} />
          </div>
        ) : null}
        <DomainAssetDetailPanel assetId={assetId} />
      </section>
    </>
  )
}
