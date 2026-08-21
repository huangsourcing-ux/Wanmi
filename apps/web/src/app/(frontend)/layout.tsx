import type { Metadata } from 'next'
import { headers } from 'next/headers'
import type { ReactNode } from 'react'
import { Suspense } from 'react'

import { PageViewTracker } from '@/components/analytics/page-view-tracker'
import { ChatbotBubble } from '@/components/home/ChatbotBubble'
import { OverlayProvider } from '@/components/home/shared/OverlayScrim'
import { RequestIdProvider } from '@/components/request-context'
import { MainOffset } from '@/components/site/main-offset'
import { SiteFooter } from '@/components/site/site-footer'
import { SiteHeader } from '@/components/site/site-header'
import { getPublicComplianceConfig } from '@/lib/public-compliance'
import { getTraceId } from '@/lib/request-id'
import { getSiteOrigin, SITE_DESCRIPTION, SITE_TITLE } from '@/lib/seo'

import './styles.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  applicationName: 'Wanmi.net',
  description: SITE_DESCRIPTION,
  metadataBase: getSiteOrigin(),
  title: {
    default: SITE_TITLE,
    template: '%s｜Wanmi.net',
  },
}

export default async function FrontendLayout({ children }: { children: ReactNode }) {
  const [compliance, requestHeaders] = await Promise.all([getPublicComplianceConfig(), headers()])

  return (
    <html data-scroll-behavior="smooth" lang="zh-CN">
      <body>
        <Suspense fallback={null}>
          <PageViewTracker />
        </Suspense>
        <RequestIdProvider requestId={getTraceId(requestHeaders)}>
          <a
            className="fixed top-2 left-2 z-[100] -translate-y-20 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:translate-y-0 focus:outline-none"
            href="#main-content"
          >
            跳到主要内容
          </a>
          <div className="dyna-content relative flex min-h-screen w-full flex-col">
            <OverlayProvider>
              <SiteHeader />
            </OverlayProvider>
            <MainOffset>{children}</MainOffset>
            <ChatbotBubble />
            <SiteFooter compliance={compliance} />
          </div>
        </RequestIdProvider>
      </body>
    </html>
  )
}
