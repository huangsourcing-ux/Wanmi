import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { PublicRelations } from '@/components/content/public-relations'
import { DomainQueryForm } from '@/components/forms/domain-query-form'
import { DomainFavoriteButton } from '@/components/local-library/favorite-buttons'
import { DnsResults } from '@/components/results/dns-results'
import { DomainSearchResults } from '@/components/results/domain-search-results'
import { IdnConverter } from '@/components/results/idn-converter'
import { ResultState } from '@/components/results/result-state'
import { SslResults } from '@/components/results/ssl-results'
import { WhoisResults } from '@/components/results/whois-results'
import { ConstructionNotice } from '@/components/site/construction-notice'
import { PageIntro } from '@/components/site/page-intro'
import { ToolActions } from '@/components/tool-actions/tool-actions'
import { createPageMetadata } from '@/lib/seo'
import { normalizeDomain } from '@/lib/domain-name'
import { TOOL_DEFINITIONS, getToolDefinition, normalizeQueryParam } from '@/lib/site-config'
import { readCachedPublicToolRelations } from '@/services/content/read-tool-relations'

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
  const relations = await readCachedPublicToolRelations(tool.slug)
  const query =
    slug === 'dns' ||
    slug === 'domain-search' ||
    slug === 'idn' ||
    slug === 'ssl-check' ||
    slug === 'whois'
      ? normalizeQueryParam(queryParams.q, slug === 'idn' ? 1_024 : 253)
      : ''
  const normalizedFavorite = query ? normalizeDomain(query) : undefined
  const normalizedDomain =
    normalizedFavorite?.ok && normalizedFavorite.value.ascii.includes('.')
      ? normalizedFavorite.value
      : undefined

  return (
    <>
      <PageIntro badge="工具入口" description={tool.description} title={tool.title} />
      {slug === 'domain-search' ? (
        <DomainQueryForm
          className="mx-auto mb-6 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
          defaultValue={query}
          description="支持完整域名，或关键词自动查询默认 10 个 TLD。当前仅使用本地 fixture；启用历史时输入只保存在当前浏览器。"
        />
      ) : slug === 'whois' ? (
        <DomainQueryForm
          action="/tools/whois"
          buttonLabel="查询 WHOIS"
          className="mx-auto mb-6 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
          defaultValue={query}
          description="输入完整域名，查询公开 RDAP/WHOIS 注册记录。浏览器历史不会同步服务端，也不会判断是否可注册。"
          label="输入要查询公开注册信息的完整域名"
          placeholder="例如 wanmi.net"
          tool="whois"
        />
      ) : slug === 'dns' ? (
        <DomainQueryForm
          action="/tools/dns"
          buttonLabel="查询 DNS"
          className="mx-auto mb-6 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
          defaultValue={query}
          description="输入完整域名，一次查询八种常见只读记录。固定使用受控解析器；历史仅保存在当前浏览器，不提供 DNS 修改。"
          label="输入要查询 DNS 记录的完整域名"
          placeholder="例如 wanmi.net"
          tool="dns"
        />
      ) : slug === 'ssl-check' ? (
        <DomainQueryForm
          action="/tools/ssl-check"
          buttonLabel="检查 SSL"
          className="mx-auto mb-6 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
          defaultValue={query}
          description="输入完整公网域名，固定连接 443 端口检查 TLS 证书与 CAA。不会抓取网页、跟随跳转或执行 OCSP。"
          label="输入要检查 TLS 证书与 CAA 的完整域名"
          placeholder="例如 wanmi.net"
          tool="ssl-check"
        />
      ) : null}
      {slug !== 'idn' && normalizedDomain ? (
        <div className="mx-auto mb-6 flex w-[calc(100%-2rem)] max-w-7xl items-center gap-3 rounded-xl border border-dashed px-4 py-3 sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            将当前域名保存到本机收藏，不锁定状态或价格。
          </p>
          <DomainFavoriteButton domain={normalizedDomain.ascii} label={normalizedDomain.unicode} />
        </div>
      ) : null}
      {slug !== 'idn' ? (
        <ToolActions currentTool={tool.slug} domainAscii={normalizedDomain?.ascii} />
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
      ) : slug === 'dns' ? (
        query ? (
          <DnsResults key={query} query={query} />
        ) : (
          <div className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]">
            <ResultState
              description="输入完整域名，查询 A、AAAA、CNAME、MX、TXT、NS、SOA 和 CAA 记录。"
              state="empty"
              title="等待 DNS 查询"
            />
          </div>
        )
      ) : slug === 'ssl-check' ? (
        query ? (
          <SslResults key={query} query={query} />
        ) : (
          <div className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]">
            <ResultState
              description="输入完整公网域名，检查固定 443 端口的 TLS 证书、证书链、域名匹配与 CAA 策略。"
              state="empty"
              title="等待 SSL / CAA 检查"
            />
          </div>
        )
      ) : slug === 'idn' ? (
        <IdnConverter defaultValue={query} key={query} />
      ) : (
        <ConstructionNotice
          description={`${tool.title}的服务端查询与结果状态将在后续工具开发中接入。`}
          query={query}
        />
      )}
      <PublicRelations
        sections={[
          { items: relations.tldPages, title: '相关 TLD 页面' },
          { items: relations.content, title: '相关内容' },
        ]}
      />
    </>
  )
}
