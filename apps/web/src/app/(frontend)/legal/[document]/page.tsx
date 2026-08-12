import type { Metadata } from 'next'
import Link from 'next/link'
import { CheckCircle2Icon, CircleHelpIcon } from 'lucide-react'
import { notFound } from 'next/navigation'

import { PageIntro } from '@/components/site/page-intro'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LEGAL_DOCUMENTS, getLegalDocument } from '@/lib/legal-config'
import { createPageMetadata } from '@/lib/seo'

type LegalPageProps = {
  params: Promise<{ document: string }>
}

export function generateStaticParams() {
  return LEGAL_DOCUMENTS.map((document) => ({ document: document.slug }))
}

export async function generateMetadata({ params }: LegalPageProps): Promise<Metadata> {
  const { document: slug } = await params
  const document = getLegalDocument(slug)
  if (!document) return {}
  return createPageMetadata({
    description: document.description,
    path: `/legal/${document.slug}`,
    title: document.title,
  })
}

export default async function LegalDocumentPage({ params }: LegalPageProps) {
  const { document: slug } = await params
  const document = getLegalDocument(slug)
  if (!document) notFound()

  return (
    <>
      <PageIntro
        badge={document.reviewSections ? '审核骨架 · 未生效' : '开发期说明'}
        description={document.description}
        title={document.title}
      />
      <section className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <Card className="max-w-3xl">
          <CardHeader className="border-b">
            <CardTitle>{document.reviewSections ? '待确认结构' : '当前批准边界'}</CardTitle>
          </CardHeader>
          <CardContent>
            {document.reviewSections ? (
              <div className="space-y-8">
                {document.reviewSections.map((section) => (
                  <section key={section.title}>
                    <h2 className="font-semibold">{section.title}</h2>
                    <ul className="mt-3 space-y-3">
                      {section.items.map((item) => (
                        <li className="flex gap-3 text-sm leading-6" key={item}>
                          <CircleHelpIcon
                            aria-hidden="true"
                            className="mt-0.5 size-5 shrink-0 text-primary"
                          />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <ul className="space-y-4">
                {document.points.map((point) => (
                  <li className="flex gap-3 text-sm leading-6" key={point}>
                    <CheckCircle2Icon
                      aria-hidden="true"
                      className="mt-0.5 size-5 shrink-0 text-primary"
                    />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-6 rounded-lg border bg-muted/50 p-4 text-sm leading-6 text-muted-foreground">
              {document.reviewSections
                ? '本页仅为审核骨架。各节内容、适用范围、生效日期和对外表述均待负责人及外部法务确认，不构成承诺或已生效法律文本。'
                : '本页是开发期产品边界说明，不构成正式法律文本，也不表示生产服务已经开放。'}
            </p>
            <Button asChild className="mt-6" variant="outline">
              <Link href="/legal">返回合规入口</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
    </>
  )
}
