import Link from 'next/link'
import { ArrowUpRightIcon } from 'lucide-react'

import type { SiteShellMenuPanel } from '@/components/site-shell/site-shell-data'

export function MegaMenuPanel({ panel }: { panel: SiteShellMenuPanel }) {
  return (
    <div
      aria-label={`${panel.label}导航`}
      className="overflow-hidden rounded-b-3xl border-x border-b border-white/10 bg-[#031242]/98 text-white shadow-[0_28px_70px_-24px_rgba(3,18,66,0.72)] backdrop-blur-xl"
      id={`site-shell-panel-${panel.id}`}
    >
      <div className="grid min-h-72 grid-cols-[minmax(14rem,0.8fr)_1.7fr]">
        <div className="border-r border-white/10 bg-white/[0.035] p-8">
          <p className="text-xs font-semibold tracking-[0.2em] text-[#63c2ff] uppercase">
            {panel.label}
          </p>
          <p className="mt-4 font-heading text-2xl leading-tight font-semibold">
            {panel.description}
          </p>
          <Link
            className="mt-8 inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-white transition-colors hover:border-white/40 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
            href={panel.groups[0]?.links[0]?.href ?? '/'}
          >
            打开首选入口
            <ArrowUpRightIcon aria-hidden="true" className="size-4" />
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-8 p-8">
          {panel.groups.map((group) => (
            <div key={group.label}>
              <p className="text-sm font-medium text-white/45">{group.label}</p>
              <ul className="mt-4 space-y-2">
                {group.links.map((link) => (
                  <li key={`${group.label}-${link.href}`}>
                    <Link
                      className="group flex items-start justify-between gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/8 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
                      href={link.href}
                    >
                      <span>
                        <span className="block text-sm font-medium text-white">{link.label}</span>
                        {link.description ? (
                          <span className="mt-1 block text-xs leading-5 text-white/50">
                            {link.description}
                          </span>
                        ) : null}
                      </span>
                      <ArrowUpRightIcon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-white/35 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-[#63c2ff]"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
