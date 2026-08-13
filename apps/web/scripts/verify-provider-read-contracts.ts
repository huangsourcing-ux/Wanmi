import { createHash, randomBytes, randomUUID } from 'node:crypto'

import OSS from 'ali-oss'

import { getEnv } from '../src/lib/env'
import type { ProviderResult } from '../src/lib/domain'
import {
  parseProviderReadContractSelection,
  providerReadContractSelectionIsComplete,
  shouldUseWestDigitalReadContractProxy,
} from '../src/lib/provider-read-contract-selection'
import { validateAliyunSmsLiveConfiguration } from '../src/providers/aliyunsms'
import { createRealnameObjectProvider } from '../src/providers/oss-realname'
import {
  deleteAllOssContractObjectVersions,
  type OssContractCleanupClient,
} from '../src/services/realname/oss-contract-cleanup'
import {
  createConfiguredWestDigitalBalanceProvider,
  type WestDigitalBalanceTransport,
  type WestDigitalBalanceTransportRequest,
  type WestDigitalBalanceTransportResponse,
} from '../src/providers/westdigital-balance'
import { LiveWestDigitalTransport } from '../src/providers/westdigital-live'
import {
  createConfiguredWestDigitalReadProvider,
  type WestDigitalReadTransport,
  type WestDigitalTransportRequest,
  type WestDigitalTransportResponse,
} from '../src/providers/westdigital'
import { createConfiguredWestDigitalWriteAdapter } from '../src/providers/westdigital-write-fixtures'
import type {
  WestDigitalWriteTransport,
  WestDigitalWriteTransportRequest,
  WestDigitalWriteTransportResponse,
} from '../src/providers/westdigital-write'
import { createConfiguredWechatPayProvider } from '../src/providers/wechatpay'
import { LiveWechatPayTransport } from '../src/providers/wechatpay-live'
import type {
  WechatPayTransport,
  WechatPayTransportRequest,
  WechatPayTransportResponse,
} from '../src/providers/wechatpay'

type ContractObservation = {
  actualFieldPaths: string[]
  adapterErrorCode?: string
  adapterOk?: boolean
  durationMs: number
  interface: string
  mappedFieldPaths?: string[]
  providerCode?: string
  requestIdHash?: string
  responseSerialMatched?: boolean
  responseSignaturePresent?: boolean
  responseSignatureVerified?: boolean
  status?: number
  transportErrorCode?: string
  verificationMode?: 'platform_certificate' | 'wechatpay_public_key'
}

type WestDigitalRequest =
  | WestDigitalBalanceTransportRequest
  | WestDigitalTransportRequest
  | WestDigitalWriteTransportRequest
type WestDigitalResponse =
  | WestDigitalBalanceTransportResponse
  | WestDigitalTransportResponse
  | WestDigitalWriteTransportResponse

