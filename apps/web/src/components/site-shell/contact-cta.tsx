import Link from 'next/link'
import { ArrowUpRightIcon } from 'lucide-react'

export function ContactCta() {
  return (
    <section className="overflow-hidden bg-[radial-gradient(55%_130%_at_50%_0%,#c5ddff_0%,#ebf3ff_100%)] px-4 py-14 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[75rem] flex-col items-center justify-between gap-7 text-center sm:flex-row sm:text-left">
        <div>
          <p className="text-sm font-semibold tracking-[0.16em] text-[#3255c3] uppercase">
            需要帮助？
          </p>
          <h2 className="mt-2 font-heading text-2xl font-semibold tracking-[-0.025em] text-[#031242] sm:text-3xl">
            告诉我们你遇到的域名问题
          </h2>
        </div>
        <Link
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-[#031242] px-6 py-3 text-sm font-semibold text-white shadow-[0_16px_34px_-20px_rgba(3,18,66,0.8)] transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[#3255c3]/60 focus-visible:ring-offset-2 focus-visible:outline-none"
          href="/contact"
        >
          联系我们
          <ArrowUpRightIcon aria-hidden="true" className="size-4" />
        </Link>
      </div>
    </section>
  )
}
