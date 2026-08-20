import { randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { hasAdminOperationScope, isCustomerUser } from '@/access/roles'
import { VIP_TIER_EVENT_SOURCES } from '@/collections/vip'
import { AppError } from '@/lib/errors'
import { getTraceId } from '@/lib/request-id'
import type { VipTierEvent } from '@/payload-types'
import {
  vipOperationalPromotionSchema,
  vipTierAppealCreateSchema,
  vipTierRulePublishSchema,
  type VipTierRuleLevelInput,
  type VipTierRulePublishInput,
} from '@/schemas/vip-tiers'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { enqueueTransactionalSecurityNotification } from '@/services/notifications/outbox'

export const VIP_BENEFIT_CHANGE_NOTICE_LEAD_MS = 24 * 60 * 60 * 1_000

export function compareVipTierEventsNewestFirst(
  left: { id: number | string; occurredAt: string },
  right: { id: number | string; occurredAt: string },
): number {
  return (
    Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || Number(right.id) - Number(left.id)
  )
}

type VipDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

type RuleRow = {
  effectiveAt: string
  id: number | string
  version: number
}

type RuleLevel = VipTierRuleLevelInput & {
  id: number | string
  ruleVersionId: number | string
  versionNumber: number
}

type TierState = {
  cumulativeSpendFenSnapshot: number
  eventId: number | string
  source: (typeof VIP_TIER_EVENT_SOURCES)[number]
  tierCode: null | string
  tierName: string
  tierRank: number
}

type OrderSpendRow = {
  amountFen: number
  customerId: number
  id: number
  paymentChannel: 'balance' | 'h5' | 'native' | null
  status: string
}

function numericId(value: unknown, code = 'VIP_RELATION_INVALID'): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(code, 'VIP 关联标识无效', 409)
  return id
}

function safeInteger(value: unknown, code: string, message: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AppError(code, message, 409)
  return parsed
}

function stableJson(value: Record<string, number>): string {
  return JSON.stringify(
    Object.fromEntries(
      [...Object.entries(value)].sort(([left], [right]) => left.localeCompare(right)),
    ),
  )
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

async function database(req: PayloadRequest): Promise<VipDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as VipDatabase | undefined
  if (!current) throw new AppError('VIP_TRANSACTION_UNAVAILABLE', 'VIP 事务暂时不可用', 503)
  return current
}

function assertConfigurationAdmin(req: PayloadRequest): void {
  if (!hasAdminOperationScope(req.user, 'system_configuration')) {
    throw new AppError('ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED', '需要系统配置操作权限', 403)
  }
}

function canonicalTiers(rawTiers: VipTierRuleLevelInput[]): VipTierRuleLevelInput[] {
  const tiers = rawTiers
    .map((tier) => ({
      ...tier,
      displayName: tier.displayName.trim(),
      quotaBenefits: tier.quotaBenefits,
      serviceContent: tier.serviceContent.trim(),
      tierCode: tier.tierCode.trim(),
    }))
    .sort(
      (left, right) =>
        left.tierRank - right.tierRank || left.tierCode.localeCompare(right.tierCode),
    )
  const codes = new Set<string>()
  let previousThreshold = 0
  for (const [index, tier] of tiers.entries()) {
    if (tier.tierRank !== index + 1 || codes.has(tier.tierCode)) {
      throw new AppError('VIP_TIER_RULE_INVALID', 'VIP 等级排名必须从 1 连续且代码唯一', 400)
    }
    if (tier.thresholdFen <= previousThreshold) {
      throw new AppError('VIP_TIER_RULE_INVALID', 'VIP 等级门槛必须随排名严格递增', 400)
    }
    codes.add(tier.tierCode)
    previousThreshold = tier.thresholdFen
  }
  return tiers
}

