import {
  AndroidIcon,
  AppleIcon,
  ChatIcon,
  ChevronDownIcon,
  FacebookIcon,
  LinkedInIcon,
  LogoIcon,
  XIcon,
  YoutubeIcon,
} from '@/components/home/shared/icons'
import { FOOTER_COLUMNS, FOOTER_LEGAL } from './site-data'


const SOCIALS = [
  { label: 'Facebook', Icon: FacebookIcon },
  { label: 'LinkedIn', Icon: LinkedInIcon },
  { label: 'X', Icon: XIcon },
  { label: 'YouTube', Icon: YoutubeIcon },
  { label: 'Chat', Icon: ChatIcon },
]

/**
 * Measured on the source (1440px, footer height 931):
 *   left rail  — 315px wide: logo, EN/USD pills, newsletter card, socials, apps
 *   link cols  — `.submenu`, `padding: 16px 28px`, `gap: 20px`, and each one
 *                carries `border-left: 1px solid #D4DCEC` (the column rules)
 *   headings   — 16px/600 #031242 · links 16px/400 **#0072BC** (not navy)
 *   newsletter — 315x220, `border-radius: 16px`, `padding: 28px 20px`,
 *                `linear-gradient(to right top,#DAE8FF 68%,#EEBFFF 96%,#F3ACFF 100%)`,
 *                with an inline email field (174x48, radius 32px) + Join Now
 *   bottom bar — `padding-top: 56px`, a single `justify-between` row
 */
export function SiteFooter() {
  return (
    <footer className="mt-auto flex w-full flex-col items-center bg-dyna-page">
      <div className="flex w-full max-w-1440 flex-col px-7 py-24 md:px-14 2xl:px-[120px]">
        <div className="footer-content flex flex-col items-center gap-10 lg:flex-row lg:items-start">
          {/* Left rail */}
          <div className="flex w-full min-w-52 max-w-[315px] flex-col items-start gap-7">
            <LogoIcon className="text-dyna-navy" />

            <div className="flex items-center gap-3">
              {['EN', 'USD ($)'].map((label) => (
                <button
                  key={label}
                  type="button"
                  className="inline-flex h-[34px] items-center gap-1.5 rounded-[100px] border border-[#D4DCEC] px-[10px] text-sm text-dyna-navy transition-colors hover:bg-white"
                >
                  {label}
                  <ChevronDownIcon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>

            {/* Newsletter card */}
            <div className="footer-newsletter flex w-full flex-col gap-4 rounded-[16px] bg-[linear-gradient(to_right_top,#DAE8FF_68%,#EEBFFF_96%,#F3ACFF_100%)] px-5 py-7">
              <h3 className="text-lg font-semibold leading-6 text-dyna-navy">
                Stay Informed with Our Newsletter
              </h3>
              <p className="text-[13px] leading-5 text-dyna-navy/75">
                Get domain deals, new launches, and more delivered right to your inbox.
              </p>
              {/* Source: 174x48 field + 101x48 button, button flush right */}
              <div className="flex h-12 items-center overflow-hidden rounded-[32px] bg-white pl-4">
                <input
                  type="email"
                  placeholder="Enter your email"
                  aria-label="Enter your email"
                  className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-dyna-navy outline-none placeholder:text-dyna-navy/50"
                />
                {/* 101x48, radius 999px, padding 8px 16px — its own stacked
                    gradient, not the section-CTA one. */}
                <button
                  type="button"
                  className="dyna-join-btn h-12 w-[101px] shrink-0 rounded-[999px] px-4 py-2 text-[13px] font-medium text-white"
                >
                  Join Now
                </button>
              </div>
            </div>

            <div className="flex items-center gap-[14px] text-dyna-navy">
              {SOCIALS.map(({ label, Icon }) => (
                <a
                  key={label}
                  href="#"
                  aria-label={label}
                  className="transition-opacity hover:opacity-65"
                >
                  <Icon className="h-4 w-4" />
                </a>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <span className="text-[13px] text-dyna-navy/75">Download the app:</span>
              <a
                href="#"
                aria-label="Download on the App Store"
                className="flex size-7 items-center justify-center rounded-md bg-dyna-navy text-white transition-opacity hover:opacity-80"
              >
                <AppleIcon className="h-4 w-4" />
              </a>
              <a
                href="#"
                aria-label="Get it on Google Play"
                className="flex size-7 items-center justify-center rounded-md bg-dyna-navy text-white transition-opacity hover:opacity-80"
              >
                <AndroidIcon className="h-4 w-4" />
              </a>
            </div>
          </div>

          {/* Link columns — each ruled off with a left border */}
          <div className="submenu-content flex w-full flex-1 flex-wrap justify-between">
            {FOOTER_COLUMNS.map((col) => (
              <div
                key={col.heading}
                className="submenu flex w-1/2 flex-col gap-5 border-l border-[#D4DCEC] px-7 py-4 lg:w-auto"
              >
                <h3 className="text-base font-semibold text-dyna-navy">{col.heading}</h3>
                <ul className="flex flex-col gap-3">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        // Source has only the generic `a:hover { color:#0072bc }`,
                        // which these links already sit at — so no hover change.
                        className="text-base text-[#0072BC]"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom bar — one justify-between row on the source */}
        <div className="footer-bottom flex flex-col items-start pt-14">
          <div className="other flex w-full flex-col items-start justify-between gap-5 md:flex-row md:items-center">
            <p className="text-[13px] text-dyna-navy/75">
              Copyright © 2002-2026 Dynadot Inc. All rights reserved.
            </p>
            <ul className="flex flex-wrap items-center gap-x-8 gap-y-2">
              {FOOTER_LEGAL.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="text-[13px] text-dyna-navy transition-colors hover:text-[#0072BC]"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>

            {/* Accreditation marks (ICANN 46x37, NamePros 80x21, Domaining
                80x21) are third-party trademarks and are not reproduced. The
                slots stay so the bottom bar keeps its measured geometry. */}
            <div aria-hidden="true" className="flex shrink-0 items-center gap-6">
              <span className="block h-[37px] w-[46px]" />
              <span className="block h-[21px] w-[80px]" />
              <span className="block h-[21px] w-[80px]" />
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
