import Link from 'next/link'
import { AlertTriangleIcon, Clock3Icon, DatabaseIcon, ShieldCheckIcon } from 'lucide-react'

import { PageIntro } from '@/components/site/page-intro'
import { ContentLanding } from '@/components/site/content-landing'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createStaticPageMetadata } from '@/lib/seo'
import { getPublicSiteData } from '@/lib/public-site-data'

export const metadata = createStaticPageMetadata('/help')

const helpItems = [
  {
    description:
      '域名可售状态、价格、实名、注册和续费计划由西部数码提供；只有服务端确认且配置有效价格时才会开放交易入口。',
    icon: DatabaseIcon,
    title: '可售与价格来源',
  },
  {
    description:
      'WHOIS / RDAP 计划通过 Who-Dat 和注册局公开数据提供。隐私保护、注册局策略或数据源失败可能导致字段缺失。',
    icon: ShieldCheckIcon,
    title: '公开注册信息',
  },
  {
    description:
      'DNS、Name Server、TLS 和 CAA 来自公开网络查询。结果会标注查询时间，但不同递归解析器可能存在传播延迟。',
    icon: Clock3Icon,
    title: 'DNS 与证书时间',
  },
  {
    description:
      '查询失败、未知状态和数据源超时不会被解释为未注册或可购买。错误页面将提供建议动作和请求 ID。',
    icon: AlertTriangleIcon,
    title: '失败与未知状态',
  },
] as const

export default async function HelpPage() {
  const data = await getPublicSiteData()
  return (
    <>
      <PageIntro
        badge="帮助中心"
        description="Wanmi 会尽量把数据来源、查询时间、缓存状态和失败原因放在结果旁边，而不是用模糊结论替代不确定性。"
        title="数据来源与使用说明"
      />
      <ContentLanding
        emptyDescription="帮助文章会在人工审核并发布后显示；下线或归档内容不会公开。"
        section={data.helpPages}
      />
      <section className="mx-auto grid max-w-7xl gap-5 px-4 pb-12 sm:grid-cols-2 sm:px-6 lg:px-8">
        {helpItems.map((item) => {
          const Icon = item.icon
          return (
            <Card key={item.title}>
              <CardHeader>
                <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Icon aria-hidden="true" className="size-5" />
                </div>
                <CardTitle>{item.title}</CardTitle>
                <CardDescription className="leading-6">{item.description}</CardDescription>
              </CardHeader>
            </Card>
          )
        })}
      </section>
      <section className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <Card className="bg-muted/40">
          <CardHeader>
            <CardTitle>当前服务边界</CardTitle>
            <CardDescription className="leading-6">
              当前是开发中的公共站骨架，不接受真实注册、续费、支付或实名材料。生产开放前仍需完成接口联调、资质备案、合规复核和最终批准。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/legal">查看合规说明入口</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
    </>
  )
}
