import config from '@payload-config'
import { getPayload } from 'payload'

import { getTraceId, problemResponse, successResponse } from '@/lib/errors'
import { walletStatementQuerySchema } from '@/schemas/wallet-statement'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { exportWalletStatement } from '@/services/wallet/statements'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const url = new URL(request.url)
    const input = walletStatementQuerySchema.parse({
      endDate: url.searchParams.get('endDate'),
      startDate: url.searchParams.get('startDate'),
    })
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    const response = successResponse(
      await exportWalletStatement(req, input),
      getTraceId(req.headers),
    )
    response.headers.set(
      'Content-Disposition',
      `attachment; filename="wallet-statement-${input.startDate}-${input.endDate}.json"`,
    )
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
