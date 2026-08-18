import { z } from 'zod'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { nameserverBatchResultSchema } from '@/schemas/domains'
import { queryCustomerNameserverBatchChange } from '@/services/domains/nameserver-changes'

import {
  defaultDomainManagementContext,
  type DomainManagementRouteContext,
} from '../../../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  queryBatch?: typeof queryCustomerNameserverBatchChange
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
}

export function createNameserverBatchQueryHandler(dependencies: Dependencies) {
  return async function nameserverBatchQuery(
    request: Request,
    context: { params: Promise<{ batchKey: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { batchKey } = await context.params
      const result = await (dependencies.queryBatch ?? queryCustomerNameserverBatchChange)(
        authenticated.req,
        z.uuid().parse(batchKey),
        { customer: authenticated.customer, traceId },
      )
      return successResponse(nameserverBatchResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const GET = createNameserverBatchQueryHandler({
  resolveContext: defaultDomainManagementContext,
})
