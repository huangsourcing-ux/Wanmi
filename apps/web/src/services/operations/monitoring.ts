import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'
import { z } from 'zod'

import { hasRole, isActiveAdminUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import {
  DEFAULT_OPERATIONS_MONITORING_THRESHOLDS,
  operationsMonitoringThresholdsSchema,
  type OperationsMonitoringThresholds,
} from '@/schemas/operations-monitoring'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { commerceWorkerHeartbeatAgeMinutes } from '@/services/operations/worker-heartbeat'

export const OPERATIONS_MONITORING_THRESHOLDS_KEY = 'operations.monitoring.thresholds.v1'
export const OPERATIONS_MONITORING_STATE_KEY = 'operations.monitoring.state.v1'

export const OPERATIONS_MONITORING_CATEGORIES = [
  'tools',
  'sms',
  'payments',
  'orders',
  'fulfillment',
  'refunds',
  'balance',
  'documents',
  'reconciliation',
  'workers',
] as const

type MonitoringCategory = (typeof OPERATIONS_MONITORING_CATEGORIES)[number]

const monitoringStateSchema = z
  .object({
    lastWindowEnd: z.iso.datetime().nullable(),
    schemaVersion: z.literal(1),
    updatedAt: z.iso.datetime(),
  })
  .strict()

type MonitoringState = z.infer<typeof monitoringStateSchema>

export type MonitoringSnapshot = {
  balance: { alertCount: number; observationAgeMinutes: null | number }
  documents: { accessCount: number; distinctDocumentCount: number }
  fulfillment: { failedOrUnknownCount: number; staleSubmittedCount: number }
  orders: { oldestOpenAgeMinutes: number; openManualReviewCount: number }
  payments: { openManualReviewCount: number }
  reconciliation: { differenceCount: number }
  refunds: { failedOrUnknownCount: number; staleSubmittedCount: number }
  sms: { attemptCount: number; failureCount: number; unknownCount: number }
  tools: {
    failureCount: number
    firstPartyFailureCount: number
    rejectedCount: number
    requestCount: number
    timeoutCount: number
  }
  workers: { commerceHeartbeatAgeMinutes: null | number }
}

export type MonitoringAlert = {
  category: MonitoringCategory
  condition: string
  observed: number | 'missing'
  threshold: number
}

type Relation = number | string | { id: number | string } | null | undefined

function relationId(value: Relation): number | string | undefined {
  if (value === null || value === undefined) return undefined
  return typeof value === 'object' ? value.id : value
}

function checkedSum(values: Array<null | number | undefined>): number {
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new AppError('OPERATIONS_MONITORING_OVERFLOW', '监控聚合值超出安全范围', 500)
  }
  return total
}

function basisPoints(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.floor((numerator * 10_000) / denominator)
}

function minutesBetween(earlier: string, later: string): number {
  return Math.max(0, Math.floor((Date.parse(later) - Date.parse(earlier)) / 60_000))
}

function timeRange(field: string, start: string, end: string) {
  return {
    and: [{ [field]: { greater_than_equal: start } }, { [field]: { less_than: end } }],
  }
}

function openReviewCategory(reasonCode: string): 'fulfillment' | 'payments' | 'refunds' | 'other' {
  if (
    reasonCode.startsWith('wechatpay.payment') ||
    reasonCode === 'wechatpay.late_payment' ||
    reasonCode === 'wechatpay.confirmed_during_review'
  ) {
    return 'payments'
  }
  if (reasonCode.startsWith('wechatpay.refund')) return 'refunds'
  if (
    reasonCode.startsWith('registration.') ||
    reasonCode.startsWith('renewal.') ||
    reasonCode.startsWith('westdigital.') ||
    reasonCode.startsWith('provider_')
  ) {
    return 'fulfillment'
  }
  return 'other'
}

