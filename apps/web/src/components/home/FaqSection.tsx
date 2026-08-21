'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { CirclePlusIcon } from '@/components/home/shared/icons'
import { FAQS } from './site-data'

/**
 * INTERACTION MODEL: click accordion, all panels closed on load, each item
 * toggles independently (verified: panel height 0 for all 14, first included).
 *
 * LAYOUT: two columns, not a centred stack.
 *   heading  — absolutely positioned at left 120 / top 200, `max-w: 325px`,
 *              48px/700 Swansea `line-height: 63.84px`, left-aligned, white
 *   list     — left 712, width 600
 * A 307x307 radial-gradient disc sits at `left: -122 / top: -125` and scales to
 * 1180x1180 at xl.
 */
export function FaqSection() {
  const [open, setOpen] = useState<number[]>([])

  const toggle = (i: number) =>
    setOpen((prev) => (prev.includes(i) ? prev.filter((v) => v !== i) : [...prev, i]))

  return (
    <div className="relative inline-flex w-full items-center justify-center overflow-hidden bg-[#031242] md:bg-[radial-gradient(100%_100%_at_50%_0%,#031242_22%,#002086_75%,#093698_99%)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-[-122px] top-[-125px] h-[307px] w-[307px] rounded-full bg-[radial-gradient(66.78%_63.2%_at_81.44%_91.96%,#98CFFF_0%,#0076DD_43.38%,#031242_100%)] xl:left-[-556px] xl:top-[-419px] xl:h-[1180px] xl:w-[1180px]"
      />

      {/* List starts 80px below the section top; 32px tail brings the section
          to the measured 1118px. */}
      <div className="relative flex w-full max-w-1440 flex-col px-7 py-20 md:px-14 xl:flex-row xl:px-[120px] xl:pb-8 xl:pt-20">
        <h2 className="w-full justify-start p-0 font-heading text-[32px] font-bold leading-[1.33] text-white xl:absolute xl:left-[120px] xl:top-[200px] xl:min-w-[325px] xl:max-w-[325px] xl:text-5xl xl:leading-[63.84px]">
          Domain Name FAQs
        </h2>

        <div className="relative mt-8 inline-flex w-full flex-col items-start justify-start rounded-[20px] xl:ml-auto xl:mt-0 xl:min-w-[600px] xl:max-w-[600px]">
          {FAQS.map((faq, i) => {
            const isOpen = open.includes(i)
            return (
              <div
                key={faq.question}
                className="flex flex-col items-start justify-start self-stretch border-0 border-b border-solid border-[rgba(238,242,255,0.2)] py-5"
              >
                <button
                  type="button"
                  onClick={() => toggle(i)}
                  aria-expanded={isOpen}
                  className="inline-flex cursor-pointer items-center justify-between gap-2 self-stretch text-left"
                >
                  <h3 className="text-[18px] font-semibold leading-6 text-dyna-indigo-50">
                    {faq.question}
                  </h3>
                  <CirclePlusIcon
                    className={cn(
                      'h-5 w-5 shrink-0 text-dyna-indigo-50 transition-transform duration-300',
                      isOpen && 'rotate-45',
                    )}
                  />
                </button>

                <div
                  className={cn(
                    'grid w-full transition-[grid-template-rows] duration-300 ease-out',
                    isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                  )}
                >
                  <div className="overflow-hidden">
                    <div className="flex flex-col gap-4 pr-8 pt-4">
                      {faq.answer.map((para) => (
                        <p
                          key={para.slice(0, 24)}
                          className="text-[15px] leading-[26px] text-white/80"
                        >
                          {para}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
