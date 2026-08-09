import config from '@payload-config'
import { getPayload } from 'payload'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { balanceControlUpdateSchema } from '@/schemas/balance-control'
import { systemAdminRequest } from '@/services/auth/admin-session'
import { loadBalanceControl, updateBalanceControl } from '@/services/commerce/balance-control'

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    const control = await loadBalanceControl(req)
    return successResponse({ configured: Boolean(control), value: control?.value }, getTraceId(req.headers))
  } catch (error) {
    return problemResponse(error, traceId)
  }
}

export async function PATCH(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = balanceControlUpdateSchema.parse(await readAdminCommerceBody(request))
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    const result = await updateBalanceControl(req, input)
    return successResponse(result, getTraceId(req.headers))
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