export function evaluateOperationsMonitoring(
  snapshot: MonitoringSnapshot,
  thresholds: OperationsMonitoringThresholds,
): MonitoringAlert[] {
  const alerts: MonitoringAlert[] = []
  const add = (
    category: MonitoringCategory,
    condition: string,
    observed: number | 'missing',
    threshold: number,
  ) => alerts.push({ category, condition, observed, threshold })

  const toolFailureRate = basisPoints(snapshot.tools.failureCount, snapshot.tools.requestCount)
  if (
    snapshot.tools.requestCount >= thresholds.tools.minimumRequests &&
    toolFailureRate >= thresholds.tools.failureRateBasisPoints
  ) {
    add(
      'tools',
      'failure_rate_basis_points',
      toolFailureRate,
      thresholds.tools.failureRateBasisPoints,
    )
  }
  if (snapshot.tools.timeoutCount >= thresholds.tools.timeoutCount) {
    add('tools', 'timeout_count', snapshot.tools.timeoutCount, thresholds.tools.timeoutCount)
  }
  if (snapshot.tools.rejectedCount >= thresholds.tools.rejectedCount) {
    add('tools', 'rejected_count', snapshot.tools.rejectedCount, thresholds.tools.rejectedCount)
  }
  if (snapshot.tools.firstPartyFailureCount >= thresholds.tools.firstPartyFailureCount) {
    add(
      'tools',
      'first_party_failure_count',
      snapshot.tools.firstPartyFailureCount,
      thresholds.tools.firstPartyFailureCount,
    )
  }

  const smsFailureRate = basisPoints(snapshot.sms.failureCount, snapshot.sms.attemptCount)
  if (
    snapshot.sms.attemptCount >= thresholds.sms.minimumAttempts &&
    smsFailureRate >= thresholds.sms.failureRateBasisPoints
  ) {
    add('sms', 'failure_rate_basis_points', smsFailureRate, thresholds.sms.failureRateBasisPoints)
  }
  if (snapshot.sms.unknownCount >= thresholds.sms.unknownCount) {
    add('sms', 'unknown_count', snapshot.sms.unknownCount, thresholds.sms.unknownCount)
  }

  if (snapshot.payments.openManualReviewCount >= thresholds.payments.openManualReviewCount) {
    add(
      'payments',
      'open_manual_review_count',
      snapshot.payments.openManualReviewCount,
      thresholds.payments.openManualReviewCount,
    )
  }
  if (snapshot.orders.openManualReviewCount >= thresholds.orders.openManualReviewCount) {
    add(
      'orders',
      'open_manual_review_count',
      snapshot.orders.openManualReviewCount,
      thresholds.orders.openManualReviewCount,
    )
  }
  if (snapshot.orders.oldestOpenAgeMinutes >= thresholds.orders.maximumOpenAgeMinutes) {
    add(
      'orders',
      'oldest_open_age_minutes',
      snapshot.orders.oldestOpenAgeMinutes,
      thresholds.orders.maximumOpenAgeMinutes,
    )
  }

  for (const category of ['fulfillment', 'refunds'] as const) {
    if (snapshot[category].failedOrUnknownCount >= thresholds[category].failedOrUnknownCount) {
      add(
        category,
        'failed_or_unknown_count',
        snapshot[category].failedOrUnknownCount,
        thresholds[category].failedOrUnknownCount,
      )
    }
    if (snapshot[category].staleSubmittedCount >= thresholds[category].staleSubmittedCount) {
      add(
        category,
        'stale_submitted_count',
        snapshot[category].staleSubmittedCount,
        thresholds[category].staleSubmittedCount,
      )
    }
  }

  if (snapshot.balance.observationAgeMinutes === null) {
    add(
      'balance',
      'observation_age_minutes',
      'missing',
      thresholds.balance.maximumObservationAgeMinutes,
    )
  } else if (
    snapshot.balance.observationAgeMinutes >= thresholds.balance.maximumObservationAgeMinutes
  ) {
    add(
      'balance',
      'observation_age_minutes',
      snapshot.balance.observationAgeMinutes,
      thresholds.balance.maximumObservationAgeMinutes,
    )
  }
  if (snapshot.balance.alertCount >= thresholds.balance.alertCount) {
    add(
      'balance',
      'low_balance_alert_count',
      snapshot.balance.alertCount,
      thresholds.balance.alertCount,
    )
  }
  if (snapshot.documents.accessCount >= thresholds.documents.accessCount) {
    add(
      'documents',
      'access_count',
      snapshot.documents.accessCount,
      thresholds.documents.accessCount,
    )
  }
  if (snapshot.documents.distinctDocumentCount >= thresholds.documents.distinctDocumentCount) {
    add(
      'documents',
      'distinct_document_count',
      snapshot.documents.distinctDocumentCount,
      thresholds.documents.distinctDocumentCount,
    )
  }
  if (snapshot.reconciliation.differenceCount >= thresholds.reconciliation.differenceCount) {
    add(
      'reconciliation',
      'difference_count',
      snapshot.reconciliation.differenceCount,
      thresholds.reconciliation.differenceCount,
    )
  }
  if (snapshot.workers.commerceHeartbeatAgeMinutes === null) {
    add(
      'workers',
      'commerce_heartbeat_age_minutes',
      'missing',
      thresholds.workers.commerceMaximumHeartbeatAgeMinutes,
    )
  } else if (
    snapshot.workers.commerceHeartbeatAgeMinutes >=
    thresholds.workers.commerceMaximumHeartbeatAgeMinutes
  ) {
    add(
      'workers',
      'commerce_heartbeat_age_minutes',
      snapshot.workers.commerceHeartbeatAgeMinutes,
      thresholds.workers.commerceMaximumHeartbeatAgeMinutes,
    )
  }
  return alerts
}

