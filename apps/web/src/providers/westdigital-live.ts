import { getEnv } from '@/lib/env'
import { assertLiveRuntimeTransportAllowed } from '@/lib/provider-write-guardrails'
import {
  executeWestDigitalHttpRequest,
  WestDigitalHttpRequestError,
} from '@/providers/westdigital-http'
import type {
  WestDigitalBalanceTransport,
  WestDigitalBalanceTransportRequest,
  WestDigitalBalanceTransportResponse,
} from '@/providers/westdigital-balance'
import {
  WestDigitalWriteTransportError,
  type WestDigitalWriteTransport,
  type WestDigitalWriteTransportRequest,
  type WestDigitalWriteTransportResponse,
} from '@/providers/westdigital-write'

type LiveRequest = WestDigitalBalanceTransportRequest | WestDigitalWriteTransportRequest
type LiveResponse = WestDigitalBalanceTransportResponse | WestDigitalWriteTransportResponse

export class LiveWestDigitalTransport
  implements WestDigitalBalanceTransport, WestDigitalWriteTransport
{
  constructor() {
    assertLiveRuntimeTransportAllowed('westdigital')
  }

  async execute(request: LiveRequest): Promise<LiveResponse> {
    const env = getEnv()
    if (!env.WESTDIGITAL_USERNAME || !env.WESTDIGITAL_API_PASSWORD) {
      throw new Error('West Digital live transport credentials are missing')
    }
    try {
      return await executeWestDigitalHttpRequest(
        {
          body: request.body,
          path: request.path,
          requestId: request.requestId,
          signal: request.signal,
        },
        {
          apiPassword: env.WESTDIGITAL_API_PASSWORD,
          maxResponseBytes: env.WESTDIGITAL_READ_RESPONSE_MAX_BYTES,
          username: env.WESTDIGITAL_USERNAME,
        },
      )
    } catch (error) {
      if (!('operation' in request)) throw error
      const transportError =
        error instanceof WestDigitalHttpRequestError
          ? error
          : new WestDigitalHttpRequestError('UNAVAILABLE', 'unknown')
      throw new WestDigitalWriteTransportError(
        transportError.code === 'TIMEOUT'
          ? 'TIMEOUT'
          : transportError.submission === 'not_submitted'
            ? 'TEMPORARILY_UNAVAILABLE'
            : 'UNAVAILABLE',
        transportError.submission,
      )
    }
  }
}
