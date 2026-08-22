"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { PillButton } from "../shared/PillButton";
import { AngleRightIcon } from "../shared/icons";
import { BENTO_CARDS } from "./site-data";

/**
 * INTERACTION MODEL: hover-driven horizontal accordion (xl and up).
 *
 * Measured on the source: four portrait cards, `h-[500px] xl:h-[650px]`,
 * `rounded-2xl` (20px at xl), `padding: 32px 0` (48px at xl), each on its own
 * radial gradient fading to white. The hovered card is `w-[450px]`, the other
 * three collapse to `w-[225px]`, animated with
 * `transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1)`.
 * Track total: 450 + 3x225 + 3x20 gap = 1185px.
 *
 * The two states also swap the card's internal order:
 *   expanded  -> image block on top (h-72), copy block beneath
 *   collapsed -> title on top (w-44), image beneath at 70% opacity
 * A single DOM order (title, image, copy) produces both by hiding the title
 * when expanded and the copy block when collapsed.
 *
 * Hover does not reset: the last hovered card stays open, matching the source.
 * Below xl every card renders in its expanded arrangement.
 */
export function BuildOnDomains() {
  const [active, setActive] = useState(0);

  return (
    <section className="flex w-full items-center justify-center bg-dyna-page">
      <div className="flex w-full max-w-1440 flex-col items-center gap-12 px-7 py-20 md:px-14 md:py-[90px] lg:gap-[60px] lg:p-[120px]">
        {/* Heading block is left-aligned on the source, not centred */}
        <div className="flex flex-col items-start justify-start gap-5 self-stretch">
          <h2 className="font-heading text-[32px] leading-[1.2] tracking-[-0.4px] text-dyna-navy md:text-[48px] md:leading-[52.8px]">
            Build on Your Domain Names
          </h2>
          <p className="text-base leading-[26px] text-dyna-navy/80 md:text-lg">
            Get everything you need to develop on your domain name. Brand,
            launch, and grow online.
          </p>
        </div>

        <div className="inline-flex w-full flex-col items-center justify-center gap-10 md:grid md:grid-cols-2 md:gap-5 xl:inline-flex xl:w-[1185px] xl:flex-row xl:gap-5">
          {BENTO_CARDS.map((card, i) => {
            const isActive = i === active;
            return (
              <div
                key={card.title}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                tabIndex={0}
                aria-expanded={isActive}
                className={cn(
                  "inline-flex h-[500px] w-full flex-col items-center justify-between overflow-hidden rounded-2xl py-8 transition-[width] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] xl:h-[650px] xl:rounded-[20px] xl:py-12",
                  isActive ? "xl:w-[450px]" : "xl:w-[225px]",
                )}
                style={{ backgroundImage: card.gradient }}
              >
                {/* Collapsed title — xl only, and only while collapsed */}
                <div
                  className={cn(
                    "hidden w-44 justify-start font-heading text-3xl font-bold leading-9",
                    !isActive && "xl:block",
                    card.titleOnDark ? "text-white" : "text-slate-950",
                  )}
                >
                  {card.title}
                </div>

                <div
                  className={cn(
                    // shrink-0 keeps the plate at its measured 288px; without
                    // it the copy block squeezes the image to ~240px.
                    "relative h-72 w-full shrink-0",
                    !isActive && "xl:h-60 xl:opacity-70",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={card.image}
                    alt={card.alt}
                    className="h-full w-full select-none object-contain"
                  />
                </div>

                {/* Copy block — hidden while collapsed at xl */}
                <div
                  className={cn(
                    "flex w-full flex-col items-start justify-start gap-2.5 px-4 md:px-8 xl:w-[450px]",
                    !isActive && "xl:hidden",
                  )}
                >
                  <h3 className="font-heading text-[26px] font-bold leading-[1.33] text-dyna-navy xl:text-[32px] xl:leading-[42.56px]">
                    {card.title}
                  </h3>
                  <p className="text-[15px] leading-[24px] text-dyna-navy/80">
                    {card.body}
                  </p>
                  <a
                    href="#"
                    className="mt-1 inline-flex items-center gap-2 text-base font-medium leading-[21.28px] text-[#0096F7] transition-[color,gap] duration-300 hover:gap-[2px] hover:text-[#006EF5]"
                  >
                    {card.cta}
                    <AngleRightIcon className="h-3.5 w-3.5 shrink-0" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>

        <div className="group max-w-[290px] md:max-w-none">
          <PillButton>Discover Our Domain Tools Arsenal</PillButton>
        </div>
      </div>
    </section>
  );
}
