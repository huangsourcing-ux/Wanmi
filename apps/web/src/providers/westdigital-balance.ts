import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { ProviderResult } from '@/lib/domain'
import { getEnv } from '@/lib/env'
import { assertLiveRuntimeTransportAllowed } from '@/lib/provider-write-guardrails'
import { LiveWestDigitalTransport } from '@/providers/westdigital-live'

import type { WestDigitalBalanceProvider } from './types'

export type WestDigitalBalanceTransportRequest = {
  body: Readonly<{ act: 'checkbalance' }>
  path: '/v2/info/'
  requestId: string
  signal: AbortSignal
  traceId: string
}

export type WestDigitalBalanceTransportResponse = { body: unknown; status: number }

export interface WestDigitalBalanceTransport {
  execute(input: WestDigitalBalanceTransportRequest): Promise<WestDigitalBalanceTransportResponse>
}

const decimalSchema = z.union([z.number().nonnegative(), z.string().regex(/^\d+(?:\.\d{1,2})?$/u)])
const envelopeSchema = z
  .object({
    data: z.object({ balance: decimalSchema, freezemoney: decimalSchema }).strict(),
    result: z.union([z.literal(200), z.literal('200')]),
  })
  .passthrough()

function minor(value: number | string): number {
  const text = String(value)
  if (!/^\d+(?:\.\d{1,2})?$/u.test(text)) throw new Error('Invalid WestDigital balance amount')
  const [yuan, fraction = ''] = text.split('.')
  const result = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error('Invalid WestDigital balance amount')
  return result
}

function success<T>(data: T, observedAt: string, requestId: string): ProviderResult<T> {
  return { data, observedAt, ok: true, requestId }
}

function failure<T>(code: string, observedAt: string, requestId: string): ProviderResult<T> {
  return {
    error: { code, message: '西部数码余额查询暂时不可用', retryable: true, statusKnown: false },
    observedAt,
    ok: false,
    requestId,
  }
}

export class WestDigitalBalanceAdapter implements WestDigitalBalanceProvider {
  constructor(
    private readonly options: {
      now?: () => Date
      requestIdFactory?: () => string
      timeoutMs?: number
      transport: WestDigitalBalanceTransport
    },
  ) {}

  async health(): Promise<ProviderResult<{ healthy: boolean }>> {
    const observedAt = (this.options.now ?? (() => new Date()))().toISOString()
    return success({ healthy: true }, observedAt, this.requestId())
  }

  async queryBalance(input: {
    traceId: string
  }): Promise<ProviderResult<{ availableMinor: number; frozenMinor: number }>> {
    const observedAt = (this.options.now ?? (() => new Date()))().toISOString()
    const requestId = this.requestId()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000)
    try {
      const response = await this.options.transport.execute({
        body: { act: 'checkbalance' },
        path: '/v2/info/',
        requestId,
        signal: controller.signal,
        traceId: input.traceId,
      })
      if (response.status !== 200) {
        return failure('WESTDIGITAL_BALANCE_UNAVAILABLE', observedAt, requestId)
      }
      const envelope = envelopeSchema.parse(response.body)
      return success(
        {
          availableMinor: minor(envelope.data.balance),
          frozenMinor: minor(envelope.data.freezemoney),
        },
        observedAt,
        requestId,
      )
    } catch {
      return failure('WESTDIGITAL_BALANCE_INVALID_OR_UNAVAILABLE', observedAt, requestId)
    } finally {
      clearTimeout(timeout)
    }
  }

  private requestId(): string {
    return (this.options.requestIdFactory ?? (() => `westdigital-balance-${randomUUID()}`))()
  }
}

export class FixtureWestDigitalBalanceTransport implements WestDigitalBalanceTransport {
  readonly requests: WestDigitalBalanceTransportRequest[] = []

  constructor(
    private readonly balance: { availableMinor: number; frozenMinor: number } = {
      availableMinor: 1_000_000,
      frozenMinor: 0,
    },
  ) {}

  async execute(
    input: WestDigitalBalanceTransportRequest,
  ): Promise<WestDigitalBalanceTransportResponse> {
    this.requests.push(input)
    return {
      body: {
        data: {
          balance: (this.balance.availableMinor / 100).toFixed(2),
          freezemoney: (this.balance.frozenMinor / 100).toFixed(2),
        },
        result: 200,
      },
      status: 200,
    }
  }
}

export function createConfiguredWestDigitalBalanceProvider(): WestDigitalBalanceAdapter {
  const env = getEnv()
  if (env.WESTDIGITAL_MODE === 'fixture') {
    return new WestDigitalBalanceAdapter({ transport: new FixtureWestDigitalBalanceTransport() })
  }
  if (
    !env.ALLOW_REAL_PROVIDER_WRITES ||
    !env.ALLOW_REAL_WESTDIGITAL ||
    !env.ALLOW_REAL_WESTDIGITAL_READS
  ) {
    throw new Error(
      'West Digital live balance mode requires the total, provider, and read-query safety gates',
    )
  }
  assertLiveRuntimeTransportAllowed('westdigital')
  return new WestDigitalBalanceAdapter({
    timeoutMs: env.WESTDIGITAL_READ_TIMEOUT_MS,
    transport: new LiveWestDigitalTransport(),
  })
}
