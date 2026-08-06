'use client'

import { AlertCircleIcon, CheckCircle2Icon, Clock3Icon, DatabaseIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ResultState } from '@/components/results/result-state'
import { DomainFavoriteButton } from '@/components/local-library/favorite-buttons'
import { CopyAction } from '@/components/tool-actions/copy-action'
import { ToolActions } from '@/components/tool-actions/tool-actions'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AppError, getTraceId, readProblemResponse, toProblemDetails } from '@/lib/errors'
import { formatCnyFen } from '@/lib/money'
import { formatAvailabilityRecord } from '@/lib/tool-actions'
import { bucketDuration, emitFirstPartyEvent, inferToolInput } from '@/lib/analytics'
import {
  domainSearchResultSchema,
  type DomainSearchItem,
  type DomainSearchResult,
} from '@/schemas/domain-search'
import type { ProblemDetails } from '@/schemas/api'

const statusPresentation = {
  available: { label: '可注册', variant: 'secondary' },
  premium: { label: '溢价域名', variant: 'default' },
  query_failed: { label: '查询失败', variant: 'destructive' },
  registered: { label: '已注册', variant: 'outline' },
  restricted: { label: '保留/限制', variant: 'outline' },
  unsupported: { label: '暂不支持', variant: 'outline' },
} as const

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function formatCache(item: DomainSearchItem): string {
  if (item.cache.status === 'hit') return '缓存命中'
  if (item.cache.status === 'miss') return '最新查询'
  return '未使用缓存'
}

function analyticsSource(result: DomainSearchResult): 'local' | 'westdigital' {
  return result.meta?.dataSource?.includes('西部数码') ? 'westdigital' : 'local'
}

function emitOutcome(result: DomainSearchResult, query: string, durationMs: number): void {
  const dimensions = inferToolInput(query)
  if (result.state === 'error' || result.state === 'rate_limited') {
    emitFirstPartyEvent({
      dataSource: analyticsSource(result),
      durationBucket: bucketDuration(durationMs),
      errorCode: result.problem.code,
      event: 'tool_failed',
      schemaVersion: 1,
      tld: dimensions.tld,
      tool: 'domain-search',
    })
    return
  }
  emitFirstPartyEvent({
    dataSource: analyticsSource(result),
    durationBucket: bucketDuration(durationMs),
    event: 'tool_completed',
    resultCategory: result.state,
    schemaVersion: 1,
    succeeded: result.state === 'ready',
    tld: dimensions.tld,
    tool: 'domain-search',
  })
}

