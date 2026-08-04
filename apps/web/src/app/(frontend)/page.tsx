import Link from 'next/link'
import {
  ArrowRightIcon,
  BadgeDollarSignIcon,
  BookOpenTextIcon,
  BracesIcon,
  CheckCircle2Icon,
  FileSearchIcon,
  Globe2Icon,
  NetworkIcon,
  SearchIcon,
  ShieldCheckIcon,
} from 'lucide-react'

import { ContentEntryCard } from '@/components/home/content-entry-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { getPublicSiteData } from '@/lib/public-site-data'
import { PRICING_TOOL, TOOL_DEFINITIONS } from '@/lib/site-config'

const toolIcons = {
  dns: NetworkIcon,
  'domain-search': SearchIcon,
  idn: BracesIcon,
  pricing: BadgeDollarSignIcon,
  'ssl-check': ShieldCheckIcon,
  whois: FileSearchIcon,
} as const

const tools = [...TOOL_DEFINITIONS, { ...PRICING_TOOL, slug: 'pricing' as const }]

export default async function HomePage() {
  const data = await getPublicSiteData()

  return (
    <>
      <section className="relative overflow-hidden border-b bg-card">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,color-mix(in_oklch,var(--accent)_58%,transparent),transparent_42%)]"
        />
        <div className="relative mx-auto grid max-w-7xl gap-10 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1fr_20rem] lg:items-end lg:px-8">
          <div className="max-w-3xl">
            <Badge className="mb-5" variant="secondary">
              中文域名工具与服务入口
            </Badge>
            <h1 className="max-w-3xl text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              查清域名状态，
              <span className="text-primary">再决定下一步。</span>
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
              用一组可信、清晰的中文工具完成域名查询、公开信息核验、DNS
              与证书检查，并了解价格和注册规则。
            </p>

            <form action="/tools/domain-search" className="mt-8" method="get">
              <label className="sr-only" htmlFor="home-domain-query">
                输入完整域名或关键词
              </label>
              <div className="flex flex-col gap-3 rounded-xl border bg-background p-2 shadow-sm sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
                  <Globe2Icon
                    aria-hidden="true"
                    className="size-5 shrink-0 text-muted-foreground"
                  />
                  <Input
                    aria-describedby="home-query-help"
                    autoCapitalize="none"
                    autoComplete="off"
                    className="h-11 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0 md:text-base"
                    id="home-domain-query"
                    maxLength={253}
                    name="q"
                    placeholder="例如 wanmi.net 或品牌关键词"
                    required
                    spellCheck={false}
                    type="text"
                  />
                </div>
                <Button className="h-11 px-5" size="lg" type="submit">
                  查询域名
                  <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
                </Button>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted-foreground" id="home-query-help">
                支持完整域名与关键词。本阶段只建立安全入口，不调用查询服务，也不保存输入。
              </p>
            </form>
          </div>

          <aside
            className="rounded-xl border bg-background/90 p-5 shadow-sm"
            aria-label="当前服务状态"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2Icon aria-hidden="true" className="size-4 text-primary" />
              页面入口已可用
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              免费工具、账号、注册和支付能力将按阶段接入。没有明确上游确认时，Wanmi
              不会把未知状态展示为可注册。
            </p>
            <Button asChild className="mt-4 px-0" size="sm" variant="link">
              <Link href="/help">了解数据与服务边界</Link>
            </Button>
          </aside>
        </div>
      </section>

      <aside
        aria-label="赞助信息"
        className="mx-auto my-8 flex min-h-24 max-w-7xl items-center justify-center px-4 sm:px-6 lg:px-8"
      >
        <div className="flex min-h-20 w-full items-center justify-center rounded-xl border border-dashed bg-muted/35 px-6 text-center text-xs text-muted-foreground">
          赞助位 · 当前无赞助内容 · 不影响主查询
        </div>
      </aside>

      <section
        aria-labelledby="core-tools-title"
        className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-primary">工具矩阵</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight" id="core-tools-title">
              从一个问题，走到下一步
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              六类核心工具分别处理可售状态、公开注册信息、DNS、价格、中文域名和证书问题。
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href="/tools">浏览全部工具</Link>
          </Button>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tools.map((tool) => {
            const Icon = toolIcons[tool.slug]
            return (
              <Card
                className="transition-transform hover:-translate-y-0.5 hover:shadow-md"
                key={tool.href}
              >
                <CardHeader>
                  <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                    <Icon aria-hidden="true" className="size-5" />
                  </div>
                  <CardTitle>{tool.title}</CardTitle>
                  <CardDescription className="leading-6">{tool.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button asChild className="px-0" size="sm" variant="link">
                    <Link href={tool.href}>
                      打开入口
                      <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </section>

      <section aria-labelledby="content-title" className="border-y bg-muted/35">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-primary">内容入口</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight" id="content-title">
              把查询结果变成可执行的判断
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              首页只读取 Payload 中已发布的内容。草稿、空库或单个栏目失败都不会影响域名查询入口。
            </p>
          </div>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            <ContentEntryCard section={data.articles} />
            <ContentEntryCard section={data.tldPages} />
            <ContentEntryCard section={data.topics} />
          </div>
        </div>
      </section>

      <section
        aria-labelledby="sources-title"
        className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8"
      >
        <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
          <div>
            <p className="text-sm font-medium text-primary">透明边界</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight" id="sources-title">
              数据从哪里来，页面就说明到哪里
            </h2>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              缓存、延迟、字段缺失和查询失败会被明确展示。注册、支付和履约服务尚未开放，当前页面不接受真实交易。
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ['可售与价格', '计划由西部数码提供，并以服务端确认和有效报价为准。'],
              ['WHOIS / RDAP', '计划通过 Who-Dat 和注册局公开数据提供，字段可能因隐私政策缺失。'],
              ['DNS 与证书', '来自公开网络查询，结果会附查询时间且不承诺全球解析器即时一致。'],
            ].map(([title, description]) => (
              <div className="rounded-xl border bg-card p-5" key={title}>
                <BookOpenTextIcon aria-hidden="true" className="size-5 text-primary" />
                <h3 className="mt-4 font-medium">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
