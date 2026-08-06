'use client'

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  DatabaseIcon,
  KeyRoundIcon,
  NetworkIcon,
  ShieldCheckIcon,
  ShieldXIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { ResultState } from '@/components/results/result-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { bucketDuration, emitFirstPartyEvent, inferToolInput } from '@/lib/analytics'
import { AppError, getTraceId, readProblemResponse, toProblemDetails } from '@/lib/errors'
import type { ProblemDetails } from '@/schemas/api'
import {
  sslCheckResultSchema,
  type CaaInspection,
  type SslCheckResult,
  type TlsInspection,
} from '@/schemas/tls'

function formatObservedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  }).format(date)
}

function cacheLabel(status: 'hit' | 'miss' | 'mixed' | 'not_used'): string {
  return {
    hit: 'Wanmi 短时缓存命中',
    miss: '本次重新查询',
    mixed: '部分缓存命中',
    not_used: '未使用 Wanmi 缓存',
  }[status]
}

function SourceDetails({ source }: { source: TlsInspection['source'] | CaaInspection['source'] }) {
  return (
    <dl className="grid gap-3 border-t pt-4 text-xs sm:grid-cols-3">
      <div>
        <dt className="flex items-center gap-1 text-muted-foreground">
          <DatabaseIcon aria-hidden="true" className="size-3.5" /> 数据源
        </dt>
        <dd className="mt-1 font-medium">{source.dataSource}</dd>
      </div>
      <div>
        <dt className="flex items-center gap-1 text-muted-foreground">
          <Clock3Icon aria-hidden="true" className="size-3.5" /> 查询时间
        </dt>
        <dd className="mt-1 font-medium">
          <time dateTime={source.observedAt}>{formatObservedAt(source.observedAt)}</time>
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">缓存状态</dt>
        <dd className="mt-1 font-medium">{cacheLabel(source.cacheStatus)}</dd>
      </div>
    </dl>
  )
}

