import { describe, expect, it, vi } from 'vitest'

import {
  buildRedirectIndex,
  isRedirectEligiblePath,
  MAX_REDIRECT_HOPS,
  normalizeRedirectPath,
  referenceDocumentPath,
} from '@/lib/redirects'
import { createRedirectResolver, loadRedirectIndex } from '@/services/redirects/runtime'

describe('managed redirects', () => {
  it('normalizes only safe public paths', () => {
    expect(normalizeRedirectPath('/legacy//guide/')).toBe('/legacy/guide')
    expect(isRedirectEligiblePath('/legacy/guide')).toBe(true)
    expect(isRedirectEligiblePath('/legacy/guide/')).toBe(true)
    for (const path of [
      'https://bad.test/path',
      '//bad.test/path',
      '/api/orders',
      '/admin',
      '/healthz',
      '/path?q=1',
      '/path#fragment',
      '/path\\other',
      '/path\n',
      '/path%2fother',
      '/%61pi/orders',
      '/path%7f',
    ]) {
      expect(() => normalizeRedirectPath(path)).toThrow()
    }
  })

  it('accepts only published referenced content', () => {
    expect(
      referenceDocumentPath({
        relationTo: 'articles',
        value: { _status: 'published', slug: 'domain-guide' },
      }),
    ).toBe('/articles/domain-guide')
    expect(
      referenceDocumentPath({
        relationTo: 'topics',
        value: { _status: 'draft', slug: 'hidden' },
      }),
    ).toBeUndefined()
  })

  it('flattens safe chains and drops loops, drafts and 302 rules', () => {
    const built = buildRedirectIndex([
      { from: '/a', to: { type: 'custom', url: '/b' }, type: '301' },
      { from: '/b', to: { type: 'custom', url: '/c' }, type: '301' },
      { from: '/loop-a', to: { type: 'custom', url: '/loop-b' }, type: '301' },
      { from: '/loop-b', to: { type: 'custom', url: '/loop-a' }, type: '301' },
      { from: '/temporary', to: { type: 'custom', url: '/c' }, type: '302' },
      {
        from: '/draft',
        to: {
          reference: { relationTo: 'articles', value: { _status: 'draft', slug: 'draft' } },
          type: 'reference',
        },
        type: '301',
      },
    ])
    expect(built.destinations.get('/a')).toBe('/c')
    expect(built.destinations.get('/b')).toBe('/c')
    expect(built.destinations.has('/loop-a')).toBe(false)
    expect(built.destinations.has('/temporary')).toBe(false)
    expect(built.destinations.has('/draft')).toBe(false)
    expect(built.invalidRules).toBeGreaterThanOrEqual(4)
  })

  it('rejects chains beyond the hop limit while keeping shorter suffixes', () => {
    const documents = Array.from({ length: MAX_REDIRECT_HOPS + 1 }, (_, index) => ({
      from: `/hop-${index}`,
      to: { type: 'custom', url: `/hop-${index + 1}` },
      type: '301',
    }))
    const built = buildRedirectIndex(documents)
    expect(built.destinations.has('/hop-0')).toBe(false)
    expect(built.destinations.get('/hop-1')).toBe(`/hop-${MAX_REDIRECT_HOPS + 1}`)
  })

  it('deduplicates refreshes and serves stale data after refresh failure', async () => {
    let now = 0
    let release: ((value: ReadonlyMap<string, string>) => void) | undefined
    const load = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<ReadonlyMap<string, string>>((resolve) => (release = resolve)),
      )
      .mockRejectedValueOnce(new Error('database unavailable'))
    const onRefreshError = vi.fn()
    const resolver = createRedirectResolver(load, { now: () => now, onRefreshError, ttlMs: 30 })

    const first = resolver.resolve('/a')
    const concurrent = resolver.resolve('/a')
    expect(load).toHaveBeenCalledTimes(1)
    release?.(new Map([['/a', '/b']]))
    await expect(first).resolves.toBe('/b')
    await expect(concurrent).resolves.toBe('/b')

    now = 31
    await expect(resolver.resolve('/a')).resolves.toBe('/b')
    await vi.waitFor(() => expect(onRefreshError).toHaveBeenCalledOnce())
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('paginates public rule reads with access control enabled', async () => {
    const find = vi
      .fn()
      .mockResolvedValueOnce({
        docs: [{ from: '/a', to: { type: 'custom', url: '/b' }, type: '301' }],
        hasNextPage: true,
      })
      .mockResolvedValueOnce({
        docs: [{ from: '/b', to: { type: 'custom', url: '/c' }, type: '301' }],
        hasNextPage: false,
      })

    const index = await loadRedirectIndex({ find: find as never })

    expect(index.get('/a')).toBe('/c')
    expect(find).toHaveBeenCalledTimes(2)
    expect(find).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        collection: 'redirects',
        depth: 1,
        limit: 200,
        overrideAccess: false,
        page: 1,
      }),
    )
    expect(find).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2 }))
  })

  it('passes through when the initial cache load fails', async () => {
    const onRefreshError = vi.fn()
    const resolver = createRedirectResolver(() => Promise.reject(new Error('offline')), {
      onRefreshError,
    })
    await expect(resolver.resolve('/missing')).resolves.toBeUndefined()
    expect(onRefreshError).toHaveBeenCalledOnce()
  })
})
