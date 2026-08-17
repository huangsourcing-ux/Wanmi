import { getTraceId, problemResponse } from '@/lib/errors'
import type { WestDigitalDomainManagementProvider } from '@/providers/types'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import { downloadDomainCertificate } from '@/services/domains/domain-management'

import {
  defaultDomainManagementContext,
  domainManagementAssetIdSchema,
  type DomainManagementRouteContext,
} from '../../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  download?: typeof downloadDomainCertificate
  provider: WestDigitalDomainManagementProvider
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
}

export function createDomainCertificateHandler(dependencies: Dependencies) {
  return async function domainCertificate(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const result = await (dependencies.download ?? downloadDomainCertificate)(
        authenticated.req,
        domainManagementAssetIdSchema.parse(assetId),
        { customer: authenticated.customer, provider: dependencies.provider, traceId },
      )
      return new Response(result.bytes, {
        headers: {
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${result.domainAscii}.certificate"`,
          'content-type': 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          'x-request-id': traceId,
        },
      })
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const GET = createDomainCertificateHandler({
  provider: createConfiguredWestDigitalWriteAdapter(),
  resolveContext: defaultDomainManagementContext,
})
