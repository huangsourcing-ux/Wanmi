import { getEnv } from '@/lib/env'
import { assertLiveRuntimeTransportAllowed } from '@/lib/provider-write-guardrails'
import {
  executeWestDigitalHttpRequest,
  WestDigitalHttpRequestError,
} from '@/providers/westdigital-http'
import { executeWestDigitalOfflineHttpRequest } from '@/providers/westdigital-offline-http'
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

type LiveWestDigitalTransportOptions = {
  fixedOriginFetchImpl?: typeof fetch
}

type StandardWestDigitalPath = '/v2/audit/' | '/v2/domain/' | '/v2/domain/query/' | '/v2/info/'
type StandardWestDigitalInputPath = StandardWestDigitalPath | 'v2/domain/query/' | 'v2/info/'

function livePath(path: StandardWestDigitalInputPath): StandardWestDigitalPath {
  if (path === 'v2/domain/query/') return '/v2/domain/query/'
  if (path === 'v2/info/') return '/v2/info/'
  return path
}

export class LiveWestDigitalTransport
  implements WestDigitalBalanceTransport, WestDigitalReadTransport, WestDigitalWriteTransport
{
  constructor(private readonly options: LiveWestDigitalTransportOptions = {}) {
    assertLiveRuntimeTransportAllowed('westdigital')
  }

  async execute(request: LiveRequest): Promise<LiveResponse> {
    const env = getEnv()
    if (!env.WESTDIGITAL_USERNAME || !env.WESTDIGITAL_API_PASSWORD) {
      throw new Error('West Digital live transport credentials are missing')
    }
    try {
      if (request.path.startsWith('/v2/offline-task/')) {
        return await executeWestDigitalOfflineHttpRequest(
          {
            body: request.body,
            path: request.path as
              | '/v2/offline-task/add-dns-record-task'
              | '/v2/offline-task/task-list'
              | '/v2/offline-task/task-record-list',
            requestId: request.requestId,
            signal: request.signal,
          },
          {
            apiPassword: env.WESTDIGITAL_API_PASSWORD,
            ...(this.options.fixedOriginFetchImpl
              ? { fetchImpl: this.options.fixedOriginFetchImpl }
              : {}),
            maxResponseBytes: env.WESTDIGITAL_READ_RESPONSE_MAX_BYTES,
            username: env.WESTDIGITAL_USERNAME,
          },
        )
      }
      return await executeWestDigitalHttpRequest(
        {
          body: request.body,
          path: livePath(request.path as StandardWestDigitalInputPath),
          requestId: request.requestId,
          signal: request.signal,
        },
        {
          apiPassword: env.WESTDIGITAL_API_PASSWORD,
          ...(this.options.fixedOriginFetchImpl
            ? { fetchImpl: this.options.fixedOriginFetchImpl }
            : {}),
          maxResponseBytes: env.WESTDIGITAL_READ_RESPONSE_MAX_BYTES,
          username: env.WESTDIGITAL_USERNAME,
        },
      )
    } catch (error) {
      if (
        !('operation' in request) ||
        request.operation === 'availability' ||
        request.operation === 'price' ||
        request.operation === 'asset_query' ||
        request.operation === 'dns_record_query' ||
        request.operation === 'domain_certificate_get' ||
        request.operation === 'domain_information_query' ||
        request.operation === 'domain_management_password_get' ||
        request.operation === 'offline_task_list' ||
        request.operation === 'offline_task_record_list' ||
        request.operation === 'realname_query'
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
