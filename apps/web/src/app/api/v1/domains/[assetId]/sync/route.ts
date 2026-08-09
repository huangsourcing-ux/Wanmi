import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'
import { z } from 'zod'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import type { WestDigitalWriteProvider } from '@/providers/types'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import { domainAssetDetailResultSchema } from '@/schemas/domains'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { syncCustomerDomainAsset } from '@/services/domains/domain-assets'

export const runtime = 'nodejs'

const assetIdSchema = z.coerce.number().int().positive()

type Context = {
  customer: { collection: 'customers'; id: number; status?: string }
  req: PayloadRequest
}

type Dependencies = {
  provider: WestDigitalWriteProvider
  resolveContext: (request: Request) => Promise<Context>
  sync?: typeof syncCustomerDomainAsset
}

async function defaultContext(request: Request): Promise<Context> {
  const payload = await getPayload({ config })
  const { req, user } = await authenticatedCustomerRequest(payload, request)
  return {
    customer: { collection: 'customers', id: user.id, status: user.status },
    req,
  }
}

export function createDomainSyncHandler(dependencies: Dependencies) {
  return async function domainSync(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const result = await (dependencies.sync ?? syncCustomerDomainAsset)(
        authenticated.req,
        assetIdSchema.parse(assetId),
        {
          customer: authenticated.customer,
          provider: dependencies.provider,
          traceId,
        },
      )
      return successResponse(domainAssetDetailResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createDomainSyncHandler({
  provider: createConfiguredWestDigitalWriteAdapter(),
  resolveContext: defaultContext,
})
