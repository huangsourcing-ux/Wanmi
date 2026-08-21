'use client'

import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'

const PricingResults = dynamic(
  () => import('./pricing-results').then((module) => module.PricingResults),
  { loading: PricingLoadingState, ssr: false },
)

function PricingLoadingState() {
  return (
    <div className="mx-auto mb-16 min-h-[36rem] w-[calc(100%-2rem)] max-w-7xl sm:w-[calc(100%-3rem)] lg:w-[calc(100%-4rem)]">
      <div aria-busy="true" className="rounded-xl border bg-card p-6" role="status">
        正在计算默认 TLD 的 1 年与 3 年成本，请稍候…
      </div>
    </div>
  )
}

export function DeferredPricingResults() {
  const [ready, setReady] = useState(false)
  const markerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const marker = markerRef.current
    if (!marker || typeof IntersectionObserver === 'undefined') {
      setReady(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry || entry.intersectionRatio < 0.75) return
        setReady(true)
        observer.disconnect()
      },
      { threshold: 0.75 },
    )
    observer.observe(marker)
    return () => observer.disconnect()
  }, [])

  return <div ref={markerRef}>{ready ? <PricingResults /> : <PricingLoadingState />}</div>
}