async function applicableRule(
  req: PayloadRequest,
  at: Date,
  inclusive = true,
): Promise<RuleRow | undefined> {
  const result = await (
    await database(req)
  ).execute(sql`
    SELECT
      id,
      version,
      effective_at AS "effectiveAt"
    FROM vip_tier_rule_versions
    WHERE effective_at < ${at.toISOString()}
       OR (${inclusive} AND effective_at = ${at.toISOString()})
    ORDER BY effective_at DESC, version DESC
    LIMIT 1
  `)
  const row = result.rows?.[0]
  if (!row) return undefined
  return {
    effectiveAt: new Date(String(row.effectiveAt)).toISOString(),
    id: row.id as number | string,
    version: safeInteger(row.version, 'VIP_RULE_INVALID', 'VIP 等级规则版本无效'),
  }
}

async function ruleLevels(req: PayloadRequest, rule: RuleRow): Promise<RuleLevel[]> {
  const result = await (
    await database(req)
  ).execute(sql`
    SELECT
      id,
      rule_version_id AS "ruleVersionId",
      version_number AS "versionNumber",
      tier_code AS "tierCode",
      tier_rank AS "tierRank",
      display_name AS "displayName",
      threshold_fen AS "thresholdFen",
      quota_benefits AS "quotaBenefits",
      service_content AS "serviceContent"
    FROM vip_tier_rule_levels
    WHERE rule_version_id = ${rule.id}
      AND version_number = ${rule.version}
    ORDER BY tier_rank ASC
  `)
  return (result.rows ?? []).map((row) => ({
    displayName: String(row.displayName),
    id: row.id as number | string,
    quotaBenefits: (row.quotaBenefits ?? {}) as Record<string, number>,
    ruleVersionId: row.ruleVersionId as number | string,
    serviceContent: String(row.serviceContent),
    thresholdFen: safeInteger(row.thresholdFen, 'VIP_RULE_INVALID', 'VIP 等级门槛无效'),
    tierCode: String(row.tierCode),
    tierRank: safeInteger(row.tierRank, 'VIP_RULE_INVALID', 'VIP 等级排名无效'),
    versionNumber: safeInteger(row.versionNumber, 'VIP_RULE_INVALID', 'VIP 等级版本无效'),
  }))
}

function userFacingRuleChanged(previous: RuleLevel[], next: VipTierRuleLevelInput[]): boolean {
  return previous.some((level, index) => {
    const candidate = next[index]!
    return (
      candidate.displayName !== level.displayName ||
      candidate.serviceContent !== level.serviceContent ||
      stableJson(candidate.quotaBenefits) !== stableJson(level.quotaBenefits)
    )
  })
}

async function currentVipCustomerIds(req: PayloadRequest): Promise<number[]> {
  const result = await (
    await database(req)
  ).execute(sql`
    SELECT latest.customer_id AS "customerId"
    FROM (
      SELECT DISTINCT ON (customer_id)
        customer_id,
        tier_rank
      FROM vip_tier_events
      ORDER BY customer_id ASC, occurred_at DESC, id DESC
    ) AS latest
    WHERE latest.tier_rank > 0
      AND latest.customer_id IS NOT NULL
    ORDER BY latest.customer_id ASC
  `)
  return (result.rows ?? []).map((row) => numericId(row.customerId))
}

