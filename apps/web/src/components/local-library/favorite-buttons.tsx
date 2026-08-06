'use client'

import { StarIcon } from 'lucide-react'
import { useState } from 'react'

import { useLocalToolLibrary } from '@/components/local-library/local-tool-library-provider'
import { Button } from '@/components/ui/button'
import { normalizeDomain } from '@/lib/domain-name'
import type { FavoriteToolSlug } from '@/lib/local-tool-library'
import { cn } from '@/lib/utils'

function resultMessage(ok: boolean, added: boolean, subject: string): string {
  if (!ok) return `无法保存${subject}，请检查浏览器本地存储设置`
  return added ? `已收藏${subject}` : `已取消收藏${subject}`
}

export function ToolFavoriteButton({
  className,
  label,
  tool,
}: {
  className?: string
  label: string
  tool: FavoriteToolSlug
}) {
  const { loaded, snapshot, toggleTool } = useLocalToolLibrary()
  const [feedback, setFeedback] = useState('')
  const favorite = snapshot.favorites.some((item) => item.kind === 'tool' && item.tool === tool)

  function handleToggle() {
    const result = toggleTool(tool)
    setFeedback(resultMessage(result.ok, result.changed === 'added', `工具“${label}”`))
  }

  return (
    <div className={cn('inline-flex items-center', className)}>
      <Button
        aria-label={favorite ? `取消收藏工具：${label}` : `收藏工具：${label}`}
        aria-pressed={favorite}
        disabled={!loaded}
        onClick={handleToggle}
        size="sm"
        type="button"
        variant={favorite ? 'secondary' : 'outline'}
      >
        <StarIcon aria-hidden="true" className={favorite ? 'fill-current' : undefined} />
        {favorite ? '已收藏' : '收藏工具'}
      </Button>
      <span aria-live="polite" className="sr-only" role="status">
        {feedback}
      </span>
    </div>
  )
}

export function DomainFavoriteButton({
  className,
  domain,
  label,
}: {
  className?: string
  domain: string
  label?: string
}) {
  const { loaded, snapshot, toggleDomain } = useLocalToolLibrary()
  const [feedback, setFeedback] = useState('')
  const normalized = normalizeDomain(domain)
  const domainAscii = normalized.ok ? normalized.value.ascii : domain.toLocaleLowerCase('en-US')
  const favorite = snapshot.favorites.some(
    (item) => item.kind === 'domain' && item.domainAscii === domainAscii,
  )

  function handleToggle() {
    const result = toggleDomain(domain)
    setFeedback(resultMessage(result.ok, result.changed === 'added', `域名“${label ?? domain}”`))
  }

  return (
    <div className={cn('inline-flex items-center', className)}>
      <Button
        aria-label={favorite ? `取消收藏域名：${label ?? domain}` : `收藏域名：${label ?? domain}`}
        aria-pressed={favorite}
        disabled={!loaded}
        onClick={handleToggle}
        size="sm"
        type="button"
        variant={favorite ? 'secondary' : 'outline'}
      >
        <StarIcon aria-hidden="true" className={favorite ? 'fill-current' : undefined} />
        {favorite ? '已收藏' : '收藏域名'}
      </Button>
      <span aria-live="polite" className="sr-only" role="status">
        {feedback}
      </span>
    </div>
  )
}
