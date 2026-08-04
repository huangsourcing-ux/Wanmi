import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { getTraceId } from '@/lib/request-id'

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers)
  const traceId = getTraceId(request.headers)
  requestHeaders.set('x-request-id', traceId)
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('x-request-id', traceId)
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
