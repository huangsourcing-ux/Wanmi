import { PillButton } from '@/components/home/shared/PillButton'
import { FEATURE_ROWS } from './site-data'

/**
 * Two `buy-domain-card` panels side by side — each 581px wide, 714px tall,
 * padding 60px 0 50px, image stacked above the copy. Section inner container:
 * max-width 1440px, padding 120px, gap 60px.
 */
export function BuyAndRegister() {
  return (
    <section className="flex w-full items-center justify-center bg-dyna-page">
      <div className="flex w-full max-w-1440 flex-col items-center gap-10 px-7 py-20 md:px-14 md:py-[90px] lg:gap-[60px] lg:p-[120px]">
        <h2 className="max-w-[820px] text-center font-heading text-[32px] leading-[1.2] tracking-[-0.4px] text-dyna-navy md:text-[48px] md:leading-[52.8px]">
          Buy &amp; Register Your Domain Names
        </h2>

        <div className="grid w-full grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-[38px]">
          {FEATURE_ROWS.map((row) => (
            <div
              key={row.title}
              className="buy-domain-card inline-flex w-full flex-col items-center gap-8 rounded-3xl bg-white px-8 pb-[50px] pt-[60px] shadow-[0_4px_24px_0_rgba(3,18,66,0.06)] lg:min-h-[714px] lg:max-w-[581px] lg:px-10"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={row.image}
                alt={row.alt}
                width={878}
                height={557}
                className="h-auto w-full select-none"
              />

              <div className="flex w-full flex-1 flex-col items-start gap-4">
                <h3 className="font-heading text-[26px] leading-[1.25] text-dyna-navy md:text-[28px]">
                  {row.title}
                </h3>
                <p className="text-base leading-[26px] text-dyna-navy/80">{row.body}</p>
                <div className="group mt-auto pt-2">
                  <PillButton variant="link">{row.cta}</PillButton>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="group">
          <PillButton>Discover Your Next Domain</PillButton>
        </div>
      </div>
    </section>
  )
}
