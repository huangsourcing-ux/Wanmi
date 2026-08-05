import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { DomainQueryForm } from '@/components/forms/domain-query-form'
import { DomainSearchResults } from '@/components/results/domain-search-results'
import { ResultState } from '@/components/results/result-state'
import { WhoisResults } from '@/components/results/whois-results'
import { ConstructionNotice } from '@/components/site/construction-notice'
import { PageIntro } from '@/components/site/page-intro'
import { createPageMetadata } from '@/lib/seo'
import { TOOL_DEFINITIONS, getToolDefinition, normalizeQueryParam } from '@/lib/site-config'

type ToolPageProps = {
  params: Promise<{ tool: string }>
  searchParams: Promise<{ q?: string | string[] }>
}

export function generateStaticParams() {
  return TOOL_DEFINITIONS.map((tool) => ({ tool: tool.slug }))
}

export async function generateMetadata({ params, searchParams }: ToolPageProps): Promise<Metadata> {
  const [{ tool: slug }, queryParams] = await Promise.all([params, searchParams])
  const tool = getToolDefinition(slug)
  if (!tool) return {}

  return createPageMetadata({
    description: tool.description,
    noIndex: queryParams.q !== undefined,
    path: tool.href,
    title: tool.title,
  })
}

export default async function ToolPage({ params, searchParams }: ToolPageProps) {
  const [{ tool: slug }, queryParams] = await Promise.all([params, searchParams])
  const tool = getToolDefinition(slug)
  if (!tool) notFound()
  const query =
    slug === 'domain-search' || slug === 'whois' ? normalizeQueryParam(queryParams.q) : ''

  return (
    <>
      <PageIntro badge="工具入口" description={tool.description} title={tool.title} />
      {slug === 'domain-search' ? (
        <DomainQueryForm
          className="mx-auto mb-6 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
          defaultValue={query}
          description="支持完整域名，或关键词自动查询默认 10 个 TLD。当前仅使用本地 fixture，不保存输入。"
        />
      ) : slug === 'whois' ? (
        <DomainQueryForm
          action="/tools/whois"
          buttonLabel="查询 WHOIS"
          className="mx-auto mb-6 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
          defaultValue={query}
          description="输入完整域名，查询公开 RDAP/WHOIS 注册记录。查询输入不会长期保存，也不会判断是否可注册。"
          label="输入要查询公开注册信息的完整域名"
          placeholder="例如 wanmi.net"
          tool="whois"
        />
      ) : null}
      {slug === 'domain-search' ? (
        query ? (
          <DomainSearchResults key={query} query={query} />
        ) : (
          <div className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]">
            <ResultState
              description="输入完整域名，或输入关键词查询默认的 10 个域名后缀。"
              state="empty"
              title="等待域名查询"
            />
          </div>
        )
      ) : slug === 'whois' ? (
        query ? (
          <WhoisResults key={query} query={query} />
        ) : (
          <div className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]">
            <ResultState
              description="输入完整域名，查询公开 RDAP/WHOIS 注册记录。查询结果不代表域名是否可注册。"
              state="empty"
              title="等待 WHOIS 查询"
            />
          </div>
        )
      ) : (
        <ConstructionNotice
          description={`${tool.title}的服务端查询与结果状态将在后续工具开发中接入。`}
          query={query}
        />
      )}
    </>
  )
}
