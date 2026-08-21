'use client'

import { useState } from 'react'
import { SearchIcon } from '@/components/home/shared/icons'

const SEARCH_TABS = ['Register', 'Transfer', 'AI Search', 'Bulk Search'] as const

export function HeroSearch() {
  const [active, setActive] = useState(0)

  return (
    <div className="dyna-gradient-border dyna-search-card hero-search-box relative z-0 mt-10 inline-flex w-full scale-100 flex-col items-center justify-center gap-[14px] rounded-2xl bg-[rgba(130,195,255,0.2)] p-[14px] shadow-[inset_0_-4px_10px_0_rgba(255,255,255,0.5)] transition-transform duration-300 ease-out focus-within:z-50 focus-within:scale-105 md:mt-12 md:max-w-[652px] md:justify-start md:p-4 lg:max-w-[840px] lg:gap-4 lg:rounded-[20px] lg:px-5 lg:py-[18px]">
      <div
        aria-hidden="true"
        className="dyna-hero-breathe dyna-hero-glow pointer-events-none absolute left-1/2 top-[76px] h-[644px] w-[760px] max-w-none select-none md:top-[78px] md:w-[1181px] lg:w-[1476px]"
      />

      <div className="z-10 inline-flex w-full min-w-0 max-w-[315px] items-center justify-between md:max-w-none md:self-stretch">
        <div className="search-tabs relative grid w-full min-w-0 max-w-[315px] grid-cols-4 items-stretch overflow-hidden rounded-[9.6px] p-[3.2px] outline outline-1 -outline-offset-1 outline-white/30 md:w-auto md:max-w-[520px] lg:max-w-[600px]">
          <div
            aria-hidden="true"
            className="dyna-search-tab-indicator pointer-events-none absolute bottom-1 top-1 rounded-[10px] bg-[#031242] shadow-[0_0_10px_0_#FFF] transition-transform duration-300 ease-out"
            data-active-index={active}
          />
          {SEARCH_TABS.map((tab, index) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActive(index)}
              aria-pressed={active === index}
              className="relative z-10 flex min-h-[44px] min-w-0 cursor-pointer items-center justify-center whitespace-nowrap px-2 lg:min-w-[130px] lg:px-4"
            >
              <span className="w-full text-center text-sm font-medium leading-none text-white md:text-base lg:text-[18px] lg:leading-[18px]">
                {tab}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="relative w-full">
        <input
          type="text"
          placeholder="Find your next domain"
          aria-label="Find your next domain"
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
  )
}
