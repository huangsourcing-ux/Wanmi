import { randomUUID } from 'node:crypto'

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers)
  const traceId =
    request.headers.get('x-request-id')?.match(/^[a-zA-Z0-9._:-]{8,128}$/)?.[0] ?? randomUUID()
  requestHeaders.set('x-request-id', traceId)
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('x-request-id', traceId)
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
