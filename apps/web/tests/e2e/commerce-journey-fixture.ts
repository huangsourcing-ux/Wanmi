import { randomUUID } from 'node:crypto'

import config from '@payload-config'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'

import { mockFailure, mockSuccess } from '@/providers/mock'
import type { ProviderResult } from '@/lib/domain'
import type {
  SmsProvider,
  WestDigitalAvailability,
  WestDigitalDomainAsset,
  WestDigitalWriteProvider,
} from '@/providers/types'
import { createWechatPayFixture } from '@/providers/wechatpay'
import {
  runCommerceFulfillment,
  type FulfillmentDependencies,
} from '@/services/commerce/fulfillment'
import { processWechatPaymentNotification } from '@/services/commerce/payments'
import { runWechatRefund } from '@/services/commerce/refunds'
import { updateBalanceControl } from '@/services/commerce/balance-control'
import { appendConsentAcceptance } from '@/services/auth/registration-consents'
import { runDomainExpiryReminders } from '@/services/domains/expiry-reminders'
import { runNameserverChange } from '@/services/domains/nameserver-changes'
import {
  createRealnameTemplate,
  submitRealnameTemplate,
  syncRealnameTemplateStatus,
} from '@/services/realname/templates'

import { approvedRealnameProviderFixture, realnameTemplateFixture } from '../fixtures/realname'
import {
  ensureAnchorSystemAdmin,
  findOrCreateUniqueFixture,
  ignorePayloadNotFound,
} from '../test-cleanup'

type Customer = {
  collection: 'customers'
  id: number
  phone: string
  status: string
}

type Order = {
  amountMinor: number
  customer: number | { id: number }
  domainAscii: string
  id: number
  merchantOrderNumber?: null | string
  orderNumber: string
  status: string
}

type ProviderMode = 'failed' | 'ready' | 'unknown'

type MutableAsset = WestDigitalDomainAsset

const runToken = randomUUID().replaceAll('-', '').slice(0, 12)
export const commerceFixturePrefix = `d7-e2e-${runToken}`

export function commerceFixturePhone(index: number): string {
  const digits = [...runToken]
    .map((character) => String(character.charCodeAt(0) % 10))
    .join('')
    .padEnd(8, '0')
    .slice(0, 8)
  return `13${index}${digits}`
}

function confirmation(state: 'succeeded') {
  return mockSuccess(
    { providerClientId: `${commerceFixturePrefix}-provider`, state },
    `${commerceFixturePrefix}-provider-write`,
  )
}

function writeProvider(options: {
  asset: MutableAsset
  nameserverMode?: ProviderMode
  registerMode?: ProviderMode
  renewMode?: ProviderMode
  renewedExpiresAt?: string
}): WestDigitalWriteProvider {
  const write = (mode: ProviderMode = 'ready') => {
    if (mode === 'failed') {
      return mockFailure('WESTDIGITAL_EXPLICIT_REJECTION', {
        retryable: false,
        statusKnown: true,
      })
    }
    if (mode === 'unknown') {
      return mockFailure('WESTDIGITAL_TIMEOUT', { retryable: true, statusKnown: false })
    }
    return confirmation('succeeded')
  }

  return {
    changeNameservers: async (input) => {
      const result = write(options.nameserverMode)
      if (result.ok) options.asset.nameservers = [...input.nameservers]
      return result
    },
    createRealname: async () =>
      mockSuccess(
        {
          providerClientId: `${commerceFixturePrefix}-realname-client`,
          providerTemplateId: '1664777',
          state: 'succeeded' as const,
        },
        `${commerceFixturePrefix}-realname-create`,
      ),
    health: async () => mockSuccess({ healthy: true }, `${commerceFixturePrefix}-write-health`),
    queryRenewalEligibility: async () =>
      mockSuccess(
        { domainAscii: options.asset.domainAscii, state: 'eligible', statusCodes: ['ok'] },
        `${commerceFixturePrefix}-renewal-eligibility`,
      ),
    queryAsset: async () =>
      mockSuccess(
        { ...options.asset, nameservers: [...options.asset.nameservers] },
        `${commerceFixturePrefix}-asset-query`,
      ),
    queryRealname: async () =>
      mockSuccess(
        {
          providerClientId: `${commerceFixturePrefix}-realname-query-client`,
          reviewState: 'approved' as const,
          state: 'succeeded' as const,
        },
        `${commerceFixturePrefix}-realname-query`,
      ),
    register: async () => write(options.registerMode),
    renew: async () => {
      const result = write(options.renewMode)
      if (result.ok && options.renewedExpiresAt) options.asset.expiresAt = options.renewedExpiresAt
      return result
    },
  }
}

