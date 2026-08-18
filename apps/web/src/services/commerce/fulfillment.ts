import { sql } from '@payloadcms/db-postgres'
import { z } from 'zod'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { AppError } from '@/lib/errors'
import type { ProviderResult } from '@/lib/domain'
import type { WestDigitalAvailability, WestDigitalWriteProvider } from '@/providers/types'
import { createConfiguredWestDigitalWriteAdapter } from '@/providers/westdigital-write-fixtures'
import {
  executeWestDigitalWriteOperation,
  generateWestDigitalOperationKey,
  queryWestDigitalAsset,
  type WestDigitalWriteOperationInput,
} from '@/services/providers/westdigital-operations'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import {
  recordAutomaticRenewalOrderSkip,
  revalidateAutomaticRenewalOrder,
} from '@/services/domains/automatic-renewals'

import { captureBalancePaymentForFulfillment } from './balance-payments'
import { transitionOrder } from './order-state'
import { requestAutomaticRegistrationFailureRefund } from './refunds'
import {
  assertSalesStopResumeAuthorized,
  getTldSalesStopState,
  holdPaidOrderForSalesStop,
} from './balance-control'

export type FulfillmentInput = {
  operationKey: string
  orderId: number
  salesStopReviewId?: number
  traceId: string
}

export type FulfillmentPreflightProvider = {
  queryAvailability(input: {
    domain: string
    traceId: string
  }): Promise<ProviderResult<WestDigitalAvailability>>
  queryBalance(input: { traceId: string }): Promise<
    ProviderResult<{
      availableMinor: number
      frozenMinor: number
    }>
  >
}

export type FulfillmentDependencies = {
  preflight: FulfillmentPreflightProvider
  write: WestDigitalWriteProvider
}

type OrderRecord = {
  amountMinor: number
  automaticRenewalAttemptKey?: null | string
  automaticRenewalMandate?: null | number | string | { id: number | string }
  automaticRenewalRulesVersion?: null | string
  currency: 'CNY'
  customer: number | string | { id: number | string }
  domainAsset?: null | number | string | { id: number | string }
  domainAscii: string
  id: number | string
  orderNumber: string
  quote: number | string | { id: number | string }
  quoteSnapshot: unknown
  realnameTemplate: number | string | { id: number | string }
  operation?: 'registration' | 'renewal'
  paymentChannel?: 'balance' | 'h5' | 'native' | null
  status: string
}

type AssetRecord = {
  customer: number | string | { id: number | string }
  domainAscii: string
  expiresAt: string
  id: number | string
  realnameTemplate: number | string | { id: number | string }
  status: string
}

type RenewalRecord = {
  confirmedExpiresAt?: null | string
  id: number | string
  previousExpiresAt: string
  providerOperationKey?: null | string
  status: 'failed' | 'manual_review' | 'pending' | 'succeeded'
}

type TemplateRecord = {
  customer: number | string | { id: number | string }
  id: number | string
  providerConfirmedAt?: null | string
  providerReviewState: string
  providerTemplateId?: null | string
  status: string
}

const dateString = z.string().refine((value) => Number.isFinite(Date.parse(value)))
const money = z.number().int().nonnegative().refine(Number.isSafeInteger)
const quoteSnapshotSchema = z.object({
  assetExpiresAt: dateString.optional(),
  availabilityObservedAt: dateString,
  availabilityRequestId: z.string().min(1),
  calculation: z
    .object({
      registrationPriceFen: money,
      renewalPriceFen: money,
      upstreamRegistrationPriceFen: money,
      upstreamRenewalPriceFen: money,
    })
    .passthrough(),
  createdTraceId: z.string().min(1),
  currency: z.literal('CNY'),
  customerId: z.string().min(1),
  domainAssetId: z.union([z.number(), z.string()]).optional(),
  domainAscii: z.string().min(1),
  expiresAt: dateString,
  orderAvailability: z.object({ observedAt: dateString, requestId: z.string().min(1) }),
  operation: z.enum(['registration', 'renewal']).default('registration'),
  providerCacheExpiresAt: dateString.optional(),
  providerCacheStatus: z.enum(['hit', 'miss', 'shared']),
  providerObservedAt: dateString,
  providerProductId: z.string().min(1),
  providerRequestId: z.string().min(1),
  quoteId: z.union([z.number(), z.string()]),
  quoteIntegrityHash: z.string().regex(/^[a-f0-9]{64}$/iu),
  quoteRef: z.uuid(),
  quotedAt: dateString,
  schemaVersion: z.literal(1),
  sourceCalculationHash: z.string().regex(/^[a-f0-9]{64}$/iu),
  sourcePriceSnapshotRef: z.uuid(),
  tld: z.string().min(1),
  upstreamCostMinor: money,
  userPriceMinor: money,
  years: z.number().int().min(1).max(10),
})

