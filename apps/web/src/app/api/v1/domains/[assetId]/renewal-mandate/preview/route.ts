import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  renewalMandatePreviewRequestSchema,
  renewalMandatePreviewResultSchema,
} from '@/schemas/domains'
import { previewCustomerRenewalMandateChange } from '@/services/domains/renewal-mandates'

import {
  defaultDomainManagementContext,
  domainManagementAssetIdSchema,
  readDomainManagementJson,
  type DomainManagementRouteContext,
} from '../../../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  preview?: typeof previewCustomerRenewalMandateChange
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
}

export function createRenewalMandatePreviewHandler(dependencies: Dependencies) {
  return async function renewalMandatePreview(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const input = renewalMandatePreviewRequestSchema.parse(
        await readDomainManagementJson(request),
      )
      const result = await (dependencies.preview ?? previewCustomerRenewalMandateChange)(
        authenticated.req,
        domainManagementAssetIdSchema.parse(assetId),
        input,
        { customer: authenticated.customer, traceId },
      )
      return successResponse(renewalMandatePreviewResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createRenewalMandatePreviewHandler({
  resolveContext: defaultDomainManagementContext,
})
