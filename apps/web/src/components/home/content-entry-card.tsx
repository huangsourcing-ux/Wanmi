import Link from 'next/link'
import { ArrowRightIcon } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import type { PublicContentSection } from '@/lib/public-site-data'

const fallbackCopy: Record<PublicContentSection['href'], string> = {
  '/articles': '内容将围绕域名选择、注册规则、DNS、WHOIS、SSL 与建站逐步发布。',
  '/pricing': '已通过上游能力和价格验证的后缀才会展示价格与购买入口。',
  '/topics': '专题将把工具、TLD 页面和实用指南串联成可执行的工作流。',
}

export function ContentEntryCard({ section }: { section: PublicContentSection }) {
  const isUnavailable = section.status === 'unavailable'

  return (
    <Card className="h-full">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{section.title}</CardTitle>
          <Badge variant={isUnavailable ? 'outline' : 'secondary'}>
            {section.status === 'ready'
              ? '已发布'
              : section.status === 'empty'
                ? '持续更新'
                : '暂时不可用'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        {section.status === 'ready' ? (
          <ul className="space-y-4">
            {section.items.map((item) => (
              <li className="border-b pb-4 last:border-0 last:pb-0" key={item.id}>
                <p className="font-medium leading-6">{item.title}</p>
                {item.summary ? (
                  <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
                    {item.summary}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-3 text-sm leading-6 text-muted-foreground">
            <p>{fallbackCopy[section.href]}</p>
            {isUnavailable ? <p>最新条目暂时无法加载，主要查询入口仍可正常使用。</p> : null}
          </div>
        )}
      </CardContent>
      <CardFooter>
        <Button asChild size="sm" variant="link">
          <Link href={section.href}>
            进入{section.title}
            <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  )
}
