import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { INVITATION_ABUSE_SIGNALS } from '@/collections/invitations'
import { AppError } from '@/lib/errors'
import type { OrderStatus } from '@/lib/domain'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { loadOperationsMonitoringThresholds } from '@/services/operations/monitoring-thresholds'
import { enqueueTransactionalSecurityNotification } from '@/services/notifications/outbox'
import {
  confirmPendingInvitationReward,
  earnPendingInvitationReward,
} from '@/services/points/ledger'

export type InvitationAbuseSignal = (typeof INVITATION_ABUSE_SIGNALS)[number]

const INVITATION_REWARD_SCAN_LIMIT = 100
const INVITATION_REWARD_ALERT_TEMPLATE = 'invitation-reward-withheld-v1'

type InvitationDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

type InvitationClaim = {
  claimId: number | string
  earningKey: string
  expiresAt: string
  inviteeCustomerId: number
  inviterCustomerId: number
  orderId: number | string
  points: number
  relationshipId: number | string
  ruleVersionNumber: number
}

function identifier(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) return value
  throw new AppError('INVITATION_REWARD_UNAVAILABLE', '邀请奖励暂时无法安全处理', 503)
}

function customerIdentifier(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError('INVITATION_REWARD_UNAVAILABLE', '邀请奖励暂时无法安全处理', 503)
  }
  return parsed
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError('INVITATION_RULE_INVALID', '邀请奖励规则配置无效', 503)
  }
  return parsed
}

async function database(req: PayloadRequest): Promise<InvitationDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as InvitationDatabase | undefined
  if (!current) {
    throw new AppError('INVITATION_REWARD_UNAVAILABLE', '邀请奖励暂时无法安全处理', 503)
  }
  return current
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

function claimFromRow(row: Record<string, unknown>): InvitationClaim {
  const expiresAt = new Date(String(row.expires_at))
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new AppError('INVITATION_REWARD_UNAVAILABLE', '邀请奖励暂时无法安全处理', 503)
  }
  return {
    claimId: identifier(row.id),
    earningKey: String(row.claim_key),
    expiresAt: expiresAt.toISOString(),
    inviteeCustomerId: customerIdentifier(row.invitee_customer_id),
    inviterCustomerId: customerIdentifier(row.inviter_customer_id),
    orderId: identifier(row.source_order_id),
    points: positiveInteger(row.points),
    relationshipId: identifier(row.relationship_id),
    ruleVersionNumber: positiveInteger(row.rule_version_number),
  }
}

async function lockClaimByInvitee(
  db: InvitationDatabase,
  inviteeCustomerId: number,
): Promise<InvitationClaim | undefined> {
  const result = await db.execute(sql`
    SELECT id, claim_key, relationship_id, inviter_customer_id, invitee_customer_id,
      source_order_id, rule_version_number, points, expires_at
    FROM invitation_reward_claims
    WHERE invitee_customer_id = ${inviteeCustomerId}
    FOR UPDATE
  `)
  return result.rows?.[0] ? claimFromRow(result.rows[0]) : undefined
}

async function claimFirstEligibleOrder(
  db: InvitationDatabase,
  input: { inviteeCustomerId: number; orderId: number | string },
): Promise<InvitationClaim | undefined> {
  await db.execute(sql`
    INSERT INTO invitation_reward_claims (
      claim_key,
      relationship_id,
      inviter_customer_id,
      invitee_customer_id,
      source_order_id,
      rule_version_id,
      rule_version_number,
      points,
      expires_at,
      updated_at,
      created_at
    )
    SELECT
      ${`invitation-reward:invitee:${input.inviteeCustomerId}`},
      relationship.id,
      relationship.inviter_customer_id,
      relationship.invitee_customer_id,
      orders.id,
      rule.id,
      rule.version,
      rule.reward_points,
      NOW() + make_interval(days => rule.reward_expiry_days::integer),
      NOW(),
      NOW()
    FROM invitation_relationships AS relationship
    JOIN orders ON orders.id = ${input.orderId}
      AND orders.customer_id = relationship.invitee_customer_id
      AND orders.customer_id = ${input.inviteeCustomerId}
      AND orders.status IN ('paid', 'fulfilling', 'succeeded')
    JOIN LATERAL (
      SELECT id, version, enabled, reward_points, reward_expiry_days
      FROM invitation_reward_rule_versions
      WHERE effective_at <= NOW()
      ORDER BY effective_at DESC, version DESC
      LIMIT 1
      FOR SHARE
    ) AS rule ON true
    WHERE relationship.invitee_customer_id = ${input.inviteeCustomerId}
      AND rule.enabled = true
    ON CONFLICT (invitee_customer_id) DO NOTHING
    RETURNING id
  `)
  return lockClaimByInvitee(db, input.inviteeCustomerId)
}

