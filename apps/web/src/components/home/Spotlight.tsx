import { PillButton } from '@/components/home/shared/PillButton'
import { ASSETS } from './site-data'

/**
 * Measured on the source: section 327px tall, `padding: 80px 0 125px`,
 * `gap: 20px`, flex column, centred.
 *
 * Layout order is heading -> button -> card strip. The card strip
 * (`spotlight-bg.webp`) renders at **804x115 in normal flow**, not as a
 * full-bleed background plate — treating it as one puts the button on top of
 * the cards. The left/right art (358x326 and 394x326) is bottom-anchored and
 * bleeds past the container edges.
 */
export function Spotlight() {
  return (
    <section className="spotlight relative flex flex-col items-center gap-5 overflow-hidden bg-[linear-gradient(180deg,rgba(235,243,255,0)_0%,#EBF3FF_21.51%,rgba(223,248,255,0.89)_49.05%,rgba(80,214,255,0.4)_101.66%)] px-6 pb-[125px] pt-20">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${ASSETS}/images/spotlight-left.webp`}
        alt=""
        aria-hidden="true"
        width={358}
        height={326}
        className="pointer-events-none absolute -left-3 bottom-0 hidden w-[358px] select-none lg:block"
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${ASSETS}/images/spotlight-right.webp`}
        alt=""
        aria-hidden="true"
        width={394}
        height={326}
        className="pointer-events-none absolute -right-3 bottom-0 hidden w-[394px] select-none lg:block"
      />

      <h2 className="relative z-10 w-full text-center font-heading text-[32px] leading-[1.2] tracking-[-0.4px] text-dyna-navy md:text-[48px] md:leading-[52.8px]">
        Spotlight Your{' '}
        <span className="dyna-gradient-text inline-block bg-[linear-gradient(90deg,#00D5D5_20.19%,#008B90_55.29%,#003B45_100%)] capitalize">
          Premium Domain
        </span>{' '}
        Power
      </h2>

      <div className="group relative z-10">
        <PillButton>Visit Our Premium Marketplace</PillButton>
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${ASSETS}/images/spotlight-bg.webp`}
        alt=""
        aria-hidden="true"
        width={804}
        height={115}
        // Source rhythm from the section top: h2 80 · button 153 · strip 212,
        // and the strip's bottom edge IS the section bottom (327). So the strip
        // sits 10px under the button and cancels the 125px bottom padding.
        className="relative z-10 -mt-2.5 mb-[-125px] h-auto w-full max-w-[804px] select-none"
      />
    </section>
  )
}