const acknowledgement = 'D7-05-READ-ONLY'
const observations: ContractObservation[] = []
const failures: Array<{ code: string; interface: string }> = []

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required read-contract setting: ${name}`)
  return value
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertProviderOk<T>(
  result: ProviderResult<T>,
  interfaceName: string,
): asserts result is Extract<ProviderResult<T>, { ok: true }> {
  if (!result.ok) throw new Error(`${interfaceName} failed: ${result.error.code}`)
}

function roundedDuration(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10
}

function requestIdHash(value: string | undefined): string | undefined {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined
}

function fieldPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? [`${prefix}[]`] : ['[]']
    return [...new Set(value.flatMap((item) => fieldPaths(item, `${prefix}[]`)))].sort()
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => fieldPaths(child, prefix ? `${prefix}.${key}` : key))
      .sort()
  }
  return prefix ? [prefix] : []
}

function providerCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const candidate = body as { code?: unknown; result?: unknown }
  const value = candidate.code ?? candidate.result
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function mappedResult<T>(result: ProviderResult<T>): {
  adapterErrorCode?: string
  adapterOk: boolean
  mappedFieldPaths?: string[]
  requestIdHash?: string
} {
  return result.ok
    ? {
        adapterOk: true,
        mappedFieldPaths: fieldPaths(result.data),
        ...(requestIdHash(result.requestId)
          ? { requestIdHash: requestIdHash(result.requestId) }
          : {}),
      }
    : {
        adapterErrorCode: result.error.code,
        adapterOk: false,
        ...(requestIdHash(result.requestId)
          ? { requestIdHash: requestIdHash(result.requestId) }
          : {}),
      }
}

function westDigitalInterface(request: WestDigitalRequest): string {
  if ('operation' in request) {
    if (request.operation === 'asset_query') return 'westdigital.domain_detail'
    return `westdigital.${request.operation}`
  }
  return 'westdigital.balance'
}

class RecordingWestDigitalTransport
  implements WestDigitalBalanceTransport, WestDigitalReadTransport, WestDigitalWriteTransport
{
  constructor(private readonly delegate: LiveWestDigitalTransport) {}

  async execute(
    request: WestDigitalBalanceTransportRequest,
  ): Promise<WestDigitalBalanceTransportResponse>
  async execute(request: WestDigitalTransportRequest): Promise<WestDigitalTransportResponse>
  async execute(
    request: WestDigitalWriteTransportRequest,
  ): Promise<WestDigitalWriteTransportResponse>
  async execute(request: WestDigitalRequest): Promise<WestDigitalResponse> {
    const startedAt = performance.now()
    const name = westDigitalInterface(request)
    try {
      const response = await this.delegate.execute(request)
      observations.push({
        actualFieldPaths: fieldPaths(response.body),
        durationMs: roundedDuration(startedAt),
        interface: name,
        ...(providerCode(response.body) ? { providerCode: providerCode(response.body) } : {}),
        status: response.status,
      })
      return response
    } catch (error) {
      observations.push({
        actualFieldPaths: [],
        durationMs: roundedDuration(startedAt),
        interface: name,
        transportErrorCode:
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'UNAVAILABLE',
      })
      throw error
    }
  }

  attachMapped<T>(name: string, result: ProviderResult<T>): void {
    const observation = [...observations]
      .reverse()
      .find((candidate) => candidate.interface === name)
    if (!observation) throw new Error(`Missing transport observation for ${name}`)
    Object.assign(observation, mappedResult(result))
  }
}

class RecordingWechatPayTransport implements WechatPayTransport {
  constructor(private readonly delegate: LiveWechatPayTransport) {}

  async request(input: WechatPayTransportRequest): Promise<WechatPayTransportResponse> {
    const startedAt = performance.now()
    try {
      const response = await this.delegate.request(input)
      let body: unknown
      try {
        body = response.body ? (JSON.parse(response.body) as unknown) : {}
      } catch {
        body = undefined
      }
      const configuredSerial = getEnv().WECHATPAY_PLATFORM_CERTIFICATE_SERIAL
      const responseSerial = response.headers.get('wechatpay-serial')?.trim()
      observations.push({
        actualFieldPaths: fieldPaths(body),
        durationMs: roundedDuration(startedAt),
        interface: 'wechatpay.order_query',
        ...(providerCode(body) ? { providerCode: providerCode(body) } : {}),
        responseSerialMatched: Boolean(
          configuredSerial && responseSerial && configuredSerial === responseSerial,
        ),
        responseSignaturePresent: Boolean(
          response.headers.get('wechatpay-nonce')?.trim() &&
            responseSerial &&
            response.headers.get('wechatpay-signature')?.trim() &&
            response.headers.get('wechatpay-timestamp')?.trim(),
        ),
        status: response.status,
        verificationMode: configuredSerial?.startsWith('PUB_KEY_ID_')
          ? 'wechatpay_public_key'
          : 'platform_certificate',
      })
      return response
    } catch (error) {
      observations.push({
        actualFieldPaths: [],
        durationMs: roundedDuration(startedAt),
        interface: 'wechatpay.order_query',
        transportErrorCode:
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'UNAVAILABLE',
      })
      throw error
    }
  }

  attachMapped<T>(result: ProviderResult<T>): void {
    const observation = [...observations]
      .reverse()
      .find((candidate) => candidate.interface === 'wechatpay.order_query')
    if (!observation) throw new Error('Missing Wechat Pay transport observation')
    Object.assign(observation, mappedResult(result))
    observation.responseSignatureVerified = Boolean(
      observation.responseSignaturePresent &&
        observation.responseSerialMatched &&
        (result.ok || result.error.code !== 'WECHATPAY_RESPONSE_SIGNATURE_INVALID'),
    )
  }
}

function assertReadOnlyPreflight(): void {
  assert(
    process.env.RUN_REAL_PROVIDER_READ_CONTRACTS === acknowledgement,
    `RUN_REAL_PROVIDER_READ_CONTRACTS must equal ${acknowledgement}`,
  )
  assert(!/^(?:1|true)$/iu.test(process.env.CI ?? ''), 'Real contracts are forbidden in CI')

  const env = getEnv()
  assert(env.ALLOW_REAL_PROVIDER_WRITES, 'The temporary total provider gate must be enabled')
  assert(env.ALLOW_REAL_WESTDIGITAL, 'West Digital provider gate must be enabled')
  assert(env.ALLOW_REAL_WESTDIGITAL_READS, 'West Digital read gate must be enabled')
  assert(env.ALLOW_REAL_WECHATPAY, 'Wechat Pay provider gate must be enabled')
  assert(env.ALLOW_REAL_ALIYUN_OSS_REALNAME, 'Private OSS contract gate must be enabled')

  const forbiddenWriteGates: Array<[boolean, string]> = [
    [env.ALLOW_REAL_ALIYUN_SMS_SENDS, 'ALLOW_REAL_ALIYUN_SMS_SENDS'],
    [env.ALLOW_REAL_WECHATPAY_PAYMENTS, 'ALLOW_REAL_WECHATPAY_PAYMENTS'],
    [env.ALLOW_REAL_WECHATPAY_REFUNDS, 'ALLOW_REAL_WECHATPAY_REFUNDS'],
    [env.ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES, 'ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES'],
    [env.ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES, 'ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES'],
    [env.ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES, 'ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES'],
    [env.ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES, 'ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES'],
  ]
  const enabledWriteGates = forbiddenWriteGates.filter(([enabled]) => enabled).map(([, key]) => key)
  assert(
    enabledWriteGates.length === 0,
    `Read-only preflight rejected enabled write gates: ${enabledWriteGates.join(', ')}`,
  )
  assert(env.WESTDIGITAL_MODE === 'live', 'WESTDIGITAL_MODE must be live')
  assert(env.WECHATPAY_MODE === 'live', 'WECHATPAY_MODE must be live')
  assert(env.ALIYUN_OSS_REALNAME_MODE === 'live', 'ALIYUN_OSS_REALNAME_MODE must be live')
  assert(env.ALIYUN_SMS_MODE === 'live', 'ALIYUN_SMS_MODE must be live')
}

async function runCheck(name: string, execute: () => Promise<void>): Promise<void> {
  try {
    await execute()
  } catch (error) {
    failures.push({
      code: error instanceof Error ? error.name : 'UNKNOWN',
      interface: name,
    })
  }
}

async function verifyWestDigital(): Promise<void> {
  const lookupDomain = required('WESTDIGITAL_READ_CONTRACT_LOOKUP_DOMAIN')
  const assetDomain = required('WESTDIGITAL_READ_CONTRACT_ASSET_DOMAIN')
  const useEnvironmentProxy = shouldUseWestDigitalReadContractProxy({
    nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY,
    requested: process.env.WESTDIGITAL_READ_CONTRACT_USE_ENV_PROXY,
  })
  const transport = new RecordingWestDigitalTransport(
    new LiveWestDigitalTransport(useEnvironmentProxy ? { fixedOriginFetchImpl: fetch } : undefined),
  )
  const reads = createConfiguredWestDigitalReadProvider({ liveTransportFactory: () => transport })
  const assets = createConfiguredWestDigitalWriteAdapter({ liveTransportFactory: () => transport })
  const balance = createConfiguredWestDigitalBalanceProvider({
    liveTransportFactory: () => transport,
  })
  const traceId = `d7-05-westdigital-${randomUUID()}`

  const availability = await reads.queryAvailability({ domain: lookupDomain, traceId })
  transport.attachMapped('westdigital.availability', availability)
  assertProviderOk(availability, 'West Digital availability mapping')

  const price = await reads.queryPrice({ domain: lookupDomain, traceId, years: 1 })
  transport.attachMapped('westdigital.price', price)
  assertProviderOk(price, 'West Digital price mapping')

  const asset = await assets.queryAsset({ domainAscii: assetDomain, traceId })
  transport.attachMapped('westdigital.domain_detail', asset)
  assertProviderOk(asset, 'West Digital domain detail mapping')

  const accountBalance = await balance.queryBalance({ traceId })
  transport.attachMapped('westdigital.balance', accountBalance)
  assertProviderOk(accountBalance, 'West Digital balance mapping')
}

async function verifyWechatPay(): Promise<void> {
  const transport = new RecordingWechatPayTransport(new LiveWechatPayTransport())
  const provider = createConfiguredWechatPayProvider({ liveTransportFactory: () => transport })
  const merchantOrderNumber =
    process.env.WECHATPAY_READ_CONTRACT_ORDER?.trim() ??
    `D705${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
  const result = await provider.queryOrder({
    merchantOrderNumber,
    traceId: `d7-05-wechatpay-${randomUUID()}`,
  })
  transport.attachMapped(result)
  assert(!result.ok, 'Wechat Pay read contract order unexpectedly exists')
  assert(
    result.error.code === 'WECHATPAY_ORDER_NOT_FOUND',
    `Wechat Pay signed error mapping differed: ${result.error.code}`,
  )
  const observation = [...observations]
    .reverse()
    .find((candidate) => candidate.interface === 'wechatpay.order_query')
  assert(observation?.responseSignatureVerified, 'Wechat Pay response signature was not verified')
}

