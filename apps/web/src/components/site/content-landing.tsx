import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ResultState } from '@/components/results/result-state'
import type { PublicContentSection } from '@/lib/public-site-data'

export function ContentLanding({
  emptyDescription,
  section,
}: {
  emptyDescription: string
  section: PublicContentSection
}) {
  return (
    <section className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-center justify-between gap-4">
            <CardTitle>{section.title}</CardTitle>
            <Badge variant="secondary">
              {section.status === 'ready'
                ? `${section.items.length} 条已发布`
                : section.status === 'empty'
                  ? '暂无已发布内容'
                  : '数据暂时不可用'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {section.status === 'ready' ? (
            <ul className="divide-y">
              {section.items.map((item) => (
                <li className="py-5 first:pt-0 last:pb-0" key={item.id}>
                  <h2 className="text-base font-medium">{item.title}</h2>
                  {item.summary ? (
                    <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                      {item.summary}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <ResultState
              compact
              description={emptyDescription}
              retryable={section.status === 'unavailable' ? true : undefined}
              state={section.status === 'unavailable' ? 'degraded' : 'empty'}
              suggestedAction={
                section.status === 'unavailable'
                  ? '请稍后重试。工具与帮助入口不依赖这组内容，仍可继续使用。'
                  : '可以先使用工具或帮助入口，稍后再查看已发布内容。'
              }
              title={section.status === 'unavailable' ? '内容数据暂时不可用' : '暂无已发布内容'}
            />
          )}
        </CardContent>
      </Card>
    </section>
  )
}
