import { DeferredHomeSections } from '@/components/home/DeferredHomeSections'
import { Hero } from '@/components/home/Hero'
import { HeroAdRail } from '@/components/home/ads/HeroAdRail'
import { createStaticPageMetadata } from '@/lib/seo'

import './home.css'

export const metadata = createStaticPageMetadata('/')

export default function HomePage() {
  return (
    <div className="home-redesign-container bg-dyna-page">
      <Hero footer={<HeroAdRail />} />
      <DeferredHomeSections />
    </div>
  )
}
