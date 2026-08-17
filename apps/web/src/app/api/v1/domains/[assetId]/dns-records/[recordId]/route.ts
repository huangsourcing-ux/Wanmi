import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  dnsRecordDeleteRequestSchema,
  dnsRecordDetailResultSchema,
  dnsRecordModifyRequestSchema,
  dnsRecordMutationResultSchema,
} from '@/schemas/dns-management'
import {
  configuredDnsRecordProvider,
  deleteCustomerDnsRecord,
  getCustomerDnsRecord,
  modifyCustomerDnsRecord,
} from '@/services/domains/dns-records'

import {
  defaultDnsRouteContext,
  dnsAssetIdSchema,
  dnsProviderRecordIdSchema,
  type DnsRouteContext,
  readDnsJson,
} from '../../../_dns-request'

export const runtime = 'nodejs'

type Dependencies = {
  deleteRecord?: typeof deleteCustomerDnsRecord
  detail?: typeof getCustomerDnsRecord
  modify?: typeof modifyCustomerDnsRecord
  resolveContext: (request: Request) => Promise<DnsRouteContext>
}

export function createDnsRecordItemHandlers(dependencies: Dependencies) {
  async function identifiers(context: { params: Promise<{ assetId: string; recordId: string }> }) {
    const params = await context.params
    return {
      assetId: dnsAssetIdSchema.parse(params.assetId),
      recordId: dnsProviderRecordIdSchema.parse(params.recordId),
    }
  }
  return {
    DELETE: async (
      request: Request,
      context: { params: Promise<{ assetId: string; recordId: string }> },
    ): Promise<Response> => {
      const traceId = getTraceId(request.headers)
      try {
        const authenticated = await dependencies.resolveContext(request)
        const ids = await identifiers(context)
        const result = await (dependencies.deleteRecord ?? deleteCustomerDnsRecord)(
          authenticated.req,
          ids.assetId,
          ids.recordId,
          dnsRecordDeleteRequestSchema.parse(await readDnsJson(request)),
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
    },
    GET: async (
      request: Request,
      context: { params: Promise<{ assetId: string; recordId: string }> },
    ): Promise<Response> => {
      const traceId = getTraceId(request.headers)
      try {
        const authenticated = await dependencies.resolveContext(request)
        const ids = await identifiers(context)
        const result = await (dependencies.detail ?? getCustomerDnsRecord)(
          authenticated.req,
          ids.assetId,
          ids.recordId,
          {
            customer: authenticated.customer,
            provider: configuredDnsRecordProvider(),
            traceId,
          },
        )
        return successResponse(dnsRecordDetailResultSchema.parse(result), traceId)
      } catch (error) {
        return problemResponse(error, traceId)
      }
    },
    PATCH: async (
      request: Request,
      context: { params: Promise<{ assetId: string; recordId: string }> },
    ): Promise<Response> => {
      const traceId = getTraceId(request.headers)
      try {
        const authenticated = await dependencies.resolveContext(request)
        const ids = await identifiers(context)
        const result = await (dependencies.modify ?? modifyCustomerDnsRecord)(
          authenticated.req,
          ids.assetId,
          ids.recordId,
          dnsRecordModifyRequestSchema.parse(await readDnsJson(request)),
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
    },
  }
}

const handlers = createDnsRecordItemHandlers({ resolveContext: defaultDnsRouteContext })
export const DELETE = handlers.DELETE
export const GET = handlers.GET
export const PATCH = handlers.PATCH
