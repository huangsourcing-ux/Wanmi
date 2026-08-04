import Link from 'next/link'
import {
  ArrowRightIcon,
  BadgeDollarSignIcon,
  BracesIcon,
  FileSearchIcon,
  NetworkIcon,
  SearchIcon,
  ShieldCheckIcon,
} from 'lucide-react'

import { PageIntro } from '@/components/site/page-intro'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createStaticPageMetadata } from '@/lib/seo'
import { PRICING_TOOL, TOOL_DEFINITIONS } from '@/lib/site-config'

export const metadata = createStaticPageMetadata('/tools')

const toolIcons = {
  dns: NetworkIcon,
  'domain-search': SearchIcon,
  idn: BracesIcon,
  pricing: BadgeDollarSignIcon,
  'ssl-check': ShieldCheckIcon,
  whois: FileSearchIcon,
} as const

const tools = [...TOOL_DEFINITIONS, { ...PRICING_TOOL, slug: 'pricing' as const }]

export default function ToolsPage() {
  return (
    <>
      <PageIntro
        badge="六类核心工具"
        description="每个工具解决一个明确问题，并分别展示数据来源、时间、限制和错误。查询能力将在后续切片接入，当前所有入口均可访问。"
        title="域名工具中心"
      />
      <section className="mx-auto grid max-w-7xl gap-5 px-4 pb-16 sm:grid-cols-2 sm:px-6 lg:grid-cols-3 lg:px-8">
        {tools.map((tool) => {
          const Icon = toolIcons[tool.slug]
          return (
            <Card key={tool.href}>
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
      </section>
    </>
  )
}
