import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'
import { z } from 'zod'

import { AppError } from '@/lib/errors'
import { authenticatedCustomerRequest } from '@/services/auth/otp'

const MAX_BODY_BYTES = 16_384

export const dnsAssetIdSchema = z.coerce.number().int().positive()
export const dnsProviderRecordIdSchema = z.string().regex(/^\d+$/u)

export type DnsRouteContext = {
  customer: { collection: 'customers'; id: number; status?: string }
  req: PayloadRequest
}

export async function defaultDnsRouteContext(request: Request): Promise<DnsRouteContext> {
  const payload = await getPayload({ config })
  const { req, user } = await authenticatedCustomerRequest(payload, request)
  return {
    customer: { collection: 'customers', id: user.id, status: user.status },
    req,
  }
}

export async function readDnsJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON DNS 解析请求', 415)
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    throw new AppError('DNS_RECORD_REQUEST_TOO_LARGE', 'DNS 解析请求过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('DNS_RECORD_REQUEST_TOO_LARGE', 'DNS 解析请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}
