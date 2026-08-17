import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import config from '@payload-config'
import { createLocalReq, getPayload, type PayloadRequest } from 'payload'
import QRCode from 'qrcode'

import { AppError } from '@/lib/errors'
import { appendConsentAcceptance } from '@/services/auth/registration-consents'
import { mockSuccess } from '@/providers/mock'
import type { PaymentProvider, WestDigitalRealnameProvider } from '@/providers/types'
import {
  createConfiguredWechatPayProvider,
  type WechatPayTransport,
  type WechatPayTransportRequest,
  type WechatPayTransportResponse,
} from '@/providers/wechatpay'
import { LiveWechatPayTransport } from '@/providers/wechatpay-live'
import { FixtureWestDigitalTransport } from '@/providers/westdigital-fixtures'
import { WestDigitalReadAdapter } from '@/providers/westdigital'
import { createCustomerOrder } from '@/services/commerce/order-creation'
import {
  createWechatPayment,
  queryAndConfirmWechatPayment,
  replayArchivedWechatPaymentNotification,
} from '@/services/commerce/payments'
import { requestAutomaticRegistrationFailureRefund } from '@/services/commerce/refunds'
import {
  reconcileWechatFunds,
  reconcileWestdigitalPrepaidBalance,
  recordThreeWayDifference,
} from '@/services/commerce/reconciliation'
import { createCustomerQuote, PayloadCustomerQuoteStore } from '@/services/pricing/customer-quotes'
import type { PricingRule } from '@/services/pricing/price-calculation'
import { PayloadPriceSnapshotStore } from '@/services/pricing/price-snapshots'
import {
  createRealnameTemplate,
  submitRealnameTemplate,
  syncRealnameTemplateStatus,
} from '@/services/realname/templates'

const statePath = '/tmp/wanmi-d7-17-state.json'
const expectedRuntime = {
  ALLOW_REAL_ALIYUN_SMS_SENDS: 'false',
  ALLOW_REAL_PROVIDER_WRITES: 'true',
  ALLOW_REAL_WECHATPAY: 'true',
  ALLOW_REAL_WECHATPAY_PAYMENTS: 'true',
  ALLOW_REAL_WECHATPAY_REFUNDS: 'true',
  ALLOW_REAL_WESTDIGITAL_NAMESERVER_WRITES: 'false',
  ALLOW_REAL_WESTDIGITAL_DNS_WRITES: 'false',
  ALLOW_REAL_WESTDIGITAL_REALNAME_WRITES: 'false',
  ALLOW_REAL_WESTDIGITAL_REGISTRATION_WRITES: 'false',
  ALLOW_REAL_WESTDIGITAL_RENEWAL_WRITES: 'false',
  WECHATPAY_MODE: 'live',
  WECHATPAY_WRITE_CUMULATIVE_AMOUNT_LIMIT_FEN: '10',
  WECHATPAY_WRITE_SINGLE_AMOUNT_LIMIT_FEN: '1',
  WESTDIGITAL_MODE: 'fixture',
} as const

type CustomerIdentity = {
  collection: 'customers'
  id: number
  status: 'active'
}

type NativeCapture = {
  platformSignatureHeadersPresent: boolean
  rawResponseFields: string[]
  responseStatus: number
  responseTimeMs: number
}

type QueryCapture = {
  platformSignatureHeadersPresent: boolean
  rawResponseFields: string[]
  responseStatus: number
  responseTimeMs: number
}

type D717State = {
  createdAt: string
  customerId: number
  expiresAt: string
  merchantOrderNumber: string
  nativeCapture: NativeCapture
  orderId: number
  orderNumber: string
  expiredPayments?: Array<{
    expiresAt: string
    merchantOrderNumber: string
    orderId: number
    orderNumber: string
    providerState: 'closed' | 'not_paid'
  }>
  paymentCreateAttempts: 1 | 2 | 3
  confirmedAt?: string
  paymentQueryCapture?: QueryCapture
  phase:
    | 'payment_confirmed'
    | 'payment_created'
    | 'notification_replayed'
    | 'refund_confirmed'
    | 'refund_created'
    | 'refund_queried'
    | 'reconciled'
  previousExpiredPayment?: {
    expiresAt: string
    merchantOrderNumber: string
    orderId: number
    orderNumber: string
    providerState: 'closed' | 'not_paid'
  }
  quoteId: number
  refundCreateCapture?: QueryCapture
  refundId?: number
  refundNumber?: string
  refundQueryAttempts?: number
  refundQueryCapture?: QueryCapture
  refundBudgetUsedBeforeFen: 0
  templateId: number
  tracePrefix: string
}

const oneFenRules: Readonly<Record<string, PricingRule>> = Object.freeze({
  xyz: {
    fixedAmountFen: 1,
    key: 'd7-17-one-fen-westdigital-cost-fixture-v1',
    mode: 'fixed',
    source: 'wanmi_fixture',
    tld: 'xyz',
    version: 1,
  },
})

function assertRuntime(): void {
  for (const [key, expected] of Object.entries(expectedRuntime)) {
    if (process.env[key] !== expected) throw new Error(`D7-17 runtime preflight failed: ${key}`)
  }
  if (process.env.WECHATPAY_NOTIFY_URL !== 'https://wanmi.net/api/v1/payments/wechat/notify') {
    throw new Error('D7-17 runtime preflight failed: WECHATPAY_NOTIFY_URL')
  }
}

function persistState(state: D717State): void {
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  const metadata = statSync(statePath)
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== 1001) {
    throw new Error('D7-17 state file permissions are invalid')
  }
}

