import type { Payload } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import {
  createUnavailablePublicSiteData,
  isSafeInternalHref,
  readPublicSiteData,
  sanitizeNavigationItems,
} from '@/lib/public-site-data'
import { DEFAULT_NAVIGATION, normalizeQueryParam } from '@/lib/site-config'

function asPublicPayload(find: ReturnType<typeof vi.fn>): Pick<Payload, 'find'> {
  return { find: find as unknown as Payload['find'] }
}

describe('public site data', () => {
  it('enforces access control and maps safe enabled navigation plus published content', async () => {
    const find = vi.fn(async ({ collection }: { collection: string; overrideAccess?: boolean }) => {
      if (collection === 'navigation') {
        return {
          docs: [
            { enabled: true, href: '/articles', id: 2, label: ' 内容 ', order: 2 },
            { enabled: true, href: 'https://example.com', id: 3, label: '外部', order: 3 },
            { enabled: false, href: '/hidden', id: 4, label: '隐藏', order: 0 },
            { enabled: true, href: '/tools', id: 1, label: '工具', order: 1 },
          ],
        }
      }
      return {
        docs: [
          { id: `${collection}-1`, slug: `${collection}-slug`, summary: '摘要', title: collection },
        ],
      }
    })

    const data = await readPublicSiteData(asPublicPayload(find))

    expect(find).toHaveBeenCalledTimes(5)
    expect(find.mock.calls.every(([args]) => args.overrideAccess === false)).toBe(true)
    expect(data.navigation).toEqual({
      items: [
        { href: '/tools', id: '1', label: '工具' },
        { href: '/articles', id: '2', label: '内容' },
      ],
      status: 'ready',
    })
    expect(data.articles).toMatchObject({ status: 'ready', title: '最新实用内容' })
    expect(data.helpPages).toMatchObject({ status: 'ready', title: '帮助文章' })
    expect(data.tldPages).toMatchObject({ status: 'ready', title: 'TLD 页面' })
    expect(data.topics).toMatchObject({ status: 'ready', title: '专题与指南' })
  })

  it('isolates failed and empty sections while retaining safe navigation fallbacks', async () => {
    const find = vi.fn(async ({ collection }: { collection: string }) => {
      if (collection === 'navigation' || collection === 'articles') throw new Error('unavailable')
      if (collection === 'tldPages') return { docs: [] }
      return { docs: [{ id: 1, slug: 'guide', title: '专题' }] }
    })

    const data = await readPublicSiteData(asPublicPayload(find))

    expect(data.navigation).toEqual({ items: DEFAULT_NAVIGATION, status: 'unavailable' })
    expect(data.articles.status).toBe('unavailable')
    expect(data.helpPages.status).toBe('ready')
    expect(data.tldPages.status).toBe('empty')
    expect(data.topics.status).toBe('ready')
  })

  it('returns a complete safe fallback when every public collection read fails', async () => {
    const find = vi.fn().mockRejectedValue(new Error('database unavailable'))

    const data = await readPublicSiteData(asPublicPayload(find))

    expect(find).toHaveBeenCalledTimes(5)
    expect(find.mock.calls.every(([args]) => args.overrideAccess === false)).toBe(true)
    expect(data.navigation).toEqual({ items: DEFAULT_NAVIGATION, status: 'unavailable' })
    expect(data.articles.status).toBe('unavailable')
    expect(data.helpPages.status).toBe('unavailable')
    expect(data.tldPages.status).toBe('unavailable')
    expect(data.topics.status).toBe('unavailable')
  })

  it('rejects external navigation and normalizes bounded query input', () => {
    expect(isSafeInternalHref('/tools/domain-search?q=wanmi')).toBe(true)
    expect(isSafeInternalHref('//example.com')).toBe(false)
    expect(isSafeInternalHref('https://example.com')).toBe(false)
    expect(isSafeInternalHref('/tools\\example')).toBe(false)
    expect(
      sanitizeNavigationItems([
        { enabled: true, href: '/tools', id: 1, label: '工具', order: 1 },
        { enabled: true, href: '/tools', id: 2, label: '重复', order: 2 },
      ]),
    ).toHaveLength(1)
    expect(normalizeQueryParam(['  中文域名  ', 'ignored'])).toBe('中文域名')
    expect(normalizeQueryParam('x'.repeat(300))).toHaveLength(253)
    expect(createUnavailablePublicSiteData().navigation.items).toEqual(DEFAULT_NAVIGATION)
  })
})
