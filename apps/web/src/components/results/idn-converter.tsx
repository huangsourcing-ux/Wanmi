'use client'

import Link from 'next/link'
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CopyIcon,
  Globe2Icon,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { FormField } from '@/components/forms/form-field'
import { ResultState } from '@/components/results/result-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { bucketDuration, emitFirstPartyEvent, inferToolInput } from '@/lib/analytics'
import {
  formatUnicodeScriptName,
  normalizeDomain,
  type DomainNormalizationResult,
  type NormalizedDomain,
} from '@/lib/domain-name'

type CopyState = 'failed' | 'idle' | 'punycode' | 'unicode'

const destinationTools = [
  { label: '查询可注册状态', path: '/tools/domain-search' },
  { label: '查询 WHOIS / RDAP', path: '/tools/whois' },
  { label: '查询 DNS / NS', path: '/tools/dns' },
  { label: '检查 SSL / CAA', path: '/tools/ssl-check' },
] as const

function emitOutcome(result: DomainNormalizationResult, durationMs: number): void {
  if (!result.ok) {
    emitFirstPartyEvent({
      dataSource: 'local',
      durationBucket: bucketDuration(durationMs),
      errorCode: result.error.code,
      event: 'tool_failed',
      schemaVersion: 1,
      tool: 'idn',
    })
    return
  }

  emitFirstPartyEvent({
    dataSource: 'local',
    durationBucket: bucketDuration(durationMs),
    event: 'tool_completed',
    resultCategory: 'ready',
    schemaVersion: 1,
    succeeded: true,
    tool: 'idn',
  })
}

