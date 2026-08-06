'use client'

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  DatabaseIcon,
  ShieldAlertIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { ResultState } from '@/components/results/result-state'
import { CopyAction } from '@/components/tool-actions/copy-action'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { bucketDuration, emitFirstPartyEvent, inferToolInput } from '@/lib/analytics'
import { AppError, getTraceId, readProblemResponse, toProblemDetails } from '@/lib/errors'
import { formatDnsRecord } from '@/lib/tool-actions'
import type { ProblemDetails } from '@/schemas/api'
import {
  dnsLookupResultSchema,
  type DnsLookupResult,
  type DnsRecord,
  type DnsRecordSet,
} from '@/schemas/dns'

function formatObservedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  }).format(date)
}

function cacheLabel(status: DnsRecordSet['cacheStatus']): string {
  return {
    hit: 'Wanmi 短时缓存命中',
    miss: '本次重新查询',
    mixed: '部分缓存命中',
    not_used: '未使用 Wanmi 缓存',
  }[status]
}

function nodeLabel(node: DnsRecordSet['resolverNode']): string {
  return node === 'alidns_primary' ? '阿里公共 DNS 主节点' : '阿里公共 DNS 备用节点'
}

function statusText(recordSet: DnsRecordSet): { description: string; label: string } {
  if (recordSet.status === 'records') {
    return { description: `共返回 ${recordSet.records.length} 条记录`, label: '已找到记录' }
  }
  if (recordSet.status === 'no_record') {
    return { description: '域名存在，但该类型没有记录。', label: '无此类记录' }
  }
  if (recordSet.status === 'nxdomain') {
    return {
      description: '递归解析器返回 NXDOMAIN；这不是可注册状态，不能据此判断域名可购买。',
      label: 'NXDOMAIN',
    }
  }
  const label = {
    blocked: '安全阻断',
    failed: '查询失败',
    rate_limited: '请求受限',
    servfail: 'SERVFAIL',
    timeout: '查询超时',
  }[recordSet.status]
  return { description: recordSet.issue.message, label }
}

function RecordValue({ record }: { record: DnsRecord }) {
  if (record.type === 'A' || record.type === 'AAAA') {
    return <span className="font-mono break-all">{record.address}</span>
  }
  if (record.type === 'CNAME') {
    return <span className="font-mono break-all">{record.target}</span>
  }
  if (record.type === 'MX') {
    return (
      <span className="font-mono break-all">
        优先级 {record.priority} · {record.exchange}
      </span>
    )
  }
  if (record.type === 'TXT') {
    return <span className="font-mono break-all whitespace-pre-wrap">{record.value}</span>
  }
  if (record.type === 'NS') {
    return <span className="font-mono break-all">{record.host}</span>
  }
  if (record.type === 'SOA') {
    return (
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">主 Name Server</dt>
          <dd className="mt-1 font-mono break-all">{record.primaryNameServer}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">责任邮箱</dt>
          <dd className="mt-1 font-mono break-all">{record.responsibleMailbox}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Serial</dt>
          <dd className="mt-1 font-mono">{record.serial}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Refresh / Retry</dt>
          <dd className="mt-1 font-mono">
            {record.refresh}s / {record.retry}s
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Expire / Minimum</dt>
          <dd className="mt-1 font-mono">
            {record.expire}s / {record.minimum}s
          </dd>
        </div>
      </dl>
    )
  }
  return (
    <span className="font-mono break-all">
      flags={record.flags} · {record.tag} · {record.value || '（空值）'}
    </span>
  )
}

