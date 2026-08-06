'use client'

import { CheckIcon, CopyIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type CopyState = 'copied' | 'failed' | 'idle'

export function CopyAction({
  ariaLabel,
  className,
  failureLabel = '复制失败',
  label,
  size = 'sm',
  successLabel = '已复制',
  text,
  variant = 'outline',
}: {
  ariaLabel?: string
  className?: string
  failureLabel?: string
  label: string
  size?: 'default' | 'sm' | 'xs'
  successLabel?: string
  text: string
  variant?: 'default' | 'ghost' | 'outline' | 'secondary'
}) {
  const [state, setState] = useState<CopyState>('idle')

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable')
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  const visibleLabel = state === 'copied' ? successLabel : state === 'failed' ? failureLabel : label

  return (
    <span className={cn('inline-flex', className)}>
      <Button
        aria-label={ariaLabel ?? label}
        data-copy-state={state}
        onClick={copy}
        size={size}
        type="button"
        variant={state === 'failed' ? 'destructive' : variant}
      >
        {state === 'copied' ? (
          <CheckIcon aria-hidden="true" data-icon="inline-start" />
        ) : state === 'failed' ? (
          <TriangleAlertIcon aria-hidden="true" data-icon="inline-start" />
        ) : (
          <CopyIcon aria-hidden="true" data-icon="inline-start" />
        )}
        <span>{visibleLabel}</span>
      </Button>
      <span aria-live="polite" className="sr-only" role="status">
        {state === 'copied' ? '剪贴板写入成功' : state === 'failed' ? '剪贴板写入失败' : ''}
      </span>
    </span>
  )
}
