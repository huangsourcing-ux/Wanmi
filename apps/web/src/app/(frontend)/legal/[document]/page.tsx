import type { Metadata } from 'next'
import Link from 'next/link'
import { CheckCircle2Icon } from 'lucide-react'
import { notFound } from 'next/navigation'

import { PageIntro } from '@/components/site/page-intro'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LEGAL_DOCUMENTS, getLegalDocument } from '@/lib/legal-config'

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
  return { description: document.description, title: document.title }
}

export default async function LegalDocumentPage({ params }: LegalPageProps) {
  const { document: slug } = await params
  const document = getLegalDocument(slug)
  if (!document) notFound()

  return (
    <>
      <PageIntro badge="开发期说明" description={document.description} title={document.title} />
      <section className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <Card className="max-w-3xl">
          <CardHeader className="border-b">
            <CardTitle>当前批准边界</CardTitle>
          </CardHeader>
          <CardContent>
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
            <p className="mt-6 rounded-lg border bg-muted/50 p-4 text-sm leading-6 text-muted-foreground">
              本页是开发期产品边界说明，不构成正式法律文本，也不表示生产服务已经开放。
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
