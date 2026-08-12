import Link from 'next/link'
import { ArrowRightIcon } from 'lucide-react'

import { PageIntro } from '@/components/site/page-intro'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LEGAL_DOCUMENTS } from '@/lib/legal-config'
import { createStaticPageMetadata } from '@/lib/seo'

export const metadata = createStaticPageMetadata('/legal')

export default function LegalPage() {
  return (
    <>
      <PageIntro
        badge="待专业复核"
        description="以下页面包含当前批准边界与待审核骨架，不是生产法律文本。实名说明和支付说明中的全部条目均待负责人及外部法务确认。"
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