function RecordSetCard({ recordSet }: { recordSet: DnsRecordSet }) {
  const presentation = statusText(recordSet)
  const blocked = recordSet.status === 'blocked'
  const failed = ['failed', 'rate_limited', 'servfail', 'timeout'].includes(recordSet.status)
  return (
    <Card data-dns-status={recordSet.status} data-dns-type={recordSet.type}>
      <CardHeader>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <CardTitle>
              <h3 className="flex items-center gap-2">
                {blocked || failed ? (
                  <ShieldAlertIcon aria-hidden="true" className="size-4 text-amber-600" />
                ) : (
                  <CheckCircle2Icon aria-hidden="true" className="size-4 text-emerald-600" />
                )}
                {recordSet.type}
              </h3>
            </CardTitle>
            <CardDescription className="mt-1">{presentation.description}</CardDescription>
          </div>
          <Badge variant={blocked || failed ? 'destructive' : 'outline'}>
            {presentation.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {recordSet.records.length > 0 ? (
          <div className="divide-y rounded-lg border">
            {recordSet.records.map((record, index) => (
              <div
                className="grid gap-3 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_7rem_auto] sm:items-center"
                key={`${record.ownerName}-${record.ttl}-${index}`}
              >
                <div className="min-w-0">
                  <p className="mb-1 text-xs text-muted-foreground break-all">{record.ownerName}</p>
                  <RecordValue record={record} />
                </div>
                <div className="sm:text-right">
                  <p className="text-xs text-muted-foreground">TTL</p>
                  <p className="mt-1 font-mono">{record.ttl} 秒</p>
                </div>
                <CopyAction
                  ariaLabel={`复制 ${record.type} 记录 ${index + 1}`}
                  label="复制记录"
                  size="xs"
                  text={formatDnsRecord(record)}
                />
              </div>
            ))}
          </div>
        ) : null}
        <dl className="grid gap-3 border-t pt-4 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">数据源</dt>
            <dd className="mt-1 font-medium">{nodeLabel(recordSet.resolverNode)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">查询时间</dt>
            <dd className="mt-1 font-medium">
              <time dateTime={recordSet.observedAt}>{formatObservedAt(recordSet.observedAt)}</time>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">缓存状态</dt>
            <dd className="mt-1 font-medium">{cacheLabel(recordSet.cacheStatus)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}

function ResultSummary({ result }: { result: DnsLookupResult }) {
  const meta = result.meta
  if (result.state === 'empty') {
    const nxdomain = result.data.recordSets.some((recordSet) => recordSet.status === 'nxdomain')
    return (
      <ResultState
        cacheStatus={meta?.cacheStatus}
        dataSource={meta?.dataSource}
        description={
          nxdomain
            ? '递归解析器返回 NXDOMAIN。这只表示该解析视角下域名不存在，绝不代表域名可注册。'
            : '域名存在，但八种受支持的记录类型均未返回记录。'
        }
        observedAt={meta?.observedAt}
        state="empty"
        title={nxdomain ? 'DNS 返回 NXDOMAIN' : '未找到支持的 DNS 记录'}
        traceId={meta?.traceId}
      />
    )
  }
  if (result.state === 'partial' || result.state === 'degraded') {
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
        <CheckCircle2Icon aria-hidden="true" className="size-4" />
        DNS 查询完成
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        已完成八种只读记录查询；结果不判断域名是否可注册。
      </p>
    </div>
  )
}

function emitOutcome(result: DnsLookupResult, query: string, durationMs: number): void {
  const dimensions = inferToolInput(query)
  if (result.state === 'error' || result.state === 'rate_limited') {
    emitFirstPartyEvent({
      dataSource: 'dns',
      durationBucket: bucketDuration(durationMs),
      errorCode: result.problem.code,
      event: 'tool_failed',
      schemaVersion: 1,
      tld: dimensions.tld,
      tool: 'dns',
    })
    return
  }
  emitFirstPartyEvent({
    dataSource: 'dns',
    durationBucket: bucketDuration(durationMs),
    event: 'tool_completed',
    resultCategory: result.state,
    schemaVersion: 1,
    succeeded: result.state === 'ready' || result.state === 'empty',
    tld: dimensions.tld,
    tool: 'dns',
  })
}

export function DnsResults({ query }: { query: string }) {
  const [result, setResult] = useState<DnsLookupResult>()
  const [problem, setProblem] = useState<ProblemDetails>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const startedAt = performance.now()
    void fetch('/api/v1/tools/dns', {
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
        const parsed = dnsLookupResultSchema.safeParse(await response.json())
        if (!parsed.success) {
          throw toProblemDetails(
            new AppError('DNS_INVALID_RESPONSE', 'DNS 查询服务返回了无法识别的结果', 503),
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
                new AppError('DNS_UNAVAILABLE', 'DNS 查询服务暂时不可用', 503),
                globalThis.crypto.randomUUID(),
              )
        setProblem(safeProblem)
        emitFirstPartyEvent({
          dataSource: 'dns',
          durationBucket: bucketDuration(performance.now() - startedAt),
          errorCode: safeProblem.code,
          event: 'tool_failed',
          schemaVersion: 1,
          tld: inferToolInput(query).tld,
          tool: 'dns',
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
          正在通过受控解析器查询八种 DNS 记录，请稍候…
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
      aria-labelledby="dns-results-title"
      className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl space-y-6 sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
    >
      <div>
        <h2 className="font-heading text-2xl font-semibold" id="dns-results-title">
          DNS / NS 查询结果
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          结果来自单一受控递归解析视角，不承诺全球解析器即时一致，也不判断域名可注册状态。
        </p>
      </div>
      <ResultSummary result={result} />
      {'data' in result ? (
        <>
          {result.data.risks.length > 0 ? (
            <div
              className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 text-sm text-amber-900"
              role="note"
            >
              <p className="flex gap-2">
                <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {result.data.risks[0].message}
              </p>
            </div>
          ) : null}
          <dl className="grid gap-4 rounded-xl border bg-card px-5 py-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Unicode 域名</dt>
              <dd className="mt-1 font-mono break-all">{result.data.normalizedQueryUnicode}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">ASCII / Punycode</dt>
              <dd className="mt-1 font-mono break-all">{result.data.normalizedQueryAscii}</dd>
            </div>
          </dl>
          <dl className="grid gap-4 rounded-xl border bg-card px-5 py-4 text-xs sm:grid-cols-3">
            <div>
              <dt className="flex items-center gap-1 text-muted-foreground">
                <DatabaseIcon aria-hidden="true" className="size-3.5" /> 数据源
              </dt>
              <dd className="mt-1 font-medium">{result.meta?.dataSource ?? '阿里公共 DNS'}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-muted-foreground">
                <Clock3Icon aria-hidden="true" className="size-3.5" /> 查询时间
              </dt>
              <dd className="mt-1 font-medium">
                {result.meta?.observedAt
                  ? formatObservedAt(result.meta.observedAt)
                  : '数据源未提供'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">缓存状态</dt>
              <dd className="mt-1 font-medium">
                {cacheLabel(result.meta?.cacheStatus ?? 'not_used')}
              </dd>
            </div>
          </dl>
          <div className="grid gap-5 lg:grid-cols-2">
            {result.data.recordSets.map((recordSet) => (
              <RecordSetCard key={recordSet.type} recordSet={recordSet} />
            ))}
          </div>
          <div
            className="rounded-xl border bg-muted/40 px-5 py-4 text-sm text-muted-foreground"
            role="note"
          >
            CAA 在此只作为原始 DNS 记录展示；证书、域名匹配与 CAA 策略检查属于后续 SSL / CAA 工具。
          </div>
        </>
      ) : null}
    </section>
  )
}
