import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'

export function PageIntro({
  badge = '功能骨架',
  children,
  description,
  title,
}: {
  badge?: string
  children?: ReactNode
  description: string
  title: string
}) {
  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
      <div className="max-w-3xl">
        <Badge className="mb-4" variant="secondary">
          {badge}
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
          {description}
        </p>
        {children}
      </div>
    </section>
  )
}
