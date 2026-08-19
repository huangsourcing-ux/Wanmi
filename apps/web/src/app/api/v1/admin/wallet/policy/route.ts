import config from '@payload-config'
import { getPayload } from 'payload'

import { readAdminCommerceBody } from '@/app/api/v1/admin/_commerce-request'
import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { walletFundsPolicyUpdateSchema } from '@/schemas/wallet-policy'
import { systemAdminRequest } from '@/services/auth/admin-session'
import { loadWalletFundsPolicy, updateWalletFundsPolicy } from '@/services/wallet/policy'

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse({ value: await loadWalletFundsPolicy(req) }, getTraceId(req.headers))
  } catch (error) {
    return problemResponse(error, traceId)
  }
}

export async function PATCH(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const input = walletFundsPolicyUpdateSchema.parse(await readAdminCommerceBody(request))
    const payload = await getPayload({ config })
    const { req } = await systemAdminRequest(payload, request)
    return successResponse(await updateWalletFundsPolicy(req, input), getTraceId(req.headers))
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
