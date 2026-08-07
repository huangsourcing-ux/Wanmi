// @vitest-environment jsdom

import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AD_VIEWABLE_DURATION_MS,
  AdvertisingEventTracker,
} from '@/components/advertising/advertising-event-tracker'
import { consumePendingAdConversion } from '@/lib/analytics'

const campaignId = '3c9cc764-74fd-4baa-94e9-48865e85efb1'
let intersectionCallback: IntersectionObserverCallback | undefined

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds = [0, 0.5]
  disconnect = vi.fn()
  observe = vi.fn()
  takeRecords = vi.fn(() => [])
  unobserve = vi.fn()

  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback
  }
}

function setPrivacyPreference(name: string, value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, value })
}

function eventBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string) as { event: string })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
  setPrivacyPreference('doNotTrack', undefined)
  setPrivacyPreference('globalPrivacyControl', undefined)
  intersectionCallback = undefined
})

describe('D3 advertising viewability and privacy events', () => {
  it('records request, viewport entry, continuous viewability, click and internal conversion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

    const view = render(
      <AdvertisingEventTracker
        campaignId={campaignId}
        external={false}
        label="测试广告"
        pageType="tool"
        placementCode="tool-after-result"
      >
        <a data-ad-click href="#advertising-event-test" onClick={(event) => event.preventDefault()}>
          测试广告
        </a>
      </AdvertisingEventTracker>,
    )
    await waitFor(() =>
      expect(eventBodies(fetchMock).map(({ event }) => event)).toContain('ad_requested'),
    )
    vi.useFakeTimers()

    act(() => {
      intersectionCallback?.(
        [{ intersectionRatio: 0.1, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })
    expect(eventBodies(fetchMock).map(({ event }) => event)).toContain('ad_served')

    act(() => {
      intersectionCallback?.(
        [{ intersectionRatio: 0.5, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
      vi.advanceTimersByTime(AD_VIEWABLE_DURATION_MS)
    })
    expect(eventBodies(fetchMock).map(({ event }) => event)).toContain('ad_viewable')

    fireEvent.click(view.getByRole('link', { name: '测试广告' }))
    expect(eventBodies(fetchMock).map(({ event }) => event)).toContain('ad_clicked')
    consumePendingAdConversion()
    expect(eventBodies(fetchMock).map(({ event }) => event)).toContain('ad_converted')
    expect(JSON.stringify(eventBodies(fetchMock))).not.toMatch(/domain|query|user|crossSite/i)
  })

  it.each([
    ['doNotTrack', '1'],
    ['globalPrivacyControl', true],
  ] as const)('emits and stores nothing when %s opts out', async (name, value) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    setPrivacyPreference(name, value)
    const view = render(
      <AdvertisingEventTracker
        campaignId={campaignId}
        external={false}
        label="隐私广告"
        pageType="tool"
        placementCode="tool-after-result"
      >
        <a
          data-ad-click
          href="#advertising-privacy-test"
          onClick={(event) => event.preventDefault()}
        >
          隐私广告
        </a>
      </AdvertisingEventTracker>,
    )
    fireEvent.click(view.getByRole('link', { name: '隐私广告' }))
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(window.sessionStorage.length).toBe(0)
  })
})
