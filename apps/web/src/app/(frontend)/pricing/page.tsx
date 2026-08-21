import { Suspense } from 'react'

import { AdvertisingSlot } from '@/components/advertising/advertising-slot'
import { RegistrarDisclosure } from '@/components/compliance/registrar-disclosure'
import { PublicRelations } from '@/components/content/public-relations'
import { DeferredPricingResults } from '@/components/results/deferred-pricing-results'
import { ContentLanding } from '@/components/site/content-landing'
import { PageIntro } from '@/components/site/page-intro'
import { ToolActions } from '@/components/tool-actions/tool-actions'
import { getPublicSiteData } from '@/lib/public-site-data'
import { getPublicComplianceConfig } from '@/lib/public-compliance'
import { createStaticPageMetadata } from '@/lib/seo'
import { readCachedPublicToolRelations } from '@/services/content/read-tool-relations'

export const metadata = createStaticPageMetadata('/pricing')

async function PricingRegistrarDisclosure() {
  const compliance = await getPublicComplianceConfig()

  if (!compliance.registrarName) return null

  return (
    <section className="mx-auto max-w-7xl px-4 pb-8 sm:px-6 lg:px-8">
      <RegistrarDisclosure registrarName={compliance.registrarName} />
    </section>
  )
}

async function PricingRelations() {
  const [data, relations] = await Promise.all([
    getPublicSiteData(),
    readCachedPublicToolRelations('pricing'),
  ])

  return (
    <>
      <ContentLanding
        emptyDescription="价格与 TLD 页面将在上游能力、成本、最低年限和续费规则完成验证后发布。"
        section={data.tldPages}
      />
      <PublicRelations
        sections={[
          { items: relations.tldPages, title: '配置关联的 TLD 页面' },
          { items: relations.content, title: '相关内容' },
        ]}
      />
    </>
  )
}

export default function PricingPage() {
  return (
    <>
      <PageIntro
        badge="价格中心"
        description="基于上游注册服务机构格式 fixture 展示普通域名注册价、续费价及 1 年/3 年成本，并为每次计算保留可追溯快照。"
        title="TLD 价格与成本"
      />
      <Suspense fallback={null}>
        <PricingRegistrarDisclosure />
      </Suspense>
      <ToolActions currentTool="pricing" />
      <DeferredPricingResults />
      <Suspense fallback={null}>
        <AdvertisingSlot pageType="tool" placementCode="tool-after-result" />
      </Suspense>
      <Suspense fallback={null}>
        <PricingRelations />
      </Suspense>
    </>
  )
}
