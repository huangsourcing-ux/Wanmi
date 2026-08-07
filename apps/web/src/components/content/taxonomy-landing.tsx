import { PublicRelations } from '@/components/content/public-relations'
import type { PublicTaxonomyViewModel } from '@/services/content/read-taxonomy'

export function TaxonomyLanding({
  kind,
  taxonomy,
}: {
  kind: '分类' | '标签'
  taxonomy: PublicTaxonomyViewModel
}) {
  return (
    <div>
      <header className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
        <p className="text-sm font-medium text-primary">文章{kind}</p>
        <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
          {taxonomy.title}
        </h1>
        {taxonomy.description ? (
          <p className="mt-4 text-lg leading-8 text-muted-foreground">{taxonomy.description}</p>
        ) : null}
      </header>
      <PublicRelations
        sections={[{ items: taxonomy.articles, title: `该${kind}下的已发布文章` }]}
      />
    </div>
  )
}