function relationId(value: number | string | { id: number | string }): number | string {
  return typeof value === 'object' ? value.id : value
}

async function transaction<T>(req: PayloadRequest, work: () => Promise<T>): Promise<T> {
  const started = await initTransaction(req)
  try {
    const result = await work()
    if (started) await commitTransaction(req)
    return result
  } catch (error) {
    if (started) await killTransaction(req)
    throw error
  }
}

async function database(req: PayloadRequest) {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as
    | {
        execute(
          statement: ReturnType<typeof sql>,
        ): Promise<{ rows?: Array<{ id: number | string }> }>
      }
    | undefined
  if (!current) {
    throw new AppError('FULFILLMENT_CLAIM_UNAVAILABLE', '无法原子认领履约任务', 503)
  }
  return current
}

export async function enqueueCommerceFulfillment(
  req: PayloadRequest,
  input: { orderId: number | string; traceId: string },
): Promise<{ idempotentReplay: boolean; jobId?: number | string }> {
  return transaction(req, async () => {
    const claimed = await (
      await database(req)
    ).execute(sql`
      UPDATE orders
      SET fulfillment_job_queued_at = NOW(), updated_at = NOW()
      WHERE id = ${input.orderId}
        AND status = 'paid'
        AND fulfillment_job_queued_at IS NULL
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) {
      const order = await req.payload.findByID({
        collection: 'orders',
        depth: 0,
        id: input.orderId,
        overrideAccess: true,
        req,
      })
      if ((order as { fulfillmentJobQueuedAt?: string }).fulfillmentJobQueuedAt) {
        return { idempotentReplay: true }
      }
      throw new AppError('ORDER_NOT_READY_FOR_FULFILLMENT', '订单尚未完成支付确认', 409)
    }
    const operationKey = `commerce-fulfillment:${input.orderId}`
    const job = await req.payload.jobs.queue({
      input: { operationKey, orderId: Number(input.orderId), traceId: input.traceId },
      overrideAccess: true,
      queue: 'commerce',
      req,
      workflow: 'commerceFulfillment',
    })
    return { idempotentReplay: false, jobId: job.id }
  })
}

async function ensureManualReview(
  req: PayloadRequest,
  order: OrderRecord,
  reasonCode: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  if (order.status !== 'manual_review') {
    await transitionOrder(req, order.id, 'manual_review', {
      actorType: 'system',
      evidence,
      reasonCode,
    })
  }
  const existing = await req.payload.find({
    collection: 'manualReviews',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { and: [{ order: { equals: order.id } }, { status: { equals: 'open' } }] },
  })
  if (!existing.totalDocs) {
    await req.payload.create({
      collection: 'manualReviews',
      data: { evidence, order: order.id as never, reasonCode, status: 'open' },
      overrideAccess: true,
      req,
    })
  }
}

async function preflight(
  req: PayloadRequest,
  order: OrderRecord,
  provider: FulfillmentPreflightProvider,
  traceId: string,
) {
  const parsed = quoteSnapshotSchema.safeParse(order.quoteSnapshot)
  const customerId = relationId(order.customer)
  const expectedUpstreamCost = parsed.success
    ? parsed.data.operation === 'renewal'
      ? parsed.data.calculation.upstreamRenewalPriceFen * parsed.data.years
      : parsed.data.calculation.upstreamRegistrationPriceFen +
        parsed.data.calculation.upstreamRenewalPriceFen * (parsed.data.years - 1)
    : undefined
  const expectedUserPrice = parsed.success
    ? parsed.data.operation === 'renewal'
      ? parsed.data.calculation.renewalPriceFen * parsed.data.years
      : parsed.data.calculation.registrationPriceFen +
        parsed.data.calculation.renewalPriceFen * (parsed.data.years - 1)
    : undefined
  if (
    !parsed.success ||
    parsed.data.operation !== 'registration' ||
    (order.operation ?? 'registration') !== 'registration' ||
    parsed.data.currency !== order.currency ||
    parsed.data.domainAscii !== order.domainAscii ||
    parsed.data.customerId !== String(customerId) ||
    String(parsed.data.quoteId) !== String(relationId(order.quote)) ||
    parsed.data.tld !== order.domainAscii.split('.').at(-1) ||
    parsed.data.upstreamCostMinor !== expectedUpstreamCost ||
    parsed.data.userPriceMinor !== expectedUserPrice ||
    parsed.data.userPriceMinor !== order.amountMinor ||
    !Number.isSafeInteger(expectedUpstreamCost) ||
    !Number.isSafeInteger(expectedUserPrice)
  ) {
    await ensureManualReview(req, order, 'registration.quote_snapshot_invalid', {
      quoteSnapshotComplete: parsed.success,
      traceId,
    })
    return { state: 'manual_review' as const }
  }

  const templateId = relationId(order.realnameTemplate)
  const template = (await req.payload.findByID({
    collection: 'realnameTemplates',
    depth: 0,
    id: templateId,
    overrideAccess: true,
    req,
  })) as unknown as TemplateRecord
  if (
    String(relationId(template.customer)) !== String(customerId) ||
    template.status !== 'approved' ||
    template.providerReviewState !== 'approved' ||
    !template.providerTemplateId ||
    !/^\d+$/u.test(template.providerTemplateId) ||
    !template.providerConfirmedAt ||
    !Number.isFinite(Date.parse(template.providerConfirmedAt))
  ) {
    await ensureManualReview(req, order, 'registration.realname_template_invalid', {
      templateId: String(templateId),
      traceId,
    })
    return { state: 'manual_review' as const }
  }

  const availability = await provider
    .queryAvailability({ domain: order.domainAscii, traceId })
    .catch(() => undefined)
  if (!availability?.ok || availability.data.domainAscii !== order.domainAscii) {
    await ensureManualReview(req, order, 'registration.domain_status_unknown', {
      providerRequestId: availability?.requestId,
      traceId,
    })
    return { state: 'manual_review' as const }
  }
  if (!availability.data.available || availability.data.premium) {
    await requestAutomaticRegistrationFailureRefund(req, {
      evidence: {
        available: availability.data.available,
        premium: availability.data.premium,
        providerRequestId: availability.requestId,
      },
      note: '支付后复核确认域名已不可按冻结订单提供注册服务，自动原路全额退款。',
      orderId: order.id,
      traceId,
    })
    const refundedOrder = await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: order.id,
      overrideAccess: true,
      req,
    })
    return { state: refundedOrder.status as 'refund_pending' | 'refunded' }
  }

  const balance = await provider.queryBalance({ traceId }).catch(() => undefined)
  if (
    !balance?.ok ||
    !Number.isSafeInteger(balance.data.availableMinor) ||
    !Number.isSafeInteger(balance.data.frozenMinor) ||
    balance.data.availableMinor < 0 ||
    balance.data.frozenMinor < 0 ||
    balance.data.availableMinor < parsed.data.upstreamCostMinor
  ) {
    await ensureManualReview(req, order, 'registration.balance_insufficient_or_unknown', {
      providerRequestId: balance?.requestId,
      requiredMinor: parsed.data.upstreamCostMinor,
      traceId,
    })
    return { state: 'manual_review' as const }
  }

  return {
    providerTemplateId: template.providerTemplateId,
    snapshot: parsed.data,
    state: 'ready' as const,
  }
}

async function createConfirmedAsset(
  req: PayloadRequest,
  order: OrderRecord,
  templateId: number | string,
  asset: {
    domainAscii: string
    expiresAt: string
    nameservers: string[]
    registeredAt: string
    registrarCode: string
  },
  evidence: Record<string, unknown>,
): Promise<boolean> {
  return transaction(req, async () => {
    const existing = await req.payload.find({
      collection: 'domainAssets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { domainAscii: { equals: order.domainAscii } },
    })
    const existingAsset = existing.docs[0]
    if (
      existingAsset &&
      (String(relationId(existingAsset.customer)) !== String(relationId(order.customer)) ||
        String(relationId(existingAsset.realnameTemplate)) !== String(templateId))
    ) {
      return false
    }
    if (!existingAsset) {
      await req.payload.create({
        collection: 'domainAssets',
        data: {
          customer: relationId(order.customer) as never,
          domainAscii: asset.domainAscii,
          expiresAt: asset.expiresAt,
          lastSyncedAt: new Date().toISOString(),
          nameservers: asset.nameservers,
          realnameTemplate: templateId as never,
          registeredAt: asset.registeredAt,
          registrar: asset.registrarCode,
          status: 'active',
          syncReviewStatus: 'none',
          syncVersion: 0,
          upstreamOwnershipStatus: 'unknown',
        },
        overrideAccess: true,
        req,
      })
    }
    const current = (await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: order.id,
      overrideAccess: true,
      req,
    })) as unknown as OrderRecord
    await captureBalancePaymentForFulfillment(req, order.id)
    if (current.status === 'succeeded') return true
    await transitionOrder(req, order.id, 'succeeded', {
      actorType: 'provider',
      evidence,
      ...(current.status === 'manual_review'
        ? { note: '只读查询确认注册成功并完成域名资产对账。' }
        : {}),
      reasonCode: 'registration.provider_confirmed_success',
    })
    return true
  })
}

async function renewalPreflight(
  req: PayloadRequest,
  order: OrderRecord,
  provider: FulfillmentPreflightProvider,
  traceId: string,
) {
  const parsed = quoteSnapshotSchema.safeParse(order.quoteSnapshot)
  const customerId = relationId(order.customer)
  const assetId = order.domainAsset ? relationId(order.domainAsset) : undefined
  const expectedUpstreamCost = parsed.success
    ? parsed.data.calculation.upstreamRenewalPriceFen * parsed.data.years
    : undefined
  const expectedUserPrice = parsed.success
    ? parsed.data.calculation.renewalPriceFen * parsed.data.years
    : undefined
  if (
    !parsed.success ||
    parsed.data.operation !== 'renewal' ||
    order.operation !== 'renewal' ||
    assetId === undefined ||
    String(parsed.data.domainAssetId) !== String(assetId) ||
    !parsed.data.assetExpiresAt ||
    parsed.data.currency !== order.currency ||
    parsed.data.domainAscii !== order.domainAscii ||
    parsed.data.customerId !== String(customerId) ||
    String(parsed.data.quoteId) !== String(relationId(order.quote)) ||
    parsed.data.tld !== order.domainAscii.split('.').at(-1) ||
    parsed.data.upstreamCostMinor !== expectedUpstreamCost ||
    parsed.data.userPriceMinor !== expectedUserPrice ||
    parsed.data.userPriceMinor !== order.amountMinor ||
    !Number.isSafeInteger(expectedUpstreamCost) ||
    !Number.isSafeInteger(expectedUserPrice)
  ) {
    await ensureManualReview(req, order, 'renewal.quote_snapshot_invalid', {
      quoteSnapshotComplete: parsed.success,
      traceId,
    })
    return { state: 'manual_review' as const }
  }

  const asset = (await req.payload.findByID({
    collection: 'domainAssets',
    depth: 0,
    id: assetId,
    overrideAccess: true,
    req,
  })) as unknown as AssetRecord
  if (
    String(relationId(asset.customer)) !== String(customerId) ||
    String(relationId(asset.realnameTemplate)) !== String(relationId(order.realnameTemplate)) ||
    asset.domainAscii !== order.domainAscii ||
    asset.status !== 'active' ||
    asset.expiresAt !== parsed.data.assetExpiresAt
  ) {
    await ensureManualReview(req, order, 'renewal.asset_changed_or_forbidden', {
      assetId: String(assetId),
      traceId,
    })
    return { state: 'manual_review' as const }
  }

  const balance = await provider.queryBalance({ traceId }).catch(() => undefined)
  if (
    !balance?.ok ||
    !Number.isSafeInteger(balance.data.availableMinor) ||
    balance.data.availableMinor < parsed.data.upstreamCostMinor
  ) {
    await ensureManualReview(req, order, 'renewal.balance_insufficient_or_unknown', {
      providerRequestId: balance?.requestId,
      requiredMinor: parsed.data.upstreamCostMinor,
      traceId,
    })
    return { state: 'manual_review' as const }
  }

  return { asset, snapshot: parsed.data, state: 'ready' as const }
}

async function findRenewal(req: PayloadRequest, orderId: number | string) {
  const found = await req.payload.find({
    collection: 'renewals',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { order: { equals: orderId } },
  })
  return found.docs[0] as unknown as RenewalRecord | undefined
}

async function ensureRenewal(
  req: PayloadRequest,
  order: OrderRecord,
  asset: AssetRecord,
  years: number,
): Promise<RenewalRecord> {
  const existing = await findRenewal(req, order.id)
  if (existing) return existing
  try {
    return (await req.payload.create({
      collection: 'renewals',
      data: {
        asset: asset.id as never,
        customer: relationId(order.customer) as never,
        order: order.id as never,
        previousExpiresAt: asset.expiresAt,
        status: 'pending',
        years,
      },
      overrideAccess: true,
      req,
    })) as unknown as RenewalRecord
  } catch (error) {
    const raced = await findRenewal(req, order.id)
    if (raced) return raced
    throw error
  }
}

async function markRenewalStatus(
  req: PayloadRequest,
  renewalId: number | string,
  status: 'failed' | 'manual_review',
  providerOperationKey: string,
): Promise<void> {
  await req.payload.update({
    collection: 'renewals',
    data: { providerOperationKey, status },
    id: renewalId,
    overrideAccess: true,
    req,
  })
}

async function commitConfirmedRenewal(
  req: PayloadRequest,
  input: {
    asset: AssetRecord
    confirmedExpiresAt: string
    operationKey: string
    order: OrderRecord
    renewal: RenewalRecord
  },
): Promise<boolean> {
  return transaction(req, async () => {
    const db = await database(req)
    const claimed = await db.execute(sql`
      UPDATE renewals
      SET
        confirmed_expires_at = ${input.confirmedExpiresAt}::timestamptz,
        provider_operation_key = ${input.operationKey},
        status = 'succeeded',
        updated_at = NOW()
      WHERE id = ${input.renewal.id}
        AND status IN ('pending', 'manual_review')
        AND previous_expires_at = ${input.renewal.previousExpiresAt}::timestamptz
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) {
      const currentRenewal = await findRenewal(req, input.order.id)
      const currentAsset = (await req.payload.findByID({
        collection: 'domainAssets',
        depth: 0,
        id: input.asset.id,
        overrideAccess: true,
        req,
      })) as unknown as AssetRecord
      return (
        currentRenewal?.status === 'succeeded' &&
        currentRenewal.confirmedExpiresAt === input.confirmedExpiresAt &&
        currentAsset.expiresAt === input.confirmedExpiresAt
      )
    }

    const assetUpdated = await db.execute(sql`
      UPDATE domain_assets
      SET
        expires_at = ${input.confirmedExpiresAt}::timestamptz,
        last_synced_at = NOW(),
        status = 'active',
        updated_at = NOW()
      WHERE id = ${input.asset.id}
        AND customer_id = ${relationId(input.order.customer)}
        AND expires_at = ${input.renewal.previousExpiresAt}::timestamptz
      RETURNING id
    `)
    if (assetUpdated.rows?.[0]?.id === undefined) {
      throw new AppError('RENEWAL_ASSET_CAS_CONFLICT', '域名到期时间已变化，需要人工核对', 409)
    }
    await recordAuditEvent(req, {
      action: 'commerce.renewal.recorded',
      actor: { type: 'system' },
      metadata: {
        confirmedExpiresAt: input.confirmedExpiresAt,
        operationKey: input.operationKey,
        previousExpiresAt: input.renewal.previousExpiresAt,
        years: quoteSnapshotSchema.parse(input.order.quoteSnapshot).years,
      },
      targetId: input.renewal.id,
    })
    const currentOrder = (await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: input.order.id,
      overrideAccess: true,
      req,
    })) as unknown as OrderRecord
    await captureBalancePaymentForFulfillment(req, input.order.id)
    if (currentOrder.status !== 'succeeded') {
      await transitionOrder(req, input.order.id, 'succeeded', {
        actorType: 'provider',
        evidence: {
          confirmedExpiresAt: input.confirmedExpiresAt,
          operationKey: input.operationKey,
        },
        ...(currentOrder.status === 'manual_review'
          ? { note: '只读查询确认续费成功并原子更新域名资产到期时间。' }
          : {}),
        reasonCode: 'renewal.provider_confirmed_success',
      })
    }
    return true
  })
}