async function appendRewardEvent(
  db: InvitationDatabase,
  claim: InvitationClaim,
  eventType: 'available' | 'flagged_after_release' | 'pending' | 'withheld',
  input: { pointsBatchId?: number | string; signals?: InvitationAbuseSignal[] } = {},
): Promise<boolean> {
  const eventKey = `invitation-reward:${claim.claimId}:${eventType}`
  const inserted = await db.execute(sql`
    INSERT INTO invitation_reward_events (
      event_key,
      claim_id,
      inviter_customer_id,
      invitee_customer_id,
      event_type,
      points_batch_id,
      occurred_at,
      updated_at,
      created_at
    ) VALUES (
      ${eventKey},
      ${claim.claimId},
      ${claim.inviterCustomerId},
      ${claim.inviteeCustomerId},
      ${eventType},
      ${input.pointsBatchId ?? null},
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT (claim_id, event_type) DO NOTHING
    RETURNING id
  `)
  const eventId = inserted.rows?.[0]?.id
  if (eventId === undefined) return false
  for (const [order, signal] of (input.signals ?? []).entries()) {
    await db.execute(sql`
      INSERT INTO invitation_reward_events_signals ("order", parent_id, value)
      VALUES (${order + 1}, ${eventId}, ${signal})
    `)
  }
  return true
}

async function appendAuditedRewardEvent(
  req: PayloadRequest,
  db: InvitationDatabase,
  claim: InvitationClaim,
  eventType: 'available' | 'flagged_after_release' | 'pending' | 'withheld',
  input: { pointsBatchId?: number | string; signals?: InvitationAbuseSignal[] } = {},
): Promise<boolean> {
  if (!(await appendRewardEvent(db, claim, eventType, input))) return false
  await recordAuditEvent(req, {
    action: `invitation.reward.${eventType}`,
    actor: { type: 'system' },
    metadata: {
      inviteeCustomerId: String(claim.inviteeCustomerId),
      inviterCustomerId: String(claim.inviterCustomerId),
      relationshipId: String(claim.relationshipId),
      ruleVersionNumber: claim.ruleVersionNumber,
      orderId: String(claim.orderId),
      points: claim.points,
      expiresAt: claim.expiresAt,
      ...(input.pointsBatchId === undefined ? {} : { pointsBatchId: String(input.pointsBatchId) }),
      ...(input.signals ? { signals: input.signals } : {}),
    },
    targetId: claim.claimId,
  })
  return true
}

