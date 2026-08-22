import { Aftermarket } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/Aftermarket";
import { BuildOnDomains } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/BuildOnDomains";
import { BuyAndRegister } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/BuyAndRegister";
import { ChatbotBubble } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/ChatbotBubble";
import { OverlayProvider } from "@/components/sites/www-dynadot-com-7f8c2392/shared/OverlayScrim";
import { ContactCta } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/ContactCta";
import { FaqSection } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/FaqSection";
import { GrowWithUs } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/GrowWithUs";
import { Hero } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/Hero";
import { HotAuctions } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/HotAuctions";
import { SiteFooter } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/SiteFooter";
import { SiteHeader } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/SiteHeader";
import { Spotlight } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/Spotlight";
import { StatsBar } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/StatsBar";
import { WhyDynadot } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/WhyDynadot";
import { HeroAdRail } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/ads/HeroAdRail";

/**
 * Clone of https://www.dynadot.com/
 * Section order and measurements: docs/research/www-dynadot-com-7f8c2392/root-8a5edab2/PAGE_TOPOLOGY.md
 *
 * The header is absolutely positioned over the hero (it is not sticky on the
 * source), so it sits as a sibling of <main> inside the relative wrapper.
 *
 * `HeroAdRail` rides in the hero's footer slot — the ad inventory lives on the
 * hero plate under the search card, which is a deliberate departure from the
 * source page.
 */
export default function Home() {
  return (
    <OverlayProvider>
      <div className="dyna-content relative w-full">
        <SiteHeader />

        <main>
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
        </main>

        <SiteFooter />
        <ChatbotBubble />
      </div>
    </OverlayProvider>
  );
}
