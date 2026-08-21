import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { AngleRightIcon } from './icons'

/**
 * The source has exactly two CTA treatments, and they are not variants of one
 * shape — card-level CTAs are plain text links, not bordered pills.
 *
 * `solid` = `.transform-bg-btn`, the section-level pill:
 *   background-image: linear-gradient(90deg, #031242 50%, #1B48D9 100%)
 *   background-size: 200% 100%;  background-position: 0 0
 *   transition: background-position 0.3s
 *   border-radius: 60px;  padding: 10px 30px (lg);  no border, no shadow
 *   label 18px/500 -> 24px at lg (line-height 28.8px); chevron 20px, weight 900
 *
 * Hover slides the background to `100% 0`, which brings the #1B48D9 end of the
 * ramp into view. (Inferred from the gradient geometry and the transition
 * property — the live hover probe would not register in the preview pane.)
 *
 * `link` = the card-level CTA: no background, no border, no padding.
 *   color #0096F7, hover #006EF5; gap 8px; label 16px/500 (line-height 21.28px);
 *   chevron 14px. `link-light` is the same on dark surfaces.
 */
type Variant = 'solid' | 'link' | 'link-light'

export function PillButton({
  children,
  variant = 'solid',
  className,
  withArrow = true,
}: {
  children: ReactNode
  variant?: Variant
  className?: string
  withArrow?: boolean
}) {
  if (variant === 'solid') {
    return (
      <button
        type="button"
        className={cn(
          'dyna-cta-gradient inline-flex items-center justify-center gap-3.5 rounded-[60px] py-2.5 pl-6 pr-5 text-white',
          'lg:gap-2.5 lg:px-[30px]',
          className,
        )}
      >
        <span className="justify-center text-lg font-medium leading-[1.2] lg:text-2xl lg:leading-[28.8px]">
          {children}
        </span>
        {withArrow ? <AngleRightIcon className="h-5 w-5 shrink-0" /> : null}
      </button>
    )
  }

  // Source hover on these CTAs is a gap collapse, not an arrow translate:
  // `.group:hover .group-hover:gap-[2px] { gap: 2px }` — 8px closes to 2px,
  // pulling the chevron toward the label. Colour goes #0096F7 -> #006EF5.
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[60px] bg-transparent p-0 transition-[color,gap] duration-300 hover:gap-[2px]',
        variant === 'link'
          ? 'text-[#0096F7] hover:text-[#006EF5]'
          : 'text-white hover:text-white/75',
        className,
      )}
    >
      <span className="justify-center text-base font-medium leading-[21.28px]">{children}</span>
      {withArrow ? <AngleRightIcon className="h-3.5 w-3.5 shrink-0" /> : null}
    </button>
  )
}
