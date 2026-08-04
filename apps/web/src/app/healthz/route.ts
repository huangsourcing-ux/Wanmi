import { getTraceId, successResponse } from '@/lib/errors'

export function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  return successResponse({ status: 'ok' }, traceId)
}
