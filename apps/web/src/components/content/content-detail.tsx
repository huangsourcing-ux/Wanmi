import Link from 'next/link'
import { Suspense } from 'react'

import { AdvertisingSlot } from '@/components/advertising/advertising-slot'
import { Badge } from '@/components/ui/badge'
import { RichTextContent } from '@/components/content/rich-text-content'
import { PublicRelations } from '@/components/content/public-relations'
import type { ContentViewModel } from '@/services/content/read-content'

export function ContentDetail({
  content,
  preview = false,
}: {
  content: ContentViewModel
  preview?: boolean
}) {
  return (
    <article className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="border-b pb-8">
        <div className="mb-4 flex flex-wrap gap-2">
          {preview ? <Badge variant="secondary">预览 · {content.status}</Badge> : null}
          {content.categories.map((category) => (
            <Link
              href={`/articles/category/${encodeURIComponent(category.slug)}`}
              key={category.id}
            >
              <Badge variant="outline">{category.title}</Badge>
            </Link>
          ))}
        </div>
        <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
          {content.title}
        </h1>
        {content.summary ? (
          <p className="mt-4 text-lg leading-8 text-muted-foreground">{content.summary}</p>
        ) : null}
        <dl className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <div>
            <dt className="inline">来源：</dt>
            <dd className="inline">{content.source || '草稿未填写'}</dd>
          </div>
          <div>
            <dt className="inline">更新时间：</dt>
            <dd className="inline">{new Date(content.updatedAt).toLocaleString('zh-CN')}</dd>
          </div>
        </dl>
      </header>
      <RichTextContent content={content.content} media={content.media} />
      {!preview ? (
        <Suspense fallback={null}>
          <AdvertisingSlot
            className="my-10 w-full"
            pageType={content.collection === 'tldPages' ? 'tld' : 'content'}
            placementCode={content.collection === 'tldPages' ? 'tld-inline' : 'content-inline'}
          />
        </Suspense>
      ) : null}
      {content.tags.length ? (
        <footer className="mt-10 flex flex-wrap gap-2 border-t pt-6">
          {content.tags.map((tag) => (
            <Link href={`/articles/tag/${encodeURIComponent(tag.slug)}`} key={tag.id}>
              <Badge variant="secondary">#{tag.title}</Badge>
            </Link>
          ))}
        </footer>
      ) : null}
      {!preview ? (
        <PublicRelations
          sections={[
            { items: content.relatedTools, title: '相关工具' },
            { items: content.relatedTldPages, title: '相关 TLD 页面' },
            { items: content.relatedContent, title: '相关内容' },
          ]}
        />
      ) : null}
    </article>
  )
}
