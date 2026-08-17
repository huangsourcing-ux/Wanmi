import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { domainCapabilitiesResultSchema } from '@/schemas/domain-management'
import { getDomainCapabilityDeclaration } from '@/services/domains/domain-management'

import {
  defaultDomainManagementContext,
  domainManagementAssetIdSchema,
  type DomainManagementRouteContext,
} from '../../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  capabilities?: typeof getDomainCapabilityDeclaration
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
}

export function createDomainCapabilitiesHandler(dependencies: Dependencies) {
  return async function domainCapabilities(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const result = await (dependencies.capabilities ?? getDomainCapabilityDeclaration)(
        authenticated.req,
        domainManagementAssetIdSchema.parse(assetId),
        { customer: authenticated.customer },
      )
      return successResponse(domainCapabilitiesResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const GET = createDomainCapabilitiesHandler({
  resolveContext: defaultDomainManagementContext,
})
