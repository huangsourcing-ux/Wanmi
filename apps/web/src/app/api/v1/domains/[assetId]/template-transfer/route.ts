import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import type { WestDigitalDomainManagementProvider } from '@/providers/types'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import {
  domainManagementMutationResultSchema,
  domainTemplateTransferRequestSchema,
} from '@/schemas/domain-management'
import { transferDomainToApprovedTemplate } from '@/services/domains/domain-management'

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
  transfer?: typeof transferDomainToApprovedTemplate
}

export function createTemplateTransferHandler(dependencies: Dependencies) {
  return async function templateTransfer(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const input = domainTemplateTransferRequestSchema.parse(
        await readDomainManagementJson(request),
      )
      const result = await (dependencies.transfer ?? transferDomainToApprovedTemplate)(
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

export const POST = createTemplateTransferHandler({
  provider: createConfiguredWestDigitalWriteAdapter(),
  resolveContext: defaultDomainManagementContext,
})
