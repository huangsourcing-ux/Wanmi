import { Badge } from '@/components/ui/badge'
import { RichTextContent } from '@/components/content/rich-text-content'
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
            <Badge key={category.id} variant="outline">
              {category.title}
            </Badge>
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
      {content.tags.length ? (
        <footer className="mt-10 flex flex-wrap gap-2 border-t pt-6">
          {content.tags.map((tag) => (
            <Badge key={tag.id} variant="secondary">
              #{tag.title}
            </Badge>
          ))}
        </footer>
      ) : null}
    </article>
  )
}
