import type { ProviderResult } from '@/lib/domain'
import { AppError, toProblemDetails } from '@/lib/errors'
import type { Result, ResultMeta } from '@/schemas/api'

type ProviderResultOptions<T> = {
  dataSource: string
  fallbackData?: T
  lastSuccessfulAt?: string
  traceId: string
}

export function providerResultToResult<T>(
  providerResult: ProviderResult<T>,
  options: ProviderResultOptions<T>,
): Result<T> {
  const meta: ResultMeta = {
    dataSource: options.dataSource,
    lastSuccessfulAt: options.lastSuccessfulAt,
    observedAt: providerResult.observedAt,
    traceId: options.traceId,
  }

  if (providerResult.ok) return { data: providerResult.data, meta, state: 'ready' }

  const problem = toProblemDetails(
    new AppError(providerResult.error.code, '暂时无法取得最新数据', 503, {
      action: providerResult.error.retryable ? '请稍后重试' : '请稍后再试或使用其他工具',
      dataSource: options.dataSource,
      lastSuccessfulAt: options.lastSuccessfulAt,
      observedAt: providerResult.observedAt,
      retryable: providerResult.error.retryable,
      retryAfterSeconds: providerResult.error.retryAfterSeconds,
      title: providerResult.error.statusKnown ? '数据源暂时不可用' : '数据状态暂时无法确认',
    }),
    options.traceId,
  )

  if (Object.hasOwn(options, 'fallbackData')) {
    return {
      data: options.fallbackData as T,
      meta: { ...meta, stale: true },
      problem,
      state: 'degraded',
    }
  }

  return { meta, problem, state: 'error' }
}
