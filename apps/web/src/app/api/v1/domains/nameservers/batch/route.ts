import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { nameserverBatchRequestSchema, nameserverBatchResultSchema } from '@/schemas/domains'
import { requestCustomerNameserverBatchChange } from '@/services/domains/nameserver-changes'

import {
  defaultDomainManagementContext,
  type DomainManagementRouteContext,
  readDomainManagementJson,
} from '../../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  requestBatch?: typeof requestCustomerNameserverBatchChange
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
}

export function createNameserverBatchHandler(dependencies: Dependencies) {
  return async function nameserverBatch(request: Request): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const input = nameserverBatchRequestSchema.parse(await readDomainManagementJson(request))
      const result = await (dependencies.requestBatch ?? requestCustomerNameserverBatchChange)(
        authenticated.req,
        input,
        { customer: authenticated.customer, traceId },
      )
      return successResponse(nameserverBatchResultSchema.parse(result), traceId, { status: 202 })
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createNameserverBatchHandler({
  resolveContext: defaultDomainManagementContext,
})
