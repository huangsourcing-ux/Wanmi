import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  dnsRecordBatchPreviewRequestSchema,
  dnsRecordBatchPreviewResultSchema,
} from '@/schemas/dns-management'
import {
  configuredDnsRecordProvider,
  previewCustomerDnsRecordBatchDelete,
} from '@/services/domains/dns-records'

import {
  defaultDnsRouteContext,
  dnsAssetIdSchema,
  type DnsRouteContext,
  readDnsJson,
} from '../../../../_dns-request'

export const runtime = 'nodejs'

type Dependencies = {
  preview?: typeof previewCustomerDnsRecordBatchDelete
  resolveContext: (request: Request) => Promise<DnsRouteContext>
}

export function createDnsRecordBatchPreviewHandler(dependencies: Dependencies) {
  return async function dnsRecordBatchPreview(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const { assetId } = await context.params
      const result = await (dependencies.preview ?? previewCustomerDnsRecordBatchDelete)(
        authenticated.req,
        dnsAssetIdSchema.parse(assetId),
        dnsRecordBatchPreviewRequestSchema.parse(await readDnsJson(request)),
        {
          customer: authenticated.customer,
          provider: configuredDnsRecordProvider(),
          traceId,
        },
      )
      return successResponse(dnsRecordBatchPreviewResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createDnsRecordBatchPreviewHandler({ resolveContext: defaultDnsRouteContext })
