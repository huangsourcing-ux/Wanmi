import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import type { WestDigitalDomainManagementProvider } from '@/providers/types'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import { domainLockRequestSchema, domainLockResultSchema } from '@/schemas/domains'
import { setCustomerDomainLockStatus } from '@/services/domains/domain-management'

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
  setLock?: typeof setCustomerDomainLockStatus
}

export function createDomainLockHandler(dependencies: Dependencies) {
  return async function domainLock(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const input = domainLockRequestSchema.parse(await readDomainManagementJson(request))
      const result = await (dependencies.setLock ?? setCustomerDomainLockStatus)(
        authenticated.req,
        domainManagementAssetIdSchema.parse(assetId),
        input,
        { customer: authenticated.customer, provider: dependencies.provider, traceId },
      )
      return successResponse(domainLockResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const PUT = createDomainLockHandler({
  provider: createConfiguredWestDigitalWriteAdapter(),
  resolveContext: defaultDomainManagementContext,
})