function DomainResultCard({ item }: { item: DomainSearchItem }) {
  const presentation = statusPresentation[item.status]
  return (
    <Card data-domain-status={item.status}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="font-mono break-all">{item.domainAscii}</CardTitle>
            {item.domainUnicode !== item.domainAscii ? (
              <CardDescription className="mt-1 break-all">{item.domainUnicode}</CardDescription>
            ) : null}
          </div>
          <Badge variant={presentation.variant}>{presentation.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {item.status === 'premium' ? (
          <p className="text-lg font-semibold text-foreground">
            {formatCnyFen(item.premiumRegistrationPriceFen)}
            <span className="ml-2 text-xs font-normal text-muted-foreground">fixture 特殊价格</span>
          </p>
        ) : null}
        {item.status === 'query_failed' ? (
          <p className="flex gap-2 text-sm leading-6 text-destructive">
            <AlertCircleIcon aria-hidden="true" className="mt-1 size-4 shrink-0" />
            <span>{item.problem.detail}</span>
          </p>
        ) : null}
        <dl className="grid gap-3 border-t pt-4 text-xs sm:grid-cols-2">
          <div>
            <dt className="flex items-center gap-1 text-muted-foreground">
              <DatabaseIcon aria-hidden="true" className="size-3.5" />
              数据源
            </dt>
            <dd className="mt-1 font-medium text-foreground">{item.dataSource}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1 text-muted-foreground">
              <Clock3Icon aria-hidden="true" className="size-3.5" />
              查询时间
            </dt>
            <dd className="mt-1 font-medium text-foreground">
              <time dateTime={item.observedAt}>{formatTime(item.observedAt)}</time>
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1 text-muted-foreground">
              <CheckCircle2Icon aria-hidden="true" className="size-3.5" />
              缓存状态
            </dt>
            <dd className="mt-1 font-medium text-foreground">{formatCache(item)}</dd>
          </div>
          {item.cache.expiresAt ? (
            <div>
              <dt className="text-muted-foreground">缓存有效至</dt>
              <dd className="mt-1 font-medium text-foreground">
                <time dateTime={item.cache.expiresAt}>{formatTime(item.cache.expiresAt)}</time>
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          <CopyAction
            ariaLabel={`复制可售记录 ${item.domainAscii}`}
            label="复制此条结果"
            text={formatAvailabilityRecord(item)}
          />
          <DomainFavoriteButton domain={item.domainAscii} label={item.domainUnicode} />
        </div>
        <ToolActions currentTool="domain-search" domainAscii={item.domainAscii} variant="compact" />
      </CardContent>
    </Card>
  )
}

function ResultSummary({ result }: { result: DomainSearchResult }) {
  if (result.state === 'ready') {
    return (
      <div className="rounded-xl border bg-accent/40 px-5 py-4" role="status">
        <p className="font-medium">查询完成，共返回 {result.data.items.length} 个明确结果。</p>
        <p className="mt-1 text-sm text-muted-foreground">
          当前全部为 fixture 数据，不代表实时可购买状态。
        </p>
      </div>
    )
  }
  if (result.state === 'empty') {
    return (
      <ResultState
        cacheStatus={result.meta?.cacheStatus}
        dataSource={result.meta?.dataSource}
        description="当前没有配置可查询的默认域名后缀。"
        observedAt={result.meta?.observedAt}
        state="empty"
        title="暂无查询目标"
        traceId={result.meta?.traceId}
      />
    )
  }
  return (
    <ResultState
      cacheStatus={result.meta?.cacheStatus}
      dataSource={result.meta?.dataSource}
      description={result.problem.detail}
      observedAt={result.meta?.observedAt}
      retryable={result.problem.retryable}
      state={result.state}
      suggestedAction={result.problem.action}
      title={result.problem.title}
      traceId={result.problem.traceId}
    />
  )
}

export function DomainSearchResults({ query }: { query: string }) {
  const [result, setResult] = useState<DomainSearchResult>()
  const [problem, setProblem] = useState<ProblemDetails>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const startedAt = performance.now()

    void fetch('/api/v1/tools/domain-search', {
      body: JSON.stringify({ query }),
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      referrerPolicy: 'origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw await readProblemResponse(response)
        const parsed = domainSearchResultSchema.safeParse(await response.json())
        if (!parsed.success) {
          throw toProblemDetails(
            new AppError('DOMAIN_SEARCH_INVALID_RESPONSE', '查询服务返回了无法识别的结果', 503),
            getTraceId(response.headers),
          )
        }
        setResult(parsed.data)
        emitOutcome(parsed.data, query, performance.now() - startedAt)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const safeProblem =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as ProblemDetails)
            : toProblemDetails(
                new AppError('DOMAIN_SEARCH_UNAVAILABLE', '域名查询服务暂时不可用', 503),
                globalThis.crypto.randomUUID(),
              )
        setProblem(safeProblem)
        emitFirstPartyEvent({
          dataSource: 'unknown',
          durationBucket: bucketDuration(performance.now() - startedAt),
          errorCode: safeProblem.code,
          event: 'tool_failed',
          schemaVersion: 1,
          tld: inferToolInput(query).tld,
          tool: 'domain-search',
        })
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [query])

  if (loading) {
    return (
      <div className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]">
        <div aria-busy="true" className="rounded-xl border bg-card p-6" role="status">
          正在查询最多 10 个域名后缀，请稍候…
        </div>
      </div>
    )
  }
  if (problem) {
    return (
      <div className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]">
        <ResultState
          dataSource={problem.dataSource}
          description={problem.detail}
          observedAt={problem.observedAt}
          retryable={problem.retryable}
          state={problem.status === 429 ? 'rate_limited' : 'error'}
          suggestedAction={problem.action}
          title={problem.title}
          traceId={problem.traceId}
        />
      </div>
    )
  }
  if (!result) return null

  return (
    <section
      aria-labelledby="domain-search-results-title"
      className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl space-y-6 sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
    >
      <div>
        <h2 className="font-heading text-2xl font-semibold" id="domain-search-results-title">
          可注册查询结果
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          可注册状态来自西部数码格式的本地 fixture，与 WHOIS/RDAP 注册信息严格分离。
        </p>
      </div>
      <ResultSummary result={result} />
      {'data' in result && result.data.items.length > 0 ? (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {result.data.items.map((item) => (
            <DomainResultCard item={item} key={item.domainAscii} />
          ))}
        </div>
      ) : null}
    </section>
  )
}
