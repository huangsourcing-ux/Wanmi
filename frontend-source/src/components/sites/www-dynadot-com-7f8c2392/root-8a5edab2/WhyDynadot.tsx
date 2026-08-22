import { cn } from "@/lib/utils";
import { PillButton } from "../shared/PillButton";
import { ASSETS, WHY_BLOCKS } from "./site-data";

/**
 * Asymmetric 2x2 card bento on `bg-indigo-50`. Measured on the source: cards
 * are 570px tall with 40px padding; each row pairs a 505px card with a 650px
 * card and the widths swap between rows (505+650+45 gap = 1200 = 1440 - 240).
 * Two decorative SVG accents float over the section.
 */
export function WhyDynadot() {
  return (
    <div className="relative inline-flex w-full items-start justify-center overflow-hidden bg-dyna-indigo-50 px-[30px] py-20 md:px-[58px] md:py-[90px] lg:p-[120px]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${ASSETS}/images/why-dynadot-pointer-star.svg`}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute right-[6%] top-[12%] hidden h-[72px] w-[72px] select-none lg:block"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${ASSETS}/images/why-dynadot-pointer-arrow.svg`}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute left-[7%] top-[54%] hidden h-[28px] w-[28px] select-none lg:block"
      />

      <div className="flex w-full max-w-1440 flex-col items-center gap-10 lg:gap-[45px]">
        <div className="flex max-w-[820px] flex-col items-center gap-5 text-center">
          <h2 className="font-heading text-[32px] leading-[1.33] tracking-[-0.4px] text-dyna-navy md:text-[48px] md:leading-[63.84px]">
            Why Buy Domains with Dynadot
          </h2>
          <p className="text-base leading-[26px] text-dyna-navy/80 md:text-lg">
            Buy and manage your domain names with a platform built on
            affordability, reliability, transparency, and expert support.
          </p>
        </div>

        <div className="grid w-full grid-cols-1 gap-[45px] lg:grid-cols-[505fr_650fr]">
          {WHY_BLOCKS.map((block, i) => (
            <div
              key={block.title}
              className={cn(
                "card-shadow inline-flex w-full flex-col items-start justify-between gap-6 rounded-3xl bg-white p-8 shadow-[0_4px_24px_0_rgba(3,18,66,0.06)] lg:min-h-[570px] lg:p-10",
                // rows swap the narrow/wide slot: 505|650 then 650|505
                i === 2 && "lg:col-start-1 lg:row-start-2 lg:order-4",
                i === 3 && "lg:col-start-2 lg:row-start-2 lg:order-3",
              )}
            >
              <div className="flex w-full flex-col items-start gap-4">
                <h3 className="font-heading text-[24px] leading-[1.25] text-dyna-navy md:text-[28px]">
                  {block.title}
                </h3>
                <p className="text-base leading-[26px] text-dyna-navy/80">
                  {block.body}
                </p>
                <div className="group">
                  <PillButton variant="link">
                    {block.cta}
                  </PillButton>
                </div>
              </div>

              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={block.image}
                alt={block.alt}
                width={570}
                height={300}
                className="mt-auto h-auto w-full select-none"
              />
            </div>
          ))}
        </div>

        <div className="group">
          <PillButton>Discover How We Support You</PillButton>
        </div>
      </div>
    </div>
  );
}
