import { AppError } from '@/lib/errors'

const MAX_BODY_BYTES = 8_192

export async function readAdminCommerceBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅接受 JSON 管理请求', 415)
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES)
    throw new AppError('ADMIN_COMMERCE_BODY_TOO_LARGE', '管理请求过大', 413)
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new AppError('ADMIN_COMMERCE_BODY_TOO_LARGE', '管理请求过大', 413)
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError('INVALID_REQUEST', '请求格式无效', 400)
  }
}