async function loadThresholds(req: PayloadRequest): Promise<OperationsMonitoringThresholds> {
  const result = await req.payload.find({
    collection: 'siteSettings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { key: { equals: OPERATIONS_MONITORING_THRESHOLDS_KEY } },
  })
  if (!result.docs[0]) return DEFAULT_OPERATIONS_MONITORING_THRESHOLDS
  const parsed = operationsMonitoringThresholdsSchema.safeParse(result.docs[0].value)
  if (!parsed.success) {
    throw new AppError('OPERATIONS_MONITORING_THRESHOLDS_INVALID', '运营监控阈值配置无效', 503)
  }
  return parsed.data
}

async function collectSnapshot(
  req: PayloadRequest,
  thresholds: OperationsMonitoringThresholds,
  start: string,
  end: string,
): Promise<MonitoringSnapshot> {
  const [
    toolBuckets,
    firstPartyFailures,
    smsChallenges,
    expirySms,
    openReviews,
    providerOperations,
    reconciliations,
    balanceObservation,
    accessLogs,
    balanceAlerts,
  ] = await Promise.all([
    req.payload.find({
      collection: 'toolObservabilityBuckets',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      req,
      select: {
        failureCount: true,
        rejectedCount: true,
        requestCount: true,
        timeoutErrorCount: true,
      },
      where: timeRange('bucketStart', start, end),
    }),
    req.payload.count({
      collection: 'firstPartyEvents',
      overrideAccess: true,
      req,
      where: {
        and: [{ event: { equals: 'tool_failed' } }, ...timeRange('createdAt', start, end).and],
      },
    }),
    req.payload.find({
      collection: 'smsChallenges',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      req,
      select: { deliveryStatus: true },
      where: timeRange('sentAt', start, end),
    }),
    req.payload.find({
      collection: 'domainExpiryReminders',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      req,
      select: { status: true },
      where: {
        and: [{ channel: { equals: 'sms' } }, ...timeRange('attemptedAt', start, end).and],
      },
    }),
    req.payload.find({
      collection: 'manualReviews',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      req,
      select: { createdAt: true, order: true, reasonCode: true },
      where: { status: { equals: 'open' } },
    }),
    req.payload.find({
      collection: 'providerOperations',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      req,
      select: { operation: true, provider: true, status: true, submittedAt: true },
      where: {
        or: [
          {
            and: [
              { status: { in: ['failed', 'unknown'] } },
              ...timeRange('updatedAt', start, end).and,
            ],
          },
          { status: { equals: 'submitted' } },
        ],
      },
    }),
    req.payload.find({
      collection: 'reconciliations',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      req,
      select: { status: true },
      where: timeRange('periodEnd', start, end),
    }),
    req.payload.find({
      collection: 'reconciliations',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      select: { periodEnd: true },
      sort: '-periodEnd',
      where: {
        and: [
          { ledger: { equals: 'westdigital_prepaid' } },
          { recordKey: { contains: 'balance-observation:' } },
          { periodEnd: { less_than_equal: end } },
        ],
      },
    }),
    req.payload.find({
      collection: 'auditLogs',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      req,
      select: { targetId: true },
      where: {
        and: [
          { action: { in: ['realname.document.downloaded', 'realname.document.viewed'] } },
          ...timeRange('createdAt', start, end).and,
        ],
      },
    }),
    req.payload.count({
      collection: 'auditLogs',
      overrideAccess: true,
      req,
      where: {
        and: [
          { action: { equals: 'commerce.balance_low.alerted' } },
          ...timeRange('createdAt', start, end).and,
        ],
      },
    }),
  ])

  const reviews = openReviews.docs.filter((review) => relationId(review.order) !== undefined)
  const reviewAges = reviews.map((review) => minutesBetween(review.createdAt, end))
  const classifiedReviews = reviews.map((review) => openReviewCategory(review.reasonCode))
  const staleBefore = {
    fulfillment: Date.parse(end) - thresholds.fulfillment.staleSubmittedMinutes * 60_000,
    refunds: Date.parse(end) - thresholds.refunds.staleSubmittedMinutes * 60_000,
  }
  const fulfillmentOperations = providerOperations.docs.filter(
    (operation) => operation.provider === 'westdigital' && operation.operation !== 'query',
  )
  const refundOperations = providerOperations.docs.filter(
    (operation) => operation.provider === 'wechatpay' && operation.operation === 'refund',
  )
  const staleCount = (operations: typeof providerOperations.docs, cutoff: number) =>
    operations.filter(
      (operation) =>
        operation.status === 'submitted' &&
        typeof operation.submittedAt === 'string' &&
        Date.parse(operation.submittedAt) <= cutoff,
    ).length

  const toolRequestCount = checkedSum(toolBuckets.docs.map((bucket) => bucket.requestCount))
  const toolFailureCount = checkedSum(toolBuckets.docs.map((bucket) => bucket.failureCount))
  const smsStatuses = [...smsChallenges.docs, ...expirySms.docs].map((record) =>
    'deliveryStatus' in record ? record.deliveryStatus : record.status,
  )
  const accessDocumentIds = new Set(
    accessLogs.docs
      .map((record) => record.targetId)
      .filter((targetId): targetId is string => typeof targetId === 'string'),
  )
  const latestBalance = balanceObservation.docs[0]
  const commerceHeartbeatAgeMinutes = await commerceWorkerHeartbeatAgeMinutes(req, end)

  return {
    balance: {
      alertCount: balanceAlerts.totalDocs,
      observationAgeMinutes: latestBalance?.periodEnd
        ? minutesBetween(latestBalance.periodEnd, end)
        : null,
    },
    documents: {
      accessCount: accessLogs.totalDocs,
      distinctDocumentCount: accessDocumentIds.size,
    },
    fulfillment: {
      failedOrUnknownCount: fulfillmentOperations.filter((operation) =>
        ['failed', 'unknown'].includes(operation.status),
      ).length,
      staleSubmittedCount: staleCount(fulfillmentOperations, staleBefore.fulfillment),
    },
    orders: {
      oldestOpenAgeMinutes: reviewAges.length ? Math.max(...reviewAges) : 0,
      openManualReviewCount: reviews.length,
    },
    payments: {
      openManualReviewCount: classifiedReviews.filter((category) => category === 'payments').length,
    },
    reconciliation: {
      differenceCount: reconciliations.docs.filter((row) => row.status === 'difference').length,
    },
    refunds: {
      failedOrUnknownCount: refundOperations.filter((operation) =>
        ['failed', 'unknown'].includes(operation.status),
      ).length,
      staleSubmittedCount: staleCount(refundOperations, staleBefore.refunds),
    },
    sms: {
      attemptCount: smsStatuses.length,
      failureCount: smsStatuses.filter((status) => status === 'failed').length,
      unknownCount: smsStatuses.filter((status) => status === 'unknown').length,
    },
    tools: {
      failureCount: toolFailureCount,
      firstPartyFailureCount: firstPartyFailures.totalDocs,
      rejectedCount: checkedSum(toolBuckets.docs.map((bucket) => bucket.rejectedCount)),
      requestCount: toolRequestCount,
      timeoutCount: checkedSum(toolBuckets.docs.map((bucket) => bucket.timeoutErrorCount)),
    },
    workers: { commerceHeartbeatAgeMinutes },
  }
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
    throw new AppError('OPERATIONS_MONITORING_CAS_UNAVAILABLE', '无法原子认领监控窗口', 503)
  }
  return current
}

