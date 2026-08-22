import type { MegaPanel } from "@/types/dynadot";
import { cn } from "@/lib/utils";
import { AngleRightIcon } from "../shared/icons";

/**
 * One hover-triggered mega-menu panel. Measured on the source:
 * - panel height 327, `padding: 45px 0 0`, background `#031242`
 * - inner row `padding: 0 85px`, columns `padding: 0 30px`, `gap: 10px`
 * - lead heading 24px/500 white; column headings 18px/500 white @ 40% opacity;
 *   links 16px/400 white
 */
export function MegaMenuPanel({ panel }: { panel: MegaPanel }) {
  return (
    <div className="min-h-[327px] w-full bg-[#031242] pt-[45px]">
      <div className="flex px-[85px]">
        {/* Lead column */}
        <div
          className="dyna-mega-column flex shrink-0 flex-col gap-[10px] px-[30px]"
          data-column-width={panel.columnWidth}
        >
          <span className="text-[24px] font-medium leading-tight text-white">
            {panel.title}
          </span>
          {panel.lead && panel.leadHref ? (
            <a
              href={panel.leadHref}
              className="text-base text-white/80 transition-opacity hover:opacity-100"
            >
              {panel.lead}
            </a>
          ) : panel.lead ? (
            <span className="text-base text-white/80">{panel.lead}</span>
          ) : null}
        </div>

        {/* Link columns. Every column after the lead one carries
            `border-left: 1px solid rgba(255,255,255,0.2)` — these are the
            vertical dividers between the groups. */}
        {panel.columns.map((col) => (
          <div
            key={col.heading}
            className={cn(
              "dyna-mega-column flex shrink-0 flex-col gap-[10px] border-l border-white/20 px-[30px]",
            )}
            data-column-width={panel.columnWidth}
          >
            <span className="text-[18px] font-medium leading-normal text-white opacity-40">
              {col.heading}
            </span>
            <ul className="flex flex-col gap-[10px]">
              {col.links.map((link) => (
                <li key={link.label}>
                  {/* `.item` is a flex row with `gap: 1px`. Its chevron sits at
                      opacity 0 until hover, then fades in and slides 5px:
                      `.item:hover i { opacity: 1; transform: translate(5px) }`
                      with `transition: transform .3s ease-in-out`. */}
                  <a
                    href={link.href}
                    className="group/item flex w-fit items-center gap-px text-base font-normal text-white"
                  >
                    {link.label}
                    <AngleRightIcon className="h-4 w-2.5 shrink-0 opacity-0 transition-[transform,opacity] duration-300 ease-in-out group-hover/item:translate-x-[5px] group-hover/item:opacity-100" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
