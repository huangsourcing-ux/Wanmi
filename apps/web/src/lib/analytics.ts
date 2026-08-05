import type {
  FirstPartyDeviceCategory,
  FirstPartyDurationBucket,
  FirstPartyEventInput,
  FirstPartyInputType,
  FirstPartyPageType,
  FirstPartySource,
} from '@/schemas/analytics'

type PrivacyNavigator = Navigator & {
  globalPrivacyControl?: boolean
  msDoNotTrack?: string
}

type PrivacyWindow = Window & {
  doNotTrack?: string
}

const searchReferrers = [
  /(^|\.)baidu\.com$/,
  /(^|\.)bing\.com$/,
  /(^|\.)google\./,
  /(^|\.)so\.com$/,
  /(^|\.)sogou\.com$/,
]
const socialReferrers = [
  /(^|\.)douyin\.com$/,
  /(^|\.)qq\.com$/,
  /(^|\.)weibo\.com$/,
  /(^|\.)weixin\.qq\.com$/,
  /(^|\.)xiaohongshu\.com$/,
]
const tldPattern = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const hostnameLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function isTrackingOptedOut(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return true
  const privacyNavigator = navigator as PrivacyNavigator
  const privacyWindow = window as PrivacyWindow
  const doNotTrackValues = [
    privacyNavigator.doNotTrack,
    privacyNavigator.msDoNotTrack,
    privacyWindow.doNotTrack,
  ]
  return (
    privacyNavigator.globalPrivacyControl === true ||
    doNotTrackValues.some((value) => value === '1' || value?.toLowerCase() === 'yes')
  )
}

export function classifyPageType(pathname: string): FirstPartyPageType {
  if (pathname === '/') return 'home'
  if (pathname === '/tools') return 'tool_index'
  if (pathname.startsWith('/tools/')) return 'tool'
  if (pathname === '/pricing') return 'pricing'
  if (pathname === '/articles' || pathname === '/topics') return 'content_index'
  if (pathname === '/help') return 'help'
  if (pathname === '/legal' || pathname.startsWith('/legal/')) return 'legal'
  return 'other'
}

export function classifySource(referrer: string, currentOrigin: string): FirstPartySource {
  if (!referrer) return 'direct'
  try {
    const source = new URL(referrer)
    if (source.origin === currentOrigin) return 'internal'
    const hostname = source.hostname.toLowerCase()
    if (searchReferrers.some((pattern) => pattern.test(hostname))) return 'search'
    if (socialReferrers.some((pattern) => pattern.test(hostname))) return 'social'
    return 'referral'
  } catch {
    return 'direct'
  }
}

export function classifyDevice(viewportWidth: number): FirstPartyDeviceCategory {
  if (viewportWidth < 768) return 'mobile'
  if (viewportWidth < 1_024) return 'tablet'
  return 'desktop'
}

export function inferToolInput(value: string): { inputType: FirstPartyInputType; tld?: string } {
  let candidate = value.trim().toLowerCase()
  if (!candidate) return { inputType: 'unknown' }
  if (candidate.endsWith('.')) candidate = candidate.slice(0, -1)
  if (/[\s/:@?#\\]/.test(candidate) || !candidate.includes('.')) {
    return { inputType: 'keyword' }
  }
  try {
    const hostname = new URL(`http://${candidate}`).hostname.toLowerCase()
    const labels = hostname.split('.')
    const tld = labels.at(-1)
    if (
      labels.length < 2 ||
      !labels.every((label) => hostnameLabelPattern.test(label)) ||
      !tld ||
      !tldPattern.test(tld)
    ) {
      return { inputType: 'keyword' }
    }
    return { inputType: 'full_domain', tld }
  } catch {
    return { inputType: 'keyword' }
  }
}

export function bucketDuration(durationMs: number): FirstPartyDurationBucket {
  if (durationMs < 100) return 'lt_100ms'
  if (durationMs < 300) return '100_299ms'
  if (durationMs < 1_000) return '300_999ms'
  if (durationMs < 3_000) return '1000_2999ms'
  if (durationMs < 10_000) return '3000_9999ms'
  return 'gte_10000ms'
}

export function emitFirstPartyEvent(input: FirstPartyEventInput): void {
  if (isTrackingOptedOut()) return
  try {
    void fetch('/api/v1/events', {
      body: JSON.stringify(input),
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      method: 'POST',
      referrerPolicy: 'origin',
    }).catch(() => undefined)
  } catch {
    // Analytics is best effort and must never interrupt a public tool flow.
  }
}
