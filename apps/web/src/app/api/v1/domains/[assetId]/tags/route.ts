import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { domainAssetPreferenceResultSchema, domainAssetTagsRequestSchema } from '@/schemas/domains'
import { updateCustomerDomainTags } from '@/services/domains/domain-preferences'

import {
  defaultDomainManagementContext,
  domainManagementAssetIdSchema,
  readDomainManagementJson,
  type DomainManagementRouteContext,
} from '../../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
  update?: typeof updateCustomerDomainTags
}

export function createDomainTagsHandler(dependencies: Dependencies) {
  return async function domainTags(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const input = domainAssetTagsRequestSchema.parse(await readDomainManagementJson(request))
      const result = await (dependencies.update ?? updateCustomerDomainTags)(
        authenticated.req,
        domainManagementAssetIdSchema.parse(assetId),
        input,
        { customer: authenticated.customer, traceId },
      )
      return successResponse(domainAssetPreferenceResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const PUT = createDomainTagsHandler({ resolveContext: defaultDomainManagementContext })
