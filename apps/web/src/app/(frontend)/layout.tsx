import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { SiteFooter } from '@/components/site/site-footer'
import { SiteHeader } from '@/components/site/site-header'
import { getPublicSiteData } from '@/lib/public-site-data'

import './styles.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  applicationName: 'Wanmi.net',
  description: '面向中文用户的域名查询、WHOIS、DNS、SSL、IDN 与 TLD 价格工具入口。',
  title: {
    default: 'Wanmi.net｜中文域名工具与服务入口',
    template: '%s｜Wanmi.net',
  },
}

export default async function FrontendLayout({ children }: { children: ReactNode }) {
  const data = await getPublicSiteData()

  return (
    <html data-scroll-behavior="smooth" lang="zh-CN">
      <body>
        <a
          className="fixed top-2 left-2 z-[100] -translate-y-20 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:translate-y-0 focus:outline-none"
          href="#main-content"
        >
          跳到主要内容
        </a>
        <div className="flex min-h-screen flex-col">
          <SiteHeader items={data.navigation.items} />
          <main className="flex-1" id="main-content" tabIndex={-1}>
            {children}
          </main>
          <SiteFooter />
        </div>
      </body>
    </html>
  )
}
