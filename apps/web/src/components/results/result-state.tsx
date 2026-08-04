'use client'

import Link from 'next/link'
import type { ElementType } from 'react'
import { CircleOffIcon, CloudOffIcon, GaugeIcon, LayersIcon, TriangleAlertIcon } from 'lucide-react'

import { useRequestId } from '@/components/request-context'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { ProblemDetails } from '@/schemas/api'

export type VisibleResultState = 'degraded' | 'empty' | 'error' | 'partial' | 'rate_limited'

type LinkAction = { href: string; label: string; onClick?: never }
type ButtonAction = { href?: never; label: string; onClick: () => void }
export type ResultAction = ButtonAction | LinkAction

const stateIcons = {
  degraded: CloudOffIcon,
  empty: CircleOffIcon,
  error: TriangleAlertIcon,
  partial: LayersIcon,
  rate_limited: GaugeIcon,
} as const

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  }).format(date)
}

function Action({ action, variant }: { action: ResultAction; variant: 'default' | 'outline' }) {
  if (action.href) {
    return (
      <Button asChild variant={variant}>
        <Link href={action.href}>{action.label}</Link>
      </Button>
    )
  }
  return (
    <Button onClick={action.onClick} type="button" variant={variant}>
      {action.label}
    </Button>
  )
}

export function ResultState({
  compact = false,
  dataSource,
  description,
  headingLevel = 2,
  lastSuccessfulAt,
  observedAt,
  primaryAction,
  retryable,
  secondaryAction,
  showContextRequestId = false,
  state,
  suggestedAction,
  title,
  traceId,
}: {
  compact?: boolean
  dataSource?: string
  description: string
  headingLevel?: 1 | 2 | 3
  lastSuccessfulAt?: string
  observedAt?: string
  primaryAction?: ResultAction
  retryable?: boolean
  secondaryAction?: ResultAction
  showContextRequestId?: boolean
  state: VisibleResultState
  suggestedAction?: string
  title: string
  traceId?: string
}) {
  const contextualRequestId = useRequestId()
  const requestId =
    traceId ?? (state === 'empty' && !showContextRequestId ? undefined : contextualRequestId)
  const Icon = stateIcons[state]
  const Heading: ElementType = headingLevel === 1 ? 'h1' : headingLevel === 3 ? 'h3' : 'h2'
  const hasMetadata = Boolean(
    dataSource || observedAt || lastSuccessfulAt || requestId || retryable !== undefined,
  )

  return (
    <Alert
      className={compact ? 'px-4 py-4' : 'px-5 py-5 sm:px-6 sm:py-6'}
      role={state === 'error' || state === 'rate_limited' ? 'alert' : 'status'}
      variant={state === 'error' || state === 'rate_limited' ? 'destructive' : 'default'}
    >
      <Icon aria-hidden="true" className="size-5" />
      <AlertTitle>
        <Heading className={compact ? 'text-sm' : 'text-lg'}>{title}</Heading>
      </AlertTitle>
      <AlertDescription className="space-y-4 text-left text-pretty">
        <p>{description}</p>
        {suggestedAction ? (
          <p>
            <span className="font-medium text-foreground">建议动作：</span>
            {suggestedAction}
          </p>
        ) : null}
        {hasMetadata ? (
          <dl className="grid gap-x-6 gap-y-2 border-t pt-4 text-xs sm:grid-cols-2">
            {retryable !== undefined ? (
              <div>
                <dt className="text-muted-foreground">是否可以重试</dt>
                <dd className="mt-1 font-medium text-foreground">{retryable ? '是' : '否'}</dd>
              </div>
            ) : null}
            {dataSource ? (
              <div>
                <dt className="text-muted-foreground">数据源</dt>
                <dd className="mt-1 font-medium text-foreground">{dataSource}</dd>
              </div>
            ) : null}
            {observedAt ? (
              <div>
                <dt className="text-muted-foreground">数据时间</dt>
                <dd className="mt-1 font-medium text-foreground">
                  <time dateTime={observedAt}>{formatTime(observedAt)}</time>
                </dd>
              </div>
            ) : null}
            {lastSuccessfulAt ? (
              <div>
                <dt className="text-muted-foreground">最后成功时间</dt>
                <dd className="mt-1 font-medium text-foreground">
                  <time dateTime={lastSuccessfulAt}>{formatTime(lastSuccessfulAt)}</time>
                </dd>
              </div>
            ) : null}
            {requestId ? (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">请求 ID</dt>
                <dd className="mt-1 font-mono text-foreground break-all">{requestId}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {primaryAction || secondaryAction ? (
          <div className="flex flex-col gap-3 pt-1 sm:flex-row">
            {primaryAction ? <Action action={primaryAction} variant="default" /> : null}
            {secondaryAction ? <Action action={secondaryAction} variant="outline" /> : null}
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export function ProblemDetailsView({
  headingLevel,
  primaryAction,
  problem,
  secondaryAction,
}: {
  headingLevel?: 1 | 2 | 3
  primaryAction?: ResultAction
  problem: ProblemDetails
  secondaryAction?: ResultAction
}) {
  return (
    <ResultState
      dataSource={problem.dataSource}
      description={problem.detail}
      headingLevel={headingLevel}
      lastSuccessfulAt={problem.lastSuccessfulAt}
      observedAt={problem.observedAt}
      primaryAction={primaryAction}
      retryable={problem.retryable}
      secondaryAction={secondaryAction}
      state={problem.status === 429 ? 'rate_limited' : 'error'}
      suggestedAction={problem.action}
      title={problem.title}
      traceId={problem.traceId}
    />
  )
}
