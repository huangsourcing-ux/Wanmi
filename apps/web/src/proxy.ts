import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { getEnv } from '@/lib/env'
import { isRedirectEligiblePath, normalizeRedirectPath } from '@/lib/redirects'
import { getTraceId } from '@/lib/request-id'
import { resolvePublicRedirect } from '@/services/redirects/runtime'

export async function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers)
  const traceId = getTraceId(request.headers)
  requestHeaders.set('x-request-id', traceId)

  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    isRedirectEligiblePath(request.nextUrl.pathname)
  ) {
    const target = await resolvePublicRedirect(normalizeRedirectPath(request.nextUrl.pathname))
    if (target) {
      const destination = new URL(target, getEnv().NEXT_PUBLIC_SERVER_URL)
      destination.search = request.nextUrl.search
      const response = new NextResponse(null, {
        headers: { location: destination.toString() },
        status: 301,
      })
      response.headers.set('x-request-id', traceId)
      return response
    }
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('x-request-id', traceId)
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
