import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  dnsRecordBatchDeleteRequestSchema,
  dnsRecordBatchDeleteResultSchema,
} from '@/schemas/dns-management'
import {
  configuredDnsRecordProvider,
  deleteCustomerDnsRecordBatch,
} from '@/services/domains/dns-records'

import {
  defaultDnsRouteContext,
  dnsAssetIdSchema,
  type DnsRouteContext,
  readDnsJson,
} from '../../../_dns-request'

export const runtime = 'nodejs'

type Dependencies = {
  deleteBatch?: typeof deleteCustomerDnsRecordBatch
  resolveContext: (request: Request) => Promise<DnsRouteContext>
}

export function createDnsRecordBatchDeleteHandler(dependencies: Dependencies) {
  return async function dnsRecordBatchDelete(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const result = await (dependencies.deleteBatch ?? deleteCustomerDnsRecordBatch)(
        authenticated.req,
        dnsAssetIdSchema.parse(assetId),
        dnsRecordBatchDeleteRequestSchema.parse(await readDnsJson(request)),
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

export const POST = createDnsRecordBatchDeleteHandler({ resolveContext: defaultDnsRouteContext })
