'use client'

import { AlertTriangleIcon, Clock3Icon, DatabaseIcon, ShieldCheckIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ResultState } from '@/components/results/result-state'
import { CopyAction } from '@/components/tool-actions/copy-action'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AppError, getTraceId, readProblemResponse, toProblemDetails } from '@/lib/errors'
import { bucketDuration, emitFirstPartyEvent, inferToolInput } from '@/lib/analytics'
import { formatWhoisField } from '@/lib/tool-actions'
import type { ProblemDetails } from '@/schemas/api'
import {
  whoisLookupResultSchema,
  type WhoisLookupData,
  type WhoisLookupResult,
} from '@/schemas/whois'

function formatObservedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  }).format(date)
}

function sourceName(data: WhoisLookupData): string {
  if (data.source.provider === 'westdigital') return '西部数码 WHOIS'
  return data.source.protocol === 'rdap' ? 'Who-Dat RDAP' : 'Who-Dat WHOIS'
}

function analyticsSource(result: WhoisLookupResult): 'whodat' | 'westdigital' | 'unknown' {
  if ('data' in result) return result.data.source.provider
  if (result.problem.code.startsWith('WESTDIGITAL_')) return 'westdigital'
  if (result.meta?.dataSource === 'Who-Dat RDAP/WHOIS') return 'whodat'
  return 'unknown'
}

function emitOutcome(result: WhoisLookupResult, query: string, durationMs: number): void {
  const dimensions = inferToolInput(query)
  if (result.state === 'error' || result.state === 'rate_limited') {
    emitFirstPartyEvent({
      dataSource: analyticsSource(result),
      durationBucket: bucketDuration(durationMs),
      errorCode: result.problem.code,
      event: 'tool_failed',
      schemaVersion: 1,
      tld: dimensions.tld,
      tool: 'whois',
    })
    return
  }
  emitFirstPartyEvent({
    dataSource: analyticsSource(result),
    durationBucket: bucketDuration(durationMs),
    event: 'tool_completed',
    resultCategory: result.state,
    schemaVersion: 1,
    succeeded: result.state === 'ready' || result.state === 'empty',
    tld: dimensions.tld,
    tool: 'whois',
  })
}

function DetailValue({ label, value }: { label: string; value: string | null }) {
  return (
    <dd className="mt-1 space-y-2 break-words font-medium text-foreground">
      <span className="block">{value ?? '数据源未提供'}</span>
      {value ? (
        <CopyAction
          ariaLabel={`复制 WHOIS 字段：${label}`}
          label="复制此字段"
          size="xs"
          text={formatWhoisField(label, value)}
        />
      ) : null}
    </dd>
  )
}

