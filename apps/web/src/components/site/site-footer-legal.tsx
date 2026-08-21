import Link from 'next/link'

const legalLinks = [
  ['/legal/privacy', '隐私说明'],
  ['/legal/realname', '实名说明'],
  ['/legal/payment', '支付说明'],
  ['/legal/terms', '使用条款'],
  ['/legal/cookies', 'Cookie 说明'],
  ['/legal/advertising', '广告说明'],
] as const

export function FooterLegalLinks() {
  return (
    <nav aria-label="法律文档" className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
      {legalLinks.map(([href, label]) => (
        <Link className="hover:text-dyna-navy" href={href} key={href}>
          {label}
        </Link>
      ))}
    </nav>
  )
}
