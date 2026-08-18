import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { renewalMandateChangeRequestSchema, renewalMandateResultSchema } from '@/schemas/domains'
import {
  changeCustomerRenewalMandate,
  getCustomerRenewalMandate,
} from '@/services/domains/renewal-mandates'

import {
  defaultDomainManagementContext,
  domainManagementAssetIdSchema,
  readDomainManagementJson,
  type DomainManagementRouteContext,
} from '../../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  change?: typeof changeCustomerRenewalMandate
  get?: typeof getCustomerRenewalMandate
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
}

export function createRenewalMandateGetHandler(dependencies: Dependencies) {
  return async function renewalMandateGet(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const result = await (dependencies.get ?? getCustomerRenewalMandate)(
        authenticated.req,
        domainManagementAssetIdSchema.parse(assetId),
        { customer: authenticated.customer, traceId },
      )
      return successResponse(renewalMandateResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export function createRenewalMandateChangeHandler(
  dependencies: Dependencies,
  expectedAction: 'authorize' | 'revoke',
) {
  return async function renewalMandateChange(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const input = renewalMandateChangeRequestSchema.parse(await readDomainManagementJson(request))
      const result = await (dependencies.change ?? changeCustomerRenewalMandate)(
        authenticated.req,
        domainManagementAssetIdSchema.parse(assetId),
        input,
        { customer: authenticated.customer, expectedAction, traceId },
      )
      return successResponse(renewalMandateResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

const dependencies = { resolveContext: defaultDomainManagementContext }

export const GET = createRenewalMandateGetHandler(dependencies)
export const PUT = createRenewalMandateChangeHandler(dependencies, 'authorize')
export const DELETE = createRenewalMandateChangeHandler(dependencies, 'revoke')
