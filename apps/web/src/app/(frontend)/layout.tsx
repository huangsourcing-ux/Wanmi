import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Suspense, type ReactNode } from 'react'

import { PageViewTracker } from '@/components/analytics/page-view-tracker'
import { LocalToolLibraryProvider } from '@/components/local-library/local-tool-library-provider'
import { RequestIdProvider } from '@/components/request-context'
import { SiteFooter } from '@/components/site/site-footer'
import { HeroSearchTracking } from '@/components/home/hero-search-tracking'
import { SiteHeader } from '@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/SiteHeader'
import { OverlayProvider } from '@/components/sites/www-dynadot-com-7f8c2392/shared/OverlayScrim'
import { getPublicComplianceConfig } from '@/lib/public-compliance'
import { getTraceId } from '@/lib/request-id'
import { getSiteOrigin, SITE_DESCRIPTION, SITE_TITLE } from '@/lib/seo'

import './styles.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  applicationName: 'Wanmi.net',
  description: SITE_DESCRIPTION,
  metadataBase: getSiteOrigin(),
  title: { default: SITE_TITLE, template: '%s｜Wanmi.net' },
}

const skipLinkClassName =
  'fixed top-2 left-2 z-[100] -translate-y-20 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:translate-y-0 focus:outline-none'

export default async function FrontendLayout({ children }: { children: ReactNode }) {
  const [compliance, requestHeaders] = await Promise.all([getPublicComplianceConfig(), headers()])
  return (
    <html data-scroll-behavior="smooth" lang="zh-CN">
      <body>
        <Suspense fallback={null}>
          <PageViewTracker />
        </Suspense>
        <RequestIdProvider requestId={getTraceId(requestHeaders)}>
          <LocalToolLibraryProvider>
            <HeroSearchTracking />
            <a className={skipLinkClassName} href="#main-content">
              跳到主要内容
            </a>
            <OverlayProvider>
              <div className="dyna-content relative flex min-h-screen w-full flex-col font-sans">
                <SiteHeader />
                <main id="main-content" tabIndex={-1}>
                  {children}
                </main>
                <SiteFooter compliance={compliance} />
              </div>
            </OverlayProvider>
          </LocalToolLibraryProvider>
        </RequestIdProvider>
      </body>
    </html>
  )
}
