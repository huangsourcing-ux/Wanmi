import type { ReactNode } from 'react'
import { HeroSearch } from './HeroSearch'

export function Hero({ footer }: { footer?: ReactNode }) {
  return (
    <section className="dyna-hero relative z-10 w-full overflow-hidden rounded-bl-[20px] rounded-br-[20px] bg-[linear-gradient(225deg,#000f3e_48.66%,#082ea8_100%)] pt-[96px] md:rounded-bl-[30px] md:rounded-br-[30px]">
      <div
        aria-hidden="true"
        className="dyna-hero-search-scrim pointer-events-none fixed inset-0 z-40 bg-[#000E3F]/50 opacity-0 backdrop-blur-[4px] transition-all duration-300"
      />
      <div
        className={`dyna-hero-content relative z-10 flex flex-col items-center justify-center px-5 pb-20 text-center text-white md:px-0 ${footer ? 'md:pb-8' : 'md:pb-[140px]'}`}
      >
        <div className="dyna-gradient-border dyna-eyebrow-border relative -mx-[6px] mt-10 inline-flex w-fit items-center justify-center rounded-[90px] bg-[linear-gradient(90deg,rgba(14,165,233,.2),rgba(232,121,249,.2),rgba(250,204,21,.2))] px-[30px] py-1.5 md:mt-[60px]">
          <div className="dyna-gradient-text bg-[linear-gradient(90deg,#63C2FF_0%,#F098FF_50%,#FFF75F_100%)] text-center text-[18px] font-medium leading-[27px]">
            Your Super-Powered Domain Marketplace
          </div>
        </div>

        <h1 className="mt-10 font-heading text-[40px] leading-[1.1] tracking-[-0.72px] text-white md:text-[60px] md:leading-[66px]">
          Empower Your{' '}
          <span className="dyna-gradient-text inline-block bg-[linear-gradient(90deg,#63C2FF_0%,#F098FF_50%,#FFF75F_100%)] capitalize">
            Domains
          </span>
        </h1>

        <HeroSearch />
        {footer}
      </div>
    </section>
  )
}
