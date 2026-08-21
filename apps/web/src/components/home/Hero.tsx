'use client'

import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useOverlay } from '@/components/home/shared/OverlayScrim'
import { SearchIcon } from '@/components/home/shared/icons'
import { SEARCH_TABS } from './site-data'

/**
 * INTERACTION MODEL: click-driven tabs. Scrolling changes nothing here.
 * The active indicator is a single absolutely-positioned pill that slides
 * between the four grid cells (bg-slate-950, radius 10px,
 * box-shadow 0 0 10px 0 rgba(255,255,255,.25)).
 *
 * `footer` is a slot under the search card, which the homepage fills with the
 * ad rail. Left unset, the hero renders exactly as measured on the source.
 */
export function Hero({ footer }: { footer?: ReactNode }) {
  const [active, setActive] = useState(0)
  /** Drives the 105% lift while the search field holds focus. */
  const [focused, setFocused] = useState(false)
  const { setActive: setScrim } = useOverlay()

  const onSearchFocus = (isFocused: boolean) => {
    setFocused(isFocused)
    setScrim(isFocused)
  }

  return (
    <section
      className={cn(
        'relative w-full overflow-hidden rounded-bl-[20px] rounded-br-[20px] bg-[linear-gradient(225deg,#000f3e_48.66%,#082ea8_100%)] pt-[96px] md:rounded-bl-[30px] md:rounded-br-[30px]',
        // The hero drops its z-10 while the search is focused. That dissolves
        // its stacking context so the card's z-50 can rise above the page
        // scrim at z-40 — keep this, or the card blurs with everything else.
        focused ? 'z-auto' : 'z-10',
      )}
    >
      {/* Content stack measured on the source, relative to the hero top:
          badge 156 · h1 235 · search box 349 (h 183) · hero bottom 672 */}
      <div
        className={cn(
          'relative flex flex-col items-center justify-center px-5 pb-20 text-center text-white md:px-0',
          // The source's 140px tail sits under a search card and nothing else.
          // With the ad rail filling that space the same tail reads as dead
          // plate, so a filled slot brings its own, shorter one.
          footer ? 'md:pb-8' : 'md:pb-[140px]',
          // This wrapper drops its z-10 on focus too. Both it AND the section
          // must go to z-auto — either one left at z-10 traps the card's z-50
          // inside a stacking context below the z-40 scrim, and the card blurs.
          focused ? 'z-auto' : 'z-10',
        )}
      >
        {/* Eyebrow pill: gradient border + gradient-filled label */}
        <div className="dyna-gradient-border dyna-eyebrow-border relative -mx-[6px] mt-10 inline-flex w-fit items-center justify-center rounded-[90px] bg-[linear-gradient(90deg,rgba(14,165,233,.2),rgba(232,121,249,.2),rgba(250,204,21,.2))] px-[30px] py-1.5 md:mt-[60px]">
          {/* 18px/27px — measured 345px wide on the source, which is what
              makes the pill 404.5x39 rather than the 16px default. */}
          <div className="dyna-gradient-text bg-[linear-gradient(90deg,#63C2FF_0%,#F098FF_50%,#FFF75F_100%)] text-center text-[18px] font-medium leading-[27px]">
            Your Super-Powered Domain Marketplace
          </div>
        </div>

        <h1 className="mt-10 font-heading text-[40px] leading-[1.1] tracking-[-0.72px] text-white md:text-[60px] md:leading-[66px]">
          Empower Your{' '}
          <span className="dyna-gradient-text inline-block bg-[linear-gradient(90deg,#63C2FF_0%,#F098FF_50%,#FFF75F_100%)] capitalize">
            Domains
          </span>
        </h1>

        {/* Glass card wrapping the tabs + input (`box-gradient-border` on the
            source): 840x183, radius 20px, fill rgba(130,195,255,.2), gap 16px,
            padding 18px 20px, inset white top-light, hairline gradient edge.

            INTERACTION: focusing the input scales the whole card to 105% and
            lifts it to z-50 (840x183 -> 882x193), reverting on blur.
            transition: transform 0.3s cubic-bezier(0, 0, 0.2, 1). */}
        <div
          className={cn(
            'dyna-gradient-border dyna-search-card hero-search-box relative mt-10 inline-flex w-full flex-col items-center justify-center gap-[14px] rounded-2xl bg-[rgba(130,195,255,0.2)] p-[14px] shadow-[inset_0_-4px_10px_0_rgba(255,255,255,0.5)] transition-transform duration-300 ease-out md:mt-12 md:max-w-[652px] md:justify-start md:p-4 lg:max-w-[840px] lg:gap-4 lg:rounded-[20px] lg:px-5 lg:py-[18px]',
            focused ? 'z-50 scale-105' : 'scale-100',
          )}
        >
          {/* Glow plate. On the source this lives inside the search box, at
              top 78px, centred on both axes — it reads as a horizontal bloom
              behind the input. Hero `overflow-hidden` clips the overhang. */}
          <div
            aria-hidden="true"
            className="dyna-hero-breathe dyna-hero-glow pointer-events-none absolute left-1/2 top-[76px] h-[644px] w-[760px] max-w-none bg-cover bg-center bg-no-repeat md:top-[78px] md:w-[1181px] lg:w-[1476px]"
          />

          {/* Tab row — self-stretch inside the card at md+, so the group is
              left-aligned against the card padding rather than centred. */}
          <div className="z-10 inline-flex w-full min-w-0 max-w-[315px] items-center justify-between md:max-w-none md:self-stretch">
            <div className="search-tabs relative grid w-full min-w-0 max-w-[315px] grid-cols-4 items-stretch overflow-hidden rounded-[9.6px] p-[3.2px] outline outline-1 -outline-offset-1 outline-white/30 md:w-auto md:max-w-[520px] lg:max-w-[600px]">
              {/* Sliding active pill */}
              <div
                aria-hidden="true"
                className="dyna-search-tab-indicator pointer-events-none absolute bottom-1 top-1 rounded-[10px] bg-[#031242] shadow-[0_0_10px_0_#FFF] transition-transform duration-300 ease-out"
                data-active-index={active}
              />
              {SEARCH_TABS.map((tab, i) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActive(i)}
                  aria-pressed={active === i}
                  className={cn(
                    // 130px cells on the source (4 x 130 + 6.4 padding = 526.4)
                    'relative z-10 flex min-h-[44px] min-w-0 cursor-pointer items-center justify-center whitespace-nowrap px-2 lg:min-w-[130px] lg:px-4',
                  )}
                >
                  <span className="w-full text-center text-sm font-medium leading-none text-white md:text-base lg:text-[18px] lg:leading-[18px]">
                    {tab}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Search field — the card's 16px gap supplies the spacing */}
          <div className="relative w-full">
            <input
              type="text"
              placeholder="Find your next domain"
              aria-label="Find your next domain"
              onFocus={() => onSearchFocus(true)}
              onBlur={() => onSearchFocus(false)}
              className="h-[64px] w-full rounded-[50px] bg-dyna-input px-9 py-2 text-lg text-white placeholder:text-white/60 shadow-[inset_0_-4px_15px_0_rgba(22,138,255,0.3),inset_0_4px_15px_0_rgba(22,138,255,0.3)] outline-none md:h-[80px] md:text-2xl md:leading-[28.8px]"
            />
            <button
              type="button"
              aria-label="Search domains"
              className="group absolute right-2 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10 md:h-16 md:w-16"
            >
              <SearchIcon className="h-6 w-6 transition-transform group-hover:scale-110" />
            </button>
          </div>
        </div>

        {footer}
      </div>
    </section>
  )
}
