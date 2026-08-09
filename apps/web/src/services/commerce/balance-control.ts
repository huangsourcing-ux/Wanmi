import { sql } from '@payloadcms/db-postgres'
import {
  commitTransaction,
  initTransaction,
  killTransaction,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type PayloadRequest,
} from 'payload'

import { hasRole, isActiveAdminUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import { getTraceId } from '@/lib/request-id'
import type { WestDigitalBalanceProvider } from '@/providers/types'
import {
  balanceControlSettingSchema,
  balanceControlUpdateSchema,
  salesStopResolutionSchema,
  type BalanceControlSetting,
} from '@/schemas/balance-control'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

import { recordWestdigitalBalanceObservation } from './reconciliation'
import { requestAutomaticRegistrationFailureRefund } from './refunds'

export const WESTDIGITAL_BALANCE_CONTROL_KEY = 'commerce.westdigital.balance-control'
const SALES_STOP_REVIEW_REASON = 'registration.sales_stopped'

function isBalanceControlOperation(context: Record<string, unknown>): boolean {
  return context.balanceControlOperation === true
}

export const guardBalanceControlSettingChange: CollectionBeforeChangeHook = ({
  context,
  data,
  originalDoc,
}) => {
  const key = data.key ?? originalDoc?.key
  if (key === WESTDIGITAL_BALANCE_CONTROL_KEY && !isBalanceControlOperation(context)) {
    throw new AppError(
      'BALANCE_CONTROL_SERVICE_REQUIRED',
      '余额与停售配置只能通过受审计的系统管理员接口修改',
      403,
    )
  }
  return data
}

export const guardBalanceControlSettingDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
  if (isBalanceControlOperation(req.context)) return
  const setting = await req.payload.findByID({
    collection: 'siteSettings',
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })
  if (setting.key === WESTDIGITAL_BALANCE_CONTROL_KEY) {
    throw new AppError(
      'BALANCE_CONTROL_SERVICE_REQUIRED',
      '余额与停售配置不得通过通用 Collection 删除',
      403,
    )
  }
}

type BalanceControlDocument = {
  id: number | string
  value: unknown
}

type PaidOrder = {
  customer: number | string | { id: number | string }
  domainAscii: string
  id: number | string
  status: string
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
    throw new AppError('BALANCE_CONTROL_CAS_UNAVAILABLE', '无法原子更新余额停售配置', 503)
  }
  return current
}

function assertSystemAdmin(req: PayloadRequest) {
  if (!isActiveAdminUser(req.user) || !hasRole(req.user, ['system_admin'])) {
    throw new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', '仅系统管理员可修改余额与停售配置', 403)
  }
  return req.user
}

async function loadDocument(req: PayloadRequest): Promise<BalanceControlDocument | undefined> {
  const found = await req.payload.find({
    collection: 'siteSettings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { key: { equals: WESTDIGITAL_BALANCE_CONTROL_KEY } },
  })
  return found.docs[0] as BalanceControlDocument | undefined
}

export async function loadBalanceControl(
  req: PayloadRequest,
): Promise<{ id: number | string; value: BalanceControlSetting } | undefined> {
  const document = await loadDocument(req)
  if (!document) return undefined
  const parsed = balanceControlSettingSchema.safeParse(document.value)
  if (!parsed.success) {
    throw new AppError('BALANCE_CONTROL_INVALID', '余额停售配置无效，已安全关闭下单', 503)
  }
  return { id: document.id, value: parsed.data }
}

async function compareAndSwap(
  req: PayloadRequest,
  id: number | string,
  previous: BalanceControlSetting,
  next: BalanceControlSetting,
): Promise<boolean> {
  const result = await (await database(req)).execute(sql`
    UPDATE site_settings
    SET value = CAST(${JSON.stringify(next)} AS jsonb), updated_at = NOW()
    WHERE id = ${id}
      AND value = CAST(${JSON.stringify(previous)} AS jsonb)
    RETURNING id
  `)
  return result.rows?.[0]?.id !== undefined
}

async function updateWithCas(
  req: PayloadRequest,
  update: (value: BalanceControlSetting) => BalanceControlSetting,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await loadBalanceControl(req)
    if (!current) throw new AppError('BALANCE_CONTROL_NOT_CONFIGURED', '余额停售配置尚未建立', 409)
    const next = balanceControlSettingSchema.parse(update(current.value))
    if (JSON.stringify(next) === JSON.stringify(current.value)) {
      return { changed: false, current, next }
    }
    if (await compareAndSwap(req, current.id, current.value, next)) {
      return { changed: true, current, next }
    }
  }
  throw new AppError('BALANCE_CONTROL_CONFLICT', '余额停售配置发生并发变化，请重试', 409)
}