function ResultSummary({ result }: { result: SslCheckResult }) {
  const meta = result.meta
  if (result.state === 'empty') {
    return (
      <ResultState
        cacheStatus={meta?.cacheStatus}
        dataSource={meta?.dataSource}
        description="受控 DNS 查询没有返回可连接的公开 A/AAAA 地址，因此没有建立 TLS 连接。"
        observedAt={meta?.observedAt}
        state="empty"
        title="没有可连接的公网地址"
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
        <CheckCircle2Icon aria-hidden="true" className="size-4 text-emerald-600" />
        TLS、证书与 CAA 检查完成
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        固定 443 端口握手成功，未发现有效期、域名匹配、自签名或证书链问题。
      </p>
    </div>
  )
}

function CertificateDetails({ tls }: { tls: TlsInspection }) {
  if (tls.status !== 'connected' || !tls.certificate) {
    return (
      <Card data-tls-status={tls.status}>
        <CardHeader>
          <CardTitle>
            <h3 className="flex items-center gap-2">
              <ShieldXIcon aria-hidden="true" className="size-4 text-amber-600" /> TLS 连接
            </h3>
          </CardTitle>
          <CardDescription>{tls.issue?.message ?? '没有可连接的公开地址。'}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm">固定端口：{tls.port}</p>
          <SourceDetails source={tls.source} />
        </CardContent>
      </Card>
    )
  }

  const certificate = tls.certificate
  return (
    <Card data-tls-status={tls.status}>
      <CardHeader>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <CardTitle>
              <h3 className="flex items-center gap-2">
                <ShieldCheckIcon aria-hidden="true" className="size-4 text-emerald-600" /> TLS
                连接与证书
              </h3>
            </CardTitle>
            <CardDescription className="mt-1">
              只完成握手诊断，未发送 HTTP 请求或应用数据。
            </CardDescription>
          </div>
          <Badge variant={tls.findings.length > 0 ? 'destructive' : 'outline'}>
            {tls.findings.length > 0 ? `发现 ${tls.findings.length} 项问题` : '证书正常'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-4 rounded-lg border px-4 py-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">固定端口</dt>
            <dd className="mt-1 font-mono">{tls.port}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">TLS 协议</dt>
            <dd className="mt-1 font-mono">{tls.protocol}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">密码套件</dt>
            <dd className="mt-1 font-mono break-all">{tls.cipherSuite}</dd>
          </div>
        </dl>

        {tls.findings.map((finding) => (
          <Alert key={finding.code} variant="destructive">
            <AlertTriangleIcon aria-hidden="true" className="size-4" />
            <AlertTitle>{finding.code}</AlertTitle>
            <AlertDescription>{finding.message}</AlertDescription>
          </Alert>
        ))}

        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">证书主题</dt>
            <dd className="mt-1 break-all">
              {certificate.subject.commonName ?? '未提供 CN'}
              {certificate.subject.organization ? ` · ${certificate.subject.organization}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">签发者</dt>
            <dd className="mt-1 break-all">
              {certificate.issuer.commonName ?? '未提供 CN'}
              {certificate.issuer.organization ? ` · ${certificate.issuer.organization}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">有效期</dt>
            <dd className="mt-1">
              {formatObservedAt(certificate.validFrom)} 至 {formatObservedAt(certificate.validTo)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">剩余天数 / 域名匹配</dt>
            <dd className="mt-1">
              {certificate.daysRemaining} 天 · {certificate.hostnameMatch ? '匹配' : '不匹配'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">信任状态</dt>
            <dd className="mt-1">
              {
                { trusted: '系统信任库验证通过', self_signed: '自签名', invalid: '证书链无效' }[
                  certificate.chain.status
                ]
              }
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">SAN</dt>
            <dd className="mt-1">
              {certificate.sanCount} 项{certificate.sanTruncated ? '（仅展示前 128 项）' : ''}
            </dd>
          </div>
        </dl>

        {certificate.subjectAlternativeNames.length > 0 ? (
          <div>
            <h4 className="text-sm font-medium">Subject Alternative Names</h4>
            <ul className="mt-2 grid gap-2 rounded-lg border px-4 py-3 font-mono text-xs sm:grid-cols-2">
              {certificate.subjectAlternativeNames.map((name, index) => (
                <li className="break-all" key={`${name}-${index}`}>
                  {name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <h4 className="flex items-center gap-2 text-sm font-medium">
            <KeyRoundIcon aria-hidden="true" className="size-4" /> 证书链（共{' '}
            {certificate.chain.depth} 层）
          </h4>
          <ol className="mt-2 divide-y rounded-lg border">
            {certificate.chain.certificates.map((item, index) => (
              <li className="px-4 py-3 text-xs" key={`${item.fingerprint256 ?? 'cert'}-${index}`}>
                <p className="font-medium break-all">
                  {index + 1}. {item.subject.commonName ?? '未提供 CN'}
                </p>
                <p className="mt-1 text-muted-foreground break-all">
                  签发者：{item.issuer.commonName ?? '未提供 CN'}
                </p>
                {item.fingerprint256 ? (
                  <p className="mt-1 font-mono text-muted-foreground break-all">
                    SHA-256 {item.fingerprint256}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
          {certificate.chain.truncated ? (
            <p className="mt-2 text-xs text-muted-foreground">证书链仅展示前 10 层。</p>
          ) : null}
        </div>
        <SourceDetails source={tls.source} />
      </CardContent>
    </Card>
  )
}

function CaaDetails({ caa }: { caa: CaaInspection }) {
  const complete =
    caa.status === 'records' || caa.status === 'no_record' || caa.status === 'nxdomain'
  return (
    <Card data-caa-status={caa.status}>
      <CardHeader>
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <CardTitle>
              <h3 className="flex items-center gap-2">
                <NetworkIcon aria-hidden="true" className="size-4" /> CAA 策略
              </h3>
            </CardTitle>
            <CardDescription className="mt-1">
              {caa.status === 'records'
                ? `${caa.inherited ? '继承自父域' : '当前域名'}：${caa.effectiveOwnerName}`
                : caa.status === 'no_record' || caa.status === 'nxdomain'
                  ? '当前域名及已检查父域没有 CAA 记录。'
                  : caa.issue?.message}
            </CardDescription>
          </div>
          <Badge variant={complete ? 'outline' : 'destructive'}>
            {caa.status === 'records'
              ? '找到策略'
              : caa.status === 'no_record'
                ? '无 CAA'
                : caa.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {caa.records.length > 0 ? (
          <div className="divide-y rounded-lg border">
            {caa.records.map((record, index) => (
              <div
                className="space-y-2 px-4 py-3 text-sm"
                key={`${record.tag}-${record.value}-${index}`}
              >
                <p className="font-mono break-all">
                  {record.flags} {record.tag} “{record.value || '（空值）'}”
                </p>
                <p className="text-xs text-muted-foreground">{record.explanation}</p>
                <p className="text-xs text-muted-foreground break-all">
                  所属域名 {record.ownerName} · TTL {record.ttl} 秒
                  {record.critical ? ' · critical' : ''}
                </p>
              </div>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          CAA 约束证书签发时的 CA 行为；本工具不会按品牌名称推断现有证书是否符合 CAA，也不会访问
          iodef 地址。
        </p>
        <SourceDetails source={caa.source} />
      </CardContent>
    </Card>
  )
}

function emitOutcome(result: SslCheckResult, query: string, durationMs: number): void {
  const dimensions = inferToolInput(query)
  if (result.state === 'error' || result.state === 'rate_limited') {
    emitFirstPartyEvent({
      dataSource: 'tls',
      durationBucket: bucketDuration(durationMs),
      errorCode: result.problem.code,
      event: 'tool_failed',
      schemaVersion: 1,
      tld: dimensions.tld,
      tool: 'ssl-check',
    })
    return
  }
  emitFirstPartyEvent({
    dataSource: 'tls',
    durationBucket: bucketDuration(durationMs),
    event: 'tool_completed',
    resultCategory: result.state,
    schemaVersion: 1,
    succeeded: result.state === 'ready' || result.state === 'empty',
    tld: dimensions.tld,
    tool: 'ssl-check',
  })
}

export function SslResults({ query }: { query: string }) {
  const [result, setResult] = useState<SslCheckResult>()
  const [problem, setProblem] = useState<ProblemDetails>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const startedAt = performance.now()
    void fetch('/api/v1/tools/ssl-check', {
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
        const parsed = sslCheckResultSchema.safeParse(await response.json())
        if (!parsed.success) {
          throw toProblemDetails(
            new AppError('TLS_INVALID_RESPONSE', 'SSL 检查服务返回了无法识别的结果', 503),
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
                new AppError('TLS_UNAVAILABLE', 'SSL 检查服务暂时不可用', 503),
                globalThis.crypto.randomUUID(),
              )
        setProblem(safeProblem)
        emitFirstPartyEvent({
          dataSource: 'tls',
          durationBucket: bucketDuration(performance.now() - startedAt),
          errorCode: safeProblem.code,
          event: 'tool_failed',
          schemaVersion: 1,
          tld: inferToolInput(query).tld,
          tool: 'ssl-check',
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
          正在安全解析目标并检查固定 443 端口的 TLS 证书与 CAA，请稍候…
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
      aria-labelledby="ssl-results-title"
      className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl space-y-6 sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
    >
      <div>
        <h2 className="font-heading text-2xl font-semibold" id="ssl-results-title">
          SSL / TLS / CAA 检查结果
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          仅执行受控 DNS 查询和 TLS 握手；不抓取网页、不跟随重定向、不执行 OCSP。
        </p>
      </div>
      <ResultSummary result={result} />
      {'data' in result ? (
        <>
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
          {result.data.risks.length > 0 ? (
            <Alert>
              <AlertTriangleIcon aria-hidden="true" className="size-4" />
              <AlertTitle>Unicode 域名提示</AlertTitle>
              <AlertDescription>{result.data.risks[0]?.message}</AlertDescription>
            </Alert>
          ) : null}
          <CertificateDetails tls={result.data.tls} />
          <CaaDetails caa={result.data.caa} />
          <dl className="grid gap-4 rounded-xl border bg-card px-5 py-4 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">聚合数据源</dt>
              <dd className="mt-1 font-medium">{result.meta?.dataSource}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">聚合查询时间</dt>
              <dd className="mt-1 font-medium">
                {result.meta?.observedAt ? formatObservedAt(result.meta.observedAt) : '未提供'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">聚合缓存状态</dt>
              <dd className="mt-1 font-medium">
                {cacheLabel(result.meta?.cacheStatus ?? 'not_used')}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">请求 ID</dt>
              <dd className="mt-1 font-mono break-all">{result.meta?.traceId ?? '未提供'}</dd>
            </div>
          </dl>
        </>
      ) : null}
    </section>
  )
}
