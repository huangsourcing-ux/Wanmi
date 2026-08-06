'use client'

import { LinkIcon, XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useState } from 'react'

import { CopyAction } from '@/components/tool-actions/copy-action'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { buildShareUrl } from '@/lib/tool-actions'
import type { PublicToolSlug } from '@/lib/site-config'

type ShareMode = 'domain' | 'tool'

export function ShareLinkDialog({
  domainAscii,
  tool,
  triggerLabel = '生成分享链接',
}: {
  domainAscii?: string
  tool: PublicToolSlug
  triggerLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ShareMode>('tool')
  const [generatedUrl, setGeneratedUrl] = useState('')
  const [generationFailed, setGenerationFailed] = useState(false)

  function reset() {
    setMode('tool')
    setGeneratedUrl('')
    setGenerationFailed(false)
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    reset()
  }

  function generate() {
    try {
      const url = buildShareUrl({
        domain: domainAscii,
        includeDomain: mode === 'domain',
        origin: window.location.origin,
        tool,
      })
      setGeneratedUrl(url)
      setGenerationFailed(false)
    } catch {
      setGeneratedUrl('')
      setGenerationFailed(true)
    }
  }

  return (
    <DialogPrimitive.Root onOpenChange={handleOpenChange} open={open}>
      <DialogPrimitive.Trigger asChild>
        <Button size="sm" type="button" variant="outline">
          <LinkIcon aria-hidden="true" data-icon="inline-start" />
          {triggerLabel}
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/20 backdrop-blur-xs data-[state=closed]:animate-out data-[state=open]:animate-in" />
        <DialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-xl focus:outline-none">
          <DialogPrimitive.Title className="font-heading text-lg font-semibold">
            生成分享链接
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm leading-6 text-muted-foreground">
            默认只分享工具入口，不包含当前查询结果。分享链接不会携带请求 ID、缓存键或其他内部标识。
          </DialogPrimitive.Description>

          <fieldset className="mt-5 space-y-3">
            <legend className="text-sm font-medium">选择分享内容</legend>
            <label className="flex cursor-pointer gap-3 rounded-lg border p-3 text-sm">
              <input
                checked={mode === 'tool'}
                className="mt-0.5 size-4"
                name={`share-mode-${tool}`}
                onChange={() => {
                  setMode('tool')
                  setGeneratedUrl('')
                }}
                type="radio"
                value="tool"
              />
              <span>
                <span className="block font-medium">仅分享工具入口</span>
                <span className="mt-1 block text-muted-foreground">链接不包含任何域名或结果。</span>
              </span>
            </label>
            {domainAscii ? (
              <label className="flex cursor-pointer gap-3 rounded-lg border p-3 text-sm">
                <input
                  checked={mode === 'domain'}
                  className="mt-0.5 size-4"
                  name={`share-mode-${tool}`}
                  onChange={() => {
                    setMode('domain')
                    setGeneratedUrl('')
                  }}
                  type="radio"
                  value="domain"
                />
                <span className="min-w-0">
                  <span className="block font-medium">包含当前域名</span>
                  <span className="mt-1 block font-mono text-xs break-all text-muted-foreground">
                    {domainAscii}
                  </span>
                </span>
              </label>
            ) : null}
          </fieldset>

          {mode === 'domain' ? (
            <Alert className="mt-4" role="note">
              <LinkIcon aria-hidden="true" />
              <AlertTitle>确认公开域名</AlertTitle>
              <AlertDescription>
                生成后，Punycode 域名会出现在链接的 q 参数中；查询结果内容仍不会写入链接。
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={generate} type="button">
              确认并生成链接
            </Button>
            <DialogPrimitive.Close asChild>
              <Button type="button" variant="ghost">
                取消
              </Button>
            </DialogPrimitive.Close>
          </div>

          {generatedUrl ? (
            <div className="mt-5 space-y-3 rounded-lg border bg-muted/40 p-3" data-share-result>
              <label className="text-sm font-medium" htmlFor={`share-url-${tool}`}>
                可分享链接
              </label>
              <Input id={`share-url-${tool}`} readOnly value={generatedUrl} />
              <CopyAction label="复制分享链接" text={generatedUrl} />
            </div>
          ) : null}
          {generationFailed ? (
            <p aria-live="polite" className="mt-4 text-sm text-destructive" role="status">
              无法生成分享链接，请稍后重试。
            </p>
          ) : null}

          <DialogPrimitive.Close asChild>
            <Button
              aria-label="关闭分享链接弹层"
              className="absolute top-3 right-3"
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" />
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