async function verifyPrivateOss(): Promise<void> {
  const provider = createRealnameObjectProvider()
  const env = getEnv()
  const prefix = env.OSS_REALNAME_PREFIX
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
  assert(accessKeyId && accessKeySecret, 'Private OSS credentials must be provided')
  assert(env.OSS_REALNAME_BUCKET && env.OSS_REALNAME_ENDPOINT, 'Private OSS location is required')
  const cleanupClient = new OSS({
    accessKeyId,
    accessKeySecret,
    bucket: env.OSS_REALNAME_BUCKET,
    endpoint: env.OSS_REALNAME_ENDPOINT,
    secure: true,
    timeout: 15_000,
  }) as OSS & OssContractCleanupClient
  const traceId = `d7-05-oss-${randomUUID()}`
  const key = `${prefix}/contract-tests/d7-05/${randomUUID()}.bin`
  const body = randomBytes(48)
  let uploadAttempted = false
  try {
    let startedAt = performance.now()
    uploadAttempted = true
    const upload = await provider.upload({ body, key, traceId })
    observations.push({
      actualFieldPaths: upload.ok ? fieldPaths(upload.data) : [],
      ...mappedResult(upload),
      durationMs: roundedDuration(startedAt),
      interface: 'aliyun.oss_private_upload_test_object',
    })
    assertProviderOk(upload, 'Private OSS test-object upload')

    startedAt = performance.now()
    const read = await provider.read({ key, traceId })
    observations.push({
      actualFieldPaths: read.ok ? fieldPaths(read.data) : [],
      ...mappedResult(read),
      durationMs: roundedDuration(startedAt),
      interface: 'aliyun.oss_private_read_test_object',
    })
    assertProviderOk(read, 'Private OSS test-object read')
    assert(Buffer.from(read.data.body).equals(body), 'Private OSS returned different test bytes')

    startedAt = performance.now()
    const signed = await provider.signRead({ expiresSeconds: 60, key, traceId })
    assertProviderOk(signed, 'Private OSS signed read')
    const response = await fetch(signed.data.url, { signal: AbortSignal.timeout(15_000) })
    const signedBody = Buffer.from(await response.arrayBuffer())
    observations.push({
      actualFieldPaths: ['url'],
      adapterOk: response.ok && signedBody.equals(body),
      durationMs: roundedDuration(startedAt),
      interface: 'aliyun.oss_private_signed_read_test_object',
      mappedFieldPaths: ['url'],
      status: response.status,
    })
    assert(
      response.ok && signedBody.equals(body),
      'Private OSS signed read returned different bytes',
    )
  } finally {
    if (uploadAttempted) {
      try {
        const startedAt = performance.now()
        const deleted = await provider.deleteObject({ key, traceId })
        observations.push({
          actualFieldPaths: deleted.ok ? fieldPaths(deleted.data) : [],
          ...mappedResult(deleted),
          durationMs: roundedDuration(startedAt),
          interface: 'aliyun.oss_private_delete_test_object',
        })
        assert(deleted.ok, 'Private OSS test-object cleanup failed')
      } finally {
        const startedAt = performance.now()
        const cleanup = await deleteAllOssContractObjectVersions({
          allowedPrefix: prefix,
          client: cleanupClient,
          key,
        })
        observations.push({
          actualFieldPaths: fieldPaths(cleanup),
          adapterOk: true,
          durationMs: roundedDuration(startedAt),
          interface: 'aliyun.oss_private_delete_all_test_object_versions',
          mappedFieldPaths: fieldPaths(cleanup),
        })
      }
    }
    body.fill(0)
  }
}

