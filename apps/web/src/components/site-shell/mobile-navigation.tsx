'use client'

import Link from 'next/link'
import { ArrowUpRightIcon, MenuIcon } from 'lucide-react'

import { BrandMark } from '@/components/site-shell/brand-mark'
import { SITE_SHELL_MENU_PANELS } from '@/components/site-shell/site-shell-data'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import type { SiteNavigationItem } from '@/lib/site-config'

export function MobileNavigation({ items }: { items: SiteNavigationItem[] }) {
  const seenHrefs = new Set(items.map((item) => item.href))
  const secondaryPanels = SITE_SHELL_MENU_PANELS.map((panel) => ({
    ...panel,
    links: panel.groups.flatMap((group) =>
      group.links.filter((link) => {
        if (seenHrefs.has(link.href)) return false
        seenHrefs.add(link.href)
        return true
      }),
    ),
  })).filter((panel) => panel.links.length > 0)

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          aria-label="打开导航"
          className="border-white/25 bg-white/10 text-white hover:bg-white/18 hover:text-white lg:hidden"
          size="icon-lg"
          variant="outline"
        >
          <MenuIcon aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent
        aria-label="移动端导航"
        className="w-[min(24rem,92vw)] overflow-y-auto border-white/10 bg-[#031242] text-white"
        side="right"
      >
        <SheetHeader className="border-b border-white/10 px-5 py-5 text-left">
          <SheetTitle className="text-white">
            <BrandMark />
          </SheetTitle>
          <SheetDescription className="text-white/55">域名工具、内容与账户入口</SheetDescription>
        </SheetHeader>

        <nav aria-label="移动端主导航" className="flex flex-col gap-7 px-5 pb-8">
          <div>
            <p className="mb-2 text-xs font-semibold tracking-[0.18em] text-[#63c2ff] uppercase">
              主要入口
            </p>
            <div className="flex flex-col">
              {items.map((item) => (
                <SheetClose asChild key={item.id}>
                  <Link
                    className="flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-base font-medium transition-colors hover:bg-white/8 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
                    href={item.href}
                  >
                    {item.label}
                    <ArrowUpRightIcon aria-hidden="true" className="size-4 text-white/40" />
                  </Link>
                </SheetClose>
              ))}
            </div>
          </div>

          {secondaryPanels.map((panel) => (
            <div key={panel.id}>
              <p className="mb-2 text-xs font-semibold tracking-[0.18em] text-white/40 uppercase">
                {panel.label}
              </p>
              <div className="grid grid-cols-2 gap-1">
                {panel.links.map((link) => (
                  <SheetClose asChild key={`${panel.id}-${link.href}`}>
                    <Link
                      className="rounded-xl px-3 py-2.5 text-sm text-white/80 transition-colors hover:bg-white/8 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
                      href={link.href}
                    >
                      {link.label}
                    </Link>
                  </SheetClose>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  )
}
