import Link from 'next/link'
import { ArrowRightIcon, CircleDashedIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function ConstructionNotice({
  description,
  query,
}: {
  description: string
  query?: string
}) {
  return (
    <Card className="mx-auto mb-16 w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]">
      <CardHeader>
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <CircleDashedIcon aria-hidden="true" className="size-5" />
        </div>
        <CardTitle>查询能力正在建设中</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {query ? (
          <p className="rounded-lg border bg-muted/50 p-4 text-sm leading-6">
            已收到查询：<code className="font-semibold break-all">{query}</code>
          </p>
        ) : null}
        <p className="text-sm leading-6 text-muted-foreground">
          当前页面不会调用查询
          provider，也不会保存本次输入。后续结果会逐项显示状态、数据来源、查询时间和可理解的失败原因。
        </p>
        <Button asChild variant="outline">
          <Link href="/tools">
            返回工具中心
            <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
