import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'

import { z } from 'zod'

import { getEnv } from '@/lib/env'
import type { ProviderResult } from '@/lib/domain'

import { mockFailure, mockSuccess } from './mock'
import type {
  PaymentChannel,
  PaymentOrder,
  PaymentProvider,
  VerifiedPaymentNotification,
} from './types'

const merchantOrderNumberSchema = z.string().regex(/^[A-Za-z0-9_*-]{1,32}$/u)
const paymentOrderSchema = z
  .object({
    amount: z.object({ currency: z.literal('CNY'), total: z.number().int().nonnegative() }),
    appid: z.string().min(1).max(32),
    mchid: z.string().min(1).max(32),
    out_trade_no: merchantOrderNumberSchema,
    success_time: z.iso.datetime({ offset: true }).optional(),
    trade_state: z.enum([
      'CLOSED',
      'NOTPAY',
      'PAYERROR',
      'REFUND',
      'REVOKED',
      'SUCCESS',
      'USERPAYING',
    ]),
    transaction_id: z.string().min(1).max(32).optional(),
  })
  .passthrough()

const notificationEnvelopeSchema = z
  .object({
    create_time: z.iso.datetime({ offset: true }),
    event_type: z.literal('TRANSACTION.SUCCESS'),
    id: z.string().min(1).max(36),
    resource: z
      .object({
        algorithm: z.literal('AEAD_AES_256_GCM'),
        associated_data: z.string().max(16).default(''),
        ciphertext: z.string().min(1).max(1_048_576),
        nonce: z.string().min(1).max(32),
        original_type: z.literal('transaction'),
      })
      .strict(),
    resource_type: z.literal('encrypt-resource'),
    summary: z.string().max(64),
  })
  .strict()

const transactionResourceSchema = z
  .object({
    amount: z.object({ currency: z.literal('CNY'), total: z.number().int().nonnegative() }),
    appid: z.string().min(1).max(32),
    mchid: z.string().min(1).max(32),
    out_trade_no: merchantOrderNumberSchema,
    success_time: z.iso.datetime({ offset: true }),
    trade_state: z.literal('SUCCESS'),
    transaction_id: z.string().min(1).max(32),
  })
  .passthrough()

export type WechatPayTransportRequest = {
  authorization: string
  body: string
  method: 'GET' | 'POST'
  path: string
  traceId: string
}

export type WechatPayTransportResponse = {
  body: string
  headers: Headers
  status: number
}

export interface WechatPayTransport {
  request(input: WechatPayTransportRequest): Promise<WechatPayTransportResponse>
}

type AdapterOptions = {
  apiV3Key: Uint8Array
  appId: string
  merchantCertificateSerial: string
  merchantId: string
  merchantPrivateKey: KeyObject
  notifyUrl: string
  now?: () => Date
  nonce?: () => string
  transport: WechatPayTransport
  wechatPayPublicKeys: ReadonlyMap<string, KeyObject>
}

function canonicalRequest(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`
}

function canonicalResponse(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}\n${nonce}\n${body}\n`
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim()
  return value || undefined
}

function verifyWechatSignature(
  headers: Headers,
  body: string,
  keys: ReadonlyMap<string, KeyObject>,
  now: Date,
): boolean {
  const nonce = header(headers, 'wechatpay-nonce')
  const serial = header(headers, 'wechatpay-serial')
  const signature = header(headers, 'wechatpay-signature')
  const timestamp = header(headers, 'wechatpay-timestamp')
  const publicKey = serial ? keys.get(serial) : undefined
  if (!nonce || !signature || !timestamp || !publicKey || !/^\d{10}$/u.test(timestamp)) return false
  const signedAtMilliseconds = Number(timestamp) * 1_000
  if (
    !Number.isSafeInteger(signedAtMilliseconds) ||
    Math.abs(now.getTime() - signedAtMilliseconds) > 5 * 60 * 1_000
  ) {
    return false
  }
  try {
    return verify(
      'RSA-SHA256',
      Buffer.from(canonicalResponse(timestamp, nonce, body)),
      publicKey,
      Buffer.from(signature, 'base64'),
    )
  } catch {
    return false
  }
}

