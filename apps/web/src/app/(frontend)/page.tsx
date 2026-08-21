import { ContactCta } from '@/components/site-shell/contact-cta'
import { ContentExplorer } from '@/components/site-shell/content-explorer'
import { Hero } from '@/components/site-shell/hero'
import { HomeAdPlaceholder } from '@/components/site-shell/home-ad-placeholder'
import { ToolShowcase } from '@/components/site-shell/tool-showcase'
import { WhyWanmi } from '@/components/site-shell/why-wanmi'
import { getPublicSiteData } from '@/lib/public-site-data'
import { createStaticPageMetadata } from '@/lib/seo'

export const metadata = createStaticPageMetadata('/')

export default async function HomePage() {
  const data = await getPublicSiteData()

  return (
    <>
      <Hero />
      <HomeAdPlaceholder />
      <ToolShowcase />
      <WhyWanmi />
      <ContentExplorer sections={[data.articles, data.tldPages, data.topics]} />
      <ContactCta />
    </>
  )
}
