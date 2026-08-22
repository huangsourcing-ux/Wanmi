import Link from 'next/link'

/** Legal document links carried over unchanged from the previous site footer. */
const legalLinks = [
  { href: '/legal/privacy', label: '隐私说明' },
  { href: '/legal/realname', label: '实名说明' },
  { href: '/legal/payment', label: '支付说明' },
  { href: '/legal/terms', label: '使用条款' },
  { href: '/legal/cookies', label: 'Cookie 说明' },
  { href: '/legal/advertising', label: '广告说明' },
] as const

export function LegalLinks() {
  return (
    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {legalLinks.map(({ href, label }) => (
        <Link
          className="rounded-sm underline underline-offset-4 hover:text-foreground focus-visible:outline-ring"
          href={href}
          key={href}
        >
          {label}
        </Link>
      ))}
    </p>
  )
}
