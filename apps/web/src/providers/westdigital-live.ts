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
import type {
  WestDigitalReadTransport,
  WestDigitalTransportRequest,
  WestDigitalTransportResponse,
} from '@/providers/westdigital'
import {
  WestDigitalWriteTransportError,
  type WestDigitalWriteTransport,
  type WestDigitalWriteTransportRequest,
  type WestDigitalWriteTransportResponse,
} from '@/providers/westdigital-write'

type LiveRequest =
  | WestDigitalBalanceTransportRequest
  | WestDigitalTransportRequest
  | WestDigitalWriteTransportRequest
type LiveResponse =
  | WestDigitalBalanceTransportResponse
  | WestDigitalTransportResponse
  | WestDigitalWriteTransportResponse

function livePath(
  path: LiveRequest['path'],
): '/v2/audit/' | '/v2/domain/' | '/v2/domain/query/' | '/v2/info/' {
  if (path === 'v2/domain/query/') return '/v2/domain/query/'
  if (path === 'v2/info/') return '/v2/info/'
  return path
}

export class LiveWestDigitalTransport
  implements WestDigitalBalanceTransport, WestDigitalReadTransport, WestDigitalWriteTransport
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
          path: livePath(request.path),
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
      if (
        !('operation' in request) ||
        request.operation === 'availability' ||
        request.operation === 'price'
      ) {
        throw error
      }
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
