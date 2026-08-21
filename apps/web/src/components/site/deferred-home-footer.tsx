'use client'

import type { ComponentType } from 'react'
import { useEffect, useRef, useState } from 'react'

export function DeferredHomeFooter() {
  const markerRef = useRef<HTMLDivElement>(null)
  const [Footer, setFooter] = useState<ComponentType | null>(null)

  useEffect(() => {
    const marker = markerRef.current
    if (!marker || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void import('@/components/home/SiteFooter').then(({ SiteFooter }) => {
          setFooter(() => SiteFooter)
        })
      },
      { rootMargin: '600px 0px' },
    )

    observer.observe(marker)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="dyna-deferred-footer" ref={markerRef}>
      {Footer ? <Footer /> : null}
    </div>
  )
}
