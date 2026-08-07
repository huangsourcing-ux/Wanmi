import Link from 'next/link'

import { Separator } from '@/components/ui/separator'

const footerGroups = [
  {
    links: [
      { href: '/tools', label: '工具中心' },
      { href: '/pricing', label: '价格中心' },
      { href: '/articles', label: '实用内容' },
      { href: '/topics', label: '专题与指南' },
    ],
    title: '发现',
  },
  {
    links: [
      { href: '/help', label: '帮助与数据来源' },
      { href: '/legal/privacy', label: '隐私说明' },
      { href: '/legal/terms', label: '使用条款' },
      { href: '/legal/cookies', label: 'Cookie 说明' },
      { href: '/legal/advertising', label: '广告说明' },
      { href: '/contact', label: '联系我们' },
      { href: '/feedback', label: '提交反馈' },
      { href: '/requests', label: '提交需求' },
    ],
    title: '帮助与合规',
  },
] as const

export function SiteFooter() {
  return (
    <footer className="border-t bg-card">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.5fr_1fr_1fr] lg:px-8">
        <div className="max-w-md">
          <Link className="text-lg font-semibold tracking-tight" href="/">
            Wanmi.net
          </Link>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            面向中文用户的域名工具、实用内容与代理注册平台。当前注册、支付和履约能力尚未开放。
          </p>
        </div>
        {footerGroups.map((group) => (
          <div key={group.title}>
            <h2 className="text-sm font-semibold">{group.title}</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link
                    className="rounded-sm hover:text-foreground focus-visible:outline-ring"
                    href={link.href}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <Separator />
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-5 text-xs leading-5 text-muted-foreground sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
        <p>© 2026 Wanmi.net。公开查询结果以所标注的数据来源和时间为准。</p>
        <p>生产服务上线前仍需完成资质、备案、合规复核及最终批准。</p>
      </div>
    </footer>
  )
}
