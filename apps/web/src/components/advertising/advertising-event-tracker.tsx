'use client'

import type { MouseEvent, ReactNode } from 'react'
import { useEffect, useRef } from 'react'

import { emitFirstPartyEvent, rememberPendingAdConversion } from '@/lib/analytics'
import type { FirstPartyAdPageType } from '@/schemas/analytics'

export const AD_VIEWABLE_RATIO = 0.5
export const AD_VIEWABLE_DURATION_MS = 1_000

type AdEventContext = {
  campaignId: string
  pageType: FirstPartyAdPageType
  placementCode: string
}

function emitRequested(pageType: FirstPartyAdPageType, placementCode: string): void {
  emitFirstPartyEvent({
    event: 'ad_requested',
    pageType,
    placementCode,
    schemaVersion: 1,
  })
}

export function AdRequestTracker({
  pageType,
  placementCode,
}: {
  pageType: FirstPartyAdPageType
  placementCode: string
}) {
  const requestedContext = useRef<string | null>(null)
  useEffect(() => {
    const contextKey = `${pageType}:${placementCode}`
    if (requestedContext.current === contextKey) return
    requestedContext.current = contextKey
    emitRequested(pageType, placementCode)
  }, [pageType, placementCode])
  return null
}

export function AdvertisingEventTracker({
  campaignId,
  children,
  className,
  external,
  label,
  pageType,
  placementCode,
}: AdEventContext & {
  children: ReactNode
  className?: string
  external: boolean
  label: string
}) {
  const rootRef = useRef<HTMLElement>(null)
  const served = useRef(false)
  const viewable = useRef(false)
  const viewableTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sufficientlyVisible = useRef(false)
  const requestedContext = useRef<string | null>(null)
  const observedContext = useRef<string | null>(null)

  useEffect(() => {
    const contextKey = `${campaignId}:${pageType}:${placementCode}`
    if (requestedContext.current === contextKey) return
    requestedContext.current = contextKey
    emitRequested(pageType, placementCode)
  }, [campaignId, pageType, placementCode])

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return

    const contextKey = `${campaignId}:${pageType}:${placementCode}`
    if (observedContext.current !== contextKey) {
      observedContext.current = contextKey
      served.current = false
      viewable.current = false
      sufficientlyVisible.current = false
    }

    const cancelViewableTimer = () => {
      if (viewableTimer.current) clearTimeout(viewableTimer.current)
      viewableTimer.current = null
    }
    const armViewableTimer = () => {
      if (
        viewable.current ||
        viewableTimer.current ||
        !sufficientlyVisible.current ||
        document.visibilityState !== 'visible'
      ) {
        return
      }
      viewableTimer.current = setTimeout(() => {
        viewableTimer.current = null
        if (
          viewable.current ||
          !sufficientlyVisible.current ||
          document.visibilityState !== 'visible'
        ) {
          return
        }
        viewable.current = true
        emitFirstPartyEvent({
          campaignId,
          event: 'ad_viewable',
          pageType,
          placementCode,
          schemaVersion: 1,
        })
      }, AD_VIEWABLE_DURATION_MS)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') armViewableTimer()
      else cancelViewableTimer()
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        if (entry.isIntersecting && entry.intersectionRatio > 0 && !served.current) {
          served.current = true
          emitFirstPartyEvent({
            campaignId,
            event: 'ad_served',
            pageType,
            placementCode,
            schemaVersion: 1,
          })
        }
        sufficientlyVisible.current =
          entry.isIntersecting && entry.intersectionRatio >= AD_VIEWABLE_RATIO
        if (sufficientlyVisible.current) armViewableTimer()
        else cancelViewableTimer()
      },
      { threshold: [0, AD_VIEWABLE_RATIO] },
    )
    observer.observe(root)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelViewableTimer()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [campaignId, pageType, placementCode])

  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target.closest('[data-ad-click]') : null
    if (!target) return
    emitFirstPartyEvent({
      campaignId,
      event: 'ad_clicked',
      pageType,
      placementCode,
      schemaVersion: 1,
    })
    if (
      !external &&
      event.button === 0 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      rememberPendingAdConversion({ campaignId, pageType, placementCode })
    }
  }

  return (
    <aside
      aria-label={label}
      className={className}
      data-ad-placement={placementCode}
      data-commercial-content="advertisement"
      onClickCapture={onClickCapture}
      ref={rootRef}
    >
      {children}
    </aside>
  )
}
