'use client'

import {
  AlertTriangleIcon,
  ArrowRightIcon,
  Clock3Icon,
  FolderHeartIcon,
  Trash2Icon,
} from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'

import { DomainFavoriteButton } from '@/components/local-library/favorite-buttons'
import { useLocalToolLibrary } from '@/components/local-library/local-tool-library-provider'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { normalizeDomain } from '@/lib/domain-name'
import {
  getFavoriteDomainDisplay,
  getFavoriteHref,
  getHistoryHref,
  type FavoriteToolSlug,
  type LocalFavoriteItem,
  type LocalHistoryItem,
  type QueryToolSlug,
} from '@/lib/local-tool-library'

const toolLabels: Record<FavoriteToolSlug, string> = {
  dns: 'DNS / NS 查询',
  'domain-search': '域名可注册查询',
  idn: 'IDN / Punycode',
  pricing: 'TLD 价格与成本',
  'ssl-check': 'SSL / CAA 检查',
  whois: 'WHOIS / RDAP',
}

const queryToolLabels = toolLabels satisfies Record<QueryToolSlug, string>

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatUpdatedAt(value: number): string {
  return dateFormatter.format(new Date(value))
}

function HistoryDisplay({ item }: { item: LocalHistoryItem }) {
  const normalized = normalizeDomain(item.query)
  if (!normalized.ok || normalized.value.ascii === normalized.value.unicode) {
    return <span className="break-all font-medium">{item.query}</span>
  }
  return (
    <span className="min-w-0">
      <span className="block break-all font-medium">{normalized.value.unicode}</span>
      <span className="block break-all font-mono text-xs text-muted-foreground">
        {normalized.value.ascii}
      </span>
    </span>
  )
}

function FavoriteDisplay({ item }: { item: LocalFavoriteItem }) {
  if (item.kind === 'tool') return <span className="font-medium">{toolLabels[item.tool]}</span>
  const display = getFavoriteDomainDisplay(item)
  return (
    <span className="min-w-0">
      <span className="block break-all font-medium">{display.primary}</span>
      {display.secondary ? (
        <span className="block break-all font-mono text-xs text-muted-foreground">
          {display.secondary}
        </span>
      ) : null}
    </span>
  )
}

