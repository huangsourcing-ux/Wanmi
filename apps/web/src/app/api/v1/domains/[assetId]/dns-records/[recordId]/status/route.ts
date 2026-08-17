import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  dnsRecordMutationResultSchema,
  dnsRecordStatusRequestSchema,
} from '@/schemas/dns-management'
import {
  configuredDnsRecordProvider,
  setCustomerDnsRecordPaused,
} from '@/services/domains/dns-records'

import {
  defaultDnsRouteContext,
  dnsAssetIdSchema,
  dnsProviderRecordIdSchema,
  type DnsRouteContext,
  readDnsJson,
} from '../../../../_dns-request'

export const runtime = 'nodejs'

type Dependencies = {
  resolveContext: (request: Request) => Promise<DnsRouteContext>
  setPaused?: typeof setCustomerDnsRecordPaused
}

export function createDnsRecordStatusHandler(dependencies: Dependencies) {
  return async function dnsRecordStatus(
    request: Request,
    context: { params: Promise<{ assetId: string; recordId: string }> },
  ): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const params = await context.params
      const result = await (dependencies.setPaused ?? setCustomerDnsRecordPaused)(
        authenticated.req,
        dnsAssetIdSchema.parse(params.assetId),
        dnsProviderRecordIdSchema.parse(params.recordId),
        dnsRecordStatusRequestSchema.parse(await readDnsJson(request)),
        {
          customer: authenticated.customer,
          provider: configuredDnsRecordProvider(),
          traceId,
        },
      )
      return successResponse(dnsRecordMutationResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const POST = createDnsRecordStatusHandler({ resolveContext: defaultDnsRouteContext })