function replaceState(state: D717State): void {
  const nextStatePath = `${statePath}.next`
  writeFileSync(nextStatePath, `${JSON.stringify(state)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  const metadata = statSync(nextStatePath)
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== 1001) {
    throw new Error('D7-17 replacement state file permissions are invalid')
  }
  renameSync(nextStatePath, statePath)
}

function readState(): D717State {
  const metadata = statSync(statePath)
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== 1001) {
    throw new Error('D7-17 state file permissions are invalid')
  }
  const candidate = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<D717State>
  if (
    (candidate.phase !== 'payment_created' &&
      candidate.phase !== 'payment_confirmed' &&
      candidate.phase !== 'notification_replayed' &&
      candidate.phase !== 'refund_confirmed' &&
      candidate.phase !== 'refund_created' &&
      candidate.phase !== 'refund_queried' &&
      candidate.phase !== 'reconciled') ||
    (candidate.paymentCreateAttempts !== 1 &&
      candidate.paymentCreateAttempts !== 2 &&
      candidate.paymentCreateAttempts !== 3) ||
    typeof candidate.merchantOrderNumber !== 'string' ||
    typeof candidate.expiresAt !== 'string'
  ) {
    throw new Error('D7-17 state file is invalid')
  }
  return candidate as D717State
}

async function customerRequest(
  payload: Awaited<ReturnType<typeof getPayload>>,
  customer: CustomerIdentity,
  traceId: string,
): Promise<PayloadRequest> {
  const req = await createLocalReq(
    { req: { headers: new Headers({ 'x-request-id': traceId }) } },
    payload,
  )
  req.user = customer as never
  return req
}

function oneFenWestdigitalProvider(): WestDigitalReadAdapter {
  const transport = new FixtureWestDigitalTransport((request) => {
    if (request.operation === 'availability') {
      const domain = `${request.body.domain ?? ''}${request.body.suffix ?? ''}`
      return {
        body: {
          clientid: 'd7-17-availability-fixture',
          data: [{ avail: 1, name: domain }],
          result: 200,
        },
        status: 200,
      }
    }
    if (request.operation === 'price') {
      return {
        body: {
          clientid: 'd7-17-price-fixture',
          data: {
            buyprice: 0,
            buyyear: '1',
            proid: 'd7-17-one-fen-cost-fixture',
            renewprice: 0,
          },
          result: 200,
        },
        status: 200,
      }
    }
    return { body: { result: 500 }, status: 200 }
  })
  return new WestDigitalReadAdapter({ transport })
}

function approvedRealnameFixture(): WestDigitalRealnameProvider {
  return {
    createTemplate: async () =>
      mockSuccess(
        { providerTemplateId: '1664777', reviewState: 'pending' as const },
        'd7-17-realname-create-fixture',
      ),
    health: async () => mockSuccess({ healthy: true }, 'd7-17-realname-health-fixture'),
    queryTemplate: async () =>
      mockSuccess({ reviewState: 'approved' as const }, 'd7-17-realname-query-fixture'),
  }
}

class CapturingWechatPayTransport implements WechatPayTransport {
  readonly captures: NativeCapture[] = []
  readonly queryCaptures: QueryCapture[] = []

  constructor(private readonly delegate: WechatPayTransport = new LiveWechatPayTransport()) {}

  async request(input: WechatPayTransportRequest): Promise<WechatPayTransportResponse> {
    const startedAt = performance.now()
    const response = await this.delegate.request(input)
    if (input.method === 'POST' && input.path === '/v3/pay/transactions/native') {
      let rawResponseFields: string[] = []
      try {
        const parsed = JSON.parse(response.body) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rawResponseFields = Object.keys(parsed).sort()
        }
      } catch {
        rawResponseFields = []
      }
      this.captures.push({
        platformSignatureHeadersPresent: [
          'wechatpay-nonce',
          'wechatpay-serial',
          'wechatpay-signature',
          'wechatpay-timestamp',
        ].every((name) => Boolean(response.headers.get(name))),
        rawResponseFields,
        responseStatus: response.status,
        responseTimeMs: Math.round((performance.now() - startedAt) * 10) / 10,
      })
    }
    if (input.method === 'GET' && input.path.startsWith('/v3/pay/transactions/out-trade-no/')) {
      let rawResponseFields: string[] = []
      try {
        const parsed = JSON.parse(response.body) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rawResponseFields = Object.keys(parsed).sort()
        }
      } catch {
        rawResponseFields = []
      }
      this.queryCaptures.push({
        platformSignatureHeadersPresent: [
          'wechatpay-nonce',
          'wechatpay-serial',
          'wechatpay-signature',
          'wechatpay-timestamp',
        ].every((name) => Boolean(response.headers.get(name))),
        rawResponseFields,
        responseStatus: response.status,
        responseTimeMs: Math.round((performance.now() - startedAt) * 10) / 10,
      })
    }
    return response
  }
}

async function assertUnusedWechatBudgets(
  payload: Awaited<ReturnType<typeof getPayload>>,
): Promise<void> {
  const budgets = await payload.find({
    collection: 'providerWriteBudgets',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    where: { scopeKey: { in: ['wechatpay:payment', 'wechatpay:refund'] } },
  })
  for (const budget of budgets.docs) {
    if (budget.usedAmountFen !== 0 || budget.usedOperations !== 0) {
      throw new Error(`D7-17 provider budget is not unused: ${budget.capability}`)
    }
  }
}

async function prepare(): Promise<void> {
  assertRuntime()
  if (existsSync(statePath))
    throw new Error('D7-17 state already exists; refusing a second payment')

  const payload = await getPayload({ config })
  try {
    await assertUnusedWechatBudgets(payload)
    const tracePrefix = `d7-17-${randomBytes(8).toString('hex')}`
    const customerDocument = await payload.create({
      collection: 'customers',
      data: {
        accountType: 'registered',
        capabilityRestrictions: [],
        defaultCustomerProfileType: 'individual',
        phone: `${tracePrefix}-fixture`,
        phoneMasked: '***0017',
        registrationSource: 'phone',
        status: 'active',
      },
      overrideAccess: true,
    })
    const customer: CustomerIdentity = {
      collection: 'customers',
      id: Number(customerDocument.id),
      status: 'active',
    }
    const req = await customerRequest(payload, customer, `${tracePrefix}-customer`)
    await appendConsentAcceptance(req, {
      acceptedAt: new Date().toISOString(),
      consentType: 'sensitive_personal_information',
      customerId: customer.id,
      headers: req.headers,
      source: 'account_privacy_center',
    })
    const realnameProvider = approvedRealnameFixture()
    const template = await createRealnameTemplate(req, {
      addressChinese: '一环路北一段99号环球广场',
      addressEnglish: '99 First Ring Road North Chengdu Sichuan',
      applicableScopes: ['cg'],
      cityChinese: '成都市',
      cityEnglish: 'Chengdu',
      contactFirstNameChinese: '小明',
      contactFirstNameEnglish: 'Xiaoming',
      contactLastNameChinese: '李',
      contactLastNameEnglish: 'Li',
      countryCode: 'CN',
      districtChinese: '金牛区',
      displayName: 'D7-17 微信小额联调 fixture',
      email: 'd7-17-realname-fixture@example.test',
      fullNameChinese: '李小明',
      identityDocumentNumber: '11010519491231002X',
      identityDocumentType: 'SFZ',
      phone: '13800000017',
      phoneCountryCode: '+86',
      phoneType: 'mobile',
      postalCode: '610031',
      provinceChinese: '四川省',
      provinceEnglish: 'Sichuan',
      type: 'individual',
    })
    await submitRealnameTemplate(
      await customerRequest(payload, customer, `${tracePrefix}-realname-submit`),
      template.id,
      realnameProvider,
    )
    await syncRealnameTemplateStatus(
      await createLocalReq(
        { req: { headers: new Headers({ 'x-request-id': `${tracePrefix}-realname-sync` }) } },
        payload,
      ),
      template.id,
      realnameProvider,
    )

    const domain = `${tracePrefix.replaceAll('-', '')}.xyz`
    const quoteProvider = oneFenWestdigitalProvider()
    const quote = await createCustomerQuote(
      { domain, years: 1 },
      {
        customer,
        provider: quoteProvider,
        quoteStore: new PayloadCustomerQuoteStore(req, customer),
        rules: oneFenRules,
        snapshots: new PayloadPriceSnapshotStore(payload),
        traceId: `${tracePrefix}-quote`,
      },
    )
    if (!('data' in quote) || !quote.data.quote || quote.data.quote.userPriceMinor !== 1) {
      throw new Error('D7-17 quote did not produce an exact one-fen ready quote')
    }
    const order = await createCustomerOrder(
      await customerRequest(payload, customer, `${tracePrefix}-order`),
      { quoteRef: quote.data.quote.quoteRef, realnameTemplateId: Number(template.id) },
      {
        customer,
        provider: quoteProvider,
        rules: oneFenRules,
        traceId: `${tracePrefix}-order`,
      },
    )
    if (
      order.state !== 'ready' ||
      order.data.amountMinor !== 1 ||
      order.data.status !== 'pending_payment'
    ) {
      throw new Error('D7-17 order did not pass the one-fen pending-payment contract')
    }

    const capture = new CapturingWechatPayTransport()
    const paymentProvider = createConfiguredWechatPayProvider({
      liveTransportFactory: () => capture,
    })
    const session = await createWechatPayment(
      await customerRequest(payload, customer, `${tracePrefix}-native-payment`),
      order.data.orderNumber,
      { channel: 'native' },
      {
        customer,
        provider: paymentProvider,
        traceId: `${tracePrefix}-native-payment`,
      },
    )
    if (session.data.channel !== 'native' || !session.data.codeUrl.startsWith('weixin://')) {
      throw new Error('D7-17 Native payment did not return a valid code_url')
    }
    const nativeCapture = capture.captures[0]
    if (
      capture.captures.length !== 1 ||
      !nativeCapture ||
      nativeCapture.responseStatus < 200 ||
      nativeCapture.responseStatus >= 300 ||
      !nativeCapture.platformSignatureHeadersPresent ||
      nativeCapture.rawResponseFields.join(',') !== 'code_url'
    ) {
      throw new Error('D7-17 Native response did not pass the signed strict response contract')
    }

    const storedOrder = await payload.find({
      collection: 'orders',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { orderNumber: { equals: order.data.orderNumber } },
    })
    const storedQuote = await payload.find({
      collection: 'quotes',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { quoteRef: { equals: quote.data.quote.quoteRef } },
    })
    const orderDocument = storedOrder.docs[0]
    const quoteDocument = storedQuote.docs[0]
    if (!orderDocument?.merchantOrderNumber || !quoteDocument) {
      throw new Error('D7-17 persisted payment identifiers are incomplete')
    }

    const paymentBudget = await payload.find({
      collection: 'providerWriteBudgets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { scopeKey: { equals: 'wechatpay:payment' } },
    })
    if (
      paymentBudget.docs[0]?.usedAmountFen !== 1 ||
      paymentBudget.docs[0]?.configuredAmountLimitFen !== 10
    ) {
      throw new Error('D7-17 payment budget did not persist the one-fen debit')
    }

    persistState({
      createdAt: new Date().toISOString(),
      customerId: customer.id,
      expiresAt: session.data.expiresAt,
      merchantOrderNumber: orderDocument.merchantOrderNumber,
      nativeCapture,
      orderId: Number(orderDocument.id),
      orderNumber: order.data.orderNumber,
      paymentCreateAttempts: 1,
      phase: 'payment_created',
      quoteId: Number(quoteDocument.id),
      refundBudgetUsedBeforeFen: 0,
      templateId: Number(template.id),
      tracePrefix,
    })

    const qrPng = await QRCode.toBuffer(session.data.codeUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      type: 'png',
      width: 360,
    })
    process.stdout.write(
      `D7_17_PREPARE ${JSON.stringify({
        amountMinor: 1,
        costSide: 'westdigital_fixture',
        expiresAt: session.data.expiresAt,
        nativeNormalizedFields: ['channel', 'codeUrl', 'expiresAt', 'merchantOrderNumber'],
        nativeRawResponseFields: nativeCapture.rawResponseFields,
        paymentBudgetUsedAmountFen: 1,
        paymentCreateAttempts: 1,
        platformSignatureVerified: true,
        providerResponseStatus: nativeCapture.responseStatus,
        providerResponseTimeMs: nativeCapture.responseTimeMs,
        quoteAndOrderValidation: 'passed',
        schemaDifference:
          'code_url -> codeUrl; server adds channel, expiresAt, merchantOrderNumber',
      })}\n`,
    )
    process.stdout.write(`D7_17_QR_PNG_BASE64 ${qrPng.toString('base64')}\n`)
  } finally {
    await payload.db.destroy?.()
  }
}

async function inspectExpiredPayment(): Promise<void> {
  assertRuntime()
  const state = readState()
  if (Date.parse(state.expiresAt) >= Date.now()) {
    throw new Error('D7-17 payment has not expired; refusing expired-order inspection')
  }

  const provider = createConfiguredWechatPayProvider()
  const startedAt = performance.now()
  const query = await provider.queryOrder({
    merchantOrderNumber: state.merchantOrderNumber,
    traceId: `${state.tracePrefix}-expired-query`,
  })
  const responseTimeMs = Math.round((performance.now() - startedAt) * 10) / 10
  if (!query.ok) {
    process.stdout.write(
      `D7_17_EXPIRED_QUERY ${JSON.stringify({
        errorCode: query.error.code,
        expired: true,
        providerResponseTimeMs: responseTimeMs,
        statusKnown: query.error.statusKnown,
      })}\n`,
    )
    return
  }
  process.stdout.write(
    `D7_17_EXPIRED_QUERY ${JSON.stringify({
      amountMatches: query.data.amountMinor === 1,
      expired: true,
      identifierMatches: query.data.merchantOrderNumber === state.merchantOrderNumber,
      platformSignatureVerified: true,
      providerResponseTimeMs: responseTimeMs,
      providerState: query.data.state,
      transactionIdentifierPresent: typeof query.data.transactionId === 'string',
    })}\n`,
  )
}

async function inspectWechatBudgets(): Promise<void> {
  assertRuntime()
  const payload = await getPayload({ config })
  try {
    const budgets = await payload.find({
      collection: 'providerWriteBudgets',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      sort: 'scopeKey',
      where: { scopeKey: { in: ['wechatpay:payment', 'wechatpay:refund'] } },
    })
    process.stdout.write(
      `D7_17_BUDGETS ${JSON.stringify(
        budgets.docs.map((budget) => ({
          configuredAmountLimitFen: budget.configuredAmountLimitFen,
          scopeKey: budget.scopeKey,
          usedAmountFen: budget.usedAmountFen,
          usedOperations: budget.usedOperations,
        })),
      )}\n`,
    )
  } finally {
    await payload.db.destroy?.()
  }
}

async function replaceExpiredPayment(): Promise<void> {
  assertRuntime()
  const previous = readState()
  if (previous.paymentCreateAttempts >= 3 || Date.parse(previous.expiresAt) >= Date.now()) {
    throw new Error('D7-17 state does not permit another replacement payment')
  }
  const previousAttempts = previous.paymentCreateAttempts
  const nextAttempts = (previousAttempts + 1) as 2 | 3

  const payload = await getPayload({ config })
  try {
    const paymentBudgetBefore = await payload.find({
      collection: 'providerWriteBudgets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { scopeKey: { equals: 'wechatpay:payment' } },
    })
    const refundBudgetBefore = await payload.find({
      collection: 'providerWriteBudgets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { scopeKey: { equals: 'wechatpay:refund' } },
    })
    if (
      paymentBudgetBefore.docs[0]?.usedAmountFen !== previousAttempts ||
      paymentBudgetBefore.docs[0]?.usedOperations !== 0 ||
      (refundBudgetBefore.docs[0] &&
        (refundBudgetBefore.docs[0].usedAmountFen !== 0 ||
          refundBudgetBefore.docs[0].usedOperations !== 0))
    ) {
      throw new Error('D7-17 budgets do not permit the replacement payment')
    }

    const oldPaymentProvider = createConfiguredWechatPayProvider()
    const oldQuery = await oldPaymentProvider.queryOrder({
      merchantOrderNumber: previous.merchantOrderNumber,
      traceId: `${previous.tracePrefix}-replacement-precheck`,
    })
    if (
      !oldQuery.ok ||
      (oldQuery.data.state !== 'not_paid' && oldQuery.data.state !== 'closed') ||
      oldQuery.data.amountMinor !== 1 ||
      oldQuery.data.merchantOrderNumber !== previous.merchantOrderNumber ||
      oldQuery.data.transactionId
    ) {
      throw new Error('D7-17 expired payment is not safely replaceable')
    }

    const tracePrefix = `d7-17-replacement-${nextAttempts}-${randomBytes(8).toString('hex')}`
    const customer: CustomerIdentity = {
      collection: 'customers',
      id: previous.customerId,
      status: 'active',
    }
    const req = await customerRequest(payload, customer, `${tracePrefix}-customer`)
    const domain = `${tracePrefix.replaceAll('-', '')}.xyz`
    const quoteProvider = oneFenWestdigitalProvider()
    const quote = await createCustomerQuote(
      { domain, years: 1 },
      {
        customer,
        provider: quoteProvider,
        quoteStore: new PayloadCustomerQuoteStore(req, customer),
        rules: oneFenRules,
        snapshots: new PayloadPriceSnapshotStore(payload),
        traceId: `${tracePrefix}-quote`,
      },
    )
    if (!('data' in quote) || !quote.data.quote || quote.data.quote.userPriceMinor !== 1) {
      throw new Error('D7-17 replacement quote did not produce an exact one-fen ready quote')
    }
    const order = await createCustomerOrder(
      await customerRequest(payload, customer, `${tracePrefix}-order`),
      { quoteRef: quote.data.quote.quoteRef, realnameTemplateId: previous.templateId },
      {
        customer,
        provider: quoteProvider,
        rules: oneFenRules,
        traceId: `${tracePrefix}-order`,
      },
    )
    if (
      order.state !== 'ready' ||
      order.data.amountMinor !== 1 ||
      order.data.status !== 'pending_payment'
    ) {
      throw new Error('D7-17 replacement order did not pass the one-fen contract')
    }

    const capture = new CapturingWechatPayTransport()
    const paymentProvider = createConfiguredWechatPayProvider({
      liveTransportFactory: () => capture,
    })
    const session = await createWechatPayment(
      await customerRequest(payload, customer, `${tracePrefix}-native-payment`),
      order.data.orderNumber,
      { channel: 'native' },
      { customer, provider: paymentProvider, traceId: `${tracePrefix}-native-payment` },
    )
    if (session.data.channel !== 'native' || !session.data.codeUrl.startsWith('weixin://')) {
      throw new Error('D7-17 replacement Native payment did not return a valid code_url')
    }
    const nativeCapture = capture.captures[0]
    if (
      capture.captures.length !== 1 ||
      !nativeCapture ||
      nativeCapture.responseStatus < 200 ||
      nativeCapture.responseStatus >= 300 ||
      !nativeCapture.platformSignatureHeadersPresent ||
      nativeCapture.rawResponseFields.join(',') !== 'code_url'
    ) {
      throw new Error('D7-17 replacement response failed the signed strict contract')
    }

    const storedOrder = await payload.find({
      collection: 'orders',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { orderNumber: { equals: order.data.orderNumber } },
    })
    const storedQuote = await payload.find({
      collection: 'quotes',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { quoteRef: { equals: quote.data.quote.quoteRef } },
    })
    const orderDocument = storedOrder.docs[0]
    const quoteDocument = storedQuote.docs[0]
    if (!orderDocument?.merchantOrderNumber || !quoteDocument) {
      throw new Error('D7-17 replacement identifiers are incomplete')
    }

    const paymentBudgetAfter = await payload.find({
      collection: 'providerWriteBudgets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { scopeKey: { equals: 'wechatpay:payment' } },
    })
    if (
      paymentBudgetAfter.docs[0]?.usedAmountFen !== nextAttempts ||
      paymentBudgetAfter.docs[0]?.usedOperations !== 0 ||
      paymentBudgetAfter.docs[0]?.configuredAmountLimitFen !== 10
    ) {
      throw new Error('D7-17 replacement budget did not persist the one-fen debit')
    }

    const expiredPayments = [
      ...(previous.expiredPayments ??
        (previous.previousExpiredPayment ? [previous.previousExpiredPayment] : [])),
      {
        expiresAt: previous.expiresAt,
        merchantOrderNumber: previous.merchantOrderNumber,
        orderId: previous.orderId,
        orderNumber: previous.orderNumber,
        providerState: oldQuery.data.state,
      },
    ]

    replaceState({
      createdAt: new Date().toISOString(),
      customerId: customer.id,
      expiresAt: session.data.expiresAt,
      merchantOrderNumber: orderDocument.merchantOrderNumber,
      nativeCapture,
      orderId: Number(orderDocument.id),
      orderNumber: order.data.orderNumber,
      expiredPayments,
      paymentCreateAttempts: nextAttempts,
      phase: 'payment_created',
      quoteId: Number(quoteDocument.id),
      refundBudgetUsedBeforeFen: 0,
      templateId: previous.templateId,
      tracePrefix,
    })

    const qrPng = await QRCode.toBuffer(session.data.codeUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      type: 'png',
      width: 360,
    })
    process.stdout.write(
      `D7_17_REPLACEMENT ${JSON.stringify({
        amountMinor: 1,
        expiresAt: session.data.expiresAt,
        oldProviderState: oldQuery.data.state,
        paymentBudgetUsedAmountFen: nextAttempts,
        paymentCreateAttempts: nextAttempts,
        platformSignatureVerified: true,
        providerResponseStatus: nativeCapture.responseStatus,
        providerResponseTimeMs: nativeCapture.responseTimeMs,
        quoteAndOrderValidation: 'passed',
      })}\n`,
    )
    process.stdout.write(`D7_17_QR_PNG_BASE64 ${qrPng.toString('base64')}\n`)
  } finally {
    await payload.db.destroy?.()
  }
}

async function confirmPaymentByActiveQuery(): Promise<void> {
  assertRuntime()
  const state = readState()
  if (state.phase !== 'payment_created' || state.paymentCreateAttempts !== 3) {
    throw new Error('D7-17 state does not permit payment confirmation')
  }

  const payload = await getPayload({ config })
  try {
    const customer: CustomerIdentity = {
      collection: 'customers',
      id: state.customerId,
      status: 'active',
    }
    const capture = new CapturingWechatPayTransport()
    const liveProvider = createConfiguredWechatPayProvider({
      liveTransportFactory: () => capture,
    })
    let observedQuery: Awaited<ReturnType<PaymentProvider['queryOrder']>> | undefined
    const provider: PaymentProvider = {
      closeOrder: (input) => liveProvider.closeOrder(input),
      createPayment: (input) => liveProvider.createPayment(input),
      health: () => liveProvider.health(),
      queryOrder: async (input) => {
        const result = await liveProvider.queryOrder(input)
        observedQuery = result
        return result
      },
      verifyNotification: (input) => liveProvider.verifyNotification(input),
    }
    const confirmation = await queryAndConfirmWechatPayment(
      await customerRequest(payload, customer, `${state.tracePrefix}-active-query-confirmation`),
      state.orderNumber,
      {
        customer,
        provider,
        traceId: `${state.tracePrefix}-active-query-confirmation`,
      },
    )
    const query = observedQuery
    const queryCapture = capture.queryCaptures[0]
    if (
      !query?.ok ||
      query.data.state !== 'paid' ||
      query.data.amountMinor !== 1 ||
      query.data.currency !== 'CNY' ||
      query.data.merchantOrderNumber !== state.merchantOrderNumber ||
      typeof query.data.transactionId !== 'string' ||
      capture.queryCaptures.length !== 1 ||
      !queryCapture ||
      queryCapture.responseStatus < 200 ||
      queryCapture.responseStatus >= 300 ||
      !queryCapture.platformSignatureHeadersPresent
    ) {
      throw new Error('D7-17 active query did not prove an exact signed one-fen payment')
    }
    if (confirmation.data.status !== 'paid') {
      throw new Error('D7-17 active query did not transition the order to paid')
    }

    const confirmedAt = new Date().toISOString()
    replaceState({
      ...state,
      confirmedAt,
      paymentQueryCapture: queryCapture,
      phase: 'payment_confirmed',
    })
    process.stdout.write(
      `D7_17_PAYMENT_CONFIRMED ${JSON.stringify({
        amountMatches: true,
        amountMinor: 1,
        currency: 'CNY',
        identifierMatches: true,
        orderStatus: confirmation.data.status,
        platformSignatureVerified: true,
        providerResponseStatus: queryCapture.responseStatus,
        providerResponseTimeMs: queryCapture.responseTimeMs,
        providerState: query.data.state,
        queryRawResponseFields: queryCapture.rawResponseFields,
        transactionIdentifierPresent: true,
      })}\n`,
    )
  } finally {
    await payload.db.destroy?.()
  }
}

async function requestAndRunRefundCreateJob(): Promise<void> {
  assertRuntime()
  const state = readState()
  if (state.phase !== 'payment_confirmed' || state.paymentCreateAttempts !== 3) {
    throw new Error('D7-17 state does not permit refund creation')
  }

  const payload = await getPayload({ config })
  try {
    const order = await payload.findByID({
      collection: 'orders',
      depth: 0,
      id: state.orderId,
      overrideAccess: true,
    })
    if (order.status !== 'paid' || order.amountMinor !== 1 || order.currency !== 'CNY') {
      throw new Error('D7-17 order is not an exact paid one-fen refund source')
    }

    const traceId = `${state.tracePrefix}-refund-create`
    const req = await createLocalReq(
      { req: { headers: new Headers({ 'x-request-id': traceId }) } },
      payload,
    )
    const requested = await requestAutomaticRegistrationFailureRefund(req, {
      evidence: {
        drill: 'D7-17 approved one-fen WeChat refund',
        westdigitalCostSide: 'fixture',
        westdigitalRegistrationAttempted: false,
      },
      note: '负责人批准的 D7-17 一分钱真实退款联调；未执行西部数码注册。',
      orderId: state.orderId,
      traceId,
      transition: {
        actorType: 'system',
        reasonCode: 'd7_17.wechatpay_refund_drill',
      },
    })
    if (requested.idempotentReplay) {
      throw new Error('D7-17 refund unexpectedly existed before the approved refund request')
    }

    const queued = await payload.find({
      collection: 'payload-jobs',
      depth: 0,
      limit: 20,
      overrideAccess: true,
      pagination: false,
      where: {
        and: [
          { queue: { equals: 'commerce' } },
          { workflowSlug: { equals: 'wechatRefund' } },
          { completedAt: { exists: false } },
        ],
      },
    })
    const matchingJobs = queued.docs.filter(
      (job) =>
        Number((job.input as { refundId?: unknown } | null)?.refundId) ===
        Number(requested.refundId),
    )
    if (matchingJobs.length !== 1 || !matchingJobs[0]) {
      throw new Error('D7-17 exact queued refund job could not be isolated')
    }

    let refundCapture: QueryCapture | undefined
    const originalFetch = globalThis.fetch
    const capturingFetch: typeof fetch = async (input, init) => {
      const requestUrl =
        typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const requestMethod = (init?.method ?? (input instanceof Request ? input.method : 'GET'))
        .toUpperCase()
        .trim()
      const startedAt = performance.now()
      const response = await originalFetch(input, init)
      const url = new URL(requestUrl)
      if (
        requestMethod === 'POST' &&
        url.origin === 'https://api.mch.weixin.qq.com' &&
        url.pathname === '/v3/refund/domestic/refunds'
      ) {
        let rawResponseFields: string[] = []
        try {
          const parsed = (await response.clone().json()) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            rawResponseFields = Object.keys(parsed).sort()
          }
        } catch {
          rawResponseFields = []
        }
        refundCapture = {
          platformSignatureHeadersPresent: [
            'wechatpay-nonce',
            'wechatpay-serial',
            'wechatpay-signature',
            'wechatpay-timestamp',
          ].every((name) => Boolean(response.headers.get(name))),
          rawResponseFields,
          responseStatus: response.status,
          responseTimeMs: Math.round((performance.now() - startedAt) * 10) / 10,
        }
      }
      return response
    }
    try {
      globalThis.fetch = capturingFetch
      await payload.jobs.runByID({ id: matchingJobs[0].id, silent: true })
    } finally {
      globalThis.fetch = originalFetch
    }

    const completedJob = await payload.findByID({
      collection: 'payload-jobs',
      depth: 0,
      id: matchingJobs[0].id,
      overrideAccess: true,
    })
    const refund = await payload.findByID({
      collection: 'refunds',
      depth: 0,
      id: requested.refundId,
      overrideAccess: true,
    })
    const updatedOrder = await payload.findByID({
      collection: 'orders',
      depth: 0,
      id: state.orderId,
      overrideAccess: true,
    })
    const refundBudget = await payload.find({
      collection: 'providerWriteBudgets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { scopeKey: { equals: 'wechatpay:refund' } },
    })
    const capture = refundCapture
    if (
      completedJob.hasError ||
      !completedJob.completedAt ||
      !capture ||
      capture.responseStatus < 200 ||
      capture.responseStatus >= 300 ||
      !capture.platformSignatureHeadersPresent ||
      !['submitted', 'succeeded'].includes(refund.status) ||
      !['refunding', 'refunded'].includes(updatedOrder.status) ||
      typeof refund.providerRefundId !== 'string' ||
      refundBudget.docs[0]?.usedAmountFen !== 1 ||
      refundBudget.docs[0]?.usedOperations !== 0 ||
      refundBudget.docs[0]?.configuredAmountLimitFen !== 10
    ) {
      throw new Error('D7-17 queued refund create did not pass its signed one-fen contract')
    }

    replaceState({
      ...state,
      phase: 'refund_created',
      refundCreateCapture: capture,
      refundId: Number(requested.refundId),
      refundNumber: requested.refundNumber,
    })
    process.stdout.write(
      `D7_17_REFUND_CREATED ${JSON.stringify({
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        normalizedFields: [
          'amountMinor',
          'currency',
          'merchantOrderNumber',
          'providerRefundId',
          'refundNumber',
          'state',
        ],
        orderStatus: updatedOrder.status,
        platformSignatureVerified: true,
        providerIdentifierPresent: true,
        providerResponseStatus: capture.responseStatus,
        providerResponseTimeMs: capture.responseTimeMs,
        providerState: refund.status === 'succeeded' ? 'succeeded' : 'processing',
        queuedCommerceJobExecuted: true,
        rawResponseFields: capture.rawResponseFields,
        refundBudgetUsedAmountFen: 1,
        refundStatus: refund.status,
        schemaDifference:
          'snake_case WeChat fields are normalized to integer-fen and internal camelCase fields',
      })}\n`,
    )
  } finally {
    await payload.db.destroy?.()
  }
}

async function queueAndRunRefundQueryJob(): Promise<void> {
  assertRuntime()
  const state = readState()
  if (
    (state.phase !== 'refund_created' && state.phase !== 'refund_queried') ||
    !state.refundId ||
    !state.refundNumber ||
    (state.refundQueryAttempts ?? 0) >= 5
  ) {
    throw new Error('D7-17 state does not permit another refund query')
  }

  const payload = await getPayload({ config })
  try {
    const attempt = (state.refundQueryAttempts ?? 0) + 1
    const traceId = `${state.tracePrefix}-refund-query-${attempt}`
    const queued = await payload.jobs.queue({
      input: { refundId: state.refundId, traceId },
      overrideAccess: true,
      queue: 'commerce',
      workflow: 'wechatRefund',
    })

    let refundCapture: QueryCapture | undefined
    const originalFetch = globalThis.fetch
    const capturingFetch: typeof fetch = async (input, init) => {
      const requestUrl =
        typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const requestMethod = (init?.method ?? (input instanceof Request ? input.method : 'GET'))
        .toUpperCase()
        .trim()
      const startedAt = performance.now()
      const response = await originalFetch(input, init)
      const url = new URL(requestUrl)
      if (
        requestMethod === 'GET' &&
        url.origin === 'https://api.mch.weixin.qq.com' &&
        url.pathname.startsWith('/v3/refund/domestic/refunds/')
      ) {
        let rawResponseFields: string[] = []
        try {
          const parsed = (await response.clone().json()) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            rawResponseFields = Object.keys(parsed).sort()
          }
        } catch {
          rawResponseFields = []
        }
        refundCapture = {
          platformSignatureHeadersPresent: [
            'wechatpay-nonce',
            'wechatpay-serial',
            'wechatpay-signature',
            'wechatpay-timestamp',
          ].every((name) => Boolean(response.headers.get(name))),
          rawResponseFields,
          responseStatus: response.status,
          responseTimeMs: Math.round((performance.now() - startedAt) * 10) / 10,
        }
      }
      return response
    }
    try {
      globalThis.fetch = capturingFetch
      await payload.jobs.runByID({ id: queued.id, silent: true })
    } finally {
      globalThis.fetch = originalFetch
    }

    const completedJob = await payload.findByID({
      collection: 'payload-jobs',
      depth: 0,
      id: queued.id,
      overrideAccess: true,
    })
    const refund = await payload.findByID({
      collection: 'refunds',
      depth: 0,
      id: state.refundId,
      overrideAccess: true,
    })
    const order = await payload.findByID({
      collection: 'orders',
      depth: 0,
      id: state.orderId,
      overrideAccess: true,
    })
    const refundBudget = await payload.find({
      collection: 'providerWriteBudgets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { scopeKey: { equals: 'wechatpay:refund' } },
    })
    const capture = refundCapture
    if (
      completedJob.hasError ||
      !completedJob.completedAt ||
      !capture ||
      capture.responseStatus < 200 ||
      capture.responseStatus >= 300 ||
      !capture.platformSignatureHeadersPresent ||
      !['submitted', 'succeeded'].includes(refund.status) ||
      !['refunding', 'refunded'].includes(order.status) ||
      refund.amountMinor !== 1 ||
      refund.currency !== 'CNY' ||
      typeof refund.providerRefundId !== 'string' ||
      refundBudget.docs[0]?.usedAmountFen !== 1 ||
      refundBudget.docs[0]?.usedOperations !== 0 ||
      refundBudget.docs[0]?.configuredAmountLimitFen !== 10
    ) {
      throw new Error('D7-17 queued refund query did not pass its signed one-fen contract')
    }

    const succeeded = refund.status === 'succeeded' && order.status === 'refunded'
    replaceState({
      ...state,
      phase: succeeded ? 'refund_confirmed' : 'refund_queried',
      refundQueryAttempts: attempt,
      refundQueryCapture: capture,
    })
    process.stdout.write(
      `D7_17_REFUND_QUERIED ${JSON.stringify({
        amountMatches: true,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        identifierMatches: true,
        orderStatus: order.status,
        platformSignatureVerified: true,
        providerIdentifierPresent: true,
        providerResponseStatus: capture.responseStatus,
        providerResponseTimeMs: capture.responseTimeMs,
        providerState: succeeded ? 'succeeded' : 'processing',
        queryAttempt: attempt,
        queuedCommerceJobExecuted: true,
        rawResponseFields: capture.rawResponseFields,
        refundArrived: succeeded,
        refundBudgetUsedAmountFen: 1,
        refundStatus: refund.status,
        refundedAtPresent: typeof refund.refundedAt === 'string',
      })}\n`,
    )
  } finally {
    await payload.db.destroy?.()
  }
}

async function replayVerifiedPaymentNotification(): Promise<void> {
  assertRuntime()
  const state = readState()
  if (state.phase !== 'refund_confirmed') {
    throw new Error('D7-17 state does not permit payment notification replay')
  }

  const payload = await getPayload({ config })
  try {
    const admins = await payload.find({
      collection: 'admins',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [{ status: { equals: 'active' } }, { roles: { contains: 'system_admin' } }],
      },
    })
    const admin = admins.docs[0]
    if (!admin) throw new Error('D7-17 requires an existing active system_admin')
    const req = await createLocalReq(
      { req: { headers: new Headers({ 'x-request-id': `${state.tracePrefix}-notify-replay` }) } },
      payload,
    )
    req.user = { ...admin, collection: 'admins' } as never

    const archives = await payload.find({
      collection: 'paymentNotificationArchives',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      where: {
        and: [{ order: { equals: state.orderId } }, { signatureVerified: { equals: true } }],
      },
    })
    const archive = archives.docs[0]
    if (archives.totalDocs !== 1 || !archive) {
      throw new Error('D7-17 expected exactly one verified payment notification archive')
    }

    const rejected = await payload.find({
      collection: 'paymentNotifications',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { confirmationStatus: { equals: 'rejected' } },
          { signatureVerified: { equals: false } },
        ],
      },
    })
    const rejectedNotification = rejected.docs[0]
    if (!rejectedNotification) {
      throw new Error('D7-17 rejected notification probe evidence is missing')
    }

    const capture = new CapturingWechatPayTransport()
    const liveProvider = createConfiguredWechatPayProvider({
      liveTransportFactory: () => capture,
    })
    let queryCalls = 0
    let observedQuery: Awaited<ReturnType<PaymentProvider['queryOrder']>> | undefined
    const provider: PaymentProvider = {
      closeOrder: (input) => liveProvider.closeOrder(input),
      createPayment: (input) => liveProvider.createPayment(input),
      health: () => liveProvider.health(),
      queryOrder: async (input) => {
        queryCalls += 1
        const result = await liveProvider.queryOrder(input)
        observedQuery = result
        return result
      },
      verifyNotification: (input) => liveProvider.verifyNotification(input),
    }

    let rejectedReplayCode: string | undefined
    try {
      await replayArchivedWechatPaymentNotification(req, rejectedNotification.notificationId, {
        evidence: {
          observedAt: new Date().toISOString(),
          reference: 'D7-17 rejected notification replay guard verification',
          source: 'provider_query',
        },
        note: '验证未验签通知不能进入归档重放路径。',
        provider,
        traceId: `${state.tracePrefix}-rejected-notify-replay`,
      })
    } catch (error) {
      if (error instanceof AppError) rejectedReplayCode = error.code
      else throw error
    }
    if (rejectedReplayCode !== 'VERIFIED_PAYMENT_NOTIFICATION_NOT_FOUND' || queryCalls !== 0) {
      throw new Error('D7-17 unverified notification replay guard did not fail closed')
    }

    if ((archive.replayCount ?? 0) > 0) {
      const recoveryQuery = await provider.queryOrder({
        merchantOrderNumber: state.merchantOrderNumber,
        traceId: `${state.tracePrefix}-verified-notify-replay-evidence-recovery`,
      })
      const queryCapture = capture.queryCaptures[0]
      const updatedArchive = await payload.findByID({
        collection: 'paymentNotificationArchives',
        depth: 0,
        id: archive.id,
        overrideAccess: true,
      })
      const order = await payload.findByID({
        collection: 'orders',
        depth: 0,
        id: state.orderId,
        overrideAccess: true,
      })
      const events = await payload.find({
        collection: 'orderEvents',
        depth: 0,
        limit: 20,
        overrideAccess: true,
        pagination: false,
        sort: 'createdAt',
        where: { order: { equals: state.orderId } },
      })
      const audits = await payload.find({
        collection: 'auditLogs',
        depth: 0,
        limit: 2,
        overrideAccess: true,
        where: {
          and: [
            { action: { equals: 'commerce.payment_notification.replayed' } },
            { targetId: { equals: archive.notificationId } },
          ],
        },
      })
      const eventStatuses = events.docs.map((event) => event.toStatus)
      if (
        !recoveryQuery.ok ||
        recoveryQuery.data.state !== 'refunded' ||
        recoveryQuery.data.amountMinor !== 1 ||
        recoveryQuery.data.currency !== 'CNY' ||
        recoveryQuery.data.merchantOrderNumber !== state.merchantOrderNumber ||
        typeof recoveryQuery.data.transactionId !== 'string' ||
        Number(queryCalls) !== 1 ||
        capture.queryCaptures.length !== 1 ||
        !queryCapture ||
        !queryCapture.platformSignatureHeadersPresent ||
        queryCapture.responseStatus < 200 ||
        queryCapture.responseStatus >= 300 ||
        updatedArchive.replayCount !== 1 ||
        !updatedArchive.lastReplayAt ||
        order.status !== 'refunded' ||
        eventStatuses.join(',') !== 'pending_payment,paid,refund_pending,refunding,refunded' ||
        audits.totalDocs !== 1
      ) {
        throw new Error('D7-17 existing replay evidence did not pass recovery validation')
      }

      replaceState({ ...state, phase: 'notification_replayed' })
      process.stdout.write(
        `D7_17_NOTIFICATION_REPLAYED ${JSON.stringify({
          activeQueryAmountMatches: true,
          activeQueryIdentifierMatches: true,
          activeQueryProviderState: recoveryQuery.data.state,
          activeQueryResponseTimeMs: queryCapture.responseTimeMs,
          auditRecorded: true,
          callbackArchiveCount: 1,
          idempotentReplay: true,
          orderEventSequence: eventStatuses,
          orderStatus: order.status,
          platformSignatureVerified: true,
          replayCount: updatedArchive.replayCount,
          replayWasNotRepeatedDuringRecovery: true,
          unverifiedArchiveRejected: true,
          unverifiedReplayProviderCalls: 0,
        })}\n`,
      )
      return
    }

    const eventsBefore = await payload.count({
      collection: 'orderEvents',
      overrideAccess: true,
      where: { order: { equals: state.orderId } },
    })
    const replayCountBefore = archive.replayCount ?? 0
    const replay = await replayArchivedWechatPaymentNotification(req, archive.notificationId, {
      evidence: {
        observedAt: new Date().toISOString(),
        reference: 'D7-17 signed payment notification replay drill',
        source: 'provider_query',
      },
      note: '重放已验签支付通知；订单已退款，验证幂等且仍以微信主动查单为准。',
      provider,
      traceId: `${state.tracePrefix}-verified-notify-replay`,
    })
    const eventsAfter = await payload.count({
      collection: 'orderEvents',
      overrideAccess: true,
      where: { order: { equals: state.orderId } },
    })
    const updatedArchive = await payload.findByID({
      collection: 'paymentNotificationArchives',
      depth: 0,
      id: archive.id,
      overrideAccess: true,
    })
    const audits = await payload.find({
      collection: 'auditLogs',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        and: [
          { action: { equals: 'commerce.payment_notification.replayed' } },
          { targetId: { equals: archive.notificationId } },
        ],
      },
    })
    const query = observedQuery
    const queryCapture = capture.queryCaptures[0]
    if (
      !query?.ok ||
      (query.data.state !== 'paid' && query.data.state !== 'refunded') ||
      query.data.amountMinor !== 1 ||
      query.data.currency !== 'CNY' ||
      query.data.merchantOrderNumber !== state.merchantOrderNumber ||
      typeof query.data.transactionId !== 'string' ||
      Number(queryCalls) !== 1 ||
      capture.queryCaptures.length !== 1 ||
      !queryCapture ||
      !queryCapture.platformSignatureHeadersPresent ||
      queryCapture.responseStatus < 200 ||
      queryCapture.responseStatus >= 300 ||
      !replay.idempotentReplay ||
      replay.orderStatus !== 'refunded' ||
      eventsAfter.totalDocs !== eventsBefore.totalDocs ||
      updatedArchive.replayCount !== replayCountBefore + 1 ||
      audits.totalDocs !== 1
    ) {
      throw new Error('D7-17 verified notification replay contract failed')
    }

    replaceState({ ...state, phase: 'notification_replayed' })
    process.stdout.write(
      `D7_17_NOTIFICATION_REPLAYED ${JSON.stringify({
        activeQueryAmountMatches: true,
        activeQueryIdentifierMatches: true,
        activeQueryProviderState: query.data.state,
        activeQueryResponseTimeMs: queryCapture.responseTimeMs,
        auditRecorded: true,
        callbackArchiveCount: 1,
        idempotentReplay: true,
        orderEventCountUnchanged: true,
        orderStatus: replay.orderStatus,
        platformSignatureVerified: true,
        replayCountIncremented: true,
        unverifiedArchiveRejected: true,
        unverifiedReplayProviderCalls: 0,
      })}\n`,
    )
  } finally {
    await payload.db.destroy?.()
  }
}

async function runPartialThreeWayReconciliation(): Promise<void> {
  assertRuntime()
  const state = readState()
  if (state.phase !== 'notification_replayed' || !state.refundId) {
    throw new Error('D7-17 state does not permit reconciliation')
  }

  const payload = await getPayload({ config })
  try {
    const traceId = `${state.tracePrefix}-partial-three-way-reconciliation`
    const req = await createLocalReq(
      { req: { headers: new Headers({ 'x-request-id': traceId }) } },
      payload,
    )
    const orderBefore = await payload.findByID({
      collection: 'orders',
      depth: 0,
      id: state.orderId,
      overrideAccess: true,
    })
    const refundBefore = await payload.findByID({
      collection: 'refunds',
      depth: 0,
      id: state.refundId,
      overrideAccess: true,
    })
    const paymentConfirmations = await payload.find({
      collection: 'paymentNotifications',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      where: {
        and: [
          { order: { equals: state.orderId } },
          { confirmationStatus: { equals: 'confirmed' } },
          { signatureVerified: { equals: true } },
        ],
      },
    })
    const paymentConfirmation = paymentConfirmations.docs[0]
    if (
      paymentConfirmations.totalDocs !== 1 ||
      !paymentConfirmation?.merchantOrderNumber ||
      !paymentConfirmation.wechatTransactionId ||
      orderBefore.status !== 'refunded' ||
      orderBefore.amountMinor !== 1 ||
      refundBefore.status !== 'succeeded' ||
      refundBefore.amountMinor !== 1 ||
      !refundBefore.refundNumber ||
      !refundBefore.providerRefundId
    ) {
      throw new Error('D7-17 real WeChat/internal reconciliation evidence is incomplete')
    }

    const period = {
      end: new Date().toISOString(),
      start: new Date(Date.parse(state.createdAt) - 1_000).toISOString(),
    }
    const wechatResults = await reconcileWechatFunds(req, {
      entries: [
        {
          amountMinor: 1,
          currency: 'CNY',
          merchantOrderNumber: paymentConfirmation.merchantOrderNumber,
          type: 'payment',
          wechatTransactionId: paymentConfirmation.wechatTransactionId,
        },
        {
          amountMinor: 1,
          currency: 'CNY',
          providerRefundId: refundBefore.providerRefundId,
          refundNumber: refundBefore.refundNumber,
          type: 'refund',
        },
      ],
      period,
      traceId: `${traceId}-wechat-real`,
    })
    const paymentReconciliation = wechatResults[0]
    const refundReconciliation = wechatResults[1]
    if (!paymentReconciliation || !refundReconciliation) {
      throw new Error('D7-17 WeChat reconciliation records are missing')
    }

    const westdigitalResult = await reconcileWestdigitalPrepaidBalance(req, {
      period,
      statement: {
        closingAvailableMinor: 1,
        closingFrozenMinor: 0,
        creditsMinor: 0,
        debits: [],
        openingAvailableMinor: 0,
        openingFrozenMinor: 0,
      },
      traceId: `${traceId}-westdigital-fixture`,
    })
    const threeWay = await recordThreeWayDifference(req, {
      orderNumber: state.orderNumber,
      period,
      traceId: `${traceId}-internal`,
      wechatReconciliationKey: paymentReconciliation.record.reconciliationKey,
      westdigitalReconciliationKey: westdigitalResult.record.reconciliationKey,
    })

    const orderAfter = await payload.findByID({
      collection: 'orders',
      depth: 0,
      id: state.orderId,
      overrideAccess: true,
    })
    const refundAfter = await payload.findByID({
      collection: 'refunds',
      depth: 0,
      id: state.refundId,
      overrideAccess: true,
    })
    const records = [
      paymentReconciliation.record,
      refundReconciliation.record,
      westdigitalResult.record,
      threeWay.record,
    ]
    const ledgerSet = new Set(records.map((record) => record.ledger))
    const keySet = new Set(records.map((record) => record.reconciliationKey))
    const westdigitalSummary = westdigitalResult.record.summary as Record<string, unknown>
    const threeWaySummary = threeWay.record.summary as Record<string, unknown>
    const orderSnapshotBefore = {
      amountMinor: orderBefore.amountMinor,
      paidAt: orderBefore.paidAt,
      status: orderBefore.status,
    }
    const orderSnapshotAfter = {
      amountMinor: orderAfter.amountMinor,
      paidAt: orderAfter.paidAt,
      status: orderAfter.status,
    }
    const refundSnapshotBefore = {
      amountMinor: refundBefore.amountMinor,
      refundedAt: refundBefore.refundedAt,
      status: refundBefore.status,
    }
    const refundSnapshotAfter = {
      amountMinor: refundAfter.amountMinor,
      refundedAt: refundAfter.refundedAt,
      status: refundAfter.status,
    }
    if (
      paymentReconciliation.record.ledger !== 'wechat_funds' ||
      paymentReconciliation.record.status !== 'matched' ||
      paymentReconciliation.record.differenceMinor !== 0 ||
      refundReconciliation.record.ledger !== 'wechat_funds' ||
      refundReconciliation.record.status !== 'matched' ||
      refundReconciliation.record.differenceMinor !== 0 ||
      westdigitalResult.record.ledger !== 'westdigital_prepaid' ||
      westdigitalResult.record.status !== 'difference' ||
      westdigitalResult.record.differenceMinor !== 1 ||
      westdigitalSummary.source !== 'westdigital_checkbalance_fixture' ||
      westdigitalSummary.correctionApplied !== false ||
      threeWay.record.ledger !== 'internal_orders' ||
      threeWay.record.status !== 'difference' ||
      threeWay.record.differenceMinor !== 1 ||
      threeWaySummary.correctionApplied !== false ||
      ledgerSet.size !== 3 ||
      keySet.size !== 4 ||
      JSON.stringify(orderSnapshotBefore) !== JSON.stringify(orderSnapshotAfter) ||
      JSON.stringify(refundSnapshotBefore) !== JSON.stringify(refundSnapshotAfter) ||
      records.some(
        (record) =>
          !record.periodStart || !record.periodEnd || !record.recordKey || !record.traceId,
      )
    ) {
      throw new Error('D7-17 partial three-way reconciliation contract failed')
    }

    replaceState({ ...state, phase: 'reconciled' })
    process.stdout.write(
      `D7_17_RECONCILED ${JSON.stringify({
        auditReconstructable: true,
        correctionApplied: false,
        differenceEvidence: {
          internalOrdersMinor: threeWay.record.differenceMinor,
          westdigitalFixtureMinor: westdigitalResult.record.differenceMinor,
        },
        independentLedgers: [...ledgerSet].sort(),
        internalOrderSide: 'real',
        orderUnchanged: true,
        partialCompletion: true,
        refundUnchanged: true,
        wechatFundsSide: {
          payment: 'real_matched',
          refund: 'real_matched',
        },
        westdigitalCostSide: 'fixture',
      })}\n`,
    )
  } finally {
    await payload.db.destroy?.()
  }
}

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'D7_17_PREPARE_FAILED', message: error.message }
  return { code: 'D7_17_PREPARE_FAILED', message: 'Unknown D7-17 failure' }
}

const phase = process.argv[2]
if (
  phase !== 'prepare' &&
  phase !== 'inspect-expired' &&
  phase !== 'inspect-budgets' &&
  phase !== 'confirm-payment' &&
  phase !== 'create-refund' &&
  phase !== 'query-refund' &&
  phase !== 'replay-notification' &&
  phase !== 'reconcile' &&
  phase !== 'replace-expired'
) {
  process.stderr.write('D7_17_SAFE_ERROR {"code":"D7_17_PHASE_INVALID"}\n')
  process.exitCode = 2
} else {
  await (
    phase === 'prepare'
      ? prepare()
      : phase === 'inspect-expired'
        ? inspectExpiredPayment()
        : phase === 'inspect-budgets'
          ? inspectWechatBudgets()
          : phase === 'confirm-payment'
            ? confirmPaymentByActiveQuery()
            : phase === 'create-refund'
              ? requestAndRunRefundCreateJob()
              : phase === 'query-refund'
                ? queueAndRunRefundQueryJob()
                : phase === 'replay-notification'
                  ? replayVerifiedPaymentNotification()
                  : phase === 'reconcile'
                    ? runPartialThreeWayReconciliation()
                    : replaceExpiredPayment()
  ).catch((error) => {
    process.stderr.write(`D7_17_SAFE_ERROR ${JSON.stringify(safeError(error))}\n`)
    process.exit(1)
  })
  process.exit(0)
}