async function loadState(
  req: PayloadRequest,
): Promise<{ id: number | string; value: MonitoringState }> {
  const initial = monitoringStateSchema.parse({
    lastWindowEnd: null,
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
  })
  await (
    await database(req)
  ).execute(sql`
    INSERT INTO site_settings (key, value, description, updated_at, created_at)
    VALUES (
      ${OPERATIONS_MONITORING_STATE_KEY},
      CAST(${JSON.stringify(initial)} AS jsonb),
      '运营监控已完成窗口；仅保存幂等水位，不保存业务指标或客户标识',
      NOW(),
      NOW()
    )
    ON CONFLICT (key) DO NOTHING
  `)
  const found = await req.payload.find({
    collection: 'siteSettings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { key: { equals: OPERATIONS_MONITORING_STATE_KEY } },
  })
  const document = found.docs[0]
  const parsed = monitoringStateSchema.safeParse(document?.value)
  if (!document || !parsed.success) {
    throw new AppError('OPERATIONS_MONITORING_STATE_INVALID', '运营监控幂等状态无效', 503)
  }
  return { id: document.id, value: parsed.data }
}

async function claimWindow(
  req: PayloadRequest,
  state: { id: number | string; value: MonitoringState },
  windowEnd: string,
): Promise<boolean> {
  if (state.value.lastWindowEnd && Date.parse(state.value.lastWindowEnd) >= Date.parse(windowEnd)) {
    return false
  }
  const next = monitoringStateSchema.parse({
    lastWindowEnd: windowEnd,
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
  })
  const claimed = await (
    await database(req)
  ).execute(sql`
    UPDATE site_settings
    SET value = CAST(${JSON.stringify(next)} AS jsonb), updated_at = NOW()
    WHERE id = ${state.id}
      AND value = CAST(${JSON.stringify(state.value)} AS jsonb)
    RETURNING id
  `)
  return claimed.rows?.[0]?.id !== undefined
}

