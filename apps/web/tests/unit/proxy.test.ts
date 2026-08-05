import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolvePublicRedirect } = vi.hoisted(() => ({ resolvePublicRedirect: vi.fn() }))
vi.mock('@/services/redirects/runtime', () => ({ resolvePublicRedirect }))

import { proxy } from '@/proxy'

describe('public redirect proxy', () => {
  beforeEach(() => resolvePublicRedirect.mockReset())

  it('returns a canonical 301 with the original query and trace ID', async () => {
    resolvePublicRedirect.mockResolvedValue('/articles/current')
    const response = await proxy(
      new NextRequest('http://example.invalid/legacy?q=wanmi.net&utm_source=test', {
        headers: { 'x-request-id': 'proxy-redirect-trace' },
      }),
    )
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(
      'http://127.0.0.1:3000/articles/current?q=wanmi.net&utm_source=test',
    )
    expect(response.headers.get('x-request-id')).toBe('proxy-redirect-trace')
    expect(resolvePublicRedirect).toHaveBeenCalledWith('/legacy')

    const headResponse = await proxy(
      new NextRequest('http://example.invalid/legacy', { method: 'HEAD' }),
    )
    expect(headResponse.status).toBe(301)
  })

  it('does not resolve protected paths or non-read methods', async () => {
    const apiResponse = await proxy(new NextRequest('http://example.invalid/api/orders'))
    const postResponse = await proxy(
      new NextRequest('http://example.invalid/legacy', { method: 'POST' }),
    )
    expect(apiResponse.headers.get('x-middleware-next')).toBe('1')
    expect(postResponse.headers.get('x-middleware-next')).toBe('1')
    expect(resolvePublicRedirect).not.toHaveBeenCalled()
  })
})