async function verifySmsConfiguration(): Promise<void> {
  const startedAt = performance.now()
  try {
    const configuration = validateAliyunSmsLiveConfiguration()
    observations.push({
      actualFieldPaths: fieldPaths(configuration),
      adapterOk: true,
      durationMs: roundedDuration(startedAt),
      interface: 'aliyun.sms_configuration_load_only',
      mappedFieldPaths: fieldPaths(configuration),
    })
  } catch (error) {
    observations.push({
      actualFieldPaths: [],
      adapterErrorCode: error instanceof Error ? error.name : 'UNKNOWN',
      adapterOk: false,
      durationMs: roundedDuration(startedAt),
      interface: 'aliyun.sms_configuration_load_only',
    })
    throw error
  }
}

async function main(): Promise<void> {
  assertReadOnlyPreflight()
  const selectedCategories = parseProviderReadContractSelection(
    process.env.PROVIDER_READ_CONTRACT_CATEGORIES,
  )
  if (selectedCategories.includes('westdigital')) {
    await runCheck('westdigital', verifyWestDigital)
  }
  if (selectedCategories.includes('wechatpay')) {
    await runCheck('wechatpay', verifyWechatPay)
  }
  if (selectedCategories.includes('aliyun.oss_private')) {
    await runCheck('aliyun.oss_private', verifyPrivateOss)
  }
  if (selectedCategories.includes('aliyun.sms_configuration')) {
    await runCheck('aliyun.sms_configuration', verifySmsConfiguration)
  }

  const completeSelection = providerReadContractSelectionIsComplete(selectedCategories)
  const status = failures.length > 0 ? 'failed' : completeSelection ? 'passed' : 'partial'

  process.stdout.write(
    `${JSON.stringify(
      {
        acknowledgement,
        failures,
        observations,
        observedAt: new Date().toISOString(),
        selectedCategories,
        smsSent: false,
        status,
        westDigitalWrites: 0,
        wechatPayWrites: 0,
      },
      null,
      2,
    )}\n`,
  )
  if (failures.length > 0) process.exitCode = 1
  else if (!completeSelection) process.exitCode = 2
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      code: error instanceof Error ? error.name : 'UNKNOWN',
      message: error instanceof Error ? error.message : 'Read-contract preflight failed',
      status: 'blocked',
    })}\n`,
  )
  process.exitCode = 1
})