function alertTarget(windowEnd: string, alert: MonitoringAlert): string {
  return `${windowEnd}:${alert.category}:${alert.condition}`
}

export async function runOperationsMonitoring(
  req: PayloadRequest,
  options: { now?: Date; thresholds?: OperationsMonitoringThresholds } = {},
) {
  const thresholds = operationsMonitoringThresholdsSchema.parse(
    options.thresholds ?? (await loadThresholds(req)),
  )
  const now = options.now ?? new Date()
  const windowMs = thresholds.windowMinutes * 60_000
  const windowEndMs = Math.floor(now.getTime() / windowMs) * windowMs
  const windowStart = new Date(windowEndMs - windowMs).toISOString()
  const windowEnd = new Date(windowEndMs).toISOString()
  const snapshot = await collectSnapshot(req, thresholds, windowStart, windowEnd)
  const alerts = evaluateOperationsMonitoring(snapshot, thresholds)

  return transaction(req, async () => {
    const state = await loadState(req)
    if (!(await claimWindow(req, state, windowEnd))) {
      return { alertCount: 0, idempotentReplay: true, snapshot, windowEnd, windowStart }
    }
    for (const alert of alerts) {
      await recordAuditEvent(req, {
        action: 'operations.monitoring.alerted',
        actor: { type: 'system' },
        metadata: {
          category: alert.category,
          condition: alert.condition,
          observed: alert.observed,
          threshold: alert.threshold,
          thresholdSettingKey: OPERATIONS_MONITORING_THRESHOLDS_KEY,
          windowEnd,
          windowStart,
        },
        targetId: alertTarget(windowEnd, alert),
      })
      req.payload.logger.warn(
        {
          category: alert.category,
          condition: alert.condition,
          observed: alert.observed,
          threshold: alert.threshold,
          windowEnd,
          windowStart,
        },
        'Operations monitoring threshold crossed',
      )
    }
    return {
      alertCount: alerts.length,
      idempotentReplay: false,
      snapshot,
      windowEnd,
      windowStart,
    }
  })
}

export async function readRealnameDocumentAccessTrail(
  req: PayloadRequest,
  input: { end: string; start: string },
) {
  if (!isActiveAdminUser(req.user) || !hasRole(req.user, ['system_admin'])) {
    throw new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', '仅系统管理员可调查证件访问审计', 403)
  }
  const result = await req.payload.find({
    collection: 'auditLogs',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    select: {
      action: true,
      actorId: true,
      actorType: true,
      createdAt: true,
      targetId: true,
      traceId: true,
    },
    sort: 'createdAt',
    where: {
      and: [
        { action: { in: ['realname.document.downloaded', 'realname.document.viewed'] } },
        ...timeRange('createdAt', input.start, input.end).and,
      ],
    },
  })
  return result.docs.map((event) => ({
    access: event.action === 'realname.document.downloaded' ? 'download' : 'view',
    accessedAt: event.createdAt,
    actorId: event.actorId,
    actorType: event.actorType,
    documentId: event.targetId,
    traceId: event.traceId,
  }))
}
