import Link from 'next/link'

import { MobileNavigation } from '@/components/site/mobile-navigation'
import { Button } from '@/components/ui/button'
import type { SiteNavigationItem } from '@/lib/site-config'

export function SiteHeader({ items }: { items: SiteNavigationItem[] }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/85">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-8 px-4 sm:px-6 lg:px-8">
        <Link
          aria-label="Wanmi.net 首页"
          className="group flex shrink-0 items-center gap-2 rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          href="/"
        >
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-sm"
          >
            W
          </span>
          <span className="text-lg font-semibold tracking-tight">Wanmi.net</span>
        </Link>

        <nav aria-label="主导航" className="hidden min-w-0 flex-1 items-center gap-1 md:flex">
          {items.map((item) => (
            <Button asChild key={item.id} size="sm" variant="ghost">
              <Link href={item.href}>{item.label}</Link>
            </Button>
          ))}
        </nav>

        <div className="ml-auto md:hidden">
          <MobileNavigation items={items} />
        </div>
      </div>
    </header>
  )
}
