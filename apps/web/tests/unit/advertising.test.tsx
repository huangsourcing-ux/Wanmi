import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { buildAdRedirectResponse } from '@/app/go/ad/[publicId]/route'
import { AdvertisementCard } from '@/components/advertising/advertising-slot'
import {
  normalizeAdPlacementCode,
  normalizeAdTarget,
  normalizeAllowedAdHost,
  publicAdClickPath,
  validateAdTargetSyntax,
} from '@/lib/advertising'
import {
  readPublicAdvertisement,
  resolvePublicAdTarget,
} from '@/services/advertising/read-public-ad'

const publicId = '3c9cc764-74fd-4baa-94e9-48865e85efb1'
const now = new Date('2026-08-07T12:00:00.000Z')

function fixturePayload(
  overrides: {
    endsAt?: string
    fail?: boolean
    position?: 'after_core_result' | 'content_inline'
    targetCheckStatus?: 'pending' | 'reachable'
  } = {},
) {
  const documents = {
    adCreatives: {
      2: {
        advertiser: 1,
        body: '固定合作内容，不参与工具事实结果。',
        creativeType: 'text',
        headline: '可信域名服务合作方',
        id: 2,
        status: 'approved',
        targetCheckFailure: 'none',
        targetCheckStatus: overrides.targetCheckStatus ?? 'reachable',
        targetType: 'external',
        targetUrl: 'https://ads.example.test/landing?campaign=d3',
      },
    },
    adPlacements: {
      3: {
        code: 'tool-after-result',
        deviceScope: 'all',
        enabled: true,
        id: 3,
        pageTypes: ['tool'],
        position: overrides.position ?? 'after_core_result',
      },
    },
    advertisers: {
      1: {
        allowedHosts: [{ host: 'ads.example.test' }],
        id: 1,
        status: 'active',
      },
    },
  } as const
  const schedule = {
    advertiser: 1,
    creative: 2,
    endsAt: overrides.endsAt ?? '2026-08-08T12:00:00.000Z',
    id: 4,
    placement: 3,
    priority: 10,
    publicId,
    startsAt: '2026-08-06T12:00:00.000Z',
    status: 'active',
    updatedAt: '2026-08-07T10:00:00.000Z',
  }
  return {
    find: vi.fn(async () => {
      if (overrides.fail) throw new Error('advertising unavailable')
      return { docs: [schedule] }
    }),
    findByID: vi.fn(
      async ({ collection, id }: { collection: keyof typeof documents; id: number }) =>
        documents[collection]?.[id as never],
    ),
  }
}

describe('D3 controlled advertising targets', () => {
  it.each(['//evil.example', '/\\evil.example', '/tools?q=wanmi.net', '/go/ad/loop'])(
    'rejects unsafe internal target %s through the D1-04 path normalizer',
    (targetUrl) => {
      expect(validateAdTargetSyntax(targetUrl, 'internal')).not.toBe(true)
      expect(() => normalizeAdTarget({ targetType: 'internal', targetUrl })).toThrow()
    },
  )

  it('normalizes safe internal paths without accepting a parallel URL grammar', () => {
    expect(normalizeAdTarget({ targetType: 'internal', targetUrl: '/help//start/' })).toBe(
      '/help/start',
    )
  })

  it('allows only exact advertiser HTTPS hosts and rejects dynamic query placeholders', () => {
    expect(normalizeAllowedAdHost('ADS.Example.test')).toBe('ads.example.test')
    expect(
      normalizeAdTarget({
        allowedHosts: ['ads.example.test'],
        targetType: 'external',
        targetUrl: 'https://ads.example.test/landing?campaign=d3',
      }),
    ).toBe('https://ads.example.test/landing?campaign=d3')
    for (const targetUrl of [
      'http://ads.example.test/landing',
      'https://evil.example/landing',
      'https://user:pass@ads.example.test/landing',
      'https://ads.example.test:8443/landing',
      'https://ads.example.test/landing?q={domain}',
    ]) {
      expect(() =>
        normalizeAdTarget({
          allowedHosts: ['ads.example.test'],
          targetType: 'external',
          targetUrl,
        }),
      ).toThrow()
    }
  })

  it('builds stable placement and controlled-click identifiers only', () => {
    expect(normalizeAdPlacementCode(' Tool-After-Result ')).toBe('tool-after-result')
    expect(publicAdClickPath(publicId)).toBe(`/go/ad/${publicId}`)
    expect(() => publicAdClickPath('https://evil.example')).toThrow()
  })
})

