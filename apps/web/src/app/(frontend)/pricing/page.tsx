import { PricingResults } from '@/components/results/pricing-results'
import { ContentLanding } from '@/components/site/content-landing'
import { PageIntro } from '@/components/site/page-intro'
import { getPublicSiteData } from '@/lib/public-site-data'
import { createStaticPageMetadata } from '@/lib/seo'

export const metadata = createStaticPageMetadata('/pricing')

export default async function PricingPage() {
  const data = await getPublicSiteData()

  return (
    <>
      <PageIntro
        badge="价格中心"
        description="基于西部数码格式 fixture 展示普通域名注册价、续费价及 1 年/3 年成本，并为每次计算保留可追溯快照。"
        title="TLD 价格与成本"
      />
      <PricingResults />
      <ContentLanding
        emptyDescription="价格与 TLD 页面将在上游能力、成本、最低年限和续费规则完成验证后发布。"
        section={data.tldPages}
      />
    </>
  )
}
