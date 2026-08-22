"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  ChevronDownIcon,
  CloseIcon,
  LogoIcon,
  MenuIcon,
  UserIcon,
} from "../shared/icons";
import { useOverlay } from "../shared/OverlayScrim";
import { MegaMenuPanel } from "./MegaMenuPanel";
import { ACCOUNT_LINK, ANNOUNCEMENT, MEGA_PANELS, PRIMARY_NAV } from "./site-data";

/**
 * Header is `position: absolute; top: 0; z-index: 2000` on the source page —
 * it overlays the hero and scrolls away with the document. Verified at
 * scrollY 600: navbar viewport top = -561px, background unchanged.
 */
export function SiteHeader() {
  const [bannerOpen, setBannerOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  /** Label of the nav item whose mega-menu is open, or null when closed. */
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const activePanel = MEGA_PANELS.find((p) => p.label === openMenu) ?? null;
  const { setActive: setScrim } = useOverlay();

  /** The scrim is shared with the hero search focus — see OverlayScrim.tsx. */
  const openPanel = (label: string | null) => {
    setOpenMenu(label);
    setScrim(label !== null);
  };

  return (
    /* The announcement bar sits in normal flow (page content starts at y=39 on
       the source); only the navbar overlays the hero. */
    <nav className="relative z-[2000]" onMouseLeave={() => openPanel(null)}>
      {bannerOpen ? (
        <div className="relative flex h-[39.28px] items-center justify-center bg-dyna-banner px-[30px] text-center text-base leading-[21.28px] text-white">
          <span className="truncate">{ANNOUNCEMENT}</span>
          <button
            type="button"
            aria-label="关闭公告"
            onClick={() => setBannerOpen(false)}
            className="absolute right-[30px] top-1/2 -translate-y-1/2 text-white/80 transition-colors hover:text-white"
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}

      <div className="absolute inset-x-0 top-full z-[1999] flex h-[72px] items-center justify-between gap-5 bg-[rgba(49,68,127,0.2)] px-6 transition-[background-color,color] duration-300 md:px-[45px]">
        {/* `.ctl-logo` slot. The mark stays 146x34, but the slot itself widens
            past the 1450px breakpoint (176 -> 236.9) because a second, visually
            empty child joins it. That widening is what pushes the link row from
            x=241 to x=302: 45 + 236.9 + 20 = 301.9. */}
        <Link
          href="/"
          aria-label="Wanmi.net 首页"
          className="flex h-[34px] w-[176px] shrink-0 items-center min-[1450px]:w-[237px]"
        >
          <LogoIcon />
        </Link>

        {/* `.navbar-left-dropdown`. The link row steps up at a custom 1450px
            breakpoint (measured: 1444 -> 15px/gap 35, 1450 -> 18px/gap 50):
              < 1450  row 563.2px — text 15px, gap 35px, chevron 13.1x15
              >= 1450 row 697.9px — text 18px, gap 50px, chevron 15.8x18
            The item's internal 10px text->chevron gap is the same in both. */}
        <div className="hidden flex-1 items-center gap-[35px] lg:flex min-[1450px]:gap-[50px]">
          {PRIMARY_NAV.map((item) => (
            <a
              key={item.label}
              href={item.href}
              onMouseEnter={() => openPanel(item.label)}
              onFocus={() => openPanel(item.label)}
              aria-expanded={openMenu === item.label}
              className="group inline-flex items-center gap-[10px] text-[15px] font-medium leading-5 text-[#EBF3FF] transition-opacity hover:opacity-80 min-[1450px]:text-[18px] min-[1450px]:leading-[23.5px]"
            >
              {item.label}
              <ChevronDownIcon
                className={cn(
                  "h-[15px] w-[13px] transition-transform min-[1450px]:h-[18px] min-[1450px]:w-[16px]",
                  openMenu === item.label && "rotate-180",
                )}
              />
            </a>
          ))}
        </div>

        {/* `.nav-right`: gap 10px; every control is 34px tall with
            padding 0 10px, radius 100px, border 1px rgb(117,129,159).
            The language/currency switch and the cart are gone — neither
            exists on this site; the account entry is a plain link. */}
        <div className="flex shrink-0 items-center gap-[10px]">
          <a
            href={ACCOUNT_LINK.href}
            className="inline-flex h-[34px] items-center gap-[5px] rounded-[100px] border border-[#EBF3FF] bg-transparent px-[10px] text-sm text-[#EBF3FF] transition-colors hover:bg-white/10"
          >
            <UserIcon className="h-[14px] w-[14px]" />
            {ACCOUNT_LINK.label}
          </a>
          <button
            type="button"
            aria-label="菜单"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((v) => !v)}
            className="text-[#EBF3FF] lg:hidden"
          >
            <MenuIcon />
          </button>
        </div>
      </div>

      {/* Mega-menu panel — sits at banner (39) + navbar (72) = 111px, the
          same offset as the source, at z-9999 above the scrim. */}
      <div
        className={cn(
          "absolute inset-x-0 top-[calc(100%+72px)] z-[9999] hidden overflow-hidden transition-[opacity,transform] duration-200 lg:block",
          activePanel
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none -translate-y-1 opacity-0",
        )}
      >
        {activePanel ? <MegaMenuPanel panel={activePanel} /> : null}
      </div>

      <div
        className={cn(
          "absolute inset-x-0 top-[calc(100%+72px)] overflow-hidden bg-[#031242]/95 backdrop-blur-sm transition-[max-height] duration-300 lg:hidden",
          mobileOpen ? "max-h-96" : "max-h-0",
        )}
      >
        <div className="flex flex-col gap-1 px-6 py-4">
          {PRIMARY_NAV.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="py-2 text-[15px] font-medium text-[#EBF3FF]"
            >
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}