export async function detectInvitationAbuseSignals(
  req: PayloadRequest,
  claim: InvitationClaim,
): Promise<InvitationAbuseSignal[]> {
  const thresholds = await loadOperationsMonitoringThresholds(req)
  const result = await (
    await database(req)
  ).execute(sql`
    SELECT
      EXISTS (
        SELECT 1
        FROM invitation_relationships AS relationship
        JOIN customer_sessions AS inviter_session
          ON inviter_session.customer_id = relationship.inviter_customer_id
         AND inviter_session.device_hash = relationship.binding_device_hash
        WHERE relationship.id = ${claim.relationshipId}
      ) AS same_device_hash,
      EXISTS (
        SELECT 1
        FROM orders AS source_order
        JOIN realname_templates AS invitee_template
          ON invitee_template.id = source_order.realname_template_id
        JOIN realname_templates AS inviter_template
          ON inviter_template.customer_id = ${claim.inviterCustomerId}
         AND inviter_template.identity_document_type = invitee_template.identity_document_type
         AND inviter_template.identity_document_number = invitee_template.identity_document_number
         AND inviter_template.status = 'approved'
         AND inviter_template.disabled_at IS NULL
        WHERE source_order.id = ${claim.orderId}
          AND invitee_template.customer_id = ${claim.inviteeCustomerId}
          AND invitee_template.status = 'approved'
          AND invitee_template.disabled_at IS NULL
      ) AS same_realname_subject,
      EXISTS (
        SELECT 1
        FROM customer_identities AS invitee_identity
        JOIN customer_identities AS inviter_identity
          ON inviter_identity.provider = 'phone'
         AND inviter_identity.identifier_hash = invitee_identity.identifier_hash
         AND inviter_identity.customer_id = ${claim.inviterCustomerId}
        WHERE invitee_identity.provider = 'phone'
          AND invitee_identity.customer_id = ${claim.inviteeCustomerId}
      ) AS same_phone_hash,
      EXISTS (
        SELECT 1
        FROM (
          SELECT invitee_payment.payer_identifier_hash
          FROM payment_notifications AS invitee_payment
          JOIN orders AS invitee_order ON invitee_order.id = invitee_payment.order_id
          WHERE invitee_order.customer_id = ${claim.inviteeCustomerId}
            AND invitee_payment.signature_verified = true
            AND invitee_payment.confirmation_status = 'confirmed'
            AND invitee_payment.payer_identifier_hash IS NOT NULL
          UNION
          SELECT invitee_top_up.payer_identifier_hash
          FROM wallet_top_up_orders AS invitee_top_up
          WHERE invitee_top_up.customer_id = ${claim.inviteeCustomerId}
            AND invitee_top_up.status IN ('provider_confirmed', 'credited')
            AND invitee_top_up.payer_identifier_hash IS NOT NULL
        ) AS invitee_payer
        WHERE (
            EXISTS (
              SELECT 1
              FROM payment_notifications AS inviter_payment
              JOIN orders AS inviter_order ON inviter_order.id = inviter_payment.order_id
              WHERE inviter_order.customer_id = ${claim.inviterCustomerId}
                AND inviter_payment.signature_verified = true
                AND inviter_payment.confirmation_status = 'confirmed'
                AND inviter_payment.payer_identifier_hash = invitee_payer.payer_identifier_hash
            )
            OR EXISTS (
              SELECT 1
              FROM wallet_top_up_orders AS inviter_top_up
              WHERE inviter_top_up.customer_id = ${claim.inviterCustomerId}
                AND inviter_top_up.status IN ('provider_confirmed', 'credited')
                AND inviter_top_up.payer_identifier_hash = invitee_payer.payer_identifier_hash
            )
          )
      ) AS same_payment_account_hash,
      (
        SELECT COUNT(*)
        FROM invitation_relationships
        WHERE inviter_customer_id = ${claim.inviterCustomerId}
          AND bound_at >= NOW() - make_interval(mins => ${thresholds.windowMinutes})
      ) >= ${thresholds.abuse.invitationGrowthCount} AS abnormal_invitation_growth
  `)
  const row = result.rows?.[0]
  if (!row) throw new AppError('INVITATION_REWARD_UNAVAILABLE', '邀请奖励暂时无法安全处理', 503)
  return INVITATION_ABUSE_SIGNALS.filter((signal) => row[signal] === true)
}

async function alertInvitationAbuse(
  req: PayloadRequest,
  claim: InvitationClaim,
  eventType: 'flagged_after_release' | 'withheld',
  signals: InvitationAbuseSignal[],
  traceId: string,
): Promise<void> {
  const db = await database(req)
  if (!(await appendAuditedRewardEvent(req, db, claim, eventType, { signals }))) return
  await req.payload.create({
    collection: 'manualReviews',
    data: {
      customer: claim.inviterCustomerId,
      evidence: { signals },
      invitationRewardClaim: customerIdentifier(claim.claimId),
      reasonCode: `invitation.reward.${eventType}`,
      status: 'open',
    },
    overrideAccess: true,
    req,
  })
  await enqueueTransactionalSecurityNotification(req, {
    body: '邀请奖励因风险信号进入人工复核；已发放奖励不会自动扣回。',
    customerId: claim.inviterCustomerId,
    domainEventType: `invitation.reward.${eventType}`,
    eventKey: `invitation-reward:${claim.claimId}:${eventType}:alert`,
    notificationType: 'invitation_reward_withheld',
    subject: '邀请奖励进入人工复核',
    templateKey: INVITATION_REWARD_ALERT_TEMPLATE,
    templateVersion: 1,
    traceId,
  })
}

