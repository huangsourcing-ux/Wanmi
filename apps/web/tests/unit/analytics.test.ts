// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  bucketDuration,
  classifyDevice,
  classifyPageType,
  classifySource,
  emitFirstPartyEvent,
  inferToolInput,
  isTrackingOptedOut,
} from '@/lib/analytics'
import {
  FIRST_PARTY_EVENT_SCHEMA_VERSION,
  firstPartyDurationBucketSchema,
  firstPartyEventSchema,
} from '@/schemas/analytics'

function setPrivacyPreference(target: object, name: string, value: unknown) {
  Object.defineProperty(target, name, { configurable: true, value })
}

afterEach(() => {
  setPrivacyPreference(navigator, 'doNotTrack', undefined)
  setPrivacyPreference(navigator, 'globalPrivacyControl', undefined)
  setPrivacyPreference(navigator, 'msDoNotTrack', undefined)
  setPrivacyPreference(window, 'doNotTrack', undefined)
  vi.unstubAllGlobals()
})

describe('D1 first-party analytics contract', () => {
  it('accepts only approved aggregate dimensions and normalizes a single-label TLD', () => {
    expect(
      firstPartyEventSchema.parse({
        event: 'tool_submitted',
        fromLocalHistory: false,
        inputType: 'full_domain',
        schemaVersion: FIRST_PARTY_EVENT_SCHEMA_VERSION,
        tld: 'NET',
        tool: 'domain-search',
      }),
    ).toEqual({
      event: 'tool_submitted',
      fromLocalHistory: false,
      inputType: 'full_domain',
      schemaVersion: 1,
      tld: 'net',
      tool: 'domain-search',
    })

    for (const durationBucket of firstPartyDurationBucketSchema.options) {
      expect(
        firstPartyEventSchema.safeParse({
          dataSource: 'whodat',
          durationBucket,
          event: 'tool_completed',
          resultCategory: 'ready',
          schemaVersion: 1,
          succeeded: true,
          tld: 'net',
          tool: 'whois',
        }).success,
      ).toBe(true)
    }
  })

  it('buckets tool durations without exposing raw timings', () => {
    expect(
      [99, 100, 299, 300, 999, 1_000, 2_999, 3_000, 9_999, 10_000].map(bucketDuration),
    ).toEqual([
      'lt_100ms',
      '100_299ms',
      '100_299ms',
      '300_999ms',
      '300_999ms',
      '1000_2999ms',
      '1000_2999ms',
      '3000_9999ms',
      '3000_9999ms',
      'gte_10000ms',
    ])
  })

  it('rejects complete domains, raw locations, arbitrary metadata and sensitive fields', () => {
    const base = {
      event: 'tool_submitted',
      fromLocalHistory: false,
      inputType: 'full_domain',
      schemaVersion: 1,
      tool: 'domain-search',
    }
    for (const candidate of [
      { ...base, tld: 'wanmi.net' },
      { ...base, domain: 'wanmi.net', tld: 'net' },
      { ...base, query: 'wanmi.net', tld: 'net' },
      { ...base, cookie: 'wanmi_admin=secret', tld: 'net' },
      { ...base, metadata: { token: 'secret' }, tld: 'net' },
      {
        deviceCategory: 'desktop',
        event: 'page_viewed',
        pageType: 'tool',
        referrer: 'https://example.test/?q=wanmi.net',
        schemaVersion: 1,
        source: 'referral',
      },
    ]) {
      expect(firstPartyEventSchema.safeParse(candidate).success).toBe(false)
    }
  })

  it('classifies pages, sources, devices and domain input without returning the full query', () => {
    expect(classifyPageType('/')).toBe('home')
    expect(classifyPageType('/tools/domain-search')).toBe('tool')
    expect(classifyPageType('/legal/privacy')).toBe('legal')
    expect(classifySource('', 'https://wanmi.net')).toBe('direct')
    expect(classifySource('https://wanmi.net/tools?q=secret', 'https://wanmi.net')).toBe('internal')
    expect(classifySource('https://www.baidu.com/s?wd=wanmi', 'https://wanmi.net')).toBe('search')
    expect(classifySource('https://weibo.com/example', 'https://wanmi.net')).toBe('social')
    expect(classifySource('https://example.com/path', 'https://wanmi.net')).toBe('referral')
    expect(classifyDevice(390)).toBe('mobile')
    expect(classifyDevice(900)).toBe('tablet')
    expect(classifyDevice(1_440)).toBe('desktop')
    expect(inferToolInput('wanmi.net')).toEqual({ inputType: 'full_domain', tld: 'net' })
    expect(inferToolInput('万米.中国')).toEqual({
      inputType: 'full_domain',
      tld: 'xn--fiqs8s',
    })
    expect(inferToolInput('品牌关键词')).toEqual({ inputType: 'keyword' })
    expect(inferToolInput('')).toEqual({ inputType: 'unknown' })
  })

  it('honors DNT and GPC without sending any request', () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    setPrivacyPreference(navigator, 'doNotTrack', '1')
    expect(isTrackingOptedOut()).toBe(true)
    emitFirstPartyEvent({
      deviceCategory: 'desktop',
      event: 'page_viewed',
      pageType: 'home',
      schemaVersion: 1,
      source: 'direct',
    })
    expect(fetch).not.toHaveBeenCalled()

    setPrivacyPreference(navigator, 'doNotTrack', 'yes')
    expect(isTrackingOptedOut()).toBe(true)

    setPrivacyPreference(navigator, 'doNotTrack', undefined)
    setPrivacyPreference(navigator, 'globalPrivacyControl', true)
    expect(isTrackingOptedOut()).toBe(true)
    emitFirstPartyEvent({
      deviceCategory: 'desktop',
      event: 'page_viewed',
      pageType: 'home',
      schemaVersion: 1,
      source: 'direct',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses a same-origin best-effort request without credentials or a full referrer', () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    emitFirstPartyEvent({
      event: 'tool_submitted',
      fromLocalHistory: false,
      inputType: 'full_domain',
      schemaVersion: 1,
      tld: 'net',
      tool: 'domain-search',
    })

    expect(fetch).toHaveBeenCalledWith('/api/v1/events', {
      body: JSON.stringify({
        event: 'tool_submitted',
        fromLocalHistory: false,
        inputType: 'full_domain',
        schemaVersion: 1,
        tld: 'net',
        tool: 'domain-search',
      }),
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      method: 'POST',
      referrerPolicy: 'origin',
    })
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('wanmi.net')
  })
})
