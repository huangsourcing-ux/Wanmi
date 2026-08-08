import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { ProviderResult } from '@/lib/domain'
import { normalizeDomain } from '@/lib/domain-name'

import { mapWestDigitalRealnameCreateFields } from './westdigital-realname'
import type {
  WestDigitalDomainAsset,
  WestDigitalRealnameProfile,
  WestDigitalRealnameReviewState,
  WestDigitalWriteConfirmation,
  WestDigitalWriteProvider,
} from './types'

export type WestDigitalWriteTransportOperation =
  | 'asset_query'
  | 'nameserver'
  | 'realname_create'
  | 'realname_query'
  | 'register'
  | 'renew'

export type WestDigitalWriteTransportRequest = {
  body: Readonly<Record<string, string>>
  operation: WestDigitalWriteTransportOperation
  path: '/v2/audit/' | '/v2/domain/'
  requestId: string
  signal: AbortSignal
  traceId: string
}

export type WestDigitalWriteTransportResponse = {
  body: unknown
  status: number
}

export interface WestDigitalWriteTransport {
  execute(input: WestDigitalWriteTransportRequest): Promise<WestDigitalWriteTransportResponse>
}

export class WestDigitalWriteTransportError extends Error {
  constructor(
    readonly code: 'RATE_LIMITED' | 'TEMPORARILY_UNAVAILABLE' | 'TIMEOUT' | 'UNAVAILABLE',
    readonly submission: 'not_submitted' | 'unknown',
  ) {
    super(code)
    this.name = 'WestDigitalWriteTransportError'
  }
}

type AdapterOptions = {
  now?: () => Date
  requestIdFactory?: () => string
  timeoutMs?: number
  transport: WestDigitalWriteTransport
}

const resultCodeSchema = z.union([z.number().int(), z.string().regex(/^\d+$/u)]).transform(Number)
const envelopeSchema = z
  .object({
    clientid: z.union([z.string(), z.number()]).transform(String).optional(),
    data: z.unknown().optional(),
    result: resultCodeSchema,
  })
  .passthrough()

const templateCreateDataSchema = z.object({ c_sysid: z.union([z.string(), z.number()]).transform(String) })
const templateQueryDataSchema = z
  .object({
    c_status: z.union([z.string(), z.number()]).transform(Number).optional(),
    r_status: z.union([z.string(), z.number()]).transform(Number).optional(),
    r_statusname: z.string().optional(),
    status_name: z.string().optional(),
  })
  .passthrough()
const assetDataSchema = z
  .object({
    dns1: z.string().default(''),
    dns2: z.string().default(''),
    dns3: z.string().default(''),
    dns4: z.string().default(''),
    dns5: z.string().default(''),
    dns6: z.string().default(''),
    domain: z.string().min(1),
    expdate: z.string().min(1),
    id: z.union([z.string(), z.number()]).transform(String),
    regdate: z.string().min(1),
    registrars: z.string().optional(),
  })
  .passthrough()

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
const positiveYearsSchema = z.number().int().min(1).max(10)
const nonNegativeFenSchema = z.number().int().nonnegative().safe()

const RETRYABLE_NOT_SUBMITTED_CODES = new Set([
  'WESTDIGITAL_RATE_LIMITED',
  'WESTDIGITAL_TEMPORARILY_UNAVAILABLE',
])

function success<T>(data: T, observedAt: string, requestId: string): ProviderResult<T> {
  return { data, observedAt, ok: true, requestId }
}

function failure<T>(
  code: string,
  message: string,
  observedAt: string,
  requestId: string,
  options: { retryable: boolean; statusKnown: boolean },
): ProviderResult<T> {
  return { error: { code, message, ...options }, observedAt, ok: false, requestId }
}

function yuanFromFen(value: number): string {
  const fen = nonNegativeFenSchema.parse(value)
  return `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, '0')}`
}

function asciiDomain(value: string): string {
  const normalized = normalizeDomain(value)
  if (!normalized.ok || normalized.value.ascii !== value.toLowerCase()) {
    throw new Error('Invalid normalized ASCII domain')
  }
  return normalized.value.ascii
}

function nameservers(values: string[]): string[] {
  if (values.length < 2 || values.length > 15) throw new Error('Two to fifteen name servers required')
  const normalized = values.map(asciiDomain)
  if (new Set(normalized).size !== normalized.length) throw new Error('Duplicate name servers')
  return normalized
}

