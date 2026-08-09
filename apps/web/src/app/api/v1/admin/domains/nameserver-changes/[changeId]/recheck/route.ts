import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'
import { z } from 'zod'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { systemAdminRequest } from '@/services/auth/admin-session'
import { enqueueNameserverReviewQuery } from '@/services/domains/nameserver-changes'

export const runtime = 'nodejs'

const changeIdSchema = z.coerce.number().int().positive()

type Dependencies = {
  enqueue?: typeof enqueueNameserverReviewQuery
  resolveContext: (request: Request) => Promise<{ req: PayloadRequest }>
}

async function defaultContext(request: Request) {
  const payload = await getPayload({ config })
  return systemAdminRequest(payload, request)
}

export function createNameserverReviewQueryHandler(dependencies: Dependencies) {
  return async function nameserverReviewQuery(
    request: Request,
    context: { params: Promise<{ changeId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { changeId } = await context.params
      const result = await (dependencies.enqueue ?? enqueueNameserverReviewQuery)(
        authenticated.req,
        changeIdSchema.parse(changeId),
        traceId,
      )
      return successResponse({ accepted: true, ...result }, traceId, { status: 202 })
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createNameserverReviewQueryHandler({ resolveContext: defaultContext })
