'use client'

import Link from 'next/link'
import { MenuIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
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
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button aria-label="打开导航" className="md:hidden" size="icon-lg" variant="outline">
          <MenuIcon aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent aria-label="移动端导航" className="w-[min(22rem,88vw)]" side="right">
        <SheetHeader className="border-b">
          <SheetTitle>Wanmi.net</SheetTitle>
          <SheetDescription>域名工具、实用内容与服务入口</SheetDescription>
        </SheetHeader>
        <nav aria-label="移动端主导航" className="flex flex-col px-3">
          {items.map((item) => (
            <SheetClose asChild key={item.id}>
              <Link
                className="rounded-lg px-3 py-3 text-base font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                href={item.href}
              >
                {item.label}
              </Link>
            </SheetClose>
          ))}
        </nav>
        <Separator />
        <div className="px-4 text-sm leading-6 text-muted-foreground">
          查询结果会标明数据来源和时间。注册与支付服务尚未开放。
        </div>
      </SheetContent>
    </Sheet>
  )
}