function dependencies(provider: WestDigitalWriteProvider): FulfillmentDependencies {
  return {
    preflight: {
      queryAvailability: async ({ domain, traceId }) =>
        mockSuccess(
          { available: true, currency: 'CNY', domainAscii: domain, premium: false },
          `${traceId}-availability`,
        ) as ProviderResult<WestDigitalAvailability>,
      queryBalance: async ({ traceId }) =>
        mockSuccess({ availableMinor: 1_000_000, frozenMinor: 0 }, `${traceId}-balance`),
    },
    write: provider,
  }
}

function deliveredSmsProvider(): SmsProvider {
  return {
    health: async () => mockSuccess({ healthy: true }, `${commerceFixturePrefix}-sms-health`),
    queryReceipt: async () =>
      mockSuccess({ status: 'delivered' as const }, `${commerceFixturePrefix}-sms-receipt`),
    sendDomainExpiry: async () =>
      mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: `${commerceFixturePrefix}-expiry-message`,
        },
        `${commerceFixturePrefix}-sms-expiry`,
      ),
    sendOtp: async () =>
      mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: `${commerceFixturePrefix}-otp-message`,
        },
        `${commerceFixturePrefix}-sms-otp`,
      ),
    sendStepUpOtp: async () =>
      mockSuccess(
        {
          accepted: true as const,
          deliveryStatus: 'delivered' as const,
          providerMessageId: `${commerceFixturePrefix}-step-up-message`,
        },
        `${commerceFixturePrefix}-sms-step-up`,
      ),
  }
}

export class CommerceJourneyFixture {
  private payload!: Payload
  private readonly customerIds = new Set<number>()
  private readonly orderIds = new Set<number>()
  private balanceControlBefore?: {
    exists: boolean
    id?: number | string
    value?: Record<string, unknown>
  }

  async initialize(): Promise<void> {
    if (process.env.ALLOW_REAL_PROVIDER_WRITES === 'true') {
      throw new Error('D7 E2E fixtures require ALLOW_REAL_PROVIDER_WRITES=false')
    }
    this.payload = await getPayload({ config })
  }

  async request(suffix: string, user?: Customer): Promise<PayloadRequest> {
    const req = await createLocalReq(
      {
        req: {
          headers: new Headers({
            'x-request-id': `${commerceFixturePrefix}-${suffix}`,
          }),
        },
      },
      this.payload,
    )
    if (user) req.user = user as never
    return req
  }

  domain(suffix: string): string {
    return `d7${runToken}${suffix.replace(/[^a-z0-9]/giu, '').toLowerCase()}.com`
  }

  async customerByPhone(phone: string): Promise<Customer> {
    const found = await this.payload.find({
      collection: 'customers',
      limit: 1,
      overrideAccess: true,
      where: { phone: { equals: `+86${phone}` } },
    })
    const doc = found.docs[0]
    if (!doc) throw new Error(`Customer fixture was not created for ${phone.slice(-4)}`)
    const customer = {
      collection: 'customers' as const,
      id: Number(doc.id),
      phone: String(doc.phone),
      status: String(doc.status),
    }
    this.customerIds.add(customer.id)
    return customer
  }