async function runRenewalFulfillment(
  req: PayloadRequest,
  order: OrderRecord,
  input: FulfillmentInput,
  dependencies: FulfillmentDependencies,
) {
  const abandonAutomaticRenewal = async (error: unknown) => {
    await recordAutomaticRenewalOrderSkip(req, order, error, `${input.traceId}:automatic-mandate`)
    await requestAutomaticRegistrationFailureRefund(req, {
      evidence: {
        mandateId: String(relationId(order.automaticRenewalMandate!)),
        reasonCode:
          error instanceof AppError ? error.code : 'AUTOMATIC_RENEWAL_REVALIDATION_FAILED',
      },
      note: '自动续费任务执行前授权或域名状态已失效，未提交上游并释放全部余额冻结。',
      orderId: order.id,
      traceId: input.traceId,
    })
    const refundedOrder = await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: order.id,
      overrideAccess: true,
      req,
    })
    return { idempotentReplay: false, status: refundedOrder.status as 'refunded' }
  }
  if (order.status === 'paid' && order.automaticRenewalMandate) {
    try {
      await transaction(req, () =>
        revalidateAutomaticRenewalOrder(req, order, {
          traceId: `${input.traceId}:automatic-mandate:initial`,
          writeProvider: dependencies.write,
        }),
      )
    } catch (error) {
      return abandonAutomaticRenewal(error)
    }
  }
  const checked = await renewalPreflight(req, order, dependencies.preflight, input.traceId)
  if (checked.state !== 'ready') return { idempotentReplay: false, status: checked.state }
  if (order.status === 'paid') {
    try {
      await transaction(req, async () => {
        await revalidateAutomaticRenewalOrder(req, order, {
          traceId: `${input.traceId}:automatic-mandate`,
          writeProvider: dependencies.write,
        })
        await transitionOrder(req, order.id, 'fulfilling', {
          actorType: 'system',
          evidence: {
            assetOwnership: true,
            automaticRenewalMandateRevalidated: Boolean(order.automaticRenewalMandate),
            balanceChecked: true,
            frozenRenewalQuote: true,
          },
          reasonCode: 'renewal.preflight_passed',
        })
      })
    } catch (error) {
      if (!order.automaticRenewalMandate) throw error
      return abandonAutomaticRenewal(error)
    }
    order = { ...order, status: 'fulfilling' }
  }
  const renewal = await ensureRenewal(req, order, checked.asset, checked.snapshot.years)
  const writeInput: WestDigitalWriteOperationInput = {
    actor: { type: 'system' },
    clientPriceFen: checked.snapshot.upstreamCostMinor,
    currentExpiresOn: renewal.previousExpiresAt.slice(0, 10),
    domainAscii: order.domainAscii,
    operation: 'renew',
    orderId: order.id,
    premium: false,
    targetId: order.id,
    traceId: input.traceId,
    years: checked.snapshot.years,
  }
  const operationKey = generateWestDigitalOperationKey(writeInput)
  const operation = await executeWestDigitalWriteOperation(req, writeInput, dependencies.write)
  const operationData = 'data' in operation ? operation.data : undefined
  if (operation.state === 'error') {
    await markRenewalStatus(req, renewal.id, 'failed', operationKey)
    await requestAutomaticRegistrationFailureRefund(req, {
      evidence: { operationKey, providerRequestId: operationData?.providerRequestId },
      note: '西部数码明确确认续费失败且未提供续费服务，自动原路全额退款。',
      orderId: order.id,
      traceId: input.traceId,
    })
    const refundedOrder = await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: order.id,
      overrideAccess: true,
      req,
    })
    return {
      idempotentReplay: operationData?.idempotentReplay ?? false,
      status: refundedOrder.status as 'refund_pending' | 'refunded',
    }
  }
  if (operation.state !== 'ready' || !operationData || operationData.status !== 'succeeded') {
    await markRenewalStatus(req, renewal.id, 'manual_review', operationKey)
    await ensureManualReview(req, order, 'renewal.provider_status_unknown', {
      operationKey,
      providerRequestId: operationData?.providerRequestId,
      traceId: input.traceId,
    })
    return {
      idempotentReplay: operationData?.idempotentReplay ?? false,
      status: 'manual_review' as const,
    }
  }
  const confirmed = await queryWestDigitalAsset(
    req,
    {
      actor: { type: 'system' },
      domainAscii: order.domainAscii,
      targetId: checked.asset.id,
      traceId: input.traceId,
    },
    dependencies.write,
  )
  if (
    confirmed.state !== 'ready' ||
    confirmed.data.domainAscii !== order.domainAscii ||
    Date.parse(confirmed.data.expiresAt) <= Date.parse(renewal.previousExpiresAt)
  ) {
    await markRenewalStatus(req, renewal.id, 'manual_review', operationKey)
    await ensureManualReview(req, order, 'renewal.asset_confirmation_unknown', {
      operationKey,
      traceId: input.traceId,
    })
    return { idempotentReplay: operationData.idempotentReplay, status: 'manual_review' as const }
  }
  const committed = await commitConfirmedRenewal(req, {
    asset: checked.asset,
    confirmedExpiresAt: confirmed.data.expiresAt,
    operationKey,
    order,
    renewal,
  })
  if (!committed) {
    await ensureManualReview(req, order, 'renewal.persistence_conflict', {
      operationKey,
      traceId: input.traceId,
    })
    return { idempotentReplay: true, status: 'manual_review' as const }
  }
  return { idempotentReplay: operationData.idempotentReplay, status: 'succeeded' as const }
}

