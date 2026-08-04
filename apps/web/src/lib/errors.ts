import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export type Problem = {
  code: string
  message: string
  traceId: string
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function getTraceId(headers?: Headers): string {
  const supplied = headers?.get('x-request-id')
  return supplied && /^[a-zA-Z0-9._:-]{8,128}$/.test(supplied) ? supplied : randomUUID()
}

export function problemResponse(error: unknown, traceId: string = randomUUID()): Response {
  const appError =
    error instanceof AppError
      ? error
      : error instanceof z.ZodError
        ? new AppError('INVALID_REQUEST', '请求参数无效', 400)
        : new AppError('INTERNAL_ERROR', '服务暂时不可用', 500)
  const body: Problem = { code: appError.code, message: appError.message, traceId }
  return Response.json(body, {
    status: appError.status,
    headers: { 'cache-control': 'no-store', 'x-request-id': traceId },
  })
}

export function successResponse<T>(data: T, traceId: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  headers.set('cache-control', 'no-store')
  headers.set('x-request-id', traceId)
  return Response.json(data, { ...init, headers })
}
