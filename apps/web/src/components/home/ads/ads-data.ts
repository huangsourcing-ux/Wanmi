/**
 * Placeholder inventory for the homepage hero ad rail. Nothing here is wired to
 * an ad server — the copy exists so the layout can be judged at realistic text
 * lengths.
 *
 * Text units are a SINGLE LINE — a headline and nothing else, clipped at the
 * cell edge rather than wrapped, so one long title can never make its row
 * taller than the other. About 26 characters is the ceiling: a 230px pill at
 * 14px, less the leading dot and its gap.
 *
 * Three unit states keep the grid from reading as wallpaper:
 *   default    the bulk of the inventory, tinted by position
 *   featured   premium placements — filled pill, white label, spark mark
 *   house      unsold slots, muted. Every ad grid has some; showing them is
 *              more honest than filling all 20 with imaginary advertisers.
 */

export type TextAdVariant = 'featured' | 'house'

export interface TextAd {
  /** The whole ad. One line, no body copy. */
  title: string
  href: string
  variant?: TextAdVariant
}

export interface BannerAd {
  title: string
  cta: string
  advertiser: string
  href: string
  /** Tailwind class for the strip's background plate. */
  background: string
  /**
   * Tailwind class for a coloured drop shadow keyed to the plate's end stop,
   * so the unit reads as lit rather than pasted on. Used by the frameless
   * rail only — the glass rail contains its units instead.
   */
  glow: string
}

/** One full-width unit — the premium slot, directly under the search card. */
export const LEAD_BANNER: BannerAd & { eyebrow: string } = {
  eyebrow: 'Featured partner',
  title: 'Register, host and secure a domain in a single checkout',
  cta: 'Start free',
  advertiser: 'Kestrel Cloud',
  href: '#',
  background: 'bg-[linear-gradient(94deg,#031242_0%,#1B48D9_58%,#00D5D5_128%)]',
  glow: 'shadow-[0_16px_40px_-14px_rgba(0,213,213,0.55)]',
}

/** 2 units side by side. */
export const BANNER_ADS: BannerAd[] = [
  {
    title: 'Sell your domains across 12 marketplaces',
    cta: 'See pricing',
    advertiser: 'ParkFlow',
    href: '#',
    background: 'bg-[linear-gradient(94deg,#7A3BC4_0%,#C4479B_100%)]',
    glow: 'shadow-[0_14px_34px_-14px_rgba(196,71,155,0.65)]',
  },
  {
    title: 'Appraise a portfolio in under a minute',
    cta: 'Try it free',
    advertiser: 'ValueMark',
    href: '#',
    background: 'bg-[linear-gradient(94deg,#0A6E8C_0%,#12A594_100%)]',
    glow: 'shadow-[0_14px_34px_-14px_rgba(18,165,148,0.65)]',
  },
]

/** 10 units = 5 per row x 2 rows. */
export const TEXT_ADS: TextAd[] = [
  { title: '.AI Domains from $69.99', href: '#' },
  { title: 'Bulk Transfer — 40% Off', href: '#', variant: 'featured' },
  { title: 'Managed WordPress, $4/mo', href: '#' },
  { title: 'Trademark Watch $9/mo', href: '#' },
  { title: 'Sell Domains 3x Faster', href: '#' },

  { title: 'Business Email $1.50/box', href: '#' },
  { title: 'Wildcard SSL, One Install', href: '#' },
  { title: 'Escrow for Domain Deals', href: '#', variant: 'featured' },
  { title: 'Anycast DNS — 8ms Global', href: '#', variant: 'featured' },
  { title: 'This Slot Available', href: '#', variant: 'house' },
]