function changedAt(): string {
  return new Date().toISOString()
}

export async function updateBalanceControl(req: PayloadRequest, rawInput: unknown) {
  const actor = assertSystemAdmin(req)
  const input = balanceControlUpdateSchema.parse(rawInput)
  return transaction(req, async () => {
    if (input.action === 'configure') {
      const existing = await loadBalanceControl(req)
      if (!existing) {
        const value = balanceControlSettingSchema.parse({
          affectedTlds: input.affectedTlds,
          automaticStoppedTlds: [],
          manualStoppedTlds: [],
          schemaVersion: 1,
          thresholdMinor: input.thresholdMinor,
          updatedAt: changedAt(),
        })
        const created = await req.payload.create({
          collection: 'siteSettings',
          context: { balanceControlOperation: true },
          data: {
            description: '西部数码预充值余额阈值与按 TLD 独立停售状态',
            key: WESTDIGITAL_BALANCE_CONTROL_KEY,
            value,
          },
          overrideAccess: true,
          req,
        })
        await recordAuditEvent(req, {
          action: 'commerce.balance_control.updated',
          actor: { id: actor.id, type: 'admin' },
          metadata: { after: value, before: null, changedAt: value.updatedAt },
          targetId: created.id,
        })
        return { changed: true, id: created.id, value }
      }
      const result = await updateWithCas(req, (current) => {
        const automaticStoppedTlds = current.automaticStoppedTlds.filter((tld) =>
          input.affectedTlds.includes(tld),
        )
        const manualStoppedTlds = current.manualStoppedTlds.filter((tld) =>
          input.affectedTlds.includes(tld),
        )
        if (
          current.thresholdMinor === input.thresholdMinor &&
          JSON.stringify(current.affectedTlds) === JSON.stringify(input.affectedTlds) &&
          JSON.stringify(current.automaticStoppedTlds) === JSON.stringify(automaticStoppedTlds) &&
          JSON.stringify(current.manualStoppedTlds) === JSON.stringify(manualStoppedTlds)
        ) {
          return current
        }
        return {
          ...current,
          affectedTlds: input.affectedTlds,
          automaticStoppedTlds,
          manualStoppedTlds,
          thresholdMinor: input.thresholdMinor,
          updatedAt: changedAt(),
        }
      })
      if (result.changed) {
        await recordAuditEvent(req, {
          action: 'commerce.balance_control.updated',
          actor: { id: actor.id, type: 'admin' },
          metadata: { after: result.next, before: result.current.value, changedAt: result.next.updatedAt },
          targetId: result.current.id,
        })
      }
      return { changed: result.changed, id: result.current.id, value: result.next }
    }

    const result = await updateWithCas(req, (current) => {
      if (!current.affectedTlds.includes(input.tld)) {
        throw new AppError('TLD_NOT_BALANCE_CONTROLLED', '该 TLD 不在余额停售配置中', 409)
      }
      const field = input.source === 'manual' ? 'manualStoppedTlds' : 'automaticStoppedTlds'
      const values = new Set(current[field])
      if (values.has(input.tld) === input.stopped) return current
      if (input.stopped) values.add(input.tld)
      else values.delete(input.tld)
      return { ...current, [field]: [...values].sort(), updatedAt: changedAt() }
    })
    if (result.changed) {
      await recordAuditEvent(req, {
        action: 'commerce.sales_stop.changed',
        actor: { id: actor.id, type: 'admin' },
        metadata: {
          after: result.next,
          before: result.current.value,
          changedAt: result.next.updatedAt,
          source: input.source,
          stopped: input.stopped,
          tld: input.tld,
        },
        targetId: result.current.id,
      })
    }
    return { changed: result.changed, id: result.current.id, value: result.next }
  })
}

export async function getTldSalesStopState(req: PayloadRequest, tld: string) {
  const control = await loadBalanceControl(req)
  if (!control || !control.value.affectedTlds.includes(tld)) {
    return { automatic: false, manual: false, stopped: false }
  }
  const automatic = control.value.automaticStoppedTlds.includes(tld)
  const manual = control.value.manualStoppedTlds.includes(tld)
  return { automatic, manual, stopped: automatic || manual }
}

