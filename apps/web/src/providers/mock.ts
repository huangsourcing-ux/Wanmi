import { randomUUID } from 'node:crypto'

import type { ProviderResult } from '@/lib/domain'

export function mockSuccess<T>(data: T, requestId = `mock-${randomUUID()}`): ProviderResult<T> {
  return { data, observedAt: new Date().toISOString(), ok: true, requestId }
}

export function mockFailure(
  code: string,
  options: { retryable?: boolean; statusKnown?: boolean } = {},
): ProviderResult<never> {
  return {
    error: {
      code,
      message: 'Mock provider failure',
      retryable: options.retryable ?? false,
      statusKnown: options.statusKnown ?? true,
    },
    observedAt: new Date().toISOString(),
    ok: false,
    requestId: `mock-${randomUUID()}`,
  }
}
