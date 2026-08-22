import { LogoIcon } from "../shared/icons";
import { FOOTER_COLUMNS, FOOTER_LEGAL, FOOTER_TAGLINE } from "./site-data";

/**
 * Measured on the source (1440px):
 *   left rail  — 315px wide: logo, then the site description
 *   link cols  — `.submenu`, `padding: 16px 28px`, `gap: 20px`, and each one
 *                carries `border-left: 1px solid #D4DCEC` (the column rules)
 *   headings   — 16px/600 #031242 · links 16px/400 **#0072BC** (not navy)
 *   bottom bar — `padding-top: 56px`, a single `justify-between` row
 * The newsletter card, language/currency pills, social icons, app badges and
 * accreditation marks of the source are gone: none of those exist here.
 */
export function SiteFooter() {
  return (
    <footer className="mt-auto flex w-full flex-col items-center bg-dyna-page">
      <div className="flex w-full max-w-1440 flex-col px-7 py-24 md:px-14 2xl:px-[120px]">
        <div className="footer-content flex flex-col items-center gap-10 lg:flex-row lg:items-start">
          {/* Left rail */}
          <div className="flex w-full min-w-52 max-w-[315px] flex-col items-start gap-7">
            <LogoIcon className="text-dyna-navy" />

            <div className="flex flex-col gap-3">
              <h3 className="text-lg font-semibold leading-6 text-dyna-navy">
                {FOOTER_TAGLINE.title}
              </h3>
              <p className="text-[13px] leading-5 text-dyna-navy/75">
                {FOOTER_TAGLINE.body}
              </p>
            </div>
          </div>

          {/* Link columns — each ruled off with a left border */}
          <div className="submenu-content flex w-full flex-1 flex-wrap justify-between">
            {FOOTER_COLUMNS.map((col) => (
              <div
                key={col.heading}
                className="submenu flex w-1/2 flex-col gap-5 border-l border-[#D4DCEC] px-7 py-4 lg:w-auto"
              >
                <h3 className="text-base font-semibold text-dyna-navy">
                  {col.heading}
                </h3>
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
            <p className="text-[13px] text-dyna-navy/75">{FOOTER_TAGLINE.bottom}</p>
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
          </div>
        </div>
      </div>
    </footer>
  );
}
