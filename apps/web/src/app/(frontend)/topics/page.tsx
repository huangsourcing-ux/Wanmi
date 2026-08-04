import type { Metadata } from 'next'

import { ContentLanding } from '@/components/site/content-landing'
import { PageIntro } from '@/components/site/page-intro'
import { getPublicSiteData } from '@/lib/public-site-data'

export const metadata: Metadata = {
  description: '串联 Wanmi.net 域名工具、TLD 页面与实用内容的专题和指南入口。',
  title: '专题与指南',
}

export default async function TopicsPage() {
  const data = await getPublicSiteData()

  return (
    <>
      <PageIntro
        badge="专题入口"
        description="专题用于把工具、TLD 页面和相关内容组合成完整工作流；赞助专题会在页面上明确标识。"
        title="专题与指南"
      />
      <ContentLanding
        emptyDescription="专题会在相关工具和内容完成后逐步发布，不使用批量生成的薄页面填充入口。"
        section={data.topics}
      />
    </>
  )
}
