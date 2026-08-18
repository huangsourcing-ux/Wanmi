import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { domainAssetListQuerySchema, domainAssetListResultSchema } from '@/schemas/domains'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { listCustomerDomainAssets } from '@/services/domains/domain-assets'

export const runtime = 'nodejs'

type Context = {
  customer: { collection: 'customers'; id: number; status?: string }
  req: PayloadRequest
}

type Dependencies = {
  list?: typeof listCustomerDomainAssets
  resolveContext: (request: Request) => Promise<Context>
}

async function defaultContext(request: Request): Promise<Context> {
  const payload = await getPayload({ config })
  const { req, user } = await authenticatedCustomerRequest(payload, request)
  return {
    customer: { collection: 'customers', id: user.id, status: user.status },
    req,
  }
}

export function createDomainListHandler(dependencies: Dependencies) {
  return async function domainList(request: Request): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const context = await dependencies.resolveContext(request)
      const search = new URL(request.url).searchParams
      const input = domainAssetListQuerySchema.parse({
        expiresWithinDays: search.get('expiresWithinDays') ?? undefined,
        lockStatus: search.get('lockStatus') ?? undefined,
        page: search.get('page') ?? undefined,
        pageSize: search.get('pageSize') ?? undefined,
        query: search.get('query') ?? undefined,
        sort: search.get('sort') ?? undefined,
        status: search.get('status') ?? undefined,
        tag: search.get('tag') ?? undefined,
      })
      const result = await (dependencies.list ?? listCustomerDomainAssets)(
        context.req,
        context.customer,
        input,
      )
      return successResponse(domainAssetListResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const GET = createDomainListHandler({ resolveContext: defaultContext })