function RegistrationDetails({ data }: { data: WhoisLookupData }) {
  return (
    <Card data-record-status={data.recordStatus}>
      <CardHeader>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <CardTitle className="font-mono break-all">{data.domainAscii}</CardTitle>
            {data.domainUnicode !== data.domainAscii ? (
              <CardDescription className="mt-1 break-all">{data.domainUnicode}</CardDescription>
            ) : null}
          </div>
          <Badge variant="outline">公开注册记录</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <dl className="grid gap-x-8 gap-y-5 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">注册商</dt>
            <DetailValue label="注册商" value={data.registrar} />
          </div>
          <div>
            <dt className="text-muted-foreground">创建时间</dt>
            <DetailValue label="创建时间" value={data.dates.created} />
          </div>
          <div>
            <dt className="text-muted-foreground">更新时间</dt>
            <DetailValue label="更新时间" value={data.dates.updated} />
          </div>
          <div>
            <dt className="text-muted-foreground">到期时间</dt>
            <DetailValue label="到期时间" value={data.dates.expires} />
          </div>
          <div>
            <dt className="text-muted-foreground">注册状态</dt>
            <dd className="mt-2 flex flex-wrap gap-2">
              {data.statuses.length > 0 ? (
                data.statuses.map((status) => (
                  <span className="flex flex-wrap items-center gap-1" key={status}>
                    <Badge className="max-w-full break-all whitespace-normal" variant="secondary">
                      {status}
                    </Badge>
                    <CopyAction
                      ariaLabel={`复制 WHOIS 状态：${status}`}
                      label="复制状态"
                      size="xs"
                      text={formatWhoisField('注册状态', status)}
                    />
                  </span>
                ))
              ) : (
                <span className="font-medium text-foreground">数据源未提供</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Name Server</dt>
            <dd className="mt-2 space-y-1 font-mono text-xs text-foreground break-all">
              {data.nameServers.length > 0 ? (
                data.nameServers.map((nameServer) => (
                  <div className="flex flex-wrap items-center gap-2" key={nameServer}>
                    <span>{nameServer}</span>
                    <CopyAction
                      ariaLabel={`复制 Name Server：${nameServer}`}
                      label="复制 NS"
                      size="xs"
                      text={formatWhoisField('Name Server', nameServer, true)}
                    />
                  </div>
                ))
              ) : (
                <span className="font-sans text-sm font-medium">数据源未提供</span>
              )}
            </dd>
          </div>
        </dl>
        {data.risks.length > 0 ? (
          <div className="space-y-2 border-t pt-5" role="note">
            {data.risks.map((risk, index) => (
              <p
                className="flex gap-2 text-sm leading-6 text-amber-700 dark:text-amber-300"
                key={`${risk.labelAscii}-${index}`}
              >
                <AlertTriangleIcon aria-hidden="true" className="mt-1 size-4 shrink-0" />
                <span>{risk.message}</span>
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ResultSummary({ result }: { result: WhoisLookupResult }) {
  const meta = result.meta
  if (result.state === 'empty') {
    return (
      <ResultState
        cacheStatus={meta?.cacheStatus}
        dataSource={meta?.dataSource}
        description="未查到公开注册记录。这只说明公开 RDAP/WHOIS 数据源没有返回记录，绝不代表该域名可注册。"
        observedAt={meta?.observedAt}
        state="empty"
        title="未查到公开注册记录"
        traceId={meta?.traceId}
      />
    )
  }
  if (result.state === 'degraded' || result.state === 'partial') {
    return (
      <ResultState
        cacheStatus={meta?.cacheStatus}
        dataSource={meta?.dataSource}
        description={result.problem.detail}
        observedAt={meta?.observedAt}
        retryable={result.problem.retryable}
        state={result.state}
        suggestedAction={result.problem.action}
        title={result.problem.title}
        traceId={result.problem.traceId}
      />
    )
  }
  if (result.state === 'error' || result.state === 'rate_limited') {
    return (
      <ResultState
        cacheStatus={meta?.cacheStatus}
        dataSource={meta?.dataSource}
        description={result.problem.detail}
        observedAt={meta?.observedAt}
        retryable={result.problem.retryable}
        state={result.state}
        suggestedAction={result.problem.action}
        title={result.problem.title}
        traceId={result.problem.traceId}
      />
    )
  }
  return (
    <div className="rounded-xl border bg-accent/40 px-5 py-4" role="status">
      <p className="flex items-center gap-2 font-medium">
        <ShieldCheckIcon aria-hidden="true" className="size-4" />
        已找到公开注册记录
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        该结果不判断域名是否可注册，也不提供购买入口。
      </p>
    </div>
  )
}

function ResultMetadata({ result }: { result: WhoisLookupResult }) {
  if (!('data' in result)) return null
  return (
    <dl className="grid gap-4 rounded-xl border bg-card px-5 py-4 text-xs sm:grid-cols-3">
      <div>
        <dt className="flex items-center gap-1 text-muted-foreground">
          <DatabaseIcon aria-hidden="true" className="size-3.5" />
          数据源
        </dt>
        <dd className="mt-1 font-medium text-foreground">{sourceName(result.data)}</dd>
      </div>
      <div>
        <dt className="flex items-center gap-1 text-muted-foreground">
          <Clock3Icon aria-hidden="true" className="size-3.5" />
          查询时间
        </dt>
        <dd className="mt-1 font-medium text-foreground">
          {result.meta?.observedAt ? (
            <time dateTime={result.meta.observedAt}>
              {formatObservedAt(result.meta.observedAt)}
            </time>
          ) : (
            '数据源未提供'
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">缓存状态</dt>
        <dd className="mt-1 font-medium text-foreground">
          {result.meta?.cacheStatus === 'hit' ? 'Who-Dat 缓存命中' : '本次未命中缓存'}
        </dd>
      </div>
    </dl>
  )
}

export function WhoisResults({ query }: { query: string }) {
  const [result, setResult] = useState<WhoisLookupResult>()
  const [problem, setProblem] = useState<ProblemDetails>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const startedAt = performance.now()
    void fetch('/api/v1/tools/whois', {
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
        const parsed = whoisLookupResultSchema.safeParse(await response.json())
        if (!parsed.success) {
          throw toProblemDetails(
            new AppError('WHOIS_INVALID_RESPONSE', 'WHOIS 查询服务返回了无法识别的结果', 503),
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
                new AppError('WHOIS_UNAVAILABLE', 'WHOIS 查询服务暂时不可用', 503),
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
          tool: 'whois',
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
          正在查询公开 RDAP/WHOIS 注册信息，请稍候…
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
      aria-labelledby="whois-results-title"
      className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl space-y-6 sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
    >
      <div>
        <h2 className="font-heading text-2xl font-semibold" id="whois-results-title">
          RDAP / WHOIS 查询结果
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          仅展示公开注册信息；隐私隐藏和可选字段缺失属于正常现象。此页面不判断可注册状态。
        </p>
      </div>
      <ResultSummary result={result} />
      <ResultMetadata result={result} />
      {'data' in result && result.data.recordStatus === 'record_found' ? (
        <RegistrationDetails data={result.data} />
      ) : null}
    </section>
  )
}