export async function publishVipTierRuleVersion(
  req: PayloadRequest,
  rawInput: VipTierRulePublishInput,
  dependencies: { now?: () => Date } = {},
): Promise<{ id: number | string; noticeCount: number; version: number }> {
  assertConfigurationAdmin(req)
  const input = vipTierRulePublishSchema.parse(rawInput)
  const effectiveAt = new Date(input.effectiveAt)
  const now = (dependencies.now ?? (() => new Date()))()
  const tiers = canonicalTiers(input.tiers)
  if (effectiveAt.getTime() < now.getTime()) {
    throw new AppError('VIP_TIER_RULE_INVALID', 'VIP 等级规则不得追溯生效', 400)
  }

  return transaction(req, async () => {
    const db = await database(req)
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('wanmi:vip-tier-rule-version'))`)
    const previousRule = await applicableRule(req, effectiveAt)
    const previousLevels = previousRule ? await ruleLevels(req, previousRule) : []
    if (previousLevels.length > 0) {
      for (const previous of previousLevels) {
        const sameRank = tiers.find((tier) => tier.tierRank === previous.tierRank)
        if (!sameRank || sameRank.tierCode !== previous.tierCode) {
          throw new AppError(
            'VIP_TIER_RULE_IDENTITY_INVALID',
            '新规则不得删除或重用既有等级排名与代码',
            409,
          )
        }
      }
    }
    const requiresAdvanceNotice = userFacingRuleChanged(previousLevels, tiers)
    if (
      requiresAdvanceNotice &&
      effectiveAt.getTime() - now.getTime() < VIP_BENEFIT_CHANGE_NOTICE_LEAD_MS
    ) {
      throw new AppError(
        'VIP_TIER_NOTICE_LEAD_REQUIRED',
        'VIP 等级名称或权益调整必须至少提前 24 小时通知',
        409,
      )
    }
    const inserted = await db.execute(sql`
      INSERT INTO vip_tier_rule_versions (
        version,
        schema_version,
        effective_at,
        notice_published_at,
        changed_by,
        change_note,
        updated_at,
        created_at
      )
      SELECT
        COALESCE(MAX(version), 0) + 1,
        1,
        ${effectiveAt.toISOString()},
        ${requiresAdvanceNotice ? now.toISOString() : null},
        ${String(req.user!.id)},
        ${input.changeNote},
        NOW(),
        NOW()
      FROM vip_tier_rule_versions
      RETURNING id, version
    `)
    const row = inserted.rows?.[0]
    if (!row) throw new AppError('VIP_TIER_RULE_CONFLICT', 'VIP 等级规则版本发生并发冲突', 409)
    const ruleId = row.id as number | string
    const version = safeInteger(row.version, 'VIP_RULE_INVALID', 'VIP 等级规则版本无效')
    for (const tier of tiers) {
      await db.execute(sql`
        INSERT INTO vip_tier_rule_levels (
          rule_version_id,
          version_number,
          tier_code,
          tier_rank,
          display_name,
          threshold_fen,
          quota_benefits,
          service_content,
          updated_at,
          created_at
        ) VALUES (
          ${ruleId},
          ${version},
          ${tier.tierCode},
          ${tier.tierRank},
          ${tier.displayName},
          ${tier.thresholdFen},
          ${JSON.stringify(tier.quotaBenefits)}::jsonb,
          ${tier.serviceContent},
          NOW(),
          NOW()
        )
      `)
    }
    let noticeCount = 0
    if (requiresAdvanceNotice) {
      const customers = await currentVipCustomerIds(req)
      for (const customerId of customers) {
        await enqueueTransactionalSecurityNotification(req, {
          body: `VIP 等级名称或权益将于 ${effectiveAt.toISOString()} 调整，请在账户会员页查看届时生效的权益。`,
          customerId,
          domainEventType: 'vip.tier_rule.user_benefit_change_published',
          eventKey: `vip-tier-rule:${version}:advance-notice:${customerId}`,
          notificationType: 'vip_benefit_change_advance',
          subject: 'VIP 等级权益调整提前通知',
          templateKey: 'vip-benefit-change-advance',
          templateVersion: 1,
          traceId: getTraceId(req.headers),
        })
        noticeCount += 1
      }
    }
    await recordAuditEvent(req, {
      action: 'vip.tier_rule.published',
      actor: { id: req.user!.id, type: 'admin' },
      metadata: {
        effectiveAt: effectiveAt.toISOString(),
        noticeCount,
        requiresAdvanceNotice,
        tiers,
        version,
      },
      targetId: ruleId,
    })
    return { id: ruleId, noticeCount, version }
  })
}

async function lockCustomer(req: PayloadRequest, customerId: number): Promise<void> {
  const result = await (
    await database(req)
  ).execute(sql`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`)
  if (result.rows?.[0]?.id === undefined) {
    throw new AppError('VIP_CUSTOMER_NOT_FOUND', '未找到 VIP 用户', 404)
  }
}

async function cumulativeSpendFen(req: PayloadRequest, customerId: number): Promise<number> {
  const result = await (
    await database(req)
  ).execute(sql`
    SELECT COALESCE(SUM(
      CASE
        WHEN entry_type = 'succeeded_order' THEN amount_fen
        WHEN entry_type IN ('order_reversal', 'data_correction', 'fraud_reversal') THEN -amount_fen
        ELSE 0
      END
    ), 0) AS "cumulativeSpendFen"
    FROM vip_spend_entries
    WHERE customer_id = ${customerId}
  `)
  return safeInteger(
    result.rows?.[0]?.cumulativeSpendFen,
    'VIP_SPEND_LEDGER_INVALID',
    'VIP 累计消费账本无效',
  )
}

async function currentTierState(
  req: PayloadRequest,
  customerId: number,
): Promise<TierState | undefined> {
  const result = await (
    await database(req)
  ).execute(sql`
    SELECT
      id AS "eventId",
      source,
      tier_code AS "tierCode",
      tier_rank AS "tierRank",
      tier_name_snapshot AS "tierName",
      cumulative_spend_fen_snapshot AS "cumulativeSpendFenSnapshot",
      occurred_at AS "occurredAt"
    FROM vip_tier_events
    WHERE customer_id = ${customerId}
      AND occurred_at = (
        SELECT MAX(occurred_at)
        FROM vip_tier_events
        WHERE customer_id = ${customerId}
      )
  `)
  const row = [...(result.rows ?? [])].sort((left, right) =>
    compareVipTierEventsNewestFirst(
      { id: left.eventId as number | string, occurredAt: String(left.occurredAt) },
      { id: right.eventId as number | string, occurredAt: String(right.occurredAt) },
    ),
  )[0]
  if (!row) return undefined
  return {
    cumulativeSpendFenSnapshot: safeInteger(
      row.cumulativeSpendFenSnapshot,
      'VIP_TIER_EVENT_INVALID',
      'VIP 等级事件累计额无效',
    ),
    eventId: row.eventId as number | string,
    source: String(row.source) as TierState['source'],
    tierCode: row.tierCode === null || row.tierCode === undefined ? null : String(row.tierCode),
    tierName: String(row.tierName),
    tierRank: safeInteger(row.tierRank, 'VIP_TIER_EVENT_INVALID', 'VIP 等级事件排名无效'),
  }
}

async function insertTierEvent(
  req: PayloadRequest,
  input: {
    approvalRequestId?: number | string
    correctionReference?: string
    cumulativeSpendFen: number
    customerId: number
    eventKey: string
    eventType: 'tier_achievement' | 'tier_correction'
    occurredAt: string
    previousTierRank: number
    reason: string
    rule?: RuleRow
    source: TierState['source']
    tier?: RuleLevel
    triggerOrderId?: number | string
  },
): Promise<number | string> {
  const inserted = await (
    await database(req)
  ).execute(sql`
    INSERT INTO vip_tier_events (
      event_key,
      customer_id,
      event_type,
      source,
      trigger_order_id,
      rule_version_id,
      rule_version_number,
      tier_code,
      tier_rank,
      tier_name_snapshot,
      quota_benefits_snapshot,
      service_content_snapshot,
      cumulative_spend_fen_snapshot,
      previous_tier_rank,
      reason,
      approval_request_id,
      correction_reference,
      occurred_at,
      updated_at,
      created_at
    ) VALUES (
      ${input.eventKey},
      ${input.customerId},
      ${input.eventType},
      ${input.source},
      ${input.triggerOrderId ?? null},
      ${input.rule?.id ?? null},
      ${input.rule?.version ?? 0},
      ${input.tier?.tierCode ?? null},
      ${input.tier?.tierRank ?? 0},
      ${input.tier?.displayName ?? '无等级'},
      ${JSON.stringify(input.tier?.quotaBenefits ?? {})}::jsonb,
      ${input.tier?.serviceContent ?? '无'},
      ${input.cumulativeSpendFen},
      ${input.previousTierRank},
      ${input.reason},
      ${input.approvalRequestId ?? null},
      ${input.correctionReference ?? null},
      ${input.occurredAt},
      NOW(),
      NOW()
    )
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id
  `)
  const eventId = inserted.rows?.[0]?.id
  if (eventId === undefined) {
    const existing = await (
      await database(req)
    ).execute(sql`SELECT id FROM vip_tier_events WHERE event_key = ${input.eventKey}`)
    const existingId = existing.rows?.[0]?.id
    if (existingId === undefined)
      throw new AppError('VIP_TIER_EVENT_CONFLICT', 'VIP 等级事件冲突', 409)
    return existingId as number | string
  }
  const auditTargetId = eventId as number | string
  const actor =
    input.source === 'natural_achievement'
      ? ({ type: 'system' } as const)
      : ({ id: req.user!.id, type: 'admin' } as const)
  await recordAuditEvent(req, {
    action:
      input.eventType === 'tier_achievement'
        ? 'vip.tier.achievement_recorded'
        : 'vip.tier.correction_recorded',
    actor,
    metadata: {
      correctionReference: input.correctionReference,
      cumulativeSpendFen: input.cumulativeSpendFen,
      eventType: input.eventType,
      previousTierRank: input.previousTierRank,
      source: input.source,
      tierCode: input.tier?.tierCode ?? null,
      tierRank: input.tier?.tierRank ?? 0,
    },
    targetId: auditTargetId,
  })
  return auditTargetId
}

async function orderSpendRow(
  req: PayloadRequest,
  orderId: number | string,
): Promise<OrderSpendRow> {
  const result = await (
    await database(req)
  ).execute(sql`
    SELECT
      id,
      customer_id AS "customerId",
      status,
      amount_minor AS "amountFen",
      payment_channel AS "paymentChannel"
    FROM orders
    WHERE id = ${orderId}
    FOR SHARE
  `)
  const row = result.rows?.[0]
  if (!row) throw new AppError('VIP_ORDER_NOT_FOUND', '未找到可累计的订单', 404)
  const paymentChannel =
    row.paymentChannel === 'native' ||
    row.paymentChannel === 'h5' ||
    row.paymentChannel === 'balance'
      ? row.paymentChannel
      : null
  return {
    amountFen: safeInteger(row.amountFen, 'VIP_ORDER_AMOUNT_INVALID', '订单冻结应付金额无效'),
    customerId: numericId(row.customerId),
    id: numericId(row.id),
    paymentChannel,
    status: String(row.status),
  }
}

export async function recordVipSpendForSucceededOrder(
  req: PayloadRequest,
  input: { eventId: number | string; orderId: number | string; occurredAt?: string },
): Promise<{ achievementCount: number; counted: boolean; cumulativeSpendFen: number }> {
  return transaction(req, async () => {
    const order = await orderSpendRow(req, input.orderId)
    if (order.status !== 'succeeded' || !order.paymentChannel) {
      return { achievementCount: 0, counted: false, cumulativeSpendFen: 0 }
    }
    await lockCustomer(req, order.customerId)
    const occurredAt = input.occurredAt ?? new Date().toISOString()
    const entryKey = `vip-order:${order.id}:succeeded`
    const inserted = await (
      await database(req)
    ).execute(sql`
      INSERT INTO vip_spend_entries (
        entry_key,
        customer_id,
        source_order_id,
        entry_type,
        payment_channel,
        amount_fen,
        reference,
        occurred_at,
        updated_at,
        created_at
      ) VALUES (
        ${entryKey},
        ${order.customerId},
        ${order.id},
        'succeeded_order',
        ${order.paymentChannel},
        ${order.amountFen},
        ${`order-event:${input.eventId}`},
        ${occurredAt},
        NOW(),
        NOW()
      )
      ON CONFLICT (entry_key) DO NOTHING
      RETURNING id
    `)
    const cumulative = await cumulativeSpendFen(req, order.customerId)
    if (inserted.rows?.[0]?.id === undefined) {
      return { achievementCount: 0, counted: false, cumulativeSpendFen: cumulative }
    }
    const rule = await applicableRule(req, new Date(occurredAt))
    if (!rule) return { achievementCount: 0, counted: true, cumulativeSpendFen: cumulative }
    const levels = await ruleLevels(req, rule)
    const current = await currentTierState(req, order.customerId)
    let currentRank = current?.tierRank ?? 0
    let achievementCount = 0
    for (const tier of levels) {
      if (tier.tierRank <= currentRank || BigInt(tier.thresholdFen) > BigInt(cumulative)) continue
      await insertTierEvent(req, {
        cumulativeSpendFen: cumulative,
        customerId: order.customerId,
        eventKey: `vip-tier:natural:${order.id}:${rule.version}:${tier.tierRank}`,
        eventType: 'tier_achievement',
        occurredAt,
        previousTierRank: currentRank,
        reason: '成功履约订单累计消费达到等级门槛',
        rule,
        source: 'natural_achievement',
        tier,
        triggerOrderId: order.id,
      })
      currentRank = tier.tierRank
      achievementCount += 1
    }
    return { achievementCount, counted: true, cumulativeSpendFen: cumulative }
  })
}

export async function recordVipSpendReversalForRefundedOrder(
  req: PayloadRequest,
  input: { eventId: number | string; orderId: number | string; occurredAt?: string },
): Promise<{ cumulativeSpendFen: number; reversed: boolean }> {
  return transaction(req, async () => {
    const source = await (
      await database(req)
    ).execute(sql`
      SELECT
        spend.amount_fen AS "amountFen",
        spend.customer_id AS "customerId"
      FROM vip_spend_entries AS spend
      INNER JOIN orders ON orders.id = spend.source_order_id
      WHERE spend.source_order_id = ${input.orderId}
        AND spend.entry_type = 'succeeded_order'
        AND orders.status = 'refunded'
      ORDER BY spend.id ASC
      LIMIT 1
      FOR SHARE OF spend
    `)
    const row = source.rows?.[0]
    if (!row) return { cumulativeSpendFen: 0, reversed: false }
    const customerId = numericId(row.customerId)
    const amountFen = safeInteger(row.amountFen, 'VIP_ORDER_AMOUNT_INVALID', '订单冻结应付金额无效')
    await lockCustomer(req, customerId)
    const inserted = await (
      await database(req)
    ).execute(sql`
      INSERT INTO vip_spend_entries (
        entry_key,
        customer_id,
        source_order_id,
        entry_type,
        amount_fen,
        reference,
        occurred_at,
        updated_at,
        created_at
      ) VALUES (
        ${`vip-order:${input.orderId}:reversed`},
        ${customerId},
        ${input.orderId},
        'order_reversal',
        ${amountFen},
        ${`order-event:${input.eventId}`},
        ${input.occurredAt ?? new Date().toISOString()},
        NOW(),
        NOW()
      )
      ON CONFLICT (entry_key) DO NOTHING
      RETURNING id
    `)
    const cumulative = await cumulativeSpendFen(req, customerId)
    const reversalId = inserted.rows?.[0]?.id
    if (reversalId === undefined) return { cumulativeSpendFen: cumulative, reversed: false }
    await recordAuditEvent(req, {
      action: 'vip.spend.order_reversed',
      actor: { type: 'system' },
      metadata: { amountFen, cumulativeSpendFen: cumulative, orderEventId: input.eventId },
      targetId: input.orderId,
    })
    return { cumulativeSpendFen: cumulative, reversed: true }
  })
}

export async function promoteCustomerVipTier(
  req: PayloadRequest,
  input: { customerId: number; reasonNote: string; tierCode: string },
  dependencies: { now?: () => Date } = {},
): Promise<{ eventId: number | string; tierRank: number }> {
  assertConfigurationAdmin(req)
  const promotion = vipOperationalPromotionSchema.parse(input)
  const occurredAt = (dependencies.now ?? (() => new Date()))().toISOString()
  return transaction(req, async () => {
    await lockCustomer(req, promotion.customerId)
    const rule = await applicableRule(req, new Date(occurredAt))
    if (!rule) throw new AppError('VIP_TIER_RULE_UNAVAILABLE', '当前没有已生效的 VIP 等级规则', 409)
    const tier = (await ruleLevels(req, rule)).find(
      (candidate) => candidate.tierCode === promotion.tierCode,
    )
    if (!tier) throw new AppError('VIP_TIER_NOT_FOUND', '未找到目标 VIP 等级', 404)
    const current = await currentTierState(req, promotion.customerId)
    const currentRank = current?.tierRank ?? 0
    if (tier.tierRank <= currentRank) {
      throw new AppError('VIP_PROMOTION_MUST_RAISE_TIER', '运营提升只能提高当前等级', 409)
    }
    const cumulative = await cumulativeSpendFen(req, promotion.customerId)
    const eventId = await insertTierEvent(req, {
      cumulativeSpendFen: cumulative,
      customerId: promotion.customerId,
      eventKey: `vip-tier:promotion:${promotion.customerId}:${randomUUID()}`,
      eventType: 'tier_achievement',
      occurredAt,
      previousTierRank: currentRank,
      reason: promotion.reasonNote,
      rule,
      source: 'operational_promotion',
      tier,
    })
    return { eventId, tierRank: tier.tierRank }
  })
}

export async function applyApprovedVipTierCorrection(
  req: PayloadRequest,
  input: {
    approvalRequestId: number | string
    correctionReference: string
    customerId: number
    reasonNote: string
    source: 'data_correction' | 'fraud_reversal'
    spendReversalFen: number
    targetTierCode: null | string
  },
  dependencies: { now?: () => Date } = {},
): Promise<{ cumulativeSpendFen: number; eventId: number | string; tierRank: number }> {
  if (req.context.adminApprovalExecution !== `vip_fraud_correction:${input.approvalRequestId}`) {
    throw new AppError('ADMIN_APPROVAL_REQUIRED', 'VIP 纠错降级必须通过已批准的高风险操作执行', 409)
  }
  if (!['data_correction', 'fraud_reversal'].includes(input.source)) {
    throw new AppError('VIP_CORRECTION_SOURCE_INVALID', 'VIP 纠错来源无效', 400)
  }
  if (!Number.isSafeInteger(input.spendReversalFen) || input.spendReversalFen < 0) {
    throw new AppError('VIP_CORRECTION_AMOUNT_INVALID', 'VIP 纠错金额必须是非负整数分', 400)
  }
  const occurredAt = (dependencies.now ?? (() => new Date()))().toISOString()
  return transaction(req, async () => {
    await lockCustomer(req, input.customerId)
    const current = await currentTierState(req, input.customerId)
    if (!current || current.tierRank === 0) {
      throw new AppError('VIP_CORRECTION_TIER_UNAVAILABLE', '用户当前没有可降低的 VIP 等级', 409)
    }
    const rule = await applicableRule(req, new Date(occurredAt))
    const levels = rule ? await ruleLevels(req, rule) : []
    const target =
      input.targetTierCode === null
        ? undefined
        : levels.find((candidate) => candidate.tierCode === input.targetTierCode)
    if (input.targetTierCode !== null && !target) {
      throw new AppError('VIP_TIER_NOT_FOUND', '未找到纠错目标 VIP 等级', 404)
    }
    const targetRank = target?.tierRank ?? 0
    if (targetRank >= current.tierRank) {
      throw new AppError('VIP_CORRECTION_MUST_LOWER_TIER', 'VIP 纠错只能降低当前等级', 409)
    }
    const beforeSpend = await cumulativeSpendFen(req, input.customerId)
    if (input.spendReversalFen > beforeSpend) {
      throw new AppError('VIP_CORRECTION_AMOUNT_EXCEEDS_SPEND', 'VIP 纠错金额超过累计消费', 409)
    }
    if (input.spendReversalFen > 0) {
      await (
        await database(req)
      ).execute(sql`
        INSERT INTO vip_spend_entries (
          entry_key,
          customer_id,
          entry_type,
          amount_fen,
          approval_request_id,
          reference,
          occurred_at,
          updated_at,
          created_at
        ) VALUES (
          ${`vip-correction:${input.approvalRequestId}:spend`},
          ${input.customerId},
          ${input.source},
          ${input.spendReversalFen},
          ${input.approvalRequestId},
          ${input.correctionReference},
          ${occurredAt},
          NOW(),
          NOW()
        )
        ON CONFLICT (entry_key) DO NOTHING
      `)
    }
    const cumulative = await cumulativeSpendFen(req, input.customerId)
    const eventId = await insertTierEvent(req, {
      approvalRequestId: input.approvalRequestId,
      correctionReference: input.correctionReference,
      cumulativeSpendFen: cumulative,
      customerId: input.customerId,
      eventKey: `vip-correction:${input.approvalRequestId}:tier`,
      eventType: 'tier_correction',
      occurredAt,
      previousTierRank: current.tierRank,
      reason: input.reasonNote.trim(),
      rule,
      source: input.source,
      tier: target,
    })
    return { cumulativeSpendFen: cumulative, eventId, tierRank: targetRank }
  })
}

export async function readCustomerVipStatus(
  req: PayloadRequest,
  dependencies: { now?: () => Date } = {},
) {
  if (!isCustomerUser(req.user)) throw new AppError('CUSTOMER_AUTH_REQUIRED', '请先登录', 401)
  const customerId = numericId(req.user.id)
  return transaction(req, async () => {
    const current = await currentTierState(req, customerId)
    const cumulative = await cumulativeSpendFen(req, customerId)
    const rule = await applicableRule(req, (dependencies.now ?? (() => new Date()))())
    const currentBenefits =
      current && current.tierRank > 0 && rule
        ? (await ruleLevels(req, rule)).find((level) => level.tierRank === current.tierRank)
        : undefined
    const events = await req.payload.find({
      collection: 'vipTierEvents',
      depth: 0,
      limit: 100,
      overrideAccess: false,
      req,
      sort: ['-occurredAt', '-id'],
      user: req.user,
      where: { customer: { equals: customerId } },
    })
    const orderedEvents = [...events.docs].sort(compareVipTierEventsNewestFirst)
    return {
      cumulativeSpendFen: cumulative,
      history: orderedEvents.map((event) => ({
        correctionReference: event.correctionReference ?? null,
        eventType: event.eventType,
        id: event.id,
        occurredAt: event.occurredAt,
        reason: event.reason,
        source: event.source,
        tierCode: event.tierCode ?? null,
        tierName: event.tierNameSnapshot,
        tierRank: event.tierRank,
      })),
      tier:
        !current || current.tierRank === 0
          ? null
          : {
              displayName: currentBenefits?.displayName ?? current.tierName,
              quotaBenefits: currentBenefits?.quotaBenefits ?? {},
              serviceContent: currentBenefits?.serviceContent ?? '',
              source: current.source,
              tierCode: current.tierCode,
              tierRank: current.tierRank,
            },
    }
  })
}

export async function recordVipTierCorrectionAppeal(req: PayloadRequest, rawInput: unknown) {
  if (!isCustomerUser(req.user)) throw new AppError('CUSTOMER_AUTH_REQUIRED', '请先登录', 401)
  const input = vipTierAppealCreateSchema.parse(rawInput)
  const customerId = numericId(req.user.id)
  return transaction(req, async () => {
    const event = (await req.payload.findByID({
      collection: 'vipTierEvents',
      depth: 0,
      id: input.tierEventId,
      overrideAccess: false,
      req,
      user: req.user,
    })) as VipTierEvent
    if (event.eventType !== 'tier_correction') {
      throw new AppError('VIP_TIER_APPEAL_FORBIDDEN', '只能申诉本人可见的 VIP 等级纠错记录', 403)
    }
    const submittedAt = new Date().toISOString()
    const appeal = await req.payload.create({
      collection: 'vipTierAppeals',
      data: {
        appealKey: `vip-appeal:${customerId}:${event.id}`,
        customer: customerId,
        statement: input.statement,
        submittedAt,
        tierEvent: numericId(event.id),
      },
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(req, {
      action: 'vip.tier_correction.appealed',
      actor: { id: customerId, type: 'customer' },
      metadata: { correctionEventId: event.id },
      targetId: appeal.id,
    })
    return { appealId: appeal.id, submittedAt }
  })
}
