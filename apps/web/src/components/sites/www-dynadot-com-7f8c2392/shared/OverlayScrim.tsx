"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The page-level dimming scrim. On the source it is a direct child of <body>:
 *   `pointer-events-none opacity-0 fixed inset-0 z-40 bg-[#000E3F]/50
 *    backdrop-blur-sm transition-all duration-300`
 * and it fades to `opacity-100` for BOTH the nav mega-menu and the hero search
 * focus — one shared element, which is why it lives in a provider here rather
 * than inside either component.
 *
 * Stacking: scrim z-40 < navbar z-1999, so the header never blurs. The hero
 * search card reaches z-50 only because the hero drops its own `z-10` while
 * focused — see Hero.tsx.
 *
 * Deviation: the source flips to `pointer-events-auto` when active. We keep it
 * inert so the header's `onMouseLeave` still fires and closes the mega-menu.
 */
const OverlayContext = createContext<{
  active: boolean;
  setActive: (v: boolean) => void;
}>({ active: false, setActive: () => {} });

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);

  return (
    <OverlayContext.Provider value={{ active, setActive }}>
      <div
        aria-hidden="true"
        className={cn(
          // backdrop-blur-sm is 8px in Tailwind v4; the source blur is 4px.
          "pointer-events-none fixed inset-0 z-40 bg-[#000E3F]/50 backdrop-blur-[4px] transition-all duration-300",
          active ? "opacity-100" : "opacity-0",
        )}
      />
      {children}
    </OverlayContext.Provider>
  );
}

export function useOverlay() {
  return useContext(OverlayContext);
}
