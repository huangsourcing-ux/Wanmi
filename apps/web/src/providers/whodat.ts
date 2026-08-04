import type { DomainProvider } from './types'
import { mockFailure, mockSuccess } from './mock'
import { getEnv } from '@/lib/env'

export class WhoDatProvider implements DomainProvider {
  async health() {
    const env = getEnv()
    try {
      const response = await fetch(env.WHO_DAT_URL, {
        headers: env.WHO_DAT_AUTH_KEY
          ? { authorization: `Bearer ${env.WHO_DAT_AUTH_KEY}` }
          : undefined,
        signal: AbortSignal.timeout(2_000),
      })
      return mockSuccess({ healthy: response.ok })
    } catch {
      return mockFailure('WHODAT_UNAVAILABLE', { retryable: true, statusKnown: true })
    }
  }

  async queryRegistration(input: { domainAscii: string; traceId: string }) {
    const env = getEnv()
    try {
      const response = await fetch(
        `${env.WHO_DAT_URL}/v1/whois/${encodeURIComponent(input.domainAscii)}`,
        {
          headers: env.WHO_DAT_AUTH_KEY
            ? { authorization: `Bearer ${env.WHO_DAT_AUTH_KEY}` }
            : undefined,
          signal: AbortSignal.timeout(5_000),
        },
      )
      if (!response.ok)
        return mockFailure('WHODAT_QUERY_FAILED', { retryable: response.status >= 500 })
      const data = (await response.json()) as { isRegistered?: boolean }
      return mockSuccess({ registered: data.isRegistered === true })
    } catch {
      return mockFailure('WHODAT_UNAVAILABLE', { retryable: true, statusKnown: false })
    }
  }

  async submitOperation(): Promise<never> {
    throw new Error('Who-Dat is read-only')
  }
}
