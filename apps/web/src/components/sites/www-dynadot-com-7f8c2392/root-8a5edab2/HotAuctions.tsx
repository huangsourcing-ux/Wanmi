"use client";

import { useRef } from "react";
import type { AuctionListing } from "@/types/dynadot";
import { cn } from "@/lib/utils";
import { PillButton } from "../shared/PillButton";
import {
  AlarmClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "../shared/icons";
import { HOT_AUCTIONS } from "./site-data";

/**
 * INTERACTION MODEL: click-driven carousel (Swiper on the source), not a
 * marquee. Measured: card 170x200, `border-radius: 20px`, `padding: 20px`,
 * white fill, 180px pitch (10px gap). Nav buttons 50x50, `border-radius: 999px`,
 * `background: rgba(255,255,255,.5)`, vertically centred on the track.
 * Section CTA "Visit Our Domain Auction" is 351x49, radius 60px.
 *
 * Two card variants share one layout:
 *   .not-ending-soon -> badge #0262C7, price #0262C7
 *   .ending-soon     -> badge #0072BC, price #AE1DF9
 */
function AuctionCard({ item }: { item: AuctionListing }) {
  const badgeColor = item.endingSoon ? "#0072BC" : "#0262C7";
  const priceColor = item.endingSoon ? "#AE1DF9" : "#0262C7";

  // Resting inset glow, tinted per variant — there is no hover lift on these
  // cards (they are not `.dyna-card-hoverable`).
  const glow = item.endingSoon
    ? "shadow-[inset_0_0_20px_0_rgba(244,171,255,0.5)]"
    : "shadow-[inset_0_0_20px_0_rgba(128,238,255,0.5)]";

  return (
    <a href="#" className="group block shrink-0">
      <div
        className={cn(
          "flex h-[200px] w-[170px] flex-col justify-between rounded-[20px] bg-white p-5",
          glow,
        )}
      >
        <div className="flex flex-col gap-3">
          <div
            className="flex w-fit items-center gap-[3.2px] text-xs font-medium"
            style={{ color: badgeColor }}
          >
            <AlarmClockIcon className="h-2.5 w-2.5" />
            {item.endsIn}
          </div>
          <div className="line-clamp-2 break-all text-base font-semibold leading-[18px] text-dyna-navy">
            {item.domain}
          </div>
        </div>

        <div className="flex flex-col gap-[6px]">
          <div className="flex flex-col">
            <div
              className="text-base font-semibold leading-6"
              style={{ color: priceColor }}
            >
              {item.price}
            </div>
            <div className="text-xs leading-[14px] text-dyna-navy opacity-50">
              {item.bids} Bids
            </div>
          </div>
          {/* Same `.transform-bg-btn` treatment as the section CTAs:
              130x30, radius 40px, padding 6px 12px, gradient slides on hover. */}
          <span className="dyna-cta-gradient flex h-[30px] w-full items-center justify-center overflow-hidden rounded-[40px] px-3 py-[6px] text-center text-xs text-white">
            Bid Now
          </span>
        </div>
      </div>
    </a>
  );
}

export function HotAuctions() {
  const track = useRef<HTMLDivElement>(null);
  /** One card pitch: 170px card + 10px gap */
  const scrollBy = (dir: -1 | 1) =>
    track.current?.scrollBy({ left: dir * 180 * 3, behavior: "smooth" });

  return (
    <section className="hot-auctions-section relative flex w-full flex-col items-center overflow-hidden bg-dyna-page bg-[radial-gradient(67.24%_100%_at_50%_100%,#ACE8FF_0%,rgba(172,232,255,0)_100%)]">
      {/* Decorative tiles, bottom corners, rotated +/-25deg */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-2 -left-3 hidden size-[199px] -rotate-[25deg] items-center justify-center rounded-2xl bg-white lg:flex"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-2 -right-4 hidden size-[199px] rotate-[25deg] items-center justify-center rounded-2xl bg-[#2DADFF] lg:flex"
      />

      <div className="flex w-full max-w-1440 flex-col items-center gap-2.5 overflow-hidden px-0 pb-14 pt-10">
        <h2 className="dyna-gradient-text bg-[linear-gradient(90deg,#031242_1.49%,#0A3D9A_41.64%,#2AABFF_100%)] text-center font-heading text-[32px] leading-[1.33] tracking-[-0.4px] md:text-[48px] md:leading-[63.84px]">
          Hot Auctions
        </h2>

        {/* Source rhythm from the section top: pt 40 · h2 64 · gap 30 ·
            track 200 · gap 30 · CTA 49 · pb 56 = 469. The flex `gap-2.5`
            supplies 10 of each 30px gap, so both blocks add 20 more. */}
        <div className="relative mt-5 w-full">
          <button
            type="button"
            aria-label="Previous auctions"
            onClick={() => scrollBy(-1)}
            className="absolute left-[120px] top-1/2 z-10 hidden size-[50px] -translate-y-1/2 items-center justify-center rounded-[999px] bg-white/50 text-dyna-navy backdrop-blur-sm transition-colors hover:bg-white xl:flex"
          >
            <ChevronLeftIcon />
          </button>
          <button
            type="button"
            aria-label="Next auctions"
            onClick={() => scrollBy(1)}
            className="absolute right-[120px] top-1/2 z-10 hidden size-[50px] -translate-y-1/2 items-center justify-center rounded-[999px] bg-white/50 text-dyna-navy backdrop-blur-sm transition-colors hover:bg-white xl:flex"
          >
            <ChevronRightIcon />
          </button>

          <div
            ref={track}
            className={cn(
              "flex gap-2.5 overflow-x-auto scroll-smooth px-6 xl:px-[182px]",
              "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            )}
          >
            {HOT_AUCTIONS.map((item) => (
              <AuctionCard key={item.domain} item={item} />
            ))}
          </div>
        </div>

        <div className="group mt-5">
          <PillButton>Visit Our Domain Auction</PillButton>
        </div>
      </div>
    </section>
  );
}
