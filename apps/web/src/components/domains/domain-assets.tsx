'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

import { ProblemDetailsView, ResultState } from '@/components/results/result-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { readProblemResponse } from '@/lib/errors'
import {
  domainAssetDetailResultSchema,
  domainAssetListResultSchema,
  nameserverChangeResultSchema,
  type DomainAssetDetailResult,
  type DomainAssetListResult,
} from '@/schemas/domains'

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

const statusLabel = {
  active: '正常',
  expired: '已到期',
  pending: '处理中',
  unknown: '待核对',
} as const

async function readAssetList(): Promise<DomainAssetListResult> {
  const response = await fetch('/api/v1/domains', {
    cache: 'no-store',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    return { problem: await readProblemResponse(response), state: 'error' }
  }
  return domainAssetListResultSchema.parse(await response.json())
}

async function readAssetDetail(assetId: string): Promise<DomainAssetDetailResult> {
  const response = await fetch(`/api/v1/domains/${encodeURIComponent(assetId)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  })
  if (!response.ok) {
    return { problem: await readProblemResponse(response), state: 'error' }
  }
  return domainAssetDetailResultSchema.parse(await response.json())
}

export function DomainAssetsPanel() {
  const [result, setResult] = useState<DomainAssetListResult>()

  const load = useCallback(async () => {
    setResult(undefined)
    setResult(await readAssetList())
  }, [])

  useEffect(() => {
    let active = true
    void readAssetList().then((next) => {
      if (active) setResult(next)
    })
    return () => {
      active = false
    }
  }, [])

  if (!result) {
    return <p aria-live="polite">正在读取域名资产…</p>
  }
  if (result.state === 'error' || result.state === 'rate_limited') {
    return (
      <ProblemDetailsView
        primaryAction={{ label: '重试', onClick: load }}
        problem={result.problem}
      />
    )
  }
  if (result.state === 'empty') {
    return (
      <ResultState
        description="注册成功并经上游查询确认后，域名会显示在这里。"
        primaryAction={{ href: '/pricing', label: '查看域名价格' }}
        state="empty"
        title="暂无域名资产"
      />
    )
  }
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {result.data.items.map((asset) => (
        <Card key={asset.id}>
          <CardHeader>
            <CardTitle className="break-all">{asset.domainAscii}</CardTitle>
            <Badge variant="secondary">{statusLabel[asset.status]}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p>
              到期时间：<time dateTime={asset.expiresAt}>{formatDate(asset.expiresAt)}</time>
            </p>
            <p className="text-muted-foreground">
              最后同步：<time dateTime={asset.lastSyncedAt}>{formatDate(asset.lastSyncedAt)}</time>
            </p>
            <Button asChild variant="outline">
              <Link href={`/account/domains/${asset.id}`}>查看详情与 Name Server</Link>
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export function DomainAssetDetailPanel({ assetId }: { assetId: string }) {
  const [result, setResult] = useState<DomainAssetDetailResult>()
  const [busy, setBusy] = useState(false)
  const [nameservers, setNameservers] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const next = await readAssetDetail(assetId)
    setResult(next)
    if ('data' in next) setNameservers(next.data.asset.nameservers.join('\n'))
  }, [assetId])

  useEffect(() => {
    let active = true
    void readAssetDetail(assetId).then((next) => {
      if (!active) return
      setResult(next)
      if ('data' in next) setNameservers(next.data.asset.nameservers.join('\n'))
    })
    return () => {
      active = false
    }
  }, [assetId])

  async function sync() {
    setBusy(true)
    setNotice('')
    try {
      const response = await fetch(`/api/v1/domains/${encodeURIComponent(assetId)}/sync`, {
        credentials: 'same-origin',
        method: 'POST',
      })
      if (!response.ok) {
        setResult({ problem: await readProblemResponse(response), state: 'error' })
        return
      }
      setResult(domainAssetDetailResultSchema.parse(await response.json()))
    } finally {
      setBusy(false)
    }
  }

  async function changeNameservers() {
    setBusy(true)
    setNotice('')
    try {
      const response = await fetch(`/api/v1/domains/${encodeURIComponent(assetId)}/nameservers`, {
        body: JSON.stringify({
          nameservers: nameservers
            .split(/\s+/u)
            .map((value) => value.trim())
            .filter(Boolean),
        }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) {
        const problem = await readProblemResponse(response)
        setNotice(`${problem.title}：${problem.detail}`)
        return
      }
      const queued = nameserverChangeResultSchema.parse(await response.json())
      if ('data' in queued) setNotice('Name Server 变更已进入 commerce 队列。')
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (!result) return <p aria-live="polite">正在读取域名详情…</p>
  if (result.state === 'error' || result.state === 'rate_limited') {
    return (
      <ProblemDetailsView
        primaryAction={{ label: '重试', onClick: load }}
        problem={result.problem}
      />
    )
  }
  const { asset } = result.data
  return (
    <div className="space-y-6">
      {result.state === 'degraded' || result.state === 'partial' ? (
        <ResultState
          dataSource={result.problem.dataSource}
          description={result.problem.detail}
          lastSuccessfulAt={result.meta?.lastSuccessfulAt}
          retryable={result.problem.retryable}
          state={result.state}
          suggestedAction={result.problem.action}
          title={result.problem.title}
          traceId={result.problem.traceId}
        />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="break-all">{asset.domainAscii}</CardTitle>
          <Badge variant="secondary">{statusLabel[asset.status]}</Badge>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <p>注册商：{asset.registrar}</p>
          <p>注册时间：{formatDate(asset.registeredAt)}</p>
          <p>到期时间：{formatDate(asset.expiresAt)}</p>
          <p>最后同步：{formatDate(asset.lastSyncedAt)}</p>
          <div className="sm:col-span-2">
            <Button disabled={busy} onClick={sync} type="button" variant="outline">
              {busy ? '处理中…' : '从上游同步资产事实'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Name Server 修改</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block text-sm font-medium" htmlFor="domain-nameservers">
            每行一个，至少两组
          </label>
          <textarea
            className="min-h-32 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
            id="domain-nameservers"
            onChange={(event) => setNameservers(event.target.value)}
            value={nameservers}
          />
          {notice ? <p aria-live="polite">{notice}</p> : null}
          <Button disabled={busy} onClick={changeNameservers} type="button">
            提交变更
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>变更与提醒记录</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <section>
            <h2 className="font-medium">Name Server 变更</h2>
            {result.data.nameserverChanges.length ? (
              <ul className="mt-3 space-y-3">
                {result.data.nameserverChanges.map((change) => (
                  <li className="rounded-md border p-3" key={change.id}>
                    <p>状态：{change.status}</p>
                    <p className="mt-1 font-mono text-xs break-all">
                      {change.previousNameservers.join(', ')} →{' '}
                      {change.requestedNameservers.join(', ')}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-muted-foreground">暂无变更记录。</p>
            )}
          </section>
          <section>
            <h2 className="font-medium">到期提醒</h2>
            {result.data.reminders.length ? (
              <ul className="mt-3 space-y-2">
                {result.data.reminders.map((reminder) => (
                  <li key={reminder.id}>
                    {reminder.channel === 'sms' ? '短信' : '站内'} · 提前 {reminder.thresholdDays}{' '}
                    天 · {reminder.status}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-muted-foreground">尚未进入提醒窗口。</p>
            )}
          </section>
        </CardContent>
      </Card>
    </div>
  )
}
