import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import type { WestDigitalDomainManagementProvider } from '@/providers/types'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import {
  domainContactUpdateRequestSchema,
  domainManagementMutationResultSchema,
} from '@/schemas/domain-management'
import { updateDomainContactInformation } from '@/services/domains/domain-management'

import {
  defaultDomainManagementContext,
  domainManagementAssetIdSchema,
  readDomainManagementJson,
  type DomainManagementRouteContext,
} from '../../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  provider: WestDigitalDomainManagementProvider
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
  update?: typeof updateDomainContactInformation
}

export function createContactInformationHandler(dependencies: Dependencies) {
  return async function contactInformation(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const input = domainContactUpdateRequestSchema.parse(await readDomainManagementJson(request))
      const result = await (dependencies.update ?? updateDomainContactInformation)(
        authenticated.req,
        domainManagementAssetIdSchema.parse(assetId),
        input,
        { customer: authenticated.customer, provider: dependencies.provider, traceId },
      )
      return successResponse(domainManagementMutationResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const PUT = createContactInformationHandler({
  provider: createConfiguredWestDigitalWriteAdapter(),
  resolveContext: defaultDomainManagementContext,
})