function ConversionResults({
  copyState,
  data,
  onCopy,
}: {
  copyState: CopyState
  data: NormalizedDomain
  onCopy: (kind: 'punycode' | 'unicode', value: string) => void
}) {
  const encodedPunycode = encodeURIComponent(data.display)

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-accent/40 px-5 py-4" role="status">
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2Icon aria-hidden="true" className="size-4" />
          IDN 转换完成
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          公开展示、复制默认值和跨工具跳转均固定使用 ASCII/Punycode。
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card data-idn-result="punycode">
          <CardHeader>
            <CardTitle>
              <h3>Punycode（公开展示）</h3>
            </CardTitle>
            <CardDescription>规范化 ASCII 域名，用于复制和进入其他工具。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <output
              className="block rounded-lg bg-muted px-4 py-3 font-mono text-base break-all"
              data-public-domain={data.display}
            >
              {data.display}
            </output>
            <Button onClick={() => onCopy('punycode', data.display)} type="button">
              <CopyIcon aria-hidden="true" data-icon="inline-start" />
              复制 Punycode
            </Button>
          </CardContent>
        </Card>

        <Card data-idn-result="unicode">
          <CardHeader>
            <CardTitle>
              <h3>Unicode（转换预览）</h3>
            </CardTitle>
            <CardDescription>仅用于识读和核对，不作为公开展示值。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <output className="block rounded-lg bg-muted px-4 py-3 text-base break-all">
              {data.unicode}
            </output>
            <Button onClick={() => onCopy('unicode', data.unicode)} type="button" variant="outline">
              <CopyIcon aria-hidden="true" data-icon="inline-start" />
              复制 Unicode
            </Button>
          </CardContent>
        </Card>
      </div>

      <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground" role="status">
        {copyState === 'punycode'
          ? '已复制 Punycode'
          : copyState === 'unicode'
            ? '已复制 Unicode'
            : copyState === 'failed'
              ? '复制失败，请手动选择结果'
              : ''}
      </p>

      {data.risks.map((risk) => (
        <Alert
          className="border-amber-500/50 bg-amber-500/5"
          data-idn-risk={risk.labelAscii}
          key={risk.labelAscii}
          role="note"
        >
          <AlertTriangleIcon aria-hidden="true" className="text-amber-700 dark:text-amber-300" />
          <AlertTitle>同形异义风险：{risk.labelAscii}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              <span className="font-medium text-foreground">混合的书写系统：</span>
              {risk.scripts.map(formatUnicodeScriptName).join('、')}
            </p>
            <p>{risk.message}</p>
          </AlertDescription>
        </Alert>
      ))}

      <Alert role="note">
        <AlertTriangleIcon aria-hidden="true" />
        <AlertTitle>转换结果边界</AlertTitle>
        <AlertDescription>
          转换成功不代表可注册或商标安全；本工具不查询注册、WHOIS、DNS 或价格。
        </AlertDescription>
      </Alert>

      <div className="rounded-xl border bg-card px-5 py-5">
        <h3 className="font-heading text-lg font-semibold">使用 Punycode 进入其他工具</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          只有点击以下链接时，Punycode 才会作为查询参数发送给对应工具。
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {destinationTools.map((tool) => (
            <Button asChild key={tool.path} variant="outline">
              <Link href={`${tool.path}?q=${encodedPunycode}`}>
                {tool.label}
                <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
              </Link>
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function IdnConverter({ defaultValue = '' }: { defaultValue?: string }) {
  const [result, setResult] = useState<DomainNormalizationResult | undefined>(() =>
    defaultValue ? normalizeDomain(defaultValue) : undefined,
  )
  const [copyState, setCopyState] = useState<CopyState>('idle')

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = new FormData(event.currentTarget).get('q')
    const value = typeof query === 'string' ? query : ''
    const startedAt = performance.now()
    const inputType = inferToolInput(value).inputType

    emitFirstPartyEvent({
      event: 'tool_submitted',
      fromLocalHistory: false,
      inputType,
      schemaVersion: 1,
      tool: 'idn',
    })

    const nextResult = normalizeDomain(value)
    setCopyState('idle')
    setResult(nextResult)
    emitOutcome(nextResult, performance.now() - startedAt)
  }

  async function copyValue(kind: 'punycode' | 'unicode', value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopyState(kind)
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <section
      aria-labelledby="idn-converter-title"
      className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl space-y-6 sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]"
    >
      <div>
        <h2 className="font-heading text-2xl font-semibold" id="idn-converter-title">
          IDN 双向转换
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          在浏览器中同时生成 Unicode 和 Punycode；输入不会因转换而上传。
        </p>
      </div>

      <form className="rounded-xl border bg-card p-4 sm:p-5" onSubmit={handleSubmit}>
        <FormField
          description="支持 Unicode 中文域名、Punycode 或普通 ASCII 域名，自动识别输入方向。"
          error={result && !result.ok ? result.error.message : undefined}
          id="idn-query"
          label="输入要转换的域名"
        >
          {(controlProps) => (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-3">
                <Globe2Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                <Input
                  {...controlProps}
                  autoCapitalize="none"
                  autoComplete="off"
                  className="h-11 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0 md:text-base"
                  defaultValue={defaultValue}
                  maxLength={1_024}
                  name="q"
                  placeholder="例如 例子.中国 或 xn--fsqu00a.xn--fiqs8s"
                  spellCheck={false}
                  type="text"
                />
              </div>
              <Button className="h-11 px-5" size="lg" type="submit">
                转换 IDN
                <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
              </Button>
            </div>
          )}
        </FormField>
      </form>

      {!result ? (
        <ResultState
          description="输入 Unicode 或 Punycode 域名，将在本地显示双向转换结果与安全提示。"
          state="empty"
          title="等待 IDN 转换"
        />
      ) : result.ok ? (
        <ConversionResults copyState={copyState} data={result.value} onCopy={copyValue} />
      ) : (
        <ResultState
          description={result.error.message}
          retryable={false}
          state="error"
          suggestedAction="请根据标签位置和原因修正输入后重试"
          title="域名格式无效"
        />
      )}
    </section>
  )
}
