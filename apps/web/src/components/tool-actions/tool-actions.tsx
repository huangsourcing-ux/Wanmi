'use client'

import Link from 'next/link'
import { ArrowRightIcon } from 'lucide-react'

import { CopyAction } from '@/components/tool-actions/copy-action'
import { ShareLinkDialog } from '@/components/tool-actions/share-link-dialog'
import { Button } from '@/components/ui/button'
import { buildToolHref, normalizeDomainForClipboard } from '@/lib/tool-actions'
import { PUBLIC_TOOL_DEFINITIONS, type PublicToolSlug } from '@/lib/site-config'
import { cn } from '@/lib/utils'

export function ToolActions({
  className,
  currentTool,
  domainAscii,
  variant = 'panel',
}: {
  className?: string
  currentTool: PublicToolSlug
  domainAscii?: string
  variant?: 'compact' | 'panel'
}) {
  const normalizedCandidate = domainAscii ? normalizeDomainForClipboard(domainAscii) : undefined
  const normalizedDomain = normalizedCandidate?.includes('.') ? normalizedCandidate : undefined
  const destinations = PUBLIC_TOOL_DEFINITIONS.filter((tool) => tool.slug !== currentTool)

  return (
    <section
      aria-label={normalizedDomain ? `域名操作：${normalizedDomain}` : '相关工具与分享'}
      className={cn(
        variant === 'panel'
          ? 'mx-auto mb-6 w-[calc(100%-2rem)] max-w-7xl rounded-xl border border-dashed bg-card px-4 py-4 sm:w-[calc(100%-3rem)] sm:px-5 lg:w-[calc(100%-4rem)]'
          : 'border-t pt-4',
        className,
      )}
      data-tool-actions={currentTool}
    >
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h2
            className={cn(
              'font-heading font-semibold',
              variant === 'panel' ? 'text-lg' : 'text-sm',
            )}
          >
            {normalizedDomain ? '继续查询或分享此域名' : '前往其他工具或分享入口'}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {normalizedDomain
              ? '站内跳转和剪贴板固定使用 Punycode；分享默认不包含域名。'
              : '跨工具入口不携带查询结果；分享链接默认只包含当前工具路径。'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {normalizedDomain ? (
            <CopyAction
              ariaLabel={`复制域名 ${normalizedDomain}`}
              label="复制域名"
              text={normalizedDomain}
            />
          ) : null}
          <ShareLinkDialog domainAscii={normalizedDomain} tool={currentTool} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {destinations.map((tool) => (
          <Button asChild key={tool.slug} size="sm" variant="ghost">
            <Link href={buildToolHref(tool.slug, normalizedDomain)}>
              {tool.title}
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Link>
          </Button>
        ))}
      </div>
    </section>
  )
}
