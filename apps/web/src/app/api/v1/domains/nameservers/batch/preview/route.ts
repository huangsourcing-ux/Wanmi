import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  nameserverBatchPreviewRequestSchema,
  nameserverBatchPreviewResultSchema,
} from '@/schemas/domains'
import { previewCustomerNameserverBatchChange } from '@/services/domains/nameserver-changes'

import {
  defaultDomainManagementContext,
  type DomainManagementRouteContext,
  readDomainManagementJson,
} from '../../../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  preview?: typeof previewCustomerNameserverBatchChange
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
}

export function createNameserverBatchPreviewHandler(dependencies: Dependencies) {
  return async function nameserverBatchPreview(request: Request): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const input = nameserverBatchPreviewRequestSchema.parse(
        await readDomainManagementJson(request),
      )
      const result = await (dependencies.preview ?? previewCustomerNameserverBatchChange)(
        authenticated.req,
        input,
        { customer: authenticated.customer, traceId },
      )
      return successResponse(nameserverBatchPreviewResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createNameserverBatchPreviewHandler({
  resolveContext: defaultDomainManagementContext,
})
