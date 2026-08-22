import { BuyAndRegister } from '@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/BuyAndRegister'
import { ContactCta } from '@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/ContactCta'
import { FaqSection } from '@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/FaqSection'
import { GrowWithUs } from '@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/GrowWithUs'
import { Hero } from '@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/Hero'
import { WhyDynadot } from '@/components/sites/www-dynadot-com-7f8c2392/root-8a5edab2/WhyDynadot'
import { createStaticPageMetadata } from '@/lib/seo'

export const metadata = createStaticPageMetadata('/')

/** frontend-source/src/app/page.tsx, <main> contents only; the shell lives in layout.tsx. */
export default function HomePage() {
  return (
    <div className="home-redesign-container bg-dyna-page">
      <Hero />
      <BuyAndRegister />
      <WhyDynadot />
      <GrowWithUs />
      <ContactCta />
      <FaqSection />
    </div>
  )
}
