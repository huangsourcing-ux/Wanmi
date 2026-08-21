'use client'

import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'

const DeferredHomeContent = dynamic(
  () => import('./DeferredHomeContent').then((module) => module.DeferredHomeContent),
  { ssr: false },
)

export function DeferredHomeSections() {
  const [revealed, setRevealed] = useState(false)
  const markerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const marker = markerRef.current
    if (!marker || typeof IntersectionObserver === 'undefined') {
      setRevealed(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        setRevealed(true)
        observer.disconnect()
      },
      { threshold: 0.01 },
    )
    observer.observe(marker)
    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!revealed) return
    const stylesheet = document.createElement('link')
    stylesheet.rel = 'stylesheet'
    stylesheet.href = '/home/fonts/site-fonts.css'
    document.head.append(stylesheet)
    return () => stylesheet.remove()
  }, [revealed])

  if (!revealed) return <div ref={markerRef} aria-hidden="true" className="h-px" />

  return <DeferredHomeContent />
}
