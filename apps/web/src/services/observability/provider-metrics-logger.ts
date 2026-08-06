import { logger as defaultLogger } from '@/lib/logging'
import { bucketDuration } from '@/lib/analytics'
import { sanitizeSensitiveData } from '@/services/privacy/sanitize-sensitive-data'
import type {
  ProviderObservation,
  ToolObservabilityErrorCategory,
  ToolObservabilityProvider,
  ToolObservabilityProviderOperation,
  ToolObservabilityStore,
} from '@/services/observability/tool-observability'

type StructuredLogger = {
  info(fields: Record<string, unknown>): void
  warn(fields: Record<string, unknown>): void
}

export type ProviderObservabilityLogger = {
  drain(): Promise<void>
  logger: StructuredLogger
}

const providerValues = new Set<ToolObservabilityProvider>([
  'alidns',
  'node_tls',
  'westdigital',
  'whodat',
])

function provider(value: unknown): ToolObservabilityProvider | undefined {
  return typeof value === 'string' && providerValues.has(value as ToolObservabilityProvider)
    ? (value as ToolObservabilityProvider)
    : undefined
}

function providerOperation(
  providerName: ToolObservabilityProvider,
  event: string,
  value: unknown,
): ToolObservabilityProviderOperation | undefined {
  if (providerName === 'whodat' || event.startsWith('westdigital_whois.')) return 'whois'
  if (providerName === 'alidns') return 'dns'
  if (providerName === 'node_tls') return 'tls'
  return value === 'availability' || value === 'price' ? value : undefined
}

export function classifyProviderErrorCode(errorCode: string): ToolObservabilityErrorCategory {
  if (/(?:QUEUE_FULL|QUEUE_TIMEOUT|RATE_LIMITED)$/u.test(errorCode)) return 'rate_limited'
  if (
    /(?:INVALID_RESPONSE|RESPONSE_TOO_LARGE|HANDSHAKE_TOO_LARGE|REDIRECT_REJECTED)$/u.test(
      errorCode,
    )
  ) {
    return 'invalid_response'
  }
  if (/(?:^|_)TIMEOUT$/u.test(errorCode)) return 'timeout'
  return 'upstream_error'
}

export function providerObservationFromLog(
  fields: Readonly<Record<string, unknown>>,
  observedAt = new Date(),
): ProviderObservation | undefined {
  const event = typeof fields.event === 'string' ? fields.event : undefined
  const providerName = provider(fields.provider)
  if (!event || !providerName) return undefined
  const outcome = event.endsWith('.request_started')
    ? 'started'
    : event.endsWith('.request_succeeded')
      ? 'succeeded'
      : event.endsWith('.request_failed')
        ? 'failed'
        : undefined
  if (!outcome) return undefined
  const operation = providerOperation(providerName, event, fields.operation)
  if (!operation) return undefined
  const queueDepth =
    typeof fields.queueDepth === 'number' &&
    Number.isSafeInteger(fields.queueDepth) &&
    fields.queueDepth >= 0
      ? fields.queueDepth
      : undefined
  const durationBucket =
    typeof fields.durationMs === 'number' &&
    Number.isFinite(fields.durationMs) &&
    fields.durationMs >= 0
      ? bucketDuration(fields.durationMs)
      : undefined
  const errorCode =
    outcome === 'failed' && typeof fields.errorCode === 'string' ? fields.errorCode : undefined

  return {
    ...(durationBucket ? { durationBucket } : {}),
    ...(errorCode ? { errorCategory: classifyProviderErrorCode(errorCode) } : {}),
    observedAt,
    operation,
    outcome,
    provider: providerName,
    ...(queueDepth === undefined ? {} : { queueDepth }),
    rejected: Boolean(errorCode && /(?:QUEUE_FULL|QUEUE_TIMEOUT|RATE_LIMITED)$/u.test(errorCode)),
    scope: 'provider',
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError'
}

export function createProviderObservabilityLogger(
  store: ToolObservabilityStore,
  options: { baseLogger?: StructuredLogger; now?: () => Date } = {},
): ProviderObservabilityLogger {
  const baseLogger = options.baseLogger ?? defaultLogger
  const now = options.now ?? (() => new Date())
  const pending = new Set<Promise<void>>()

  const observe = (fields: Record<string, unknown>) => {
    const observation = providerObservationFromLog(fields, now())
    if (!observation) return
    const task = store.record(observation).catch((error: unknown) => {
      baseLogger.warn({
        errorType: errorName(error),
        event: 'observability.persist_failed',
        operation: observation.operation,
        provider: observation.provider,
        scope: 'provider',
      })
    })
    pending.add(task)
    void task.finally(() => pending.delete(task))
  }

  const write = (level: 'info' | 'warn', fields: Record<string, unknown>) => {
    const safeFields = sanitizeSensitiveData(fields)
    baseLogger[level](safeFields)
    observe(safeFields)
  }

  return {
    async drain() {
      while (pending.size > 0) await Promise.all([...pending])
    },
    logger: {
      info: (fields) => write('info', fields),
      warn: (fields) => write('warn', fields),
    },
  }
}
