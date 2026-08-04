import { z } from 'zod'

import { createTraceId, getTraceId, isValidTraceId } from '@/lib/request-id'
import { PROBLEM_CODE_PATTERN, problemDetailsSchema, type ProblemDetails } from '@/schemas/api'

export type AppErrorOptions = {
  action?: string
  dataSource?: string
  lastSuccessfulAt?: string
  observedAt?: string
  retryable?: boolean
  retryAfterSeconds?: number
  title?: string
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly options: AppErrorOptions = {},
  ) {
    super(message)
    this.name = 'AppError'
  }
}

type ProblemPresentation = {
  action: string
  retryable: boolean
  title: string
}

function presentationForStatus(status: number): ProblemPresentation {
  if (status === 401)
    return {
      action: '请重新验证身份后再试',
      retryable: false,
      title: '身份验证未通过',
    }
  if (status === 403)
    return { action: '请确认当前账号权限', retryable: false, title: '当前操作不可用' }
  if (status === 404)
    return { action: '请检查地址或返回上一页', retryable: false, title: '未找到请求的内容' }
  if (status === 429) return { action: '请稍后再试', retryable: true, title: '请求过于频繁' }
  if (status >= 500) return { action: '请稍后重试', retryable: true, title: '服务暂时不可用' }
  return { action: '请检查输入内容后重试', retryable: false, title: '请求未能完成' }
}

function normalizeStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
}

function isProblemStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 599
}

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (error instanceof z.ZodError)
    return new AppError('INVALID_REQUEST', '请求参数无效', 400, {
      action: '请检查填写内容后重试',
      retryable: false,
      title: '请求参数无效',
    })
  return new AppError('INTERNAL_ERROR', '服务暂时不可用', 500, {
    action: '请稍后重试',
    retryable: true,
    title: '服务暂时不可用',
  })
}

export function toProblemDetails(error: unknown, traceId: string): ProblemDetails {
  const normalizedError = normalizeError(error)
  const appError =
    PROBLEM_CODE_PATTERN.test(normalizedError.code) && isProblemStatus(normalizedError.status)
      ? normalizedError
      : normalizeError(undefined)
  const status = normalizeStatus(appError.status)
  const defaults = presentationForStatus(status)
  const detail = appError.message
  const safeTraceId = isValidTraceId(traceId) ? traceId : createTraceId()

  const parsed = problemDetailsSchema.safeParse({
    action: appError.options.action ?? defaults.action,
    code: appError.code,
    dataSource: appError.options.dataSource,
    detail,
    lastSuccessfulAt: appError.options.lastSuccessfulAt,
    message: detail,
    observedAt: appError.options.observedAt,
    retryable: appError.options.retryable ?? defaults.retryable,
    retryAfterSeconds: appError.options.retryAfterSeconds,
    status,
    title: appError.options.title ?? defaults.title,
    traceId: safeTraceId,
    type: `urn:wanmi:problem:${appError.code}`,
  })
  if (parsed.success) return parsed.data

  return problemDetailsSchema.parse({
    action: '请稍后重试',
    code: 'INTERNAL_ERROR',
    detail: '服务暂时不可用',
    message: '服务暂时不可用',
    retryable: true,
    status: 500,
    title: '服务暂时不可用',
    traceId: safeTraceId,
    type: 'urn:wanmi:problem:INTERNAL_ERROR',
  })
}

export function problemResponse(error: unknown, traceId: string = createTraceId()): Response {
  const body = toProblemDetails(error, traceId)
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/problem+json',
    'x-request-id': body.traceId,
  })
  if (body.retryAfterSeconds) headers.set('retry-after', String(body.retryAfterSeconds))

  return Response.json(body, {
    status: body.status,
    headers,
  })
}

export function successResponse<T>(data: T, traceId: string, init?: ResponseInit): Response {
  const safeTraceId = isValidTraceId(traceId) ? traceId : createTraceId()
  const headers = new Headers(init?.headers)
  headers.set('cache-control', 'no-store')
  headers.set('x-request-id', safeTraceId)
  return Response.json(data, { ...init, headers })
}

export async function readProblemResponse(response: Response): Promise<ProblemDetails> {
  const candidate = await response.json().catch(() => undefined)
  const parsed = problemDetailsSchema.safeParse(candidate)
  if (parsed.success && parsed.data.status === response.status) return parsed.data

  const status = normalizeStatus(response.status)
  const defaults = presentationForStatus(status)
  const traceId = getTraceId(response.headers)
  const code = `HTTP_${status}`
  const detail = status >= 500 ? '服务暂时不可用' : '请求未能完成'

  return problemDetailsSchema.parse({
    action: defaults.action,
    code,
    detail,
    message: detail,
    retryable: defaults.retryable,
    status,
    title: defaults.title,
    traceId,
    type: `urn:wanmi:problem:${code}`,
  })
}

export { getTraceId }
