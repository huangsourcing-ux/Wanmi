import { randomUUID } from 'node:crypto'

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { getEnv } from '@/lib/env'
import { isRedirectEligiblePath, normalizeRedirectPath } from '@/lib/redirects'
import { getTraceId } from '@/lib/request-id'
import { isPublishedPublicContentPath } from '@/services/content/publication-gate'
import { resolvePublicRedirect } from '@/services/redirects/runtime'

const BLOCKED_ADMIN_AUTH_PATHS = new Set([
  '/api/admins/first-register',
  '/api/admins/forgot-password',
  '/api/admins/login',
  '/api/admins/refresh-token',
  '/api/admins/reset-password',
  '/api/admins/unlock',
  '/api/graphql',
  '/api/graphql-playground',
])

const BLOCKED_ADMIN_UI_PATHS = new Set([
  '/admin/create-first-user',
  '/admin/forgot',
  '/admin/reset',
  '/admin/unlock',
])

const SAFE_API_METHODS = new Set(['GET', 'HEAD'])

export function buildContentSecurityPolicy(
  nonce: string,
  options: { allowDevelopmentRuntime?: boolean } = {},
): string {
  const scriptPolicy = options.allowDevelopmentRuntime
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
  const stylePolicy = options.allowDevelopmentRuntime
    ? `style-src 'self' 'unsafe-inline'`
    : `style-src 'self' 'nonce-${nonce}'`
  return [
    "default-src 'self'",
    scriptPolicy,
    stylePolicy,
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

function referrerPolicyForPath(
  pathname: string,
): 'no-referrer' | 'origin' | 'strict-origin-when-cross-origin' {
  if (
    pathname === '/api/v1/realname/documents/access' ||
    pathname === '/api/v1/admin/realname/documents/access'
  ) {
    return 'no-referrer'
  }
  if (pathname.startsWith('/go/ad/')) return 'origin'
  return 'strict-origin-when-cross-origin'
}

function applySecurityHeaders(
  response: NextResponse,
  contentSecurityPolicy: string,
  pathname: string,
): NextResponse {
  response.headers.set('content-security-policy', contentSecurityPolicy)
  response.headers.set('cross-origin-opener-policy', 'same-origin')
  response.headers.set('cross-origin-resource-policy', 'same-origin')
  response.headers.set('permissions-policy', 'camera=(), geolocation=(), microphone=(), payment=()')
  response.headers.set('referrer-policy', referrerPolicyForPath(pathname))
  response.headers.set('x-content-type-options', 'nosniff')
  response.headers.set('x-frame-options', 'DENY')
  return response
}

export function isCrossSiteFirstPartyApiRequest(request: NextRequest): boolean {
  if (!request.nextUrl.pathname.startsWith('/api/v1/')) return false
  const origin = request.headers.get('origin')
  const expectedOrigin = new URL(getEnv().NEXT_PUBLIC_SERVER_URL).origin
  if (origin && origin !== expectedOrigin) return true

  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase()
  if (fetchSite === 'cross-site') return true

  return (
    !SAFE_API_METHODS.has(request.method) && fetchSite === 'same-site' && origin !== expectedOrigin
  )
}

export function normalizeSecurityPathname(pathname: string): string | null {
  let decoded = pathname
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    }
  } catch {
    return null
  }

  const normalized = decoded.replaceAll('\\', '/').replace(/\/{2,}/g, '/')
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

export function isBlockedAdminSurface(pathname: string | null): boolean {
  if (pathname === null) return true
  const normalized = normalizeSecurityPathname(pathname)
  if (normalized === null) return true
  return BLOCKED_ADMIN_AUTH_PATHS.has(normalized) || BLOCKED_ADMIN_UI_PATHS.has(normalized)
}

export async function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers)
  const traceId = getTraceId(request.headers)
  const nonce = randomUUID().replaceAll('-', '')
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce, {
    allowDevelopmentRuntime: process.env.NODE_ENV === 'development',
  })
  requestHeaders.set('x-request-id', traceId)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', contentSecurityPolicy)

  if (isCrossSiteFirstPartyApiRequest(request)) {
    const response = new NextResponse(null, {
      headers: { 'cache-control': 'no-store', 'x-request-id': traceId },
      status: 403,
    })
    response.headers.append('vary', 'origin')
    response.headers.append('vary', 'sec-fetch-site')
    return applySecurityHeaders(response, contentSecurityPolicy, request.nextUrl.pathname)
  }

  if (isBlockedAdminSurface(request.nextUrl.pathname)) {
    return applySecurityHeaders(
      new NextResponse(null, {
        headers: { 'cache-control': 'no-store', 'x-request-id': traceId },
        status: 404,
      }),
      contentSecurityPolicy,
      request.nextUrl.pathname,
    )
  }

  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    isRedirectEligiblePath(request.nextUrl.pathname)
  ) {
    const target = await resolvePublicRedirect(normalizeRedirectPath(request.nextUrl.pathname))
    if (target) {
      try {
        const destination = new URL(normalizeRedirectPath(target), getEnv().NEXT_PUBLIC_SERVER_URL)
        destination.search = request.nextUrl.search
        const response = new NextResponse(null, {
          headers: { location: destination.toString() },
          status: 301,
        })
        response.headers.set('x-request-id', traceId)
        return applySecurityHeaders(response, contentSecurityPolicy, request.nextUrl.pathname)
      } catch {
        // A stale or corrupted redirect cache must fail closed before emitting Location.
      }
    }
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    let published: boolean | undefined
    try {
      published = await isPublishedPublicContentPath(request.nextUrl.pathname)
    } catch {
      published = false
    }
    if (published === false) {
      return applySecurityHeaders(
        new NextResponse(null, {
          headers: { 'cache-control': 'no-store', 'x-request-id': traceId },
          status: 404,
        }),
        contentSecurityPolicy,
        request.nextUrl.pathname,
      )
    }
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('x-request-id', traceId)
  if (request.nextUrl.pathname.startsWith('/preview/content/')) {
    response.headers.set('cache-control', 'private, no-store, max-age=0')
    response.headers.set('x-robots-tag', 'noindex, nofollow')
  }
  if (request.nextUrl.pathname.startsWith('/api/v1/')) {
    response.headers.set('cache-control', 'no-store')
    response.headers.append('vary', 'origin')
    response.headers.append('vary', 'sec-fetch-site')
  }
  return applySecurityHeaders(response, contentSecurityPolicy, request.nextUrl.pathname)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
