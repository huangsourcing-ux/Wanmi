import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { dnsRecordBatchDeleteResultSchema } from '@/schemas/dns-management'
import {
  configuredDnsRecordProvider,
  queryCustomerDnsRecordBatchDelete,
} from '@/services/domains/dns-records'

import {
  defaultDnsRouteContext,
  dnsAssetIdSchema,
  type DnsRouteContext,
} from '../../../../_dns-request'

export const runtime = 'nodejs'

type Dependencies = {
  queryBatch?: typeof queryCustomerDnsRecordBatchDelete
  resolveContext: (request: Request) => Promise<DnsRouteContext>
}

export function createDnsRecordBatchQueryHandler(dependencies: Dependencies) {
  return async function dnsRecordBatchQuery(
    request: Request,
    context: { params: Promise<{ assetId: string; batchKey: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId, batchKey } = await context.params
      const result = await (dependencies.queryBatch ?? queryCustomerDnsRecordBatchDelete)(
        authenticated.req,
        dnsAssetIdSchema.parse(assetId),
        batchKey,
        {
          customer: authenticated.customer,
          provider: configuredDnsRecordProvider(),
          traceId,
        },
      )
      return successResponse(dnsRecordBatchDeleteResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const GET = createDnsRecordBatchQueryHandler({ resolveContext: defaultDnsRouteContext })
