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
        description="只有通过西部数码能力验证、价格有效且配置用户价的 TLD 才会开放购买。当前不展示未经验证的价格。"
        title="TLD 价格与成本"
      />
      <ContentLanding
        emptyDescription="价格与 TLD 页面将在上游能力、成本、最低年限和续费规则完成验证后发布。"
        section={data.tldPages}
      />
    </>
  )
}
