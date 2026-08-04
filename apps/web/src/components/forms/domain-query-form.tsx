import { ArrowRightIcon, Globe2Icon } from 'lucide-react'

import { FormField } from '@/components/forms/form-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export function DomainQueryForm({
  className,
  defaultValue,
  description = '支持完整域名与关键词。本阶段只建立安全入口，不调用查询服务，也不保存输入。',
}: {
  className?: string
  defaultValue?: string
  description?: string
}) {
  return (
    <form action="/tools/domain-search" className={cn('w-full', className)} method="get">
      <FormField description={description} hideLabel id="domain-query" label="输入完整域名或关键词">
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
                placeholder="例如 wanmi.net 或品牌关键词"
                required
                spellCheck={false}
                type="text"
              />
            </div>
            <Button className="h-11 px-5" size="lg" type="submit">
              查询域名
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          </div>
        )}
      </FormField>
    </form>
  )
}
