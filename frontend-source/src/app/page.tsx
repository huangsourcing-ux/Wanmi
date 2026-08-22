import { BuyAndRegister } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/BuyAndRegister";
import { OverlayProvider } from "@/components/sites/www-dynadot-com-7f8c2392/shared/OverlayScrim";
import { ContactCta } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/ContactCta";
import { FaqSection } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/FaqSection";
import { GrowWithUs } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/GrowWithUs";
import { Hero } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/Hero";
import { SiteFooter } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/SiteFooter";
import { SiteHeader } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/SiteHeader";
import { WhyDynadot } from "@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/WhyDynadot";

/**
 * Wanmi.net homepage. The layout is the dynadot.com clone's
 * (docs/research/www-dynadot-com-7f8c2392/root-8a5edab2/PAGE_TOPOLOGY.md);
 * the sections that correspond to products this site does not offer
 * (auctions, aftermarket, website builder, email, stats bar, ad rail, chat
 * bubble, login modal) are gone rather than left as dead links.
 *
 * The header is absolutely positioned over the hero (it is not sticky on the
 * source), so it sits as a sibling of <main> inside the relative wrapper.
 */
export default function Home() {
  return (
    <OverlayProvider>
      <div className="dyna-content relative w-full">
        <SiteHeader />

        <main>
          <div className="home-redesign-container bg-dyna-page">
            <Hero />
            <BuyAndRegister />
            <WhyDynadot />
            <GrowWithUs />
            <ContactCta />
            <FaqSection />
          </div>
        </main>

        <SiteFooter />
      </div>
    </OverlayProvider>
  );
}
