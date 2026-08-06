'use client'

import {
  AlertCircleIcon,
  CalculatorIcon,
  Clock3Icon,
  DatabaseIcon,
  HistoryIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { ResultState } from '@/components/results/result-state'
import { CopyAction } from '@/components/tool-actions/copy-action'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { bucketDuration, emitFirstPartyEvent } from '@/lib/analytics'
import { AppError, getTraceId, readProblemResponse, toProblemDetails } from '@/lib/errors'
import { formatCnyFen } from '@/lib/money'
import { formatPricingRecord } from '@/lib/tool-actions'
import type { ProblemDetails } from '@/schemas/api'
import { pricingResultSchema, type PricingItem, type PricingResult } from '@/schemas/pricing'

const statusPresentation = {
  priced: { label: '价格可追溯', variant: 'secondary' },
  query_failed: { label: '查询失败', variant: 'destructive' },
  stale: { label: '历史快照', variant: 'outline' },
  unconfigured: { label: '未开放', variant: 'outline' },
  unsupported: { label: '暂不支持', variant: 'outline' },
} as const

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function formatCache(item: PricingItem): string {
  if (item.cache.status === 'hit') return '缓存命中'
  if (item.cache.status === 'miss') return '最新查询'
  return '未使用缓存'
}

function analyticsSource(result: PricingResult): 'cache' | 'westdigital' | 'unknown' {
  if (result.meta?.cacheStatus === 'hit') return 'cache'
  if (result.meta?.dataSource?.includes('西部数码')) return 'westdigital'
  return 'unknown'
}

function emitOutcome(result: PricingResult, durationMs: number): void {
  if (result.state === 'error' || result.state === 'rate_limited') {
    emitFirstPartyEvent({
      dataSource: analyticsSource(result),
      durationBucket: bucketDuration(durationMs),
      errorCode: result.problem.code,
      event: 'tool_failed',
      schemaVersion: 1,
      tool: 'pricing',
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
    tool: 'pricing',
  })
}

function PriceGrid({ item }: { item: Extract<PricingItem, { status: 'priced' | 'stale' }> }) {
  const rows = [
    { amount: item.registrationPriceFen, label: '注册价' },
    { amount: item.renewalPriceFen, label: '续费价/年' },
    { amount: item.oneYearTotalFen, label: '1 年总成本' },
    { amount: item.threeYearTotalFen, label: '3 年总成本' },
  ]
  return (
    <dl className="grid grid-cols-2 gap-3">
      {rows.map(({ amount, label }) => (
        <div className="rounded-lg bg-muted/60 p-3" key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 font-semibold tabular-nums text-foreground">
            {formatCnyFen(amount)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function PricingCard({ item }: { item: PricingItem }) {
  const presentation = statusPresentation[item.status]
  const hasPrice = item.status === 'priced' || item.status === 'stale'
  return (
    <Card data-pricing-status={item.status}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="font-mono text-xl">.{item.tld}</CardTitle>
            <CardDescription className="mt-1">
              {hasPrice ? '普通域名 · 最低注册 1 年' : '普通域名'}
            </CardDescription>
          </div>
          <Badge variant={presentation.variant}>{presentation.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasPrice ? <PriceGrid item={item} /> : null}
        {item.status === 'unconfigured' ? (
          <p className="flex gap-2 text-sm leading-6 text-amber-700 dark:text-amber-300">
            <AlertCircleIcon aria-hidden="true" className="mt-1 size-4 shrink-0" />
            <span>未配置加价规则，不开放购买。</span>
          </p>
        ) : null}
        {item.status === 'unsupported' ? (
          <p className="text-sm leading-6 text-muted-foreground">
            该后缀不在当前 fixture 支持目录中。
          </p>
        ) : null}
        {item.status === 'query_failed' ? (
          <p className="flex gap-2 text-sm leading-6 text-destructive">
            <AlertCircleIcon aria-hidden="true" className="mt-1 size-4 shrink-0" />
            <span>{item.problem.detail}</span>
          </p>
        ) : null}
        {item.status === 'stale' ? (
          <p className="flex gap-2 text-sm leading-6 text-amber-700 dark:text-amber-300">
            <HistoryIcon aria-hidden="true" className="mt-1 size-4 shrink-0" />
            <span>最新取价失败，当前为历史快照，仅供参考且不能购买。</span>
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
              取价时间
            </dt>
            <dd className="mt-1 font-medium text-foreground">
              <time dateTime={item.observedAt}>{formatTime(item.observedAt)}</time>
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1 text-muted-foreground">
              <CalculatorIcon aria-hidden="true" className="size-3.5" />
              缓存状态
            </dt>
            <dd className="mt-1 font-medium text-foreground">{formatCache(item)}</dd>
          </div>
          {hasPrice ? (
            <div>
              <dt className="text-muted-foreground">快照引用</dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-foreground">
                {item.snapshotRef}
              </dd>
            </div>
          ) : null}
        </dl>
        <CopyAction
          ariaLabel={`复制 .${item.tld} 价格记录`}
          label="复制此条价格"
          text={formatPricingRecord(item)}
        />
      </CardContent>
    </Card>
  )
}

function ResultSummary({ result }: { result: PricingResult }) {
  if (result.state === 'ready') {
    const priced = result.data.items.filter((item) => item.status === 'priced').length
    return (
      <div className="rounded-xl border bg-accent/40 px-5 py-4" role="status">
        <p className="font-medium">价格查询完成，{priced} 个后缀生成了可追溯快照。</p>
        <p className="mt-1 text-sm text-muted-foreground">
          所有金额均为 fixture 合成数据；交易功能尚未开放。
        </p>
      </div>
    )
  }
  if (result.state === 'empty') {
    return (
      <ResultState
        cacheStatus={result.meta?.cacheStatus}
        dataSource={result.meta?.dataSource}
        description="当前请求没有可计算价格的后缀。"
        observedAt={result.meta?.observedAt}
        state="empty"
        title="暂无公开价格"
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

export function PricingResults() {
  const [result, setResult] = useState<PricingResult>()
  const [problem, setProblem] = useState<ProblemDetails>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const startedAt = performance.now()
    void fetch('/api/v1/tools/pricing', {
      body: '{}',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      referrerPolicy: 'origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw await readProblemResponse(response)
        const parsed = pricingResultSchema.safeParse(await response.json())
        if (!parsed.success) {
          throw toProblemDetails(
            new AppError('PRICING_INVALID_RESPONSE', '价格服务返回了无法识别的结果', 503),
            getTraceId(response.headers),
          )
        }
        setResult(parsed.data)
        emitOutcome(parsed.data, performance.now() - startedAt)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const safeProblem =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as ProblemDetails)
            : toProblemDetails(
                new AppError('PRICING_UNAVAILABLE', '价格服务暂时不可用', 503),
                globalThis.crypto.randomUUID(),
              )
        setProblem(safeProblem)
        emitFirstPartyEvent({
          dataSource: 'unknown',
          durationBucket: bucketDuration(performance.now() - startedAt),
          errorCode: safeProblem.code,
          event: 'tool_failed',
          schemaVersion: 1,
          tool: 'pricing',
        })
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [])

  if (loading) {
    return (
      <div className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]">
        <div aria-busy="true" className="rounded-xl border bg-card p-6" role="status">
          正在计算默认 TLD 的 1 年与 3 年成本，请稍候…
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
      aria-labelledby="pricing-results-title"
      className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl space-y-6 sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
    >
      <div>
        <h2 className="font-heading text-2xl font-semibold" id="pricing-results-title">
          普通域名价格表
        </h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-muted-foreground">
          当前只展示本地 fixture 的普通域名价格，溢价域名不在本表内。1 年成本等于注册终价；3
          年成本等于注册终价加两年续费终价。
        </p>
      </div>
      <ResultSummary result={result} />
      {'data' in result && result.data.items.length > 0 ? (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {result.data.items.map((item) => (
            <PricingCard item={item} key={item.tld} />
          ))}
        </div>
      ) : null}
      <p className="rounded-xl border border-dashed px-5 py-4 text-sm text-muted-foreground">
        交易功能尚未开放：当前页面不提供购买入口、报价锁定或订单功能。
      </p>
    </section>
  )
}
