import { Aftermarket } from './Aftermarket'
import { BuildOnDomains } from './BuildOnDomains'
import { BuyAndRegister } from './BuyAndRegister'
import { ContactCta } from './ContactCta'
import { FaqSection } from './FaqSection'
import { GrowWithUs } from './GrowWithUs'
import { HotAuctions } from './HotAuctions'
import { Spotlight } from './Spotlight'
import { StatsBar } from './StatsBar'
import { WhyDynadot } from './WhyDynadot'

export function DeferredHomeContent() {
  return (
    <>
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
    </>
  )
}