function decryptNotificationResource(
  key: Uint8Array,
  resource: z.infer<typeof notificationEnvelopeSchema>['resource'],
): unknown {
  const encrypted = Buffer.from(resource.ciphertext, 'base64')
  if (encrypted.length <= 16) throw new Error('Invalid encrypted resource')
  const ciphertext = encrypted.subarray(0, -16)
  const authTag = encrypted.subarray(-16)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce))
  decipher.setAAD(Buffer.from(resource.associated_data))
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as unknown
}

function tradeState(
  value: z.infer<typeof paymentOrderSchema>['trade_state'],
): PaymentOrder['state'] {
  if (value === 'SUCCESS') return 'paid'
  if (value === 'NOTPAY' || value === 'USERPAYING') return 'not_paid'
  if (value === 'CLOSED' || value === 'REVOKED' || value === 'PAYERROR') return 'closed'
  if (value === 'REFUND') return 'refunded'
  return 'unknown'
}

export class WechatPayApiV3Adapter implements PaymentProvider {
  private readonly now: () => Date
  private readonly nonce: () => string

  constructor(private readonly options: AdapterOptions) {
    if (options.apiV3Key.byteLength !== 32)
      throw new Error('Wechat Pay API v3 key must be 32 bytes')
    this.now = options.now ?? (() => new Date())
    this.nonce = options.nonce ?? (() => randomBytes(16).toString('hex'))
  }