function reviewState(data: z.infer<typeof templateQueryDataSchema>): WestDigitalRealnameReviewState {
  const label = `${data.r_statusname ?? ''} ${data.status_name ?? ''}`
  if (/通过|已实名|审核成功/u.test(label) || data.r_status === 1 || data.c_status === 1) return 'approved'
  if (/失败|拒绝|不通过/u.test(label) || data.r_status === -1 || data.c_status === -1) return 'rejected'
  if (/待|审核|未实名|未传图片/u.test(label) || data.r_status === 0 || data.c_status === 0) return 'pending'
  return 'unknown'
}

export function isExplicitlyRetryableWestDigitalWriteError(code: string): boolean {
  return RETRYABLE_NOT_SUBMITTED_CODES.has(code)
}

export class WestDigitalWriteAdapter implements WestDigitalWriteProvider {
  private readonly now: () => Date
  private readonly requestIdFactory: () => string
  private readonly timeoutMs: number

  constructor(private readonly options: AdapterOptions) {
    this.now = options.now ?? (() => new Date())
    this.requestIdFactory = options.requestIdFactory ?? (() => `westdigital-write-${randomUUID()}`)
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  async health(): Promise<ProviderResult<{ healthy: boolean }>> {
    return success({ healthy: true }, this.now().toISOString(), this.requestIdFactory())
  }

  async createRealname(input: {
    profile: WestDigitalRealnameProfile
    traceId: string
  }): Promise<ProviderResult<WestDigitalWriteConfirmation & { providerTemplateId: string }>> {
    const body = mapWestDigitalRealnameCreateFields(input.profile)
    return this.request({
      body,
      input,
      operation: 'realname_create',
      parse: (envelope) => {
        const data = templateCreateDataSchema.parse(envelope.data)
        return {
          providerClientId: envelope.clientid!,
          providerTemplateId: data.c_sysid,
          state: 'accepted' as const,
        }
      },
      path: '/v2/audit/',
      write: true,
    })
  }

  async register(input: {
    clientPriceFen: number
    domainAscii: string
    nameservers: string[]
    premium: boolean
    providerTemplateId: string
    traceId: string
    years: number
  }): Promise<ProviderResult<WestDigitalWriteConfirmation>> {
    const domain = asciiDomain(input.domainAscii)
    const dns = nameservers(input.nameservers)
    const body: Record<string, string> = {
      act: 'regdomain',
      client_price: yuanFromFen(input.clientPriceFen),
      c_sysid: z.string().regex(/^\d+$/u).parse(input.providerTemplateId),
      domain,
      regyear: String(positiveYearsSchema.parse(input.years)),
    }
    dns.forEach((value, index) => (body[`dns_host${index + 1}`] = value))
    if (input.premium) body.premium = 'yes'
    return this.request({
      body,
      input,
      operation: 'register',
      parse: (envelope) => {
        const value = z.record(z.string(), z.union([z.number(), z.string()])).parse(envelope.data)[domain]
        if (Number(value) !== 200) throw new Error('Domain registration explicitly rejected')
        return { providerClientId: envelope.clientid!, state: 'accepted' as const }
      },
      path: '/v2/audit/',
      write: true,
    })
  }

  async renew(input: {
    clientPriceFen: number
    currentExpiresOn: string
    domainAscii: string
    premium: boolean
    traceId: string
    years: number
  }): Promise<ProviderResult<WestDigitalWriteConfirmation>> {
    const body: Record<string, string> = {
      act: 'renew',
      client_price: yuanFromFen(input.clientPriceFen),
      domain: asciiDomain(input.domainAscii),
      expiredate: dateOnlySchema.parse(input.currentExpiresOn),
      year: String(positiveYearsSchema.parse(input.years)),
    }
    if (input.premium) body.premium = 'yes'
    return this.request({
      body,
      input,
      operation: 'renew',
      parse: (envelope) => ({ providerClientId: envelope.clientid!, state: 'accepted' as const }),
      path: '/v2/domain/',
      write: true,
    })
  }

  async changeNameservers(input: {
    domainAscii: string
    nameservers: string[]
    traceId: string
  }): Promise<ProviderResult<WestDigitalWriteConfirmation>> {
    const body: Record<string, string> = { act: 'moddns', domain: asciiDomain(input.domainAscii) }
    nameservers(input.nameservers).forEach((value, index) => (body[`dns${index + 1}`] = value))
    return this.request({
      body,
      input,
      operation: 'nameserver',
      parse: (envelope) => ({ providerClientId: envelope.clientid!, state: 'accepted' as const }),
      path: '/v2/domain/',
      write: true,
    })
  }

  async queryAsset(input: {
    domainAscii: string
    traceId: string
  }): Promise<ProviderResult<WestDigitalDomainAsset>> {
    const expected = asciiDomain(input.domainAscii)
    return this.request({
      body: { act: 'view', domain: expected },
      input,
      operation: 'asset_query',
      parse: (envelope) => {
        const data = assetDataSchema.parse(envelope.data)
        if (asciiDomain(data.domain) !== expected) throw new Error('Mismatched asset domain')
        return {
          domainAscii: expected,
          expiresAt: data.expdate,
          nameservers: [data.dns1, data.dns2, data.dns3, data.dns4, data.dns5, data.dns6].filter(Boolean),
          providerAssetId: data.id,
          registeredAt: data.regdate,
          registrarCode: data.registrars ?? 'westdigital',
        }
      },
      path: '/v2/domain/',
      write: false,
    })
  }

  async queryRealname(input: { providerTemplateId: string; traceId: string }): Promise<
    ProviderResult<
      WestDigitalWriteConfirmation & { reviewState: WestDigitalRealnameReviewState }
    >
  > {
    return this.request({
      body: { act: 'auditinfo', c_sysid: z.string().regex(/^\d+$/u).parse(input.providerTemplateId) },
      input,
      operation: 'realname_query',
      parse: (envelope) => {
        const review = reviewState(templateQueryDataSchema.parse(envelope.data))
        const state =
          review === 'approved'
            ? ('succeeded' as const)
            : review === 'rejected'
              ? ('failed' as const)
              : review
        return { providerClientId: envelope.clientid!, reviewState: review, state }
      },
      path: '/v2/audit/',
      write: false,
    })
  }

  private async request<T>(input: {
    body: Readonly<Record<string, string>>
    input: { traceId: string }
    operation: WestDigitalWriteTransportOperation
    parse: (envelope: z.infer<typeof envelopeSchema>) => T
    path: '/v2/audit/' | '/v2/domain/'
    write: boolean
  }): Promise<ProviderResult<T>> {
    const requestId = this.requestIdFactory()
    const observedAt = () => this.now().toISOString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.options.transport.execute({
        body: input.body,
        operation: input.operation,
        path: input.path,
        requestId,
        signal: controller.signal,
        traceId: input.input.traceId,
      })
      if (response.status !== 200) {
        return failure(
          input.write ? 'WESTDIGITAL_WRITE_STATUS_UNKNOWN' : 'WESTDIGITAL_QUERY_UNAVAILABLE',
          '西部数码返回非预期 HTTP 状态',
          observedAt(),
          requestId,
          { retryable: false, statusKnown: !input.write },
        )
      }
      const envelope = envelopeSchema.safeParse(response.body)
      if (!envelope.success || envelope.data.result !== 200 || !envelope.data.clientid) {
        return failure(
          'WESTDIGITAL_EXPLICIT_REJECTION',
          '西部数码明确拒绝该操作',
          observedAt(),
          requestId,
          { retryable: false, statusKnown: true },
        )
      }
      try {
        return success(input.parse(envelope.data), observedAt(), requestId)
      } catch {
        return failure(
          input.write ? 'WESTDIGITAL_WRITE_STATUS_UNKNOWN' : 'WESTDIGITAL_INVALID_RESPONSE',
          '西部数码响应无法安全确认',
          observedAt(),
          requestId,
          { retryable: false, statusKnown: !input.write },
        )
      }
    } catch (error) {
      const transportError =
        error instanceof WestDigitalWriteTransportError
          ? error
          : new WestDigitalWriteTransportError(
              controller.signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE',
              input.write ? 'unknown' : 'not_submitted',
            )
      const code =
        transportError.submission === 'unknown'
          ? 'WESTDIGITAL_WRITE_STATUS_UNKNOWN'
          : transportError.code === 'RATE_LIMITED'
            ? 'WESTDIGITAL_RATE_LIMITED'
            : transportError.code === 'TEMPORARILY_UNAVAILABLE'
              ? 'WESTDIGITAL_TEMPORARILY_UNAVAILABLE'
              : transportError.code === 'TIMEOUT'
                ? 'WESTDIGITAL_QUERY_TIMEOUT'
                : 'WESTDIGITAL_QUERY_UNAVAILABLE'
      return failure(code, '西部数码请求未能安全完成', observedAt(), requestId, {
        retryable: transportError.submission === 'not_submitted' && RETRYABLE_NOT_SUBMITTED_CODES.has(code),
        statusKnown: transportError.submission === 'not_submitted',
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}