  async createApprovedTemplate(customer: Customer, suffix: string) {
    const providerTemplateId = String(1_660_000 + this.customerIds.size * 100 + suffix.length)
    const provider = approvedRealnameProviderFixture(providerTemplateId)
    const req = await this.request(`realname-${suffix}`, customer)
    await appendConsentAcceptance(req, {
      acceptedAt: new Date().toISOString(),
      consentType: 'sensitive_personal_information',
      customerId: customer.id,
      headers: req.headers,
      source: 'account_privacy_center',
    })
    const draft = await createRealnameTemplate(
      req,
      realnameTemplateFixture({
        displayName: `${commerceFixturePrefix}-${suffix}`,
        email: `${commerceFixturePrefix}-${suffix}@example.test`,
        phone: customer.phone.replace('+86', ''),
      }),
    )
    const pending = await submitRealnameTemplate(req, draft.id, provider)
    const approved = await syncRealnameTemplateStatus(
      await this.request(`realname-sync-${suffix}`),
      pending.id,
      provider,
    )
    return approved
  }

  async trackOrder(orderNumber: string): Promise<Order> {
    const found = await this.payload.find({
      collection: 'orders',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { orderNumber: { equals: orderNumber } },
    })
    const order = found.docs[0] as unknown as Order | undefined
    if (!order) throw new Error(`Order fixture ${orderNumber} was not persisted`)
    this.orderIds.add(Number(order.id))
    return { ...order, id: Number(order.id) }
  }