export function LocalToolLibraryPanel() {
  const {
    clearAll,
    clearFavorites,
    clearHistory,
    deleteFavorite,
    deleteHistory,
    loaded,
    recordHistory,
    snapshot,
  } = useLocalToolLibrary()
  const [feedback, setFeedback] = useState('')

  function setMutationFeedback(ok: boolean, success: string) {
    setFeedback(ok ? success : '操作失败：浏览器本地存储当前不可用')
  }

  if (!loaded) {
    return (
      <section
        aria-busy="true"
        aria-label="本地历史与收藏"
        className="mx-auto max-w-7xl px-4 pb-8 sm:px-6 lg:px-8"
      >
        <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground" role="status">
          正在读取浏览器本地历史与收藏…
        </div>
      </section>
    )
  }

  const hasItems = snapshot.history.length > 0 || snapshot.favorites.length > 0

  return (
    <section
      aria-labelledby="local-library-title"
      className="mx-auto max-w-7xl space-y-5 px-4 pb-10 sm:px-6 lg:px-8"
      data-local-library="ready"
    >
      <div className="flex flex-col gap-4 rounded-xl border bg-accent/30 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FolderHeartIcon aria-hidden="true" className="size-5 text-primary" />
            <h2 className="font-heading text-2xl font-semibold" id="local-library-title">
              我的本地工具箱
            </h2>
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            历史和收藏各保留最多 30 条、90
            天，只存在当前浏览器；收藏不锁定域名状态、价格或可注册性。
          </p>
        </div>
        <Button
          disabled={!hasItems}
          onClick={() => {
            const result = clearAll()
            setMutationFeedback(result.ok, '已清空全部本地历史与收藏')
          }}
          type="button"
          variant="destructive"
        >
          <Trash2Icon aria-hidden="true" />
          清空全部本地数据
        </Button>
      </div>

      {!snapshot.available ? (
        <Alert variant="destructive">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>本地存储不可用</AlertTitle>
          <AlertDescription>
            浏览器可能禁用了本地存储或空间不足。查询工具仍可使用，但历史和收藏可能无法保存。
          </AlertDescription>
        </Alert>
      ) : null}
      {!snapshot.historyRecordingEnabled ? (
        <Alert>
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>已尊重 DNT / GPC 隐私信号</AlertTitle>
          <AlertDescription>
            自动查询历史已关闭；已有历史仍可查看或删除，您主动选择的收藏仍只保存在本机。
          </AlertDescription>
        </Alert>
      ) : null}
      {snapshot.recovered ? (
        <Alert>
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>已修复本地数据</AlertTitle>
          <AlertDescription>
            损坏、过期或超出上限的记录已安全清理，页面未读取无效内容。
          </AlertDescription>
        </Alert>
      ) : null}

      <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground" role="status">
        {feedback}
      </p>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock3Icon aria-hidden="true" className="size-4 text-primary" />
                最近查询
                <Badge variant="outline">{snapshot.history.length}/30</Badge>
              </CardTitle>
            </div>
            <Button
              disabled={snapshot.history.length === 0}
              onClick={() => {
                const result = clearHistory()
                setMutationFeedback(result.ok, '已清空全部查询历史')
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              清空历史
            </Button>
          </CardHeader>
          <CardContent>
            {snapshot.history.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                暂无本地查询历史。只有您主动提交的查询会记录在这里。
              </p>
            ) : (
              <ul className="divide-y" data-local-history-list>
                {snapshot.history.map((item) => {
                  const normalized = normalizeDomain(item.query)
                  return (
                    <li
                      className="space-y-3 py-4 first:pt-0 last:pb-0"
                      key={`${item.tool}:${item.query}`}
                    >
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <HistoryDisplay item={item} />
                        <Badge className="shrink-0" variant="outline">
                          {queryToolLabels[item.tool]}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        最近使用：
                        <time dateTime={new Date(item.updatedAt).toISOString()}>
                          {formatUpdatedAt(item.updatedAt)}
                        </time>
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button asChild size="sm">
                          <Link
                            href={getHistoryHref(item)}
                            onClick={() => {
                              recordHistory({ query: item.query, tool: item.tool })
                            }}
                          >
                            再次查询
                            <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
                          </Link>
                        </Button>
                        {normalized.ok ? (
                          <DomainFavoriteButton
                            domain={normalized.value.ascii}
                            label={normalized.value.unicode}
                          />
                        ) : null}
                        <Button
                          aria-label={`删除查询历史：${item.query}`}
                          onClick={() => {
                            const result = deleteHistory(item)
                            setMutationFeedback(result.ok, `已删除查询历史“${item.query}”`)
                          }}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2Icon aria-hidden="true" />
                          删除
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <FolderHeartIcon aria-hidden="true" className="size-4 text-primary" />
              我的收藏
              <Badge variant="outline">{snapshot.favorites.length}/30</Badge>
            </CardTitle>
            <Button
              disabled={snapshot.favorites.length === 0}
              onClick={() => {
                const result = clearFavorites()
                setMutationFeedback(result.ok, '已清空全部收藏')
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              清空收藏
            </Button>
          </CardHeader>
          <CardContent>
            {snapshot.favorites.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                暂无收藏。可从工具卡或域名结果旁的收藏按钮添加。
              </p>
            ) : (
              <ul className="divide-y" data-local-favorites-list>
                {snapshot.favorites.map((item) => (
                  <li
                    className="flex items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
                    key={item.kind === 'tool' ? `tool:${item.tool}` : `domain:${item.domainAscii}`}
                  >
                    <div className="min-w-0">
                      <FavoriteDisplay item={item} />
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {item.kind === 'tool' ? '工具入口' : '域名收藏'} ·{' '}
                        {formatUpdatedAt(item.updatedAt)}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button asChild size="sm" variant="outline">
                        <Link href={getFavoriteHref(item)}>打开</Link>
                      </Button>
                      <Button
                        aria-label={`删除收藏：${item.kind === 'tool' ? toolLabels[item.tool] : item.domainAscii}`}
                        onClick={() => {
                          const result = deleteFavorite(item)
                          setMutationFeedback(
                            result.ok,
                            `已删除收藏“${item.kind === 'tool' ? toolLabels[item.tool] : item.domainAscii}”`,
                          )
                        }}
                        size="icon-sm"
                        title="删除收藏"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
