import Link from 'next/link'

import type { PublicRelatedItem } from '@/services/content/read-content'

export function PublicRelations({
  sections,
}: {
  sections: Array<{ items: PublicRelatedItem[]; title: string }>
}) {
  const visible = sections.filter((section) => section.items.length)
  if (!visible.length) return null

  return (
    <aside className="mx-auto w-full max-w-7xl space-y-8 px-4 py-10 sm:px-6 lg:px-8">
      {visible.map((section) => (
        <section key={section.title}>
          <h2 className="font-heading text-2xl font-semibold tracking-tight">{section.title}</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {section.items.map((item) => (
              <Link
                className="rounded-2xl border bg-card p-5 transition-colors hover:border-primary/50"
                href={item.href}
                key={item.id}
              >
                <h3 className="font-medium text-card-foreground">{item.title}</h3>
                {item.description ? (
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
                ) : null}
              </Link>
            ))}
          </div>
        </section>
      ))}
    </aside>
  )
}
