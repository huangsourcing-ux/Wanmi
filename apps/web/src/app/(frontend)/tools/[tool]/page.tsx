import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { ConstructionNotice } from '@/components/site/construction-notice'
import { PageIntro } from '@/components/site/page-intro'
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
  const query = slug === 'domain-search' ? normalizeQueryParam(queryParams.q) : ''

  return {
    description: tool.description,
    robots: query ? { follow: false, index: false } : undefined,
    title: tool.title,
  }
}

export default async function ToolPage({ params, searchParams }: ToolPageProps) {
  const [{ tool: slug }, queryParams] = await Promise.all([params, searchParams])
  const tool = getToolDefinition(slug)
  if (!tool) notFound()
  const query = slug === 'domain-search' ? normalizeQueryParam(queryParams.q) : ''

  return (
    <>
      <PageIntro badge="工具入口" description={tool.description} title={tool.title} />
      <ConstructionNotice
        description={`${tool.title}的服务端查询与结果状态将在后续工具开发中接入。`}
        query={query}
      />
    </>
  )
}
