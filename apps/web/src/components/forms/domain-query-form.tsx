'use client'

import { ArrowRightIcon, Globe2Icon } from 'lucide-react'
import type { FormEvent } from 'react'

import { FormField } from '@/components/forms/form-field'
import { useLocalToolLibrary } from '@/components/local-library/local-tool-library-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { reportToolSubmission } from '@/lib/tool-submission'
import { cn } from '@/lib/utils'

export function DomainQueryForm({
  action = '/tools/domain-search',
  buttonLabel = '查询域名',
  className,
  defaultValue,
  description = '支持完整域名与关键词。启用浏览器历史时，提交内容只保存在当前浏览器。',
  label = '输入完整域名或关键词',
  placeholder = '例如 wanmi.net 或品牌关键词',
  tool = 'domain-search',
}: {
  action?: string
  buttonLabel?: string
  className?: string
  defaultValue?: string
  description?: string
  label?: string
  placeholder?: string
  tool?: 'dns' | 'domain-search' | 'ssl-check' | 'whois'
}) {
  const { recordHistory } = useLocalToolLibrary()

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    reportToolSubmission(event.currentTarget, tool, recordHistory)
  }

  return (
    <form action={action} className={cn('w-full', className)} method="get" onSubmit={handleSubmit}>
      <FormField description={description} hideLabel id={`${tool}-query`} label={label}>
        {(controlProps) => (
          <div className="flex flex-col gap-3 rounded-xl border bg-background p-2 shadow-sm sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
              <Globe2Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
              <Input
                {...controlProps}
                autoCapitalize="none"
                autoComplete="off"
                className="h-11 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0 md:text-base"
                defaultValue={defaultValue}
                maxLength={253}
                name="q"
                placeholder={placeholder}
                required
                spellCheck={false}
                type="text"
              />
            </div>
            <Button className="h-11 px-5" size="lg" type="submit">
              {buttonLabel}
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          </div>
        )}
      </FormField>
    </form>
  )
}