  async readOrder(orderId: number): Promise<Order> {
    return (await this.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: orderId,
      overrideAccess: true,
    })) as unknown as Order
  }

  async assetByDomain(domainAscii: string) {
    const found = await this.payload.find({
      collection: 'domainAssets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { domainAscii: { equals: domainAscii } },
    })
    const asset = found.docs[0]
    if (!asset) throw new Error(`Domain asset ${domainAscii} was not persisted`)
    return asset
  }

  async latestNameserverChange(assetId: number | string) {
    const found = await this.payload.find({
      collection: 'nameserverChanges',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      sort: '-createdAt',
      where: { asset: { equals: assetId } },
    })
    const change = found.docs[0]
    if (!change) throw new Error(`Name Server change for asset ${assetId} was not persisted`)
    return change
  }

  async remindersForAsset(assetId: number | string) {
    return this.payload.find({
      collection: 'domainExpiryReminders',
      depth: 0,
      limit: 20,
      overrideAccess: true,
      where: { asset: { equals: assetId } },
    })
  }

  async openReviewsForOrder(orderId: number | string) {
    return this.payload.find({
      collection: 'manualReviews',
      depth: 0,
      limit: 20,
      overrideAccess: true,
      where: { and: [{ order: { equals: orderId } }, { status: { equals: 'open' } }] },
    })
  }

  async refundsForOrder(orderId: number | string) {
    return this.payload.find({
      collection: 'refunds',
      depth: 0,
      limit: 20,
      overrideAccess: true,
      where: { order: { equals: orderId } },
    })
  }

  async completeRefund(orderId: number, suffix: string) {
    const order = await this.readOrder(orderId)
    if (!order.merchantOrderNumber) throw new Error('Payment fixture was not created')
    const refunds = await this.refundsForOrder(orderId)
    const refund = refunds.docs[0]
    if (!refund) throw new Error('Automatic refund fixture was not persisted')

    const now = new Date()
    const fixture = createWechatPayFixture({ now: () => now })
    const refundId = Number(refund.id)
    await runWechatRefund(
      await this.request(`refund-submit-${suffix}`),
      { refundId, traceId: `${commerceFixturePrefix}-refund-submit-${suffix}` },
      fixture.provider,
    )
    fixture.setRefund({
      amountMinor: order.amountMinor,
      merchantOrderNumber: order.merchantOrderNumber,
      providerRefundId: `5030${runToken}${String(orderId).padStart(16, '0')}`.slice(0, 32),
      refundNumber: String(refund.refundNumber),
      refundedAt: now.toISOString(),
      state: 'succeeded',
    })
    return runWechatRefund(
      await this.request(`refund-query-${suffix}`),
      { refundId, traceId: `${commerceFixturePrefix}-refund-query-${suffix}` },
      fixture.provider,
    )
  }

  async expireQuote(quoteRef: string): Promise<void> {
    const found = await this.payload.find({
      collection: 'quotes',
      limit: 1,
      overrideAccess: true,
      where: { quoteRef: { equals: quoteRef } },
    })
    if (!found.docs[0]) throw new Error('Quote fixture was not persisted')
    await this.payload.update({
      collection: 'quotes',
      data: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
      id: found.docs[0].id,
      overrideAccess: true,
    })
  }

  async confirmPayment(orderId: number, suffix: string): Promise<Order> {
    const order = await this.readOrder(orderId)
    if (!order.merchantOrderNumber) throw new Error('Payment fixture was not created')
    const now = new Date()
    const fixture = createWechatPayFixture({ now: () => now })
    const paidAt = now.toISOString()
    const transactionId = `4200${runToken}${String(orderId).padStart(16, '0')}`.slice(0, 32)
    fixture.setOrder({
      amountMinor: order.amountMinor,
      merchantOrderNumber: order.merchantOrderNumber,
      paidAt,
      state: 'paid',
      transactionId,
    })
    const notification = fixture.notification({
      amountMinor: order.amountMinor,
      merchantOrderNumber: order.merchantOrderNumber,
      notificationId: `${commerceFixturePrefix}-${suffix}`,
      paidAt,
      transactionId,
    })
    await processWechatPaymentNotification(
      await this.request(`payment-confirm-${suffix}`),
      { ...notification, traceId: `${commerceFixturePrefix}-payment-confirm-${suffix}` },
      fixture.provider,
    )
    return this.readOrder(orderId)
  }

  async fulfill(
    orderId: number,
    options: {
      asset?: MutableAsset
      registerMode?: ProviderMode
      renewMode?: ProviderMode
      renewedExpiresAt?: string
    } = {},
  ) {
    const order = await this.readOrder(orderId)
    const asset =
      options.asset ??
      ({
        domainAscii: order.domainAscii,
        expiresAt: '2027-08-08T04:00:00.000Z',
        nameservers: ['ns1.myhostadmin.net', 'ns2.myhostadmin.net'],
        providerAssetId: `${commerceFixturePrefix}-asset-${order.id}`,
        registeredAt: '2026-08-09T04:00:00.000Z',
        registrarCode: 'west-fixture',
        status: 'active',
      } satisfies MutableAsset)
    const provider = writeProvider({
      asset,
      registerMode: options.registerMode,
      renewMode: options.renewMode,
      renewedExpiresAt: options.renewedExpiresAt,
    })
    const result = await runCommerceFulfillment(
      await this.request(`fulfillment-${order.id}`),
      {
        operationKey: `commerce-fulfillment:${order.id}`,
        orderId: order.id,
        traceId: `${commerceFixturePrefix}-fulfillment-${order.id}`,
      },
      dependencies(provider),
    )
    return { asset, provider, result }
  }

  async runNameserverChange(
    assetId: number,
    changeId: number,
    domainAscii: string,
    requestedNameservers: string[],
  ) {
    const asset = await this.payload.findByID({
      collection: 'domainAssets',
      depth: 0,
      id: assetId,
      overrideAccess: true,
    })
    const providerAsset: MutableAsset = {
      domainAscii,
      expiresAt: String(asset.expiresAt),
      nameservers: [...(asset.nameservers ?? [])],
      providerAssetId: `${commerceFixturePrefix}-asset-${assetId}`,
      registeredAt: String(asset.registeredAt),
      registrarCode: String(asset.registrar),
      status: 'active',
    }
    const provider = writeProvider({ asset: providerAsset, nameserverMode: 'ready' })
    const result = await runNameserverChange(
      await this.request(`nameserver-run-${changeId}`),
      {
        assetId,
        changeId,
        operationKey: `nameserver-change:${changeId}`,
        traceId: `${commerceFixturePrefix}-nameserver-run-${changeId}`,
      },
      provider,
    )
    if (!requestedNameservers.every((value) => providerAsset.nameservers.includes(value))) {
      throw new Error('Name Server fixture did not confirm the requested values')
    }
    return result
  }

  async runExpiryReminder(assetId: number, expiresAt: string) {
    const now = new Date(Date.parse(expiresAt) - 20 * 86_400_000)
    return runDomainExpiryReminders(await this.request(`expiry-${assetId}`), {
      now: () => now,
      provider: deliveredSmsProvider(),
      thresholds: [30, 7, 1],
      traceId: `${commerceFixturePrefix}-expiry-${assetId}`,
    })
  }

  async stopComSales(): Promise<void> {
    const existing = await this.payload.find({
      collection: 'siteSettings',
      limit: 1,
      overrideAccess: true,
      where: { key: { equals: 'commerce.westdigital.balance-control' } },
    })
    const before = existing.docs[0]
    this.balanceControlBefore = before
      ? {
          exists: true,
          id: before.id,
          value: structuredClone(before.value as Record<string, unknown>),
        }
      : { exists: false }

    await findOrCreateUniqueFixture({
      create: () =>
        this.payload.create({
          collection: 'siteSettings',
          context: { balanceControlOperation: true },
          data: {
            description: `${commerceFixturePrefix} sales-stop fixture`,
            key: 'commerce.westdigital.balance-control',
            value: {
              affectedTlds: ['com'],
              automaticStoppedTlds: [],
              manualStoppedTlds: [],
              schemaVersion: 1,
              thresholdMinor: 10_000,
              updatedAt: new Date().toISOString(),
            },
          },
          overrideAccess: true,
        }),
      find: async () =>
        (
          await this.payload.find({
            collection: 'siteSettings',
            limit: 1,
            overrideAccess: true,
            where: { key: { equals: 'commerce.westdigital.balance-control' } },
          })
        ).docs[0],
      path: 'key',
      tableName: 'site_settings',
    })

    const admin = await ensureAnchorSystemAdmin(this.payload)
    const req = await this.request('sales-stop')
    req.user = admin
    await updateBalanceControl(req, {
      action: 'configure',
      affectedTlds: ['com'],
      thresholdMinor: 10_000,
    })
    await updateBalanceControl(req, {
      action: 'set_sales_stop',
      source: 'manual',
      stopped: true,
      tld: 'com',
    })
  }

  async customerVisibleTemplate(customer: Customer, templateId: number | string) {
    return this.payload.find({
      collection: 'realnameTemplates',
      limit: 1,
      overrideAccess: false,
      user: customer,
      where: { id: { equals: templateId } },
    })
  }

  async cleanup(): Promise<void> {
    if (!this.payload) return

    if (this.balanceControlBefore) {
      const current = await this.payload.find({
        collection: 'siteSettings',
        limit: 1,
        overrideAccess: true,
        where: { key: { equals: 'commerce.westdigital.balance-control' } },
      })
      const row = current.docs[0]
      if (row) {
        if (this.balanceControlBefore.exists) {
          await this.payload.update({
            collection: 'siteSettings',
            context: { balanceControlOperation: true },
            data: { value: this.balanceControlBefore.value },
            id: row.id,
            overrideAccess: true,
          })
        } else {
          await this.payload.delete({
            collection: 'siteSettings',
            context: { balanceControlOperation: true },
            id: row.id,
            overrideAccess: true,
          })
        }
      }
    }

    const orderIds = [...this.orderIds]
    for (const collection of [
      'renewals',
      'refundNotifications',
      'orderManualActions',
      'paymentNotificationArchives',
      'refunds',
      'manualReviews',
      'providerOperations',
      'paymentNotifications',
      'orderEvents',
    ] as const) {
      const rows = orderIds.length
        ? await this.payload.find({
            collection,
            limit: 500,
            overrideAccess: true,
            where:
              collection === 'refundNotifications'
                ? { createdAt: { greater_than: new Date(Date.now() - 3_600_000).toISOString() } }
                : { order: { in: orderIds } },
          })
        : { docs: [] }
      for (const row of rows.docs) {
        if (
          collection === 'refundNotifications' &&
          !JSON.stringify(row).includes(commerceFixturePrefix)
        ) {
          continue
        }
        await ignorePayloadNotFound(() =>
          this.payload.delete({ collection, id: row.id, overrideAccess: true }),
        )
      }
    }

    const assets = await this.payload.find({
      collection: 'domainAssets',
      limit: 200,
      overrideAccess: true,
      where: { domainAscii: { contains: `d7${runToken}` } },
    })
    const assetIds = assets.docs.map((asset) => asset.id)
    for (const collection of ['domainExpiryReminders', 'nameserverChanges'] as const) {
      const rows = assetIds.length
        ? await this.payload.find({
            collection,
            limit: 500,
            overrideAccess: true,
            where: { asset: { in: assetIds } },
          })
        : { docs: [] }
      for (const row of rows.docs) {
        await ignorePayloadNotFound(() =>
          this.payload.delete({ collection, id: row.id, overrideAccess: true }),
        )
      }
    }

    const jobs = await this.payload.find({
      collection: 'payload-jobs',
      limit: 500,
      overrideAccess: true,
      where: {
        workflowSlug: {
          in: ['commerceFulfillment', 'domainExpiryReminders', 'nameserverChange', 'wechatRefund'],
        },
      },
    })
    for (const job of jobs.docs) {
      const input = JSON.stringify(job.input)
      if (
        input.includes(commerceFixturePrefix) ||
        orderIds.some((id) => input.includes(`\"orderId\":${id}`)) ||
        assetIds.some((id) => input.includes(`\"assetId\":${id}`))
      ) {
        await ignorePayloadNotFound(() =>
          this.payload.delete({ collection: 'payload-jobs', id: job.id, overrideAccess: true }),
        )
      }
    }

    for (const orderId of orderIds) {
      await ignorePayloadNotFound(() =>
        this.payload.delete({ collection: 'orders', id: orderId, overrideAccess: true }),
      )
    }
    for (const asset of assets.docs) {
      await ignorePayloadNotFound(() =>
        this.payload.delete({ collection: 'domainAssets', id: asset.id, overrideAccess: true }),
      )
    }

    for (const collection of ['priceSnapshots', 'quotes'] as const) {
      const rows = await this.payload.find({
        collection,
        limit: 500,
        overrideAccess: true,
        where: { createdTraceId: { contains: commerceFixturePrefix } },
      })
      for (const row of rows.docs) {
        await ignorePayloadNotFound(() =>
          this.payload.delete({ collection, id: row.id, overrideAccess: true }),
        )
      }
    }

    const templates = await this.payload.find({
      collection: 'realnameTemplates',
      limit: 100,
      overrideAccess: true,
      where: { displayName: { contains: commerceFixturePrefix } },
    })
    for (const template of templates.docs) {
      await ignorePayloadNotFound(() =>
        this.payload.delete({
          collection: 'realnameTemplates',
          id: template.id,
          overrideAccess: true,
        }),
      )
    }

    for (const customerId of this.customerIds) {
      for (const collection of [
        'customerIdentities',
        'customerSessions',
        'customerSecurityEvents',
      ] as const) {
        await this.payload.delete({
          collection,
          overrideAccess: true,
          where: { customer: { equals: customerId } },
        })
      }
    }

    // Registration consent is append-only and its customer relationship is required. The random
    // run token isolates these customer facts; the disposable fixture database owns their cleanup.

    for (const collection of ['smsChallenges', 'auditLogs'] as const) {
      const rows = await this.payload.find({
        collection,
        limit: 500,
        overrideAccess: true,
        where:
          collection === 'smsChallenges'
            ? { phone: { contains: runToken.slice(-4) } }
            : { traceId: { contains: commerceFixturePrefix } },
      })
      for (const row of rows.docs) {
        await ignorePayloadNotFound(() =>
          this.payload.delete({ collection, id: row.id, overrideAccess: true }),
        )
      }
    }

    await this.payload.db.destroy?.()
  }
}
