import { cn } from '@/lib/utils'
import { AngleRightIcon } from '@/components/home/shared/icons'
import { BANNER_ADS, LEAD_BANNER, TEXT_ADS } from './ads-data'

/**
 * The hero ad rail: 1 full-width banner, 2 banners side by side, then 5 text
 * units per row over 2 rows. Frameless and lit.
 *
 *   - No container. An earlier pass wrapped the rail in the same glass panel
 *     the search card uses, which left two competing glass slabs in the hero
 *     and cost the search card its status as the one bright object. The units
 *     sit straight on the hero plate; a rule carries the disclosure instead.
 *   - Banners are lit rather than filled: each carries a drop shadow keyed to
 *     its own gradient (`glow` in ads-data), plus a 1px top highlight, so the
 *     unit reads as a light source on the navy instead of a pasted rectangle.
 *   - Text units carry weight on purpose. A first pass used bare hairlines and
 *     they read as decoration — sitting under two lit banner rows, nothing
 *     that quiet gets looked at. Each unit now has a tinted fill, a stronger
 *     ring, a leading dot, and its own coloured glow, at 42px and 14px rather
 *     than 36 and 13. The glow matches the banners' treatment, so the rows
 *     gain presence without introducing a second visual language.
 *   - Unsold slots take a dashed hairline, which reads as "empty" at a glance
 *     without needing to be read.
 */

/** Static class sets — Tailwind needs whole class names, not built strings. */
const TINTS = [
  {
    text: 'text-[#63C2FF]',
    dot: 'bg-[#63C2FF]',
    base: 'bg-[#63C2FF]/12 ring-[#63C2FF]/55 shadow-[0_4px_16px_-6px_rgba(99,194,255,0.55)]',
    hover: 'hover:bg-[#63C2FF]/25 hover:ring-[#63C2FF]/90',
  },
  {
    text: 'text-[#F098FF]',
    dot: 'bg-[#F098FF]',
    base: 'bg-[#F098FF]/12 ring-[#F098FF]/55 shadow-[0_4px_16px_-6px_rgba(240,152,255,0.55)]',
    hover: 'hover:bg-[#F098FF]/25 hover:ring-[#F098FF]/90',
  },
  {
    text: 'text-[#FFF75F]',
    dot: 'bg-[#FFF75F]',
    base: 'bg-[#FFF75F]/12 ring-[#FFF75F]/55 shadow-[0_4px_16px_-6px_rgba(255,247,95,0.5)]',
    hover: 'hover:bg-[#FFF75F]/25 hover:ring-[#FFF75F]/90',
  },
]

function AdTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'select-none text-[10px] font-medium uppercase leading-none tracking-[0.1em] text-white/60',
        className,
      )}
    >
      Ad
    </span>
  )
}

/** 4-point spark marking a featured text unit. */
function SparkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M12 2.5l2.3 6.2 6.2 2.3-6.2 2.3-2.3 6.2-2.3-6.2L3.5 11l6.2-2.3L12 2.5z"
        fill="currentColor"
      />
    </svg>
  )
}