export async function processInvitationRewardForOrderTransition(
  req: PayloadRequest,
  input: {
    eventId: number | string
    orderId: number | string
    status: Extract<OrderStatus, 'fulfilling' | 'paid' | 'succeeded'>
    traceId: string
  },
): Promise<{ outcome: 'available' | 'ignored' | 'pending' | 'withheld' }> {
  return transaction(req, async () => {
    const db = await database(req)
    const order = await db.execute(sql`
      SELECT customer_id
      FROM orders
      WHERE id = ${input.orderId}
      FOR SHARE
    `)
    const row = order.rows?.[0]
    if (!row) throw new AppError('INVITATION_REWARD_ORDER_INVALID', '邀请奖励订单状态无效', 409)
    const inviteeCustomerId = customerIdentifier(row.customer_id)
    const claim = await claimFirstEligibleOrder(db, {
      inviteeCustomerId,
      orderId: input.orderId,
    })
    if (!claim || String(claim.orderId) !== String(input.orderId)) return { outcome: 'ignored' }

    const earned = await earnPendingInvitationReward(req, {
      customerId: claim.inviterCustomerId,
      earningKey: claim.earningKey,
      expiresAt: claim.expiresAt,
      orderId: claim.orderId,
      orderTransitionEventId: input.eventId,
      points: claim.points,
      sourceCustomerId: claim.inviteeCustomerId,
      transitionStatus: input.status,
    })
    const pointsBatchId = earned.batchId
    await appendAuditedRewardEvent(req, db, claim, 'pending', { pointsBatchId })
    if (input.status !== 'succeeded') return { outcome: 'pending' }

    const signals = await detectInvitationAbuseSignals(req, claim)
    if (signals.length > 0) {
      await alertInvitationAbuse(req, claim, 'withheld', signals, input.traceId)
      return { outcome: 'withheld' }
    }
    const confirmed = await confirmPendingInvitationReward(req, {
      earningKey: claim.earningKey,
      orderTransitionEventId: input.eventId,
    })
    await appendAuditedRewardEvent(req, db, claim, 'available', {
      pointsBatchId: confirmed.batchId,
    })
    return { outcome: 'available' }
  })
}

export async function recheckInvitationRewardClaim(
  req: PayloadRequest,
  input: { claimId: number | string; traceId: string },
): Promise<{ flagged: boolean }> {
  return transaction(req, async () => {
    const db = await database(req)
    const selected = await db.execute(sql`
      SELECT id, claim_key, relationship_id, inviter_customer_id, invitee_customer_id,
        source_order_id, rule_version_number, points, expires_at
      FROM invitation_reward_claims
      WHERE id = ${input.claimId}
        AND EXISTS (
          SELECT 1 FROM invitation_reward_events
          WHERE claim_id = invitation_reward_claims.id AND event_type = 'available'
        )
      FOR UPDATE
    `)
    if (!selected.rows?.[0]) return { flagged: false }
    const claim = claimFromRow(selected.rows[0])
    const signals = await detectInvitationAbuseSignals(req, claim)
    if (signals.length === 0) return { flagged: false }
    await alertInvitationAbuse(req, claim, 'flagged_after_release', signals, input.traceId)
    return { flagged: true }
  })
}

export async function scanReleasedInvitationRewardsForAbuse(
  req: PayloadRequest,
  input: { limit?: number; traceId: string },
): Promise<{ flaggedCount: number; scannedCount: number }> {
  const limit = input.limit ?? INVITATION_REWARD_SCAN_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > INVITATION_REWARD_SCAN_LIMIT) {
    throw new AppError('INVITATION_REWARD_SCAN_LIMIT_INVALID', '邀请奖励巡检数量无效', 400)
  }
  return transaction(req, async () => {
    const result = await (
      await database(req)
    ).execute(sql`
      SELECT claims.id
      FROM invitation_reward_claims AS claims
      WHERE EXISTS (
        SELECT 1 FROM invitation_reward_events
        WHERE claim_id = claims.id AND event_type = 'available'
      )
        AND NOT EXISTS (
          SELECT 1 FROM invitation_reward_events
          WHERE claim_id = claims.id AND event_type = 'flagged_after_release'
      )
      ORDER BY claims.id ASC
      LIMIT ${limit}
    `)
    let flaggedCount = 0
    for (const [index, row] of (result.rows ?? []).entries()) {
      const checked = await recheckInvitationRewardClaim(req, {
        claimId: identifier(row.id),
        traceId: `${input.traceId}:${index}`,
      })
      if (checked.flagged) flaggedCount += 1
    }
    return { flaggedCount, scannedCount: result.rows?.length ?? 0 }
  })
}