describe('D3 public advertising selection and rendering', () => {
  it('returns a minimal commercial view model and never adds the complete query domain', async () => {
    const payload = fixturePayload()
    const advertisement = await readPublicAdvertisement(payload as never, {
      now,
      pageType: 'tool',
      placementCode: 'tool-after-result',
    })
    expect(advertisement).toMatchObject({
      clickHref: `/go/ad/${publicId}`,
      external: true,
      headline: '可信域名服务合作方',
    })
    expect(JSON.stringify(advertisement)).not.toContain('wanmi.net')
    expect(payload.find).toHaveBeenCalledWith(expect.objectContaining({ overrideAccess: false }))
  })

  it('folds expired or failed advertising without throwing into the tool page', async () => {
    await expect(
      readPublicAdvertisement(fixturePayload({ endsAt: '2026-08-07T11:59:59.000Z' }) as never, {
        now,
        pageType: 'tool',
        placementCode: 'tool-after-result',
      }),
    ).resolves.toBeNull()
    await expect(
      readPublicAdvertisement(fixturePayload({ fail: true }) as never, {
        now,
        pageType: 'tool',
        placementCode: 'tool-after-result',
      }),
    ).resolves.toBeNull()
    await expect(
      readPublicAdvertisement(fixturePayload({ position: 'content_inline' }) as never, {
        now,
        pageType: 'tool',
        placementCode: 'tool-after-result',
      }),
    ).resolves.toBeNull()
    await expect(
      readPublicAdvertisement(fixturePayload({ targetCheckStatus: 'pending' }) as never, {
        now,
        pageType: 'tool',
        placementCode: 'tool-after-result',
      }),
    ).resolves.toBeNull()
  })

  it('renders an unmistakable advertisement with the required external-link policy', () => {
    const markup = renderToStaticMarkup(
      <AdvertisementCard
        advertisement={{
          body: '固定合作内容',
          clickHref: `/go/ad/${publicId}`,
          deviceScope: 'all',
          external: true,
          headline: '可信合作方',
          placementCode: 'tool-after-result',
          publicId,
        }}
        pageType="tool"
      />,
    )
    expect(markup).toContain('data-commercial-content="advertisement"')
    expect(markup).toContain('广告')
    expect(markup).toContain('不影响工具结果排序')
    expect(markup).toContain('rel="sponsored nofollow noopener"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('referrerPolicy="origin"')
    expect(markup).not.toContain('wanmi.net')
  })
})

describe('GET /go/ad/:publicId', () => {
  it('redirects only to the stored target and ignores query and referrer input', async () => {
    const payload = fixturePayload()
    const resolved = await resolvePublicAdTarget(payload as never, publicId, now)
    const response = buildAdRedirectResponse(
      new Request(`https://wanmi.test/go/ad/${publicId}?q=private.example`, {
        headers: { referer: 'https://wanmi.test/tools/domain-search?q=private.example' },
      }),
      resolved,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://ads.example.test/landing?campaign=d3')
    expect(response.headers.get('referrer-policy')).toBe('origin')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('location')).not.toContain('private.example')
  })

  it('fails closed when no current approved schedule exists', () => {
    const response = buildAdRedirectResponse(
      new Request(`https://wanmi.test/go/ad/${publicId}`),
      null,
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })
})
