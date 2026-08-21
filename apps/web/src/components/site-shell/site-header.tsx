'use client'

import Link from 'next/link'
import { ChevronDownIcon, LayoutDashboardIcon } from 'lucide-react'
import { useState } from 'react'

import { BrandMark } from '@/components/site-shell/brand-mark'
import { MegaMenuPanel } from '@/components/site-shell/mega-menu-panel'
import { MobileNavigation } from '@/components/site-shell/mobile-navigation'
import {
  SITE_SHELL_ANNOUNCEMENT,
  SITE_SHELL_MENU_PANELS,
} from '@/components/site-shell/site-shell-data'
import { cn } from '@/lib/utils'
import type { SiteNavigationItem } from '@/lib/site-config'

export function SiteHeader({ items }: { items: SiteNavigationItem[] }) {
  const [openPanelId, setOpenPanelId] = useState<string | null>(null)
  const openPanel = SITE_SHELL_MENU_PANELS.find((panel) => panel.id === openPanelId) ?? null

  return (
    <header
      className="sticky top-0 z-40 text-white"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpenPanelId(null)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpenPanelId(null)
      }}
      onMouseLeave={() => setOpenPanelId(null)}
    >
      <div className="flex min-h-9 items-center justify-center bg-[#2749a8] px-10 py-2 text-center text-xs leading-5 text-white/85 sm:text-sm">
        {SITE_SHELL_ANNOUNCEMENT}
      </div>

      <div className="relative border-b border-white/10 bg-[#031242]/98 shadow-[0_12px_32px_-24px_rgba(3,18,66,0.8)] backdrop-blur-xl">
        <div className="mx-auto flex h-[4.5rem] max-w-[90rem] items-center gap-6 px-4 sm:px-6 lg:px-8 xl:gap-10">
          <Link
            aria-label="Wanmi.net 首页"
            className="shrink-0 rounded-xl text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
            href="/"
          >
            <BrandMark />
          </Link>

          <nav aria-label="主导航" className="hidden min-w-0 flex-1 items-center gap-1 lg:flex">
            {SITE_SHELL_MENU_PANELS.map((panel) => {
              const active = openPanelId === panel.id
              return (
                <button
                  aria-controls={`site-shell-panel-${panel.id}`}
                  aria-expanded={active}
                  aria-haspopup="true"
                  className={cn(
                    'inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-medium text-white/78 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none',
                    active && 'bg-white/12 text-white',
                  )}
                  key={panel.id}
                  onClick={() => setOpenPanelId(active ? null : panel.id)}
                  onMouseEnter={() => setOpenPanelId(panel.id)}
                  type="button"
                >
                  {panel.label}
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={cn('size-4 transition-transform', active && 'rotate-180')}
                  />
                </button>
              )
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Link
              className="hidden h-10 items-center gap-2 rounded-full border border-white/20 bg-white/8 px-4 text-sm font-medium text-white transition-colors hover:border-white/35 hover:bg-white/14 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none sm:inline-flex"
              href="/account/domains"
            >
              <LayoutDashboardIcon aria-hidden="true" className="size-4" />
              我的域名
            </Link>
            <MobileNavigation items={items} />
          </div>
        </div>

        <div
          className={cn(
            'pointer-events-none absolute top-full left-1/2 hidden w-[min(74rem,calc(100vw-4rem))] -translate-x-1/2 transition-[opacity,transform] duration-200 lg:block',
            openPanel
              ? 'pointer-events-auto translate-y-0 opacity-100'
              : '-translate-y-2 opacity-0',
          )}
        >
          {openPanel ? <MegaMenuPanel panel={openPanel} /> : null}
        </div>
      </div>
    </header>
  )
}
