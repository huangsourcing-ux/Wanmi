import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import type { WestDigitalDomainManagementProvider } from '@/providers/types'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import {
  domainManagementMutationResultSchema,
  domainManagementPasswordModifyRequestSchema,
  domainManagementPasswordResultSchema,
  domainManagementPasswordRevealRequestSchema,
} from '@/schemas/domain-management'
import {
  modifyDomainManagementPassword,
  revealDomainManagementPassword,
} from '@/services/domains/domain-management'

import {
  defaultDomainManagementContext,
  domainManagementAssetIdSchema,
  readDomainManagementJson,
  type DomainManagementRouteContext,
} from '../../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  modify?: typeof modifyDomainManagementPassword
  provider: WestDigitalDomainManagementProvider
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
  reveal?: typeof revealDomainManagementPassword
}

export function createManagementPasswordHandler(dependencies: Dependencies) {
  const handle = async (
    request: Request,
    context: { params: Promise<{ assetId: string }> },
    operation: 'modify' | 'reveal',
  ): Promise<Response> => {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const parsedAssetId = domainManagementAssetIdSchema.parse(assetId)
      if (operation === 'reveal') {
        const input = domainManagementPasswordRevealRequestSchema.parse(
          await readDomainManagementJson(request),
        )
        const result = await (dependencies.reveal ?? revealDomainManagementPassword)(
          authenticated.req,
          parsedAssetId,
          input,
          { customer: authenticated.customer, provider: dependencies.provider, traceId },
        )
        return successResponse(domainManagementPasswordResultSchema.parse(result), traceId)
      }
      const input = domainManagementPasswordModifyRequestSchema.parse(
        await readDomainManagementJson(request),
      )
      const result = await (dependencies.modify ?? modifyDomainManagementPassword)(
        authenticated.req,
        parsedAssetId,
        input,
        { customer: authenticated.customer, provider: dependencies.provider, traceId },
      )
      return successResponse(domainManagementMutationResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
  return {
    POST: (request: Request, context: { params: Promise<{ assetId: string }> }) =>
      handle(request, context, 'reveal'),
    PUT: (request: Request, context: { params: Promise<{ assetId: string }> }) =>
      handle(request, context, 'modify'),
  }
}

const handlers = createManagementPasswordHandler({
  provider: createConfiguredWestDigitalWriteAdapter(),
  resolveContext: defaultDomainManagementContext,
})

export const POST = handlers.POST
export const PUT = handlers.PUT
