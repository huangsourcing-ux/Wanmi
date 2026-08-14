import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { readFileSync } from 'node:fs'

import { z } from 'zod'

import { getEnv } from '@/lib/env'
import type { ProviderResult } from '@/lib/domain'
import {
  assertLiveRuntimeTransportAllowed,
  authorizeWechatPayWrite,
  type ProviderWriteBudgetAuthorization,
  ProviderWriteGuardError,
} from '@/lib/provider-write-guardrails'
import { LiveWechatPayTransport } from '@/providers/wechatpay-live'

import { mockFailure, mockSuccess } from './mock'
import type {
  PaymentChannel,
  PaymentOrder,
  PaymentProvider,
  RefundOrder,
  RefundProvider,
  VerifiedPaymentNotification,
  VerifiedRefundNotification,
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

const refundOrderSchema = z
  .object({
    amount: z.object({ currency: z.literal('CNY'), refund: z.number().int().nonnegative() }),
    out_refund_no: z.string().regex(/^[A-Za-z0-9_*-]{1,64}$/u),
    out_trade_no: merchantOrderNumberSchema,
    refund_id: z.string().min(1).max(64).optional(),
    status: z.enum(['ABNORMAL', 'CLOSED', 'PROCESSING', 'SUCCESS']),
    success_time: z.iso.datetime({ offset: true }).optional(),
  })
  .passthrough()

const refundNotificationEnvelopeSchema = notificationEnvelopeSchema.extend({
  event_type: z.literal('REFUND.SUCCESS'),
  resource: notificationEnvelopeSchema.shape.resource.extend({
    original_type: z.literal('refund'),
  }),
})

const refundResourceSchema = z
  .object({
    amount: z.object({ currency: z.literal('CNY'), refund: z.number().int().nonnegative() }),
    out_refund_no: z.string().regex(/^[A-Za-z0-9_*-]{1,64}$/u),
    out_trade_no: merchantOrderNumberSchema,
    refund_id: z.string().min(1).max(64),
    refund_status: z.literal('SUCCESS'),
    success_time: z.iso.datetime({ offset: true }),
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
  resource: {
    associated_data: string
    ciphertext: string
    nonce: string
  },
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

function refundState(value: z.infer<typeof refundOrderSchema>['status']): RefundOrder['state'] {
  if (value === 'SUCCESS') return 'succeeded'
  if (value === 'PROCESSING') return 'processing'
  if (value === 'CLOSED') return 'closed'
  if (value === 'ABNORMAL') return 'failed'
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
      response.status !== 204 &&
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
      let providerCode: string | undefined
      try {
        providerCode = z
          .object({ code: z.string().max(64) })
          .passthrough()
          .parse(JSON.parse(response.body) as unknown).code
      } catch {
        providerCode = undefined
      }
      const mappedError = path.startsWith('/v3/refund/')
        ? providerCode === 'NOT_ENOUGH'
          ? 'WECHATPAY_REFUND_BALANCE_INSUFFICIENT'
          : providerCode === 'REFUND_ABNORMAL' || providerCode === 'TRADE_STATE_ERROR'
            ? 'WECHATPAY_REFUND_DISPUTED'
            : 'WECHATPAY_REFUND_REJECTED'
        : method === 'GET' &&
            path.startsWith('/v3/pay/transactions/out-trade-no/') &&
            providerCode === 'ORDER_NOT_EXIST'
          ? 'WECHATPAY_ORDER_NOT_FOUND'
          : 'WECHATPAY_REQUEST_REJECTED'
      return mockFailure(mappedError, {
        retryable: response.status >= 500,
        statusKnown: response.status < 500,
      })
    }
    if (response.status === 204) {
      return mockSuccess({}, header(response.headers, 'request-id'))
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

  async closeOrder(input: { merchantOrderNumber: string; traceId: string }) {
    const merchantOrderNumber = merchantOrderNumberSchema.parse(input.merchantOrderNumber)
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(merchantOrderNumber)}/close`
    const result = await this.request(
      'POST',
      path,
      { mchid: this.options.merchantId },
      input.traceId,
    )
    if (!result.ok) return result
    return mockSuccess({ closed: true as const }, result.requestId)
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

  async createRefund(input: {
    amountMinor: number
    merchantOrderNumber: string
    reason: string
    refundNumber: string
    traceId: string
  }) {
    const merchantOrderNumber = merchantOrderNumberSchema.parse(input.merchantOrderNumber)
    const refundNumber = z
      .string()
      .regex(/^[A-Za-z0-9_*-]{1,64}$/u)
      .parse(input.refundNumber)
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      return mockFailure('WECHATPAY_REFUND_AMOUNT_INVALID', { statusKnown: true })
    }
    const result = await this.request(
      'POST',
      '/v3/refund/domestic/refunds',
      {
        amount: {
          currency: 'CNY',
          refund: input.amountMinor,
          total: input.amountMinor,
        },
        notify_url: this.options.notifyUrl.replace('/payments/', '/refunds/'),
        out_refund_no: refundNumber,
        out_trade_no: merchantOrderNumber,
        reason: input.reason.slice(0, 80),
      },
      input.traceId,
    )
    if (!result.ok) return result
    return this.parseRefundResult(result.data, result.requestId)
  }

  async queryRefund(input: { refundNumber: string; traceId: string }) {
    const refundNumber = z
      .string()
      .regex(/^[A-Za-z0-9_*-]{1,64}$/u)
      .parse(input.refundNumber)
    const result = await this.request(
      'GET',
      `/v3/refund/domestic/refunds/${encodeURIComponent(refundNumber)}`,
      undefined,
      input.traceId,
    )
    if (!result.ok) return result
    return this.parseRefundResult(result.data, result.requestId)
  }

  private parseRefundResult(data: unknown, requestId: string) {
    const parsed = refundOrderSchema.safeParse(data)
    if (!parsed.success) return mockFailure('WECHATPAY_RESPONSE_INVALID', { statusKnown: false })
    return mockSuccess(
      {
        amountMinor: parsed.data.amount.refund,
        currency: parsed.data.amount.currency,
        merchantOrderNumber: parsed.data.out_trade_no,
        ...(parsed.data.refund_id ? { providerRefundId: parsed.data.refund_id } : {}),
        refundNumber: parsed.data.out_refund_no,
        ...(parsed.data.success_time ? { refundedAt: parsed.data.success_time } : {}),
        state: refundState(parsed.data.status),
        ...(parsed.data.status === 'ABNORMAL'
          ? { failureCategory: 'provider_rejected' as const }
          : {}),
      },
      requestId,
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

  async verifyRefundNotification(input: {
    body: string
    headers: Headers
    traceId: string
  }): Promise<VerifiedRefundNotification> {
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
      const envelope = refundNotificationEnvelopeSchema.parse(JSON.parse(input.body) as unknown)
      const refund = refundResourceSchema.parse(
        decryptNotificationResource(this.options.apiV3Key, envelope.resource),
      )
      return {
        amountMinor: refund.amount.refund,
        currency: refund.amount.currency,
        merchantOrderNumber: refund.out_trade_no,
        notificationId: envelope.id,
        providerRefundId: refund.refund_id,
        refundNumber: refund.out_refund_no,
        refundedAt: refund.success_time,
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

type FixtureRefundState = {
  amountMinor: number
  failureCategory?: RefundOrder['failureCategory']
  merchantOrderNumber: string
  providerRefundId?: string
  refundNumber: string
  refundedAt?: string
  state: RefundOrder['state']
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
  refundNotification(
    input: Required<
      Pick<
        FixtureRefundState,
        'amountMinor' | 'merchantOrderNumber' | 'providerRefundId' | 'refundNumber' | 'refundedAt'
      >
    > & { notificationId?: string },
  ): { body: string; headers: Headers }
  setOrder(input: FixtureState): void
  setOrderQueryError(input: { code: string; merchantOrderNumber: string; status: number }): void
  setRefund(input: FixtureRefundState): void
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
  const orderQueryErrors = new Map<string, { code: string; status: number }>()
  const refunds = new Map<string, FixtureRefundState>()
  const now = options.now ?? (() => new Date())
  const signedResponse = (body: unknown, requestId = `fixture-${randomUUID()}`, status = 200) => {
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
      status,
    }
  }
  const transport: WechatPayTransport = {
    async request(request) {
      if (request.method === 'POST') {
        const closeMatch = request.path.match(/out-trade-no\/([^/]+)\/close$/u)
        if (closeMatch) {
          const merchantOrderNumber = decodeURIComponent(closeMatch[1] ?? '')
          const order = orders.get(merchantOrderNumber)
          if (order?.state === 'paid') {
            return signedResponse({ code: 'ORDER_PAID' })
          }
          if (order) orders.set(merchantOrderNumber, { ...order, state: 'closed' })
          return {
            body: '',
            headers: new Headers({ 'request-id': `fixture-${randomUUID()}` }),
            status: 204,
          }
        }
        if (request.path === '/v3/refund/domestic/refunds') {
          const input = z
            .object({
              amount: z.object({ currency: z.literal('CNY'), refund: z.number().int() }),
              out_refund_no: z.string(),
              out_trade_no: merchantOrderNumberSchema,
            })
            .passthrough()
            .parse(JSON.parse(request.body) as unknown)
          const existing = refunds.get(input.out_refund_no)
          const refund = existing ?? {
            amountMinor: input.amount.refund,
            merchantOrderNumber: input.out_trade_no,
            providerRefundId: `503000000000000000000000${refunds.size + 1}`,
            refundNumber: input.out_refund_no,
            state: 'processing' as const,
          }
          refunds.set(input.out_refund_no, refund)
          return signedResponse(refundFixtureResponse(refund))
        }
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
      const refundMatch = request.path.match(/refunds\/([^?]+)/u)
      if (refundMatch) {
        const refundNumber = decodeURIComponent(refundMatch[1] ?? '')
        const refund = refunds.get(refundNumber)
        if (!refund) {
          return signedResponse({
            amount: { currency: 'CNY', refund: 0 },
            out_refund_no: refundNumber,
            out_trade_no: 'UNKNOWN',
            status: 'CLOSED',
          })
        }
        return signedResponse(refundFixtureResponse(refund))
      }
      const match = request.path.match(/out-trade-no\/([^?]+)/u)
      const merchantOrderNumber = decodeURIComponent(match?.[1] ?? '')
      const queryError = orderQueryErrors.get(merchantOrderNumber)
      if (queryError) {
        return signedResponse(
          { code: queryError.code, message: 'Wechat Pay fixture query rejection' },
          `fixture-${randomUUID()}`,
          queryError.status,
        )
      }
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
  function signedNotification(body: string) {
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
  }
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
      return signedNotification(body)
    },
    refundNotification(input) {
      const notificationId = input.notificationId ?? `REFUND-${randomUUID()}`
      const nonce = randomBytes(12).toString('base64url').slice(0, 12)
      const associatedData = 'refund'
      const body = JSON.stringify({
        create_time: now().toISOString(),
        event_type: 'REFUND.SUCCESS',
        id: notificationId,
        resource: {
          algorithm: 'AEAD_AES_256_GCM',
          associated_data: associatedData,
          ciphertext: encryptFixtureResource(
            apiV3Key,
            {
              amount: { currency: 'CNY', refund: input.amountMinor },
              out_refund_no: input.refundNumber,
              out_trade_no: input.merchantOrderNumber,
              refund_id: input.providerRefundId,
              refund_status: 'SUCCESS',
              success_time: input.refundedAt,
            },
            nonce,
            associatedData,
          ),
          nonce,
          original_type: 'refund',
        },
        resource_type: 'encrypt-resource',
        summary: '退款成功',
      })
      return signedNotification(body)
    },
    provider,
    setOrder(input) {
      orders.set(input.merchantOrderNumber, input)
    },
    setOrderQueryError(input) {
      orderQueryErrors.set(input.merchantOrderNumber, {
        code: input.code,
        status: input.status,
      })
    },
    setRefund(input) {
      refunds.set(input.refundNumber, input)
    },
  }
}

function refundFixtureResponse(refund: FixtureRefundState) {
  const status =
    refund.state === 'succeeded'
      ? 'SUCCESS'
      : refund.state === 'processing' || refund.state === 'unknown'
        ? 'PROCESSING'
        : refund.state === 'closed'
          ? 'CLOSED'
          : 'ABNORMAL'
  return {
    amount: { currency: 'CNY', refund: refund.amountMinor },
    out_refund_no: refund.refundNumber,
    out_trade_no: refund.merchantOrderNumber,
    ...(refund.providerRefundId ? { refund_id: refund.providerRefundId } : {}),
    status,
    ...(refund.refundedAt ? { success_time: refund.refundedAt } : {}),
  }
}

export class MockWechatPayProvider implements PaymentProvider, RefundProvider {
  private readonly fixture = createWechatPayFixture()

  async health() {
    return this.fixture.provider.health()
  }

  async createPayment(input: Parameters<PaymentProvider['createPayment']>[0]) {
    return this.fixture.provider.createPayment(input)
  }

  async closeOrder(input: Parameters<PaymentProvider['closeOrder']>[0]) {
    return this.fixture.provider.closeOrder(input)
  }

  async queryOrder(input: Parameters<PaymentProvider['queryOrder']>[0]) {
    return this.fixture.provider.queryOrder(input)
  }

  async createRefund(input: Parameters<RefundProvider['createRefund']>[0]) {
    return this.fixture.provider.createRefund(input)
  }

  async queryRefund(input: Parameters<RefundProvider['queryRefund']>[0]) {
    return this.fixture.provider.queryRefund(input)
  }

  async verifyNotification(input: Parameters<PaymentProvider['verifyNotification']>[0]) {
    return this.fixture.provider.verifyNotification(input)
  }

  async verifyRefundNotification(input: Parameters<RefundProvider['verifyRefundNotification']>[0]) {
    return this.fixture.provider.verifyRefundNotification(input)
  }
}

type WechatPayBudgetConsumer = (input: ProviderWriteBudgetAuthorization) => Promise<unknown>

async function consumeRuntimeWechatPayBudget(
  input: ProviderWriteBudgetAuthorization,
): Promise<void> {
  const [{ default: config }, { consumeProviderWriteBudget }, { createLocalReq, getPayload }] =
    await Promise.all([
      import('@payload-config'),
      import('@/services/providers/provider-write-budget'),
      import('payload'),
    ])
  const payload = await getPayload({ config })
  const req = await createLocalReq({}, payload)
  await consumeProviderWriteBudget(req, input)
}

export class SafetyFencedWechatPayProvider implements PaymentProvider, RefundProvider {
  constructor(
    private readonly delegate: PaymentProvider & RefundProvider,
    private readonly consumeBudget: WechatPayBudgetConsumer = consumeRuntimeWechatPayBudget,
  ) {}

  async health() {
    return this.delegate.health()
  }

  async createPayment(input: Parameters<PaymentProvider['createPayment']>[0]) {
    try {
      const authorization = authorizeWechatPayWrite(
        'payment',
        input.amountMinor,
        `wechatpay:payment:${input.merchantOrderNumber}`,
      )
      if (authorization) await this.consumeBudget(authorization)
    } catch (error) {
      if (error instanceof ProviderWriteGuardError) {
        return mockFailure(error.code, { statusKnown: true })
      }
      throw error
    }
    return this.delegate.createPayment(input)
  }

  async closeOrder(input: Parameters<PaymentProvider['closeOrder']>[0]) {
    try {
      authorizeWechatPayWrite(
        'payment_close',
        0,
        `wechatpay:payment-close:${input.merchantOrderNumber}`,
      )
    } catch (error) {
      if (error instanceof ProviderWriteGuardError) {
        return mockFailure(error.code, { statusKnown: true })
      }
      throw error
    }
    return this.delegate.closeOrder(input)
  }

  async queryOrder(input: Parameters<PaymentProvider['queryOrder']>[0]) {
    return this.delegate.queryOrder(input)
  }

  async createRefund(input: Parameters<RefundProvider['createRefund']>[0]) {
    try {
      const authorization = authorizeWechatPayWrite(
        'refund',
        input.amountMinor,
        `wechatpay:refund:${input.refundNumber}`,
      )
      if (authorization) await this.consumeBudget(authorization)
    } catch (error) {
      if (error instanceof ProviderWriteGuardError) {
        return mockFailure(error.code, { statusKnown: true })
      }
      throw error
    }
    return this.delegate.createRefund(input)
  }

  async queryRefund(input: Parameters<RefundProvider['queryRefund']>[0]) {
    return this.delegate.queryRefund(input)
  }

  async verifyNotification(input: Parameters<PaymentProvider['verifyNotification']>[0]) {
    return this.delegate.verifyNotification(input)
  }

  async verifyRefundNotification(input: Parameters<RefundProvider['verifyRefundNotification']>[0]) {
    return this.delegate.verifyRefundNotification(input)
  }
}

export function paymentPayloadDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

function readKeyFile(path: string, label: string): Buffer {
  const value = readFileSync(path)
  if (value.byteLength === 0 || value.byteLength > 64 * 1024) {
    throw new Error(`${label} file is empty or exceeds the safety limit`)
  }
  return value
}

export function createConfiguredWechatPayProvider(
  options: {
    liveTransportFactory?: () => WechatPayTransport
  } = {},
): PaymentProvider & RefundProvider {
  const env = getEnv()
  if (env.WECHATPAY_MODE === 'fixture') return createWechatPayFixture().provider
  assertLiveRuntimeTransportAllowed('wechatpay')
  if (
    !env.WECHATPAY_API_V3_KEY ||
    !env.WECHATPAY_APP_ID ||
    !env.WECHATPAY_MERCHANT_CERTIFICATE_SERIAL ||
    !env.WECHATPAY_MERCHANT_ID ||
    !env.WECHATPAY_MERCHANT_PRIVATE_KEY_PATH ||
    !env.WECHATPAY_NOTIFY_URL ||
    !env.WECHATPAY_PLATFORM_CERTIFICATE_SERIAL ||
    !env.WECHATPAY_PLATFORM_PUBLIC_KEY_PATH
  ) {
    throw new Error(
      'Wechat Pay live mode is missing an explicit credential or certificate reference',
    )
  }
  if (new URL(env.WECHATPAY_NOTIFY_URL).protocol !== 'https:') {
    throw new Error('Wechat Pay live notify URL must use HTTPS')
  }
  const transport = options.liveTransportFactory
    ? options.liveTransportFactory()
    : new LiveWechatPayTransport()
  const provider = new WechatPayApiV3Adapter({
    apiV3Key: Buffer.from(env.WECHATPAY_API_V3_KEY, 'utf8'),
    appId: env.WECHATPAY_APP_ID,
    merchantCertificateSerial: env.WECHATPAY_MERCHANT_CERTIFICATE_SERIAL,
    merchantId: env.WECHATPAY_MERCHANT_ID,
    merchantPrivateKey: createPrivateKey(
      readKeyFile(env.WECHATPAY_MERCHANT_PRIVATE_KEY_PATH, 'Wechat Pay merchant private key'),
    ),
    notifyUrl: env.WECHATPAY_NOTIFY_URL,
    transport,
    wechatPayPublicKeys: new Map([
      [
        env.WECHATPAY_PLATFORM_CERTIFICATE_SERIAL,
        createPublicKey(
          readKeyFile(env.WECHATPAY_PLATFORM_PUBLIC_KEY_PATH, 'Wechat Pay platform public key'),
        ),
      ],
    ]),
  })
  return new SafetyFencedWechatPayProvider(provider)
}

let runtimeProvider: (PaymentProvider & RefundProvider) | undefined

export function getRuntimeWechatPayProvider(): PaymentProvider & RefundProvider {
  runtimeProvider ??= createConfiguredWechatPayProvider()
  return runtimeProvider
}

export function resetWechatPayRuntimeForTests(): void {
  runtimeProvider = undefined
}
