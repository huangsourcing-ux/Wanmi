import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { isPublishedPublicContentPath, resolvePublicRedirect } = vi.hoisted(() => ({
  isPublishedPublicContentPath: vi.fn(),
  resolvePublicRedirect: vi.fn(),
}))
vi.mock('@/services/content/publication-gate', () => ({ isPublishedPublicContentPath }))
vi.mock('@/services/redirects/runtime', () => ({ resolvePublicRedirect }))

import { proxy } from '@/proxy'
import {
  buildContentSecurityPolicy,
  isBlockedAdminSurface,
  normalizeSecurityPathname,
} from '@/proxy'

describe('public redirect proxy', () => {
  beforeEach(() => {
    isPublishedPublicContentPath.mockReset().mockResolvedValue(undefined)
    resolvePublicRedirect.mockReset()
  })

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

  it.each([
    '/api/admins/login',
    '/api/admins/first-register',
    '/api/admins/forgot-password',
    '/api/admins/reset-password',
    '/api/admins/unlock',
    '/api/admins/refresh-token',
    '/api/graphql',
    '/api/graphql-playground',
  ])('blocks the default Payload administrator auth endpoint %s', async (path) => {
    const response = await proxy(new NextRequest(`http://example.invalid${path}`))
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it.each([
    '/api/admins/%6Cogin',
    '/api/%61dmins/forgot-password',
    '/api/admins/forgot-passwor%64',
    '/api/admins/%256Cogin',
    '/api/admins/%25256Cogin',
    '/api/admins%2Freset-password',
    '/api/admins\\refresh-token',
    '/api/%67raphql',
    '/admin/%66orgot',
    '/api/%61dmins/%',
  ])('blocks encoded and alternate-separator admin auth endpoint %s', async (path) => {
    const response = await proxy(new NextRequest(`http://example.invalid${path}`))
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('normalizes bounded encodings and separators while malformed input fails closed', () => {
    expect(normalizeSecurityPathname('/api/admins/%25256Cogin')).toBe('/api/admins/login')
    expect(normalizeSecurityPathname('/api//admins\\login/')).toBe('/api/admins/login')
    expect(normalizeSecurityPathname('/api/admins/%')).toBeNull()
    expect(isBlockedAdminSurface(null)).toBe(true)
    expect(isBlockedAdminSurface('/api/admins/%')).toBe(true)
  })

  it.each([
    '//evil.example/api/v1/events',
    'https://wanmi.example@evil.example/api/v1/events',
    'https://evil.example/@wanmi.example/api/v1/events',
  ])('never turns URL confusion input into an external redirect: %s', async (target) => {
    resolvePublicRedirect.mockResolvedValue(target)
    const response = await proxy(new NextRequest('http://example.invalid/legacy'))
    expect(response.status).not.toBe(301)
    expect(response.headers.get('location')).toBeNull()
  })

  it('rejects cross-site first-party API requests and emits a strict nonce CSP', async () => {
    const response = await proxy(
      new NextRequest('http://example.invalid/api/v1/events', {
        headers: {
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
          'x-request-id': 'cross-site-security-trace',
        },
        method: 'POST',
      }),
    )
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('vary')).toContain('origin')
    const csp = response.headers.get('content-security-policy')
    expect(csp).toMatch(/script-src 'self' 'nonce-[a-f0-9]{32}' 'strict-dynamic'/u)
    expect(csp).not.toContain("'unsafe-inline'")
    expect(csp).not.toContain("'unsafe-eval'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  it('keeps same-origin APIs no-store without enabling credentialed cross-origin reads', async () => {
    const response = await proxy(
      new NextRequest('http://example.invalid/api/v1/tools/dns', {
        headers: {
          origin: 'http://127.0.0.1:3000',
          'sec-fetch-site': 'same-origin',
        },
        method: 'POST',
      }),
    )
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('builds a CSP without unsafe execution fallbacks', () => {
    const csp = buildContentSecurityPolicy('0123456789abcdef')
    expect(csp).toContain("script-src 'self' 'nonce-0123456789abcdef' 'strict-dynamic'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toMatch(/unsafe-(?:eval|inline)/u)
  })

  it('does not broaden the block to required Payload administrator REST endpoints', async () => {
    for (const path of ['/api/admins/me', '/api/admins/logout', '/api/admins/123']) {
      const response = await proxy(new NextRequest(`http://example.invalid${path}`))
      expect(response.headers.get('x-middleware-next'), path).toBe('1')
    }
  })

  it('forces private no-store and noindex headers on every content preview response', async () => {
    const response = await proxy(
      new NextRequest('http://example.invalid/preview/content/articles/private-draft'),
    )
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })

  it('returns a literal 404 before streaming an unpublished public content detail', async () => {
    isPublishedPublicContentPath.mockResolvedValue(false)
    const response = await proxy(new NextRequest('http://example.invalid/articles/private-draft'))
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
