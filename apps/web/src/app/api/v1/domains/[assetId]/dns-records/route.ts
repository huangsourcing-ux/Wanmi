import { z } from 'zod'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  dnsRecordAddRequestSchema,
  dnsRecordListResultSchema,
  dnsRecordMutationResultSchema,
  managedDnsRecordTypeSchema,
} from '@/schemas/dns-management'
import {
  addCustomerDnsRecord,
  configuredDnsRecordProvider,
  listCustomerDnsRecords,
} from '@/services/domains/dns-records'

import {
  defaultDnsRouteContext,
  dnsAssetIdSchema,
  type DnsRouteContext,
  readDnsJson,
} from '../../_dns-request'

export const runtime = 'nodejs'

const listQuerySchema = z.strictObject({
  host: z.string().max(253).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().positive().default(1),
  type: managedDnsRecordTypeSchema.optional(),
  value: z.string().max(2_048).optional(),
})

type Dependencies = {
  add?: typeof addCustomerDnsRecord
  list?: typeof listCustomerDnsRecords
  resolveContext: (request: Request) => Promise<DnsRouteContext>
}

function readListQuery(request: Request) {
  const url = new URL(request.url)
  return listQuerySchema.parse(Object.fromEntries(url.searchParams))
}

export function createDnsRecordCollectionHandlers(dependencies: Dependencies) {
  return {
    GET: async (
      request: Request,
      context: { params: Promise<{ assetId: string }> },
    ): Promise<Response> => {
      const traceId = getTraceId(request.headers)
      try {
        const authenticated = await dependencies.resolveContext(request)
        const { assetId } = await context.params
        const result = await (dependencies.list ?? listCustomerDnsRecords)(
          authenticated.req,
          dnsAssetIdSchema.parse(assetId),
          readListQuery(request),
          {
            customer: authenticated.customer,
            provider: configuredDnsRecordProvider(),
            traceId,
          },
        )
        return successResponse(dnsRecordListResultSchema.parse(result), traceId)
      } catch (error) {
        return problemResponse(error, traceId)
      }
    },
    POST: async (
      request: Request,
      context: { params: Promise<{ assetId: string }> },
    ): Promise<Response> => {
      const traceId = getTraceId(request.headers)
      try {
        const authenticated = await dependencies.resolveContext(request)
        const { assetId } = await context.params
        const result = await (dependencies.add ?? addCustomerDnsRecord)(
          authenticated.req,
          dnsAssetIdSchema.parse(assetId),
          dnsRecordAddRequestSchema.parse(await readDnsJson(request)),
          {
            customer: authenticated.customer,
            provider: configuredDnsRecordProvider(),
            traceId,
          },
        )
        return successResponse(dnsRecordMutationResultSchema.parse(result), traceId, {
          status: 201,
        })
      } catch (error) {
        return problemResponse(error, traceId)
      }
    },
  }
}

const handlers = createDnsRecordCollectionHandlers({ resolveContext: defaultDnsRouteContext })
export const GET = handlers.GET
export const POST = handlers.POST
