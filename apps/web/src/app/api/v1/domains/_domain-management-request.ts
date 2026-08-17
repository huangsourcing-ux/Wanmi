import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'
import { z } from 'zod'

import { AppError } from '@/lib/errors'
import { authenticatedCustomerRequest } from '@/services/auth/otp'

const MAX_BODY_BYTES = 16_384

export const domainManagementAssetIdSchema = z.coerce.number().int().positive()

export type DomainManagementRouteContext = {
  customer: { collection: 'customers'; id: number; status?: string }
  req: PayloadRequest
}

export async function defaultDomainManagementContext(
  request: Request,
): Promise<DomainManagementRouteContext> {
  const payload = await getPayload({ config })
  const { req, user } = await authenticatedCustomerRequest(payload, request)
  return {
    customer: { collection: 'customers', id: user.id, status: user.status },
    req,
  }
}

export async function readDomainManagementJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 域名管理请求', 415)
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    throw new AppError('DOMAIN_MANAGEMENT_REQUEST_TOO_LARGE', '域名管理请求过大', 413)
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('DOMAIN_MANAGEMENT_REQUEST_TOO_LARGE', '域名管理请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}
