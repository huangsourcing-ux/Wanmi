import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRightIcon } from 'lucide-react'

import { PageIntro } from '@/components/site/page-intro'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LEGAL_DOCUMENTS } from '@/lib/legal-config'

export const metadata: Metadata = {
  description: 'Wanmi.net 隐私、使用条款、Cookie 和广告说明的开发期入口。',
  title: '帮助与合规',
}

export default function LegalPage() {
  return (
    <>
      <PageIntro
        badge="待专业复核"
        description="以下页面只固化当前批准的产品与安全边界，不是生产法律文本。正式版本将在真实服务开放前完成外部专业复核并公布生效信息。"
        title="帮助与合规"
      />
      <section className="mx-auto grid max-w-7xl gap-5 px-4 pb-16 sm:grid-cols-2 sm:px-6 lg:px-8">
        {LEGAL_DOCUMENTS.map((document) => (
          <Card key={document.slug}>
            <CardHeader>
              <CardTitle>{document.title}</CardTitle>
              <CardDescription className="leading-6">{document.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild className="px-0" size="sm" variant="link">
                <Link href={`/legal/${document.slug}`}>
                  查看说明
                  <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
    </>
  )
}
