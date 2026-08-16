import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type PayloadRequest } from 'payload'

import { mockSuccess } from '@/providers/mock'
import type { WestDigitalRealnameProvider } from '@/providers/types'
import { enqueueCommerceFulfillment } from '@/services/commerce/fulfillment'
import {
  createRealnameTemplate,
  submitRealnameTemplate,
  syncRealnameTemplateStatus,
} from '@/services/realname/templates'

const acknowledgement = 'D7-07-LOCAL-ONLY'

function assertLocalOnly(): void {
  if (process.env.WANMI_D7_REBUILD_VALIDATION !== acknowledgement) {
    throw new Error(`WANMI_D7_REBUILD_VALIDATION must equal ${acknowledgement}`)
  }
  if (/^(?:1|true)$/iu.test(process.env.ALLOW_REAL_PROVIDER_WRITES ?? '')) {
    throw new Error('D7-07 probe refuses any enabled real-provider write gate')
  }
  if (process.env.WESTDIGITAL_MODE !== 'fixture' || process.env.WECHATPAY_MODE !== 'fixture') {
    throw new Error('D7-07 probe requires fixture providers')
  }
}

function realnameProvider(): WestDigitalRealnameProvider {
  return {
    createTemplate: async () =>
      mockSuccess(
        { providerTemplateId: '1664777', reviewState: 'pending' as const },
        'd7-07-realname-create',
      ),
    health: async () => mockSuccess({ healthy: true }, 'd7-07-realname-health'),
    queryTemplate: async () =>
      mockSuccess({ reviewState: 'approved' as const }, 'd7-07-realname-query'),
  }
}

async function request(payload: Awaited<ReturnType<typeof getPayload>>, traceId: string) {
  return createLocalReq({ req: { headers: new Headers({ 'x-request-id': traceId }) } }, payload)
}

async function seedRegistrationProbe(
  payload: Awaited<ReturnType<typeof getPayload>>,
): Promise<Record<string, unknown>> {
  const id = randomUUID()
  const prefix = `d707-${id}`
  const traceId = `${prefix}-interrupt`
  const domainAscii = `d707-${id.replaceAll('-', '')}.com`
  const customer = await payload.create({
    collection: 'customers',
    data: {
      capabilityRestrictions: [],
      phone: prefix,
      phoneMasked: '***d707',
      status: 'active',
    },
    overrideAccess: true,
  })
  const customerReq = await request(payload, `${prefix}-customer`)
  customerReq.user = { ...customer, collection: 'customers' } as never
  const template = await createRealnameTemplate(customerReq, {
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
    displayName: prefix,
    email: `${id}@example.test`,
    fullNameChinese: '李小明',
    identityDocumentNumber: '11010519491231002X',
    identityDocumentType: 'SFZ',
    phone: '13812345678',
    phoneCountryCode: '+86',
    phoneType: 'mobile',
    postalCode: '610031',
    provinceChinese: '四川省',
    provinceEnglish: 'Sichuan',
    type: 'individual',
  })
  const provider = realnameProvider()
  await submitRealnameTemplate(customerReq, template.id, provider)
  await syncRealnameTemplateStatus(
    await request(payload, `${prefix}-realname-query`),
    template.id,
    provider,
  )

  const now = new Date().toISOString()
  const amountMinor = 2_999
  const quoteRef = randomUUID()
  const sourcePriceSnapshotRef = randomUUID()
  const quote = await payload.create({
    collection: 'quotes',
    data: {
      availabilityObservedAt: now,
      availabilityRequestId: `${prefix}-availability`,
      calculationFormula: 'registration_price_plus_annual_renewal_price',
      calculationVersion: 1,
      createdTraceId: `${prefix}-quote`,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      priceClass: 'standard',
      provider: 'westdigital_fixture',
      providerCacheStatus: 'miss',
      providerObservedAt: now,
      providerProductId: `${prefix}-product`,
      providerRequestId: `${prefix}-price`,
      quotedAt: now,
      quoteIntegrityHash: '2'.repeat(64),
      quoteRef,
      registrationPriceMinor: amountMinor,
      renewalPriceMinor: amountMinor,
      ruleFixedAmountMinor: 0,
      ruleKey: `${prefix}-rule`,
      ruleMode: 'fixed',
      ruleSource: 'wanmi_fixture',
      ruleVersion: 1,
      roundingMode: 'half_up_to_fen',
      schemaVersion: 1,
      sourceCalculationHash: '3'.repeat(64),
      sourcePriceSnapshotRef,
      tld: 'com',
      upstreamCostMinor: amountMinor,
      upstreamRegistrationPriceMinor: amountMinor,
      upstreamRenewalPriceMinor: amountMinor,
      userPriceMinor: amountMinor,
      years: 1,
    },
    overrideAccess: true,
  })
  const merchantOrderNumber = `WM${id.replaceAll('-', '')}`
  const order = await payload.create({
    collection: 'orders',
    data: {
      amountMinor,
      currency: 'CNY',
      customer: customer.id,
      domainAscii,
      merchantOrderNumber,
      orderNumber: `${prefix}-order`,
      paidAt: now,
      quote: quote.id,
      quoteSnapshot: {
        availabilityObservedAt: now,
        availabilityRequestId: `${prefix}-availability`,
        calculation: {
          registrationPriceFen: amountMinor,
          renewalPriceFen: amountMinor,
          upstreamRegistrationPriceFen: amountMinor,
          upstreamRenewalPriceFen: amountMinor,
        },
        createdTraceId: `${prefix}-quote`,
        currency: 'CNY',
        customerId: String(customer.id),
        domainAscii,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        operation: 'registration',
        orderAvailability: { observedAt: now, requestId: `${prefix}-order-availability` },
        providerCacheStatus: 'miss',
        providerObservedAt: now,
        providerProductId: `${prefix}-product`,
        providerRequestId: `${prefix}-price`,
        quoteId: quote.id,
        quoteIntegrityHash: '2'.repeat(64),
        quoteRef,
        quotedAt: now,
        schemaVersion: 1,
        sourceCalculationHash: '3'.repeat(64),
        sourcePriceSnapshotRef,
        tld: 'com',
        upstreamCostMinor: amountMinor,
        userPriceMinor: amountMinor,
        years: 1,
      },
      realnameTemplate: Number(template.id),
      status: 'paid',
    },
    overrideAccess: true,
  })
  await payload.create({
    collection: 'paymentNotifications',
    data: {
      amountMinor,
      confirmationStatus: 'confirmed',
      currency: 'CNY',
      merchantOrderNumber,
      notificationId: `PAY-${id}`,
      order: order.id,
      paidAt: now,
      payloadDigest: '4'.repeat(64),
      receivedAt: now,
      signatureVerified: true,
      source: 'query',
      wechatTransactionId: `WX-${id}`,
    },
    overrideAccess: true,
  })
  const queued = await enqueueCommerceFulfillment(
    (await request(payload, traceId)) as PayloadRequest,
    { orderId: order.id, traceId },
  )
  return {
    domainAscii,
    jobId: queued.jobId,
    operationKey: `commerce-fulfillment:${order.id}`,
    orderId: order.id,
    prefix,
  }
}

assertLocalOnly()
const payload = await getPayload({ config })
try {
  const result = await seedRegistrationProbe(payload)
  process.stdout.write(`D7_PROBE_RESULT ${JSON.stringify(result)}\n`)
} finally {
  await payload.db.destroy?.()
}