  async health() {
    return mockSuccess({ healthy: true }, 'wechatpay-configured')
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    candidateBody: unknown,
    traceId: string,
  ): Promise<ProviderResult<unknown>> {
    const body = method === 'POST' ? JSON.stringify(candidateBody) : ''
    const timestamp = String(Math.floor(this.now().getTime() / 1000))
    const nonce = this.nonce()
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(canonicalRequest(method, path, timestamp, nonce, body)),
      this.options.merchantPrivateKey,
    ).toString('base64')
    const authorization =
      `WECHATPAY2-SHA256-RSA2048 mchid="${this.options.merchantId}",` +
      `nonce_str="${nonce}",timestamp="${timestamp}",` +
      `serial_no="${this.options.merchantCertificateSerial}",signature="${signature}"`
    let response: WechatPayTransportResponse
    try {
      response = await this.options.transport.request({
        authorization,
        body,
        method,
        path,
        traceId,
      })
    } catch {
      return mockFailure('WECHATPAY_TRANSPORT_UNAVAILABLE', {
        retryable: true,
        statusKnown: false,
      })
    }
    if (
      !verifyWechatSignature(
        response.headers,
        response.body,
        this.options.wechatPayPublicKeys,
        this.now(),
      )
    ) {
      return mockFailure('WECHATPAY_RESPONSE_SIGNATURE_INVALID', { statusKnown: false })
    }
    if (response.status < 200 || response.status >= 300) {
      return mockFailure('WECHATPAY_REQUEST_REJECTED', {
        retryable: response.status >= 500,
        statusKnown: response.status < 500,
      })
    }
    try {
      return mockSuccess(
        JSON.parse(response.body) as unknown,
        header(response.headers, 'request-id'),
      )
    } catch {
      return mockFailure('WECHATPAY_RESPONSE_INVALID', { statusKnown: false })
    }
  }

  async createPayment(input: {
    amountMinor: number
    channel: PaymentChannel
    clientIp?: string
    description: string
    expiresAt: string
    merchantOrderNumber: string
    traceId: string
  }) {
    const merchantOrderNumber = merchantOrderNumberSchema.parse(input.merchantOrderNumber)
    const expiresAt = z.iso.datetime({ offset: true }).parse(input.expiresAt)
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
      return mockFailure('WECHATPAY_AMOUNT_INVALID', { statusKnown: true })
    }
    if (Date.parse(expiresAt) <= this.now().getTime()) {
      return mockFailure('WECHATPAY_EXPIRES_AT_INVALID', { statusKnown: true })
    }
    if (input.channel === 'h5' && !input.clientIp) {
      return mockFailure('WECHATPAY_CLIENT_IP_REQUIRED', { statusKnown: true })
    }
    const path = `/v3/pay/transactions/${input.channel}`
    const result = await this.request(
      'POST',
      path,
      {
        amount: { currency: 'CNY', total: input.amountMinor },
        appid: this.options.appId,
        description: input.description.slice(0, 127),
        mchid: this.options.merchantId,
        notify_url: this.options.notifyUrl,
        out_trade_no: merchantOrderNumber,
        ...(input.channel === 'h5'
          ? {
              scene_info: {
                h5_info: { type: 'Wap' },
                payer_client_ip: input.clientIp,
              },
            }
          : {}),
        time_expire: expiresAt,
      },
      input.traceId,
    )
    if (!result.ok) return result
    if (input.channel === 'native') {
      const parsed = z
        .object({ code_url: z.string().startsWith('weixin://') })
        .strict()
        .safeParse(result.data)
      if (!parsed.success) return mockFailure('WECHATPAY_RESPONSE_INVALID', { statusKnown: false })
      return mockSuccess(
        { channel: 'native' as const, codeUrl: parsed.data.code_url, expiresAt },
        result.requestId,
      )
    }
    const parsed = z.object({ h5_url: z.url() }).strict().safeParse(result.data)
    if (!parsed.success) return mockFailure('WECHATPAY_RESPONSE_INVALID', { statusKnown: false })
    return mockSuccess(
      { channel: 'h5' as const, expiresAt, h5Url: parsed.data.h5_url },
      result.requestId,
    )
  }

  async queryOrder(input: { merchantOrderNumber: string; traceId: string }) {
    const merchantOrderNumber = merchantOrderNumberSchema.parse(input.merchantOrderNumber)
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(merchantOrderNumber)}?mchid=${encodeURIComponent(this.options.merchantId)}`
    const result = await this.request('GET', path, undefined, input.traceId)
    if (!result.ok) return result
    const parsed = paymentOrderSchema.safeParse(result.data)
    if (!parsed.success) return mockFailure('WECHATPAY_RESPONSE_INVALID', { statusKnown: false })
    if (parsed.data.appid !== this.options.appId || parsed.data.mchid !== this.options.merchantId) {
      return mockFailure('WECHATPAY_MERCHANT_MISMATCH', { statusKnown: false })
    }
    return mockSuccess(
      {
        amountMinor: parsed.data.amount.total,
        currency: parsed.data.amount.currency,
        merchantOrderNumber: parsed.data.out_trade_no,
        ...(parsed.data.success_time ? { paidAt: parsed.data.success_time } : {}),
        state: tradeState(parsed.data.trade_state),
        ...(parsed.data.transaction_id ? { transactionId: parsed.data.transaction_id } : {}),
      },
      result.requestId,
    )
  }

  async verifyNotification(input: {
    body: string
    headers: Headers
    traceId: string
  }): Promise<VerifiedPaymentNotification> {
    if (
      !verifyWechatSignature(
        input.headers,
        input.body,
        this.options.wechatPayPublicKeys,
        this.now(),
      )
    ) {
      return {
        reason:
          header(input.headers, 'wechatpay-signature') && header(input.headers, 'wechatpay-serial')
            ? 'invalid_signature'
            : 'malformed_headers',
        signatureVerified: false,
        verified: false,
      }
    }
    try {
      const envelope = notificationEnvelopeSchema.parse(JSON.parse(input.body) as unknown)
      const transaction = transactionResourceSchema.parse(
        decryptNotificationResource(this.options.apiV3Key, envelope.resource),
      )
      if (
        transaction.appid !== this.options.appId ||
        transaction.mchid !== this.options.merchantId
      ) {
        return { reason: 'invalid_resource', signatureVerified: true, verified: false }
      }
      return {
        amountMinor: transaction.amount.total,
        currency: transaction.amount.currency,
        merchantOrderNumber: transaction.out_trade_no,
        notificationId: envelope.id,
        paidAt: transaction.success_time,
        transactionId: transaction.transaction_id,
        verified: true,
      }
    } catch {
      return { reason: 'invalid_resource', signatureVerified: true, verified: false }
    }
  }
}

type FixtureState = {
  amountMinor: number
  channel?: PaymentChannel
  merchantOrderNumber: string
  paidAt?: string
  state: PaymentOrder['state']
  transactionId?: string
}

export type WechatPayFixture = {
  notification(
    input: Required<
      Pick<FixtureState, 'amountMinor' | 'merchantOrderNumber' | 'paidAt' | 'transactionId'>
    > & {
      notificationId?: string
    },
  ): { body: string; headers: Headers }
  provider: WechatPayApiV3Adapter
  setOrder(input: FixtureState): void
}

function encryptFixtureResource(key: Uint8Array, plaintext: unknown, nonce: string, aad: string) {
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(nonce))
  cipher.setAAD(Buffer.from(aad))
  return Buffer.concat([
    cipher.update(JSON.stringify(plaintext), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64')
}

export function createWechatPayFixture(options: { now?: () => Date } = {}): WechatPayFixture {
  const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const wechatKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const apiV3Key = randomBytes(32)
  const wechatSerial = 'WECHATPAY_FIXTURE_SERIAL'
  const orders = new Map<string, FixtureState>()
  const now = options.now ?? (() => new Date())
  const signedResponse = (body: unknown, requestId = `fixture-${randomUUID()}`) => {
    const rawBody = JSON.stringify(body)
    const timestamp = String(Math.floor(now().getTime() / 1000))
    const nonce = randomBytes(8).toString('hex')
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(canonicalResponse(timestamp, nonce, rawBody)),
      wechatKeys.privateKey,
    ).toString('base64')
    return {
      body: rawBody,
      headers: new Headers({
        'request-id': requestId,
        'wechatpay-nonce': nonce,
        'wechatpay-serial': wechatSerial,
        'wechatpay-signature': signature,
        'wechatpay-timestamp': timestamp,
      }),
      status: 200,
    }
  }
  const transport: WechatPayTransport = {
    async request(request) {
      if (request.method === 'POST') {
        const input = z
          .object({
            amount: z.object({ currency: z.literal('CNY'), total: z.number().int() }),
            out_trade_no: merchantOrderNumberSchema,
          })
          .passthrough()
          .parse(JSON.parse(request.body) as unknown)
        orders.set(input.out_trade_no, {
          amountMinor: input.amount.total,
          channel: request.path.endsWith('/h5') ? 'h5' : 'native',
          merchantOrderNumber: input.out_trade_no,
          state: 'not_paid',
        })
        return signedResponse(
          request.path.endsWith('/h5')
            ? {
                h5_url: `https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=${input.out_trade_no}`,
              }
            : { code_url: `weixin://wxpay/bizpayurl/up?pr=${input.out_trade_no}` },
        )
      }
      const match = request.path.match(/out-trade-no\/([^?]+)/u)
      const merchantOrderNumber = decodeURIComponent(match?.[1] ?? '')
      const order = orders.get(merchantOrderNumber)
      if (!order) {
        return signedResponse({
          amount: { currency: 'CNY', total: 0 },
          appid: 'wx-fixture-app',
          mchid: '1900000001',
          out_trade_no: merchantOrderNumber,
          trade_state: 'NOTPAY',
        })
      }
      const tradeState =
        order.state === 'paid'
          ? 'SUCCESS'
          : order.state === 'closed'
            ? 'CLOSED'
            : order.state === 'refunded'
              ? 'REFUND'
              : order.state === 'unknown'
                ? 'USERPAYING'
                : 'NOTPAY'
      return signedResponse({
        amount: { currency: 'CNY', total: order.amountMinor },
        appid: 'wx-fixture-app',
        mchid: '1900000001',
        out_trade_no: order.merchantOrderNumber,
        ...(order.paidAt ? { success_time: order.paidAt } : {}),
        trade_state: tradeState,
        ...(order.transactionId ? { transaction_id: order.transactionId } : {}),
      })
    },
  }
  const provider = new WechatPayApiV3Adapter({
    apiV3Key,
    appId: 'wx-fixture-app',
    merchantCertificateSerial: 'MERCHANT_FIXTURE_SERIAL',
    merchantId: '1900000001',
    merchantPrivateKey: merchantKeys.privateKey,
    notifyUrl: 'https://wanmi.test/api/v1/payments/wechat/notify',
    now,
    transport,
    wechatPayPublicKeys: new Map([[wechatSerial, wechatKeys.publicKey]]),
  })
  return {
    notification(input) {
      const notificationId = input.notificationId ?? `EV-${randomUUID()}`
      const nonce = randomBytes(12).toString('base64url').slice(0, 12)
      const associatedData = 'transaction'
      const body = JSON.stringify({
        create_time: now().toISOString(),
        event_type: 'TRANSACTION.SUCCESS',
        id: notificationId,
        resource: {
          algorithm: 'AEAD_AES_256_GCM',
          associated_data: associatedData,
          ciphertext: encryptFixtureResource(
            apiV3Key,
            {
              amount: { currency: 'CNY', total: input.amountMinor },
              appid: 'wx-fixture-app',
              mchid: '1900000001',
              out_trade_no: input.merchantOrderNumber,
              success_time: input.paidAt,
              trade_state: 'SUCCESS',
              transaction_id: input.transactionId,
            },
            nonce,
            associatedData,
          ),
          nonce,
          original_type: 'transaction',
        },
        resource_type: 'encrypt-resource',
        summary: '支付成功',
      })
      const timestamp = String(Math.floor(now().getTime() / 1000))
      const signatureNonce = randomBytes(8).toString('hex')
      return {
        body,
        headers: new Headers({
          'wechatpay-nonce': signatureNonce,
          'wechatpay-serial': wechatSerial,
          'wechatpay-signature': sign(
            'RSA-SHA256',
            Buffer.from(canonicalResponse(timestamp, signatureNonce, body)),
            wechatKeys.privateKey,
          ).toString('base64'),
          'wechatpay-timestamp': timestamp,
        }),
      }
    },
    provider,
    setOrder(input) {
      orders.set(input.merchantOrderNumber, input)
    },
  }
}

export class MockWechatPayProvider implements PaymentProvider {
  private readonly fixture = createWechatPayFixture()

  async health() {
    return this.fixture.provider.health()
  }

  async createPayment(input: Parameters<PaymentProvider['createPayment']>[0]) {
    return this.fixture.provider.createPayment(input)
  }

  async queryOrder(input: Parameters<PaymentProvider['queryOrder']>[0]) {
    return this.fixture.provider.queryOrder(input)
  }

  async verifyNotification(input: Parameters<PaymentProvider['verifyNotification']>[0]) {
    return this.fixture.provider.verifyNotification(input)
  }
}

export function paymentPayloadDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

export function assertRealWechatPayWritesDisabled(): void {
  if (getEnv().ALLOW_REAL_PROVIDER_WRITES) {
    throw new Error('D5-03 fixture provider cannot run with real provider writes enabled')
  }
}

let runtimeFixture: WechatPayFixture | undefined

export function getRuntimeWechatPayProvider(): PaymentProvider {
  assertRealWechatPayWritesDisabled()
  runtimeFixture ??= createWechatPayFixture()
  return runtimeFixture.provider
}
