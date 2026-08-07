'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'

import {
  classifyDevice,
  classifyPageType,
  classifySource,
  consumePendingAdConversion,
  emitFirstPartyEvent,
} from '@/lib/analytics'

export function PageViewTracker() {
  const pathname = usePathname()
  const hasTrackedNavigation = useRef(false)

  useEffect(() => {
    emitFirstPartyEvent({
      deviceCategory: classifyDevice(window.innerWidth),
      event: 'page_viewed',
      pageType: classifyPageType(pathname),
      schemaVersion: 1,
      source: hasTrackedNavigation.current
        ? 'internal'
        : classifySource(document.referrer, window.location.origin),
    })
    consumePendingAdConversion()
    hasTrackedNavigation.current = true
  }, [pathname])

  return null
}