export async function assertTldSalesOpen(req: PayloadRequest, tld: string): Promise<void> {
  const state = await getTldSalesStopState(req, tld)
  if (state.stopped) {
    throw new AppError('TLD_SALES_STOPPED', '该域名后缀当前暂停新下单，请稍后重试', 409, {
      action: '请稍后重新获取报价',
      retryable: true,
      title: '当前暂停购买',
    })
  }
}

async function claimAutomaticSalesStop(req: PayloadRequest, traceId: string) {
  const result = await updateWithCas(req, (current) => {
    const stopped = new Set(current.automaticStoppedTlds)
    if (current.affectedTlds.every((tld) => stopped.has(tld))) return current
    current.affectedTlds.forEach((tld) => stopped.add(tld))
    return { ...current, automaticStoppedTlds: [...stopped].sort(), updatedAt: changedAt() }
  })
  if (!result.changed) return { changed: false, control: result.next, id: result.current.id }
  await recordAuditEvent(req, {
    action: 'commerce.sales_stop.changed',
    actor: { type: 'system' },
    metadata: {
      affectedTlds: result.next.affectedTlds,
      after: result.next,
      before: result.current.value,
      changedAt: result.next.updatedAt,
      source: 'automatic',
      stopped: true,
    },
    targetId: result.current.id,
  })
  await recordAuditEvent(req, {
    action: 'commerce.balance_low.alerted',
    actor: { type: 'system' },
    metadata: {
      affectedTldCount: result.next.affectedTlds.length,
      reasonCode: 'westdigital.balance_below_threshold',
    },
    targetId: result.current.id,
  })
  req.payload.logger.warn(
    {
      affectedTldCount: result.next.affectedTlds.length,
      reasonCode: 'westdigital.balance_below_threshold',
      traceId,
    },
    'WestDigital balance threshold crossed; affected TLD sales stopped',
  )
  return { changed: true, control: result.next, id: result.current.id }
}

export async function monitorWestDigitalBalance(
  req: PayloadRequest,
  input: { provider: WestDigitalBalanceProvider; traceId: string },
) {
  const balance = await input.provider.queryBalance({ traceId: input.traceId })
  if (!balance.ok) {
    req.payload.logger.warn(
      { reasonCode: 'westdigital.balance_query_unavailable', traceId: input.traceId },
      'WestDigital balance monitoring query failed',
    )
    return { automaticStopTriggered: false, observed: false }
  }
  return transaction(req, async () => {
    await recordWestdigitalBalanceObservation(req, {
      availableMinor: balance.data.availableMinor,
      frozenMinor: balance.data.frozenMinor,
      observedAt: balance.observedAt,
      providerRequestId: balance.requestId,
      traceId: input.traceId,
    })
    const control = await loadBalanceControl(req)
    if (!control || balance.data.availableMinor >= control.value.thresholdMinor) {
      return { automaticStopTriggered: false, observed: true }
    }
    const claimed = await claimAutomaticSalesStop(req, input.traceId)
    return { automaticStopTriggered: claimed.changed, observed: true }
  })
}

