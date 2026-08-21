import { Aftermarket } from '@/components/home/Aftermarket'
import { BuildOnDomains } from '@/components/home/BuildOnDomains'
import { BuyAndRegister } from '@/components/home/BuyAndRegister'
import { ContactCta } from '@/components/home/ContactCta'
import { FaqSection } from '@/components/home/FaqSection'
import { GrowWithUs } from '@/components/home/GrowWithUs'
import { Hero } from '@/components/home/Hero'
import { HotAuctions } from '@/components/home/HotAuctions'
import { Spotlight } from '@/components/home/Spotlight'
import { StatsBar } from '@/components/home/StatsBar'
import { WhyDynadot } from '@/components/home/WhyDynadot'
import { HeroAdRail } from '@/components/home/ads/HeroAdRail'
import { createStaticPageMetadata } from '@/lib/seo'

export const metadata = createStaticPageMetadata('/')

export default function HomePage() {
  return (
    <div className="home-redesign-container bg-dyna-page">
      <Hero footer={<HeroAdRail />} />
      <StatsBar />
      <HotAuctions />
      <Spotlight />
      <BuyAndRegister />
      <Aftermarket />
      <BuildOnDomains />
      <WhyDynadot />
      <GrowWithUs />
      <ContactCta />
      <FaqSection />
    </div>
  )
}
