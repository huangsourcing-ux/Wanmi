import { cn } from '@/lib/utils'
import { PillButton } from '@/components/home/shared/PillButton'
import { AFTERMARKET_CARDS, AFTERMARKET_TICKER } from './site-data'

/**
 * Source structure (measured): inner container max-w 1440, padding 120px,
 * gap 60px, holding three blocks —
 *   1. left-aligned heading block, 102px
 *   2. a stack of three FULL-WIDTH cards (1192px wide), gap 20px, 859px total
 *   3. the CTA pill, 49px
 * The first card carries the 73px auction ticker strip along its bottom edge,
 * with `rounded-b-[20px]` clipping the marquee.
 */
export function Aftermarket() {
  const track = [...AFTERMARKET_TICKER, ...AFTERMARKET_TICKER]
  const cardHeights = ['lg:min-h-[290px]', 'lg:min-h-[218px]', 'lg:min-h-[311px]']

  return (
    <section className="flex w-full items-center justify-center bg-[linear-gradient(180deg,#0F172A_0%,#1D4ED8_50%,#EEF2FF_100%)]">
      <div className="flex w-full max-w-1440 flex-col items-start gap-10 px-7 py-20 md:px-14 md:py-[90px] lg:gap-[60px] lg:p-[120px]">
        <div className="flex flex-col items-start justify-start gap-5 self-stretch">
          <h2 className="font-heading text-[32px] leading-[1.2] tracking-[-0.4px] text-white md:text-[48px] md:leading-[52.8px]">
            Our Leading Aftermarket
          </h2>
          <p className="text-base leading-[26px] text-white/85 md:text-lg">
            Discover and buy unique domain names using powerful aftermarket acquisition tools.
          </p>
        </div>

        <div className="flex w-full flex-col items-start justify-start gap-10 md:gap-[15px] lg:gap-5">
          {AFTERMARKET_CARDS.map((card, i) => (
            <div
              key={card.title}
              className={cn(
                'relative flex w-full flex-col items-start justify-start self-stretch overflow-hidden rounded-[20px] border border-white/15 bg-white/10 backdrop-blur-sm',
                cardHeights[i],
              )}
            >
              <div className="flex w-full flex-col items-start gap-4 p-8 lg:p-10">
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={card.icon}
                    alt={card.alt}
                    width={40}
                    height={38}
                    loading="lazy"
                    decoding="async"
                    className="h-[38px] w-auto select-none"
                  />
                  <h3 className="font-heading text-[22px] leading-[1.3] text-white md:text-[26px]">
                    {card.title}
                  </h3>
                </div>
                <p className="max-w-[640px] text-[15px] leading-[24px] text-white/80">
                  {card.body}
                </p>
                <div className="group">
                  <PillButton variant="link-light">{card.cta}</PillButton>
                </div>
              </div>

              {/* Auction ticker strip pinned to the first card's bottom edge */}
              {i === 0 ? (
                <div className="dyna-marquee mt-auto h-[73px] w-full overflow-hidden rounded-bl-[20px] rounded-br-[20px] border-t border-white/15 bg-white/5 [--dyna-marquee-duration:90s]">
                  <div className="dyna-marquee-track flex h-full items-center gap-4 px-4">
                    {track.map((item, n) => (
                      <div
                        key={`${item.domain}-${n}`}
                        className="flex w-[240px] shrink-0 items-center justify-center gap-2 rounded-[50px] bg-white/10 px-[10px] py-1.5"
                      >
                        <span className="h-5 w-5 shrink-0 rounded-full bg-[linear-gradient(232.48deg,#f9d571_12.57%,#f9dcc1_46%,#f9d571_100%)]" />
                        <span className="truncate text-sm text-white">{item.domain}</span>
                        <span className="inline-block h-[24px] shrink-0 whitespace-nowrap rounded-[50px] bg-white/15 px-2 text-sm leading-6 text-white">
                          {item.price}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <div className="group max-w-[256px] md:max-w-none">
          <PillButton>Discover Our Domain Aftermarket Gems</PillButton>
        </div>
      </div>
    </section>
  )
}