export function HeroAdRail() {
  return (
    <div className="relative z-10 mt-9 flex w-full max-w-[1200px] flex-col gap-3.5">
      {/* Disclosure. Without a container the label is what marks the zone, so
          it gets a gradient bar and full-width rules rather than a small chip. */}
      <div className="flex items-center gap-3">
        <span className="h-3 w-[3px] shrink-0 rounded-full bg-[linear-gradient(180deg,#63C2FF,#F098FF)]" />
        <span className="shrink-0 text-[11px] font-semibold uppercase leading-none tracking-[0.18em] text-white/45">
          Sponsored
        </span>
        <span className="h-px flex-1 bg-[linear-gradient(90deg,rgba(255,255,255,0.16),rgba(255,255,255,0))]" />
        <a
          href="#"
          className="shrink-0 text-[11px] font-medium leading-none text-white/45 transition-colors hover:text-white"
        >
          Advertise here
        </a>
      </div>

      {/* Lead banner — 1 unit, full width */}
      <a
        href={LEAD_BANNER.href}
        rel="sponsored nofollow"
        className={cn(
          'group relative flex min-h-[68px] flex-col items-start gap-3 overflow-hidden rounded-2xl px-5 py-3.5 text-left',
          'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.22)] sm:flex-row sm:items-center sm:gap-5 md:px-7',
          LEAD_BANNER.background,
          LEAD_BANNER.glow,
        )}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-10 -top-24 h-[220px] w-[320px] bg-[radial-gradient(circle_at_50%_50%,rgba(255,255,255,0.4),rgba(255,255,255,0)_70%)] transition-transform duration-500 group-hover:scale-110"
        />

        <span className="relative z-10 flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex min-w-0 items-center gap-2 text-[10px] font-semibold uppercase leading-none tracking-[0.14em]">
            <span className="shrink-0 text-[#7FE9F0]">{LEAD_BANNER.eyebrow}</span>
            <span className="h-2.5 w-px shrink-0 bg-white/25" />
            <span className="truncate font-medium tracking-[0.08em] text-white/55">
              {LEAD_BANNER.advertiser}
            </span>
          </span>
          <span className="line-clamp-2 font-heading text-[18px] leading-tight text-white sm:line-clamp-1 md:text-[20px]">
            {LEAD_BANNER.title}
          </span>
        </span>

        <span className="relative z-10 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-5 py-2.5 text-[13px] font-semibold leading-none text-dyna-navy transition-transform duration-300 group-hover:scale-105">
          {LEAD_BANNER.cta}
          <AngleRightIcon className="h-3 w-3" />
        </span>

        <AdTag className="absolute right-2 top-2 z-10" />
      </a>

      {/* Banner row — 2 units */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2 lg:gap-4">
        {BANNER_ADS.map((ad) => (
          <a
            key={ad.advertiser}
            href={ad.href}
            rel="sponsored nofollow"
            className={cn(
              'group relative flex min-h-[62px] items-center gap-4 overflow-hidden rounded-xl px-4 py-2.5 text-left',
              'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] md:px-5',
              ad.background,
              ad.glow,
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-[10px] font-medium uppercase leading-none tracking-[0.1em] text-white/50">
                {ad.advertiser}
              </span>
              <span className="line-clamp-2 text-[15px] font-medium leading-tight text-white lg:line-clamp-1">
                {ad.title}
              </span>
            </span>

            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/20 px-3.5 py-2 text-xs font-medium leading-none text-white transition-colors group-hover:bg-white/35">
              {ad.cta}
              <AngleRightIcon className="h-3 w-3" />
            </span>

            <AdTag className="absolute right-2 top-2" />
          </a>
        ))}
      </div>

      {/* Text grid — 5 per row, 2 rows, outlined */}
      <div className="grid grid-cols-1 gap-x-2 gap-y-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 xl:gap-x-3">
        {TEXT_ADS.map((ad, i) => {
          const featured = ad.variant === 'featured'
          const house = ad.variant === 'house'
          const tint = TINTS[i % TINTS.length]
          return (
            <a
              key={`${ad.title}-${i}`}
              href={ad.href}
              rel="sponsored nofollow"
              title={ad.title}
              className={cn(
                'flex h-[42px] items-center justify-center gap-2 overflow-hidden rounded-full px-4 text-sm font-medium leading-none transition-colors',
                featured
                  ? cn(
                      'bg-[linear-gradient(94deg,#63C2FF,#F098FF)] font-semibold text-dyna-navy',
                      'shadow-[0_8px_24px_-8px_rgba(240,152,255,0.95)] hover:brightness-110',
                    )
                  : house
                    ? 'border border-dashed border-white/20 font-normal text-white/35 hover:border-white/40 hover:text-white/60'
                    : cn('ring-1 ring-inset', tint.text, tint.base, tint.hover),
              )}
            >
              {featured ? <SparkIcon className="h-3.5 w-3.5 shrink-0 text-dyna-navy" /> : null}
              {!featured && !house ? (
                <span
                  aria-hidden="true"
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tint.dot)}
                />
              ) : null}
              <span className="truncate">{ad.title}</span>
            </a>
          )
        })}
      </div>
    </div>
  )
}