export async function runCommerceFulfillment(
  req: PayloadRequest,
  input: FulfillmentInput,
  dependencies: FulfillmentDependencies,
) {
  let order = (await req.payload.findByID({
    collection: 'orders',
    depth: 0,
    id: input.orderId,
    overrideAccess: true,
    req,
  })) as unknown as OrderRecord
  if (order.status === 'succeeded') return { idempotentReplay: true, status: 'succeeded' as const }
  if (!['paid', 'fulfilling', 'manual_review'].includes(order.status)) {
    throw new AppError('ORDER_NOT_FULFILLABLE', '订单当前状态不能履约', 409)
  }

  if (order.status === 'paid') {
    if (input.salesStopReviewId !== undefined) {
      await assertSalesStopResumeAuthorized(req, order.id, input.salesStopReviewId)
    } else {
      const tld = order.domainAscii.split('.').at(-1) ?? ''
      const salesStop = await getTldSalesStopState(req, tld)
      if (salesStop.stopped) {
        await holdPaidOrderForSalesStop(req, order)
        return { idempotentReplay: true, status: 'paid' as const }
      }
    }
  }

  if (order.operation === 'renewal') {
    return runRenewalFulfillment(req, order, input, dependencies)
  }

  let snapshot: z.infer<typeof quoteSnapshotSchema>
  let providerTemplateId: string
  if (order.status === 'paid') {
    const checked = await preflight(req, order, dependencies.preflight, input.traceId)
    if (checked.state !== 'ready') return { idempotentReplay: false, status: checked.state }
    snapshot = checked.snapshot
    providerTemplateId = checked.providerTemplateId
    await transitionOrder(req, order.id, 'fulfilling', {
      actorType: 'system',
      evidence: {
        balanceChecked: true,
        domainAvailable: true,
        quoteSnapshotIntegrity: true,
        realnameTemplateApproved: true,
      },
      reasonCode: 'registration.preflight_passed',
    })
    order = { ...order, status: 'fulfilling' }
  } else {
    const parsed = quoteSnapshotSchema.safeParse(order.quoteSnapshot)
    const template = (await req.payload.findByID({
      collection: 'realnameTemplates',
      depth: 0,
      id: relationId(order.realnameTemplate),
      overrideAccess: true,
      req,
    })) as unknown as TemplateRecord
    if (!parsed.success || !template.providerTemplateId) {
      await ensureManualReview(req, order, 'registration.resume_evidence_invalid', {
        traceId: input.traceId,
      })
      return { idempotentReplay: true, status: 'manual_review' as const }
    }
    snapshot = parsed.data
    providerTemplateId = template.providerTemplateId
  }

  const writeInput: WestDigitalWriteOperationInput = {
    actor: { type: 'system' },
    clientPriceFen: snapshot.upstreamCostMinor,
    domainAscii: order.domainAscii,
    nameservers: ['ns1.myhostadmin.net', 'ns2.myhostadmin.net'],
    operation: 'register',
    orderId: order.id,
    premium: false,
    providerTemplateId,
    targetId: order.id,
    traceId: input.traceId,
    years: snapshot.years,
  }
  const writeOperationKey = generateWestDigitalOperationKey(writeInput)
  const operation = await executeWestDigitalWriteOperation(req, writeInput, dependencies.write)
  const operationData = 'data' in operation ? operation.data : undefined

  if (operation.state === 'error') {
    await requestAutomaticRegistrationFailureRefund(req, {
      evidence: {
        operationKey: writeOperationKey,
        providerRequestId: operationData?.providerRequestId,
      },
      note: '西部数码明确确认注册失败且未提供域名服务，自动原路全额退款。',
      orderId: order.id,
      traceId: input.traceId,
    })
    const refundedOrder = await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: order.id,
      overrideAccess: true,
      req,
    })
    return {
      idempotentReplay: operationData?.idempotentReplay ?? false,
      status: refundedOrder.status as 'refund_pending' | 'refunded',
    }
  }
  if (operation.state !== 'ready' || !operationData || operationData.status !== 'succeeded') {
    await ensureManualReview(req, order, 'registration.provider_status_unknown', {
      operationKey: writeOperationKey,
      providerRequestId: operationData?.providerRequestId,
      traceId: input.traceId,
    })
    return {
      idempotentReplay: operationData?.idempotentReplay ?? false,
      status: 'manual_review' as const,
    }
  }

  const confirmed = await queryWestDigitalAsset(
    req,
    {
      actor: { type: 'system' },
      domainAscii: order.domainAscii,
      targetId: order.id,
      traceId: input.traceId,
    },
    dependencies.write,
  )
  if (confirmed.state !== 'ready' || confirmed.data.domainAscii !== order.domainAscii) {
    await ensureManualReview(req, order, 'registration.asset_confirmation_unknown', {
      operationKey: writeOperationKey,
      traceId: input.traceId,
    })
    return { idempotentReplay: operationData.idempotentReplay, status: 'manual_review' as const }
  }
  const assetRecorded = await createConfirmedAsset(
    req,
    order,
    relationId(order.realnameTemplate),
    confirmed.data,
    {
      operationKey: writeOperationKey,
      providerAssetId: confirmed.data.providerAssetId,
      providerRequestId: operationData.providerRequestId,
    },
  )
  if (!assetRecorded) {
    await ensureManualReview(req, order, 'registration.asset_ownership_conflict', {
      operationKey: writeOperationKey,
      providerAssetId: confirmed.data.providerAssetId,
      traceId: input.traceId,
    })
    return { idempotentReplay: operationData.idempotentReplay, status: 'manual_review' as const }
  }
  return { idempotentReplay: operationData.idempotentReplay, status: 'succeeded' as const }
}

function runtimeDependencies(): FulfillmentDependencies {
  return {
    preflight: {
      queryAvailability: async ({ domain, traceId }) => ({
        data: { available: true, currency: 'CNY', domainAscii: domain, premium: false },
        observedAt: new Date().toISOString(),
        ok: true,
        requestId: `${traceId}-availability-fixture`,
      }),
      queryBalance: async ({ traceId }) => ({
        data: { availableMinor: Number.MAX_SAFE_INTEGER, frozenMinor: 0 },
        observedAt: new Date().toISOString(),
        ok: true,
        requestId: `${traceId}-balance-fixture`,
      }),
    },
    write: createConfiguredWestDigitalWriteAdapter(),
  }
}

export async function runConfiguredCommerceFulfillment(
  req: PayloadRequest,
  input: FulfillmentInput,
) {
  return runCommerceFulfillment(req, input, runtimeDependencies())
}
