import type { Metadata } from 'next'

import { DomainAssetsPanel } from '@/components/domains/domain-assets'
import { PageIntro } from '@/components/site/page-intro'

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: '我的域名',
}

export default function DomainsPage() {
  return (
    <>
      <PageIntro
        badge="域名资产"
        description="只显示当前登录账号拥有的域名；资产事实来自服务端保存的最近一次上游确认。"
        title="我的域名"
      />
      <section className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <DomainAssetsPanel />
      </section>
    </>
  )
}
