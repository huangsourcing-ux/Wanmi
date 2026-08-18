import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  domainAssetPreferenceResultSchema,
  domainExpiryReminderPreferencesRequestSchema,
} from '@/schemas/domains'
import { updateCustomerDomainExpiryReminderPreferences } from '@/services/domains/domain-preferences'

import {
  defaultDomainManagementContext,
  readDomainManagementJson,
  type DomainManagementRouteContext,
} from '../_domain-management-request'

export const runtime = 'nodejs'

type Dependencies = {
  resolveContext: (request: Request) => Promise<DomainManagementRouteContext>
  update?: typeof updateCustomerDomainExpiryReminderPreferences
}

export function createDomainReminderPreferencesHandler(dependencies: Dependencies) {
  return async function domainReminderPreferences(request: Request): Promise<Response> {
    const traceId = getTraceId(request.headers)
    try {
      const authenticated = await dependencies.resolveContext(request)
      const input = domainExpiryReminderPreferencesRequestSchema.parse(
        await readDomainManagementJson(request),
      )
      const result = await (dependencies.update ?? updateCustomerDomainExpiryReminderPreferences)(
        authenticated.req,
        input,
        { customer: authenticated.customer, traceId },
      )
      return successResponse(domainAssetPreferenceResultSchema.parse(result), traceId)
    } catch (error) {
      return problemResponse(error, traceId)
    }
  }
}

export const PATCH = createDomainReminderPreferencesHandler({
  resolveContext: defaultDomainManagementContext,
})
