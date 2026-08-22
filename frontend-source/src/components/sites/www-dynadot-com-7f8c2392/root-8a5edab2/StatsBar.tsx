import { ASSETS, STATS } from "./site-data";

/**
 * Negative top margin tucks this band under the hero's 30px bottom radius.
 * Layout: flex row with gap 60px at lg+, 4-col grid at sm, 2-col at base.
 * The Trustpilot block is `order-first col-span-2 sm:col-span-4 lg:order-none`.
 */
export function StatsBar() {
  return (
    <section className="relative -mt-5 w-full overflow-hidden bg-dyna-page pt-5">
      <div className="grid grid-cols-2 items-center justify-center gap-y-5 px-6 py-10 text-dyna-slate-900 sm:grid-cols-4 md:justify-items-center lg:flex lg:gap-[60px]">
        {STATS.map((stat) => (
          <div
            key={stat.label}
            className="flex flex-col items-center gap-1 text-center text-base font-medium leading-6 md:flex-row"
          >
            <span className="text-lg font-semibold leading-[30px] lg:text-xl">
              {stat.value}
            </span>
            <span>{stat.label}</span>
          </div>
        ))}

        <div className="order-first col-span-2 flex items-center justify-center gap-2 sm:col-span-4 lg:order-none">
          <span className="text-base font-medium leading-6">Excellent</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${ASSETS}/images/trustpilot-stars.svg`}
            alt="Trustpilot rating stars"
            width={100}
            height={19}
            className="h-[19px] w-auto"
          />
          <span className="text-base font-medium leading-6">Trustpilot</span>
        </div>
      </div>
    </section>
  );
}