export async function holdPaidOrderForSalesStop(req: PayloadRequest, order: PaidOrder) {
  return transaction(req, async () => {
    await (await database(req)).execute(sql`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`)
    const current = (await req.payload.findByID({
      collection: 'orders',
      depth: 0,
      id: order.id,
      overrideAccess: true,
      req,
    })) as unknown as PaidOrder
    if (current.status !== 'paid') return { created: false, reviewId: undefined }
    const existing = await req.payload.find({
      collection: 'manualReviews',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: {
        and: [
          { order: { equals: order.id } },
          { reasonCode: { equals: SALES_STOP_REVIEW_REASON } },
          { status: { equals: 'open' } },
        ],
      },
    })
    if (existing.docs[0]) return { created: false, reviewId: existing.docs[0].id }
    const review = await req.payload.create({
      collection: 'manualReviews',
      data: {
        evidence: { domainTld: order.domainAscii.split('.').at(-1), salesStopActive: true },
        order: order.id as never,
        reasonCode: SALES_STOP_REVIEW_REASON,
        status: 'open',
      },
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(req, {
      action: 'commerce.sales_stop.paid_order_held',
      actor: { type: 'system' },
      metadata: { orderStatusUnchanged: true, reasonCode: SALES_STOP_REVIEW_REASON },
      targetId: order.id,
    })
    return { created: true, reviewId: review.id }
  })
}

export async function assertSalesStopResumeAuthorized(
  req: PayloadRequest,
  orderId: number | string,
  reviewId: number | string,
): Promise<void> {
  const review = await req.payload.findByID({
    collection: 'manualReviews',
    depth: 0,
    id: reviewId,
    overrideAccess: true,
    req,
  })
  const evidence = review.evidence as { resolution?: { decision?: string } } | undefined
  const reviewOrder = typeof review.order === 'object' ? review.order?.id : review.order
  if (
    String(reviewOrder) !== String(orderId) ||
    review.reasonCode !== SALES_STOP_REVIEW_REASON ||
    review.status !== 'resolved' ||
    evidence?.resolution?.decision !== 'resume' ||
    !review.resolvedBy ||
    !review.resolvedAt ||
    !review.resolutionNote
  ) {
    throw new AppError('SALES_STOP_RESUME_NOT_AUTHORIZED', '缺少有效的负责人恢复履约决定', 409)
  }
}

export async function resolvePaidOrderSalesStop(
  req: PayloadRequest,
  orderNumber: string,
  rawInput: unknown,
) {
  const actor = assertSystemAdmin(req)
  const input = salesStopResolutionSchema.parse(rawInput)
  return transaction(req, async () => {
    const found = await req.payload.find({
      collection: 'orders',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { orderNumber: { equals: orderNumber } },
    })
    const order = found.docs[0] as unknown as PaidOrder | undefined
    if (!order) throw new AppError('ORDER_NOT_FOUND', '未找到订单', 404)
    if (order.status !== 'paid') {
      throw new AppError('SALES_STOP_ORDER_NOT_PAID', '只有仍为已支付的停售订单可人工处理', 409)
    }
    const reviews = await req.payload.find({
      collection: 'manualReviews',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: {
        and: [
          { order: { equals: order.id } },
          { reasonCode: { equals: SALES_STOP_REVIEW_REASON } },
          { status: { equals: 'open' } },
        ],
      },
    })
    const review = reviews.docs[0]
    if (!review) throw new AppError('SALES_STOP_REVIEW_NOT_OPEN', '停售人工处理已被认领或不存在', 409)
    const resolvedAt = changedAt()
    const evidence = {
      ...((review.evidence as Record<string, unknown> | undefined) ?? {}),
      resolution: {
        decision: input.decision,
        evidence: input.evidence,
        selectedAt: resolvedAt,
        selectedBy: String(actor.id),
      },
    }
    const claimed = await (await database(req)).execute(sql`
      UPDATE manual_reviews
      SET status = 'resolved',
          evidence = CAST(${JSON.stringify(evidence)} AS jsonb),
          resolution_note = ${input.note},
          resolved_by_id = ${actor.id},
          resolved_at = ${resolvedAt},
          updated_at = NOW()
      WHERE id = ${review.id}
        AND order_id = ${order.id}
        AND reason_code = ${SALES_STOP_REVIEW_REASON}
        AND status = 'open'
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) {
      throw new AppError('SALES_STOP_REVIEW_CONFLICT', '停售人工处理已被其他执行者认领', 409)
    }

    if (input.decision === 'resume') {
      const operationKey = `commerce-fulfillment:${order.id}:sales-stop-review:${review.id}`
      const job = await req.payload.jobs.queue({
        input: {
          operationKey,
          orderId: Number(order.id),
          salesStopReviewId: Number(review.id),
          traceId: getTraceId(req.headers),
        },
        overrideAccess: true,
        queue: 'commerce',
        req,
        workflow: 'commerceFulfillment',
      })
      await recordAuditEvent(req, {
        action: 'commerce.sales_stop.resume_selected',
        actor: { id: actor.id, type: 'admin' },
        metadata: { evidence: input.evidence, note: input.note, reviewId: review.id },
        targetId: order.id,
      })
      return { decision: input.decision, jobId: job.id, reviewId: review.id }
    }

    const refund = await requestAutomaticRegistrationFailureRefund(req, {
      evidence: { manualDecision: input.evidence, salesStopReviewId: review.id },
      note: input.note,
      orderId: order.id,
      traceId: getTraceId(req.headers),
      transition: {
        actorId: String(actor.id),
        actorType: 'admin',
        reasonCode: 'registration.sales_stop_refund_selected',
      },
    })
    await recordAuditEvent(req, {
      action: 'commerce.sales_stop.refund_selected',
      actor: { id: actor.id, type: 'admin' },
      metadata: { evidence: input.evidence, note: input.note, refundId: refund.refundId, reviewId: review.id },
      targetId: order.id,
    })
    return { decision: input.decision, refundId: refund.refundId, reviewId: review.id }
  })
}
