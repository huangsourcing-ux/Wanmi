import config from '@payload-config'
import { getPayload } from 'payload'

import { AppError, getTraceId, problemResponse, successResponse } from '@/lib/errors'
import {
  adminPersonalInformationQuerySchema,
  personalInformationResponseSchema,
} from '@/schemas/privacy'
import { systemAdminRequest } from '@/services/auth/admin-session'
import { readPersonalInformation } from '@/services/privacy/personal-information'

export async function GET(request: Request, context: { params: Promise<{ customerId: string }> }) {
  const traceId = getTraceId(request.headers)
  try {
    const { customerId: rawCustomerId } = await context.params
    const customerId = Number(rawCustomerId)
    if (!Number.isSafeInteger(customerId) || customerId <= 0) {
      throw new AppError('CUSTOMER_ID_INVALID', '客户编号无效', 400)
    }
    const query = adminPersonalInformationQuerySchema.parse({
      purpose: new URL(request.url).searchParams.get('purpose'),
    })
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    const result = await readPersonalInformation(req, {
      customerId,
      mode: 'view',
      purpose: query.purpose,
    })
    return successResponse(personalInformationResponseSchema.parse(result), traceId, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
