import type { Metadata } from 'next'

import { ContentLanding } from '@/components/site/content-landing'
import { PageIntro } from '@/components/site/page-intro'
import { getPublicSiteData } from '@/lib/public-site-data'

export const metadata: Metadata = {
  description: '域名选择、注册规则、DNS、WHOIS、SSL 与建站相关的中文实用内容入口。',
  title: '实用内容',
}

export default async function ArticlesPage() {
  const data = await getPublicSiteData()

  return (
    <>
      <PageIntro
        badge="内容入口"
        description="公开内容只读取经过人工审核并发布的 Payload 版本。草稿、定时内容和已下线内容不会出现在这里。"
        title="实用内容"
      />
      <ContentLanding
        emptyDescription="首批内容将围绕域名选择与注册、DNS/WHOIS、SSL/建站三个内容集群发布。"
        section={data.articles}
      />
    </>
  )
}
