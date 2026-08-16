import { randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

import { hasRole } from '@/access/roles'
import {
  CUSTOMER_ACCOUNT_STATUSES,
  type CustomerAccountStatus,
  type CustomerCapabilityRestriction,
} from '@/lib/domain'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import type { AccountRecoveryDecisionInput, AccountRecoveryRequestInput } from '@/schemas/auth'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

import { accountRestrictions, transitionCustomerAccount } from './account-state'
import { authTransactionDatabase, inAuthTransaction } from './atomic'
import { normalizeChinesePhone } from './client-facts'
import {
  activeCustomerIdentities,
  notifyFormerCustomerIdentities,
  type IdentityRecord,
} from './customer-identities'
import { revokeAllCustomerSessions } from './customer-sessions'
import { recordCustomerSecurityEvent } from './security-events'

const RECOVERY_REASON_CODE = 'customer_account_recovery'

type VerifiedRecoveryEvidence = {
  customerId: number
  orderId: number
  paymentNotificationId: number
  realnameTemplateId: number
}

type RecoveryAccountState = {
  capabilityRestrictions: CustomerCapabilityRestriction[]
  cooldownStartedAt?: string
  status: CustomerAccountStatus
}

function invalidEvidence(): AppError {
  return new AppError('ACCOUNT_RECOVERY_EVIDENCE_INVALID', '账户找回证据不完整或无法核验', 403)
}

function positiveId(value: unknown): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw invalidEvidence()
  return id
}

function assertAllLoginChannelsUnavailable(input: AccountRecoveryRequestInput): void {
  if (input.phoneUnavailable !== true) {
    throw new AppError(
      'ACCOUNT_RECOVERY_CHANNEL_STILL_AVAILABLE',
      '仅受理全部登录渠道均不可用的找回',
      409,
    )
  }
  if (input.wechatUnavailable !== true) {
    throw new AppError(
      'ACCOUNT_RECOVERY_CHANNEL_STILL_AVAILABLE',
      '仅受理全部登录渠道均不可用的找回',
      409,
    )
  }
}

export async function verifyAccountRecoveryEvidence(
  req: PayloadRequest,
  input: AccountRecoveryRequestInput,
): Promise<VerifiedRecoveryEvidence> {
  let phone: string
  try {
    phone = normalizeChinesePhone(input.phone)
  } catch {
    throw invalidEvidence()
  }

  let row: Record<string, unknown> | undefined
  try {
    const database = await authTransactionDatabase(req)
    const verified = await database.execute(sql`
      SELECT
        customers.id AS customer_id,
        realname_templates.id AS realname_template_id,
        orders.id AS order_id,
        payment_notifications.id AS payment_notification_id
      FROM customers
      INNER JOIN realname_templates
        ON realname_templates.customer_id = customers.id
      INNER JOIN orders
        ON orders.customer_id = customers.id
      INNER JOIN payment_notifications
        ON payment_notifications.order_id = orders.id
      WHERE customers.phone = ${phone}
        AND realname_templates.full_name_chinese = ${input.fullNameChinese}
        AND realname_templates.identity_document_number = ${input.identityDocumentNumber}
        AND orders.order_number = ${input.historicalOrderNumber}
        AND payment_notifications.wechat_transaction_id = ${input.paymentTransactionId}
        AND payment_notifications.signature_verified = TRUE
        AND payment_notifications.confirmation_status = 'confirmed'
      LIMIT 1
    `)
    row = verified.rows?.[0]
  } catch {
    throw new AppError('ACCOUNT_RECOVERY_EVIDENCE_UNAVAILABLE', '账户找回证据暂时无法核验', 503)
  }
  if (!row) throw invalidEvidence()
  return {
    customerId: positiveId(row.customer_id),
    orderId: positiveId(row.order_id),
    paymentNotificationId: positiveId(row.payment_notification_id),
    realnameTemplateId: positiveId(row.realname_template_id),
  }
}

export async function submitAccountRecoveryRequest(
  req: PayloadRequest,
  input: AccountRecoveryRequestInput,
): Promise<{ recoveryRequestId: string; status: 'manual_review'; submittedAt: string }> {
  assertAllLoginChannelsUnavailable(input)
  return inAuthTransaction(req, async () => {
    const evidence = await verifyAccountRecoveryEvidence(req, input)
    const requestKey = randomUUID()
    const submittedAt = new Date().toISOString()
    const manualReview = await req.payload.create({
      collection: 'manualReviews',
      data: {
        customer: evidence.customerId,
        evidence: {
          paymentNotificationId: evidence.paymentNotificationId,
          recoveryRequestId: requestKey,
          unavailableProviders: ['phone', 'wechat'],
        },
        order: evidence.orderId,
        paymentNotification: evidence.paymentNotificationId,
        realnameTemplate: evidence.realnameTemplateId,
        reasonCode: RECOVERY_REASON_CODE,
        status: 'open',
      },
      overrideAccess: true,
      req,
    })
    await req.payload.create({
      collection: 'accountRecoveryRecords',
      data: {
        customer: evidence.customerId,
        eventType: 'request_submitted',
        manualReview: manualReview.id,
        occurredAt: submittedAt,
        order: evidence.orderId,
        paymentNotification: evidence.paymentNotificationId,
        realnameTemplate: evidence.realnameTemplateId,
        recordKey: `${requestKey}:request_submitted`,
        requestKey,
        unavailableProviders: ['phone', 'wechat'],
      },
      overrideAccess: true,
      req,
    })
    await recordCustomerSecurityEvent(req, evidence.customerId, 'account_recovery_requested', {
      manualReviewId: manualReview.id,
      recoveryRequestId: requestKey,
    })
    await recordAuditEvent(req, {
      action: 'customer.account_recovery.requested',
      actor: { type: 'anonymous' },
      metadata: {
        manualReviewId: manualReview.id,
        orderId: evidence.orderId,
        paymentNotificationId: evidence.paymentNotificationId,
        realnameTemplateId: evidence.realnameTemplateId,
        recoveryRequestId: requestKey,
      },
      targetId: evidence.customerId,
    })
    return { recoveryRequestId: requestKey, status: 'manual_review' as const, submittedAt }
  })
}

function systemAdminReviewerId(req: PayloadRequest, reviewerId: number | string): number {
  const normalizedReviewerId = Number(reviewerId)
  if (
    hasRole(req.user, ['system_admin']) &&
    String(req.user?.id) === String(reviewerId) &&
    Number.isSafeInteger(normalizedReviewerId) &&
    normalizedReviewerId > 0
  ) {
    return normalizedReviewerId
  }
  throw new AppError('ACCOUNT_RECOVERY_REVIEW_FORBIDDEN', '仅系统管理员可审核账户找回', 403)
}

function accountStatus(value: unknown): CustomerAccountStatus {
  if ((CUSTOMER_ACCOUNT_STATUSES as readonly unknown[]).includes(value)) {
    return value as CustomerAccountStatus
  }
  throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)
}

export async function loadRecoveryAccountState(
  req: PayloadRequest,
  customerId: number,
): Promise<RecoveryAccountState> {
  let row: Record<string, unknown> | undefined
  try {
    const database = await authTransactionDatabase(req)
    const state = await database.execute(sql`
      SELECT id, status, capability_restrictions, identity_risk_cooldown_started_at
      FROM customers
      WHERE id = ${customerId}
      FOR UPDATE
    `)
    row = state.rows?.[0]
  } catch {
    throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)
  }
  if (!row) {
    throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)
  }
  if (positiveId(row.id) !== customerId) {
    throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)
  }
  const status = accountStatus(row.status)
  let capabilityRestrictions: CustomerCapabilityRestriction[]
  try {
    capabilityRestrictions = accountRestrictions({
      capabilityRestrictions: row.capability_restrictions,
      id: customerId,
      status,
    })
  } catch {
    throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)
  }
  if (
    (status === 'restricted' && capabilityRestrictions.length === 0) ||
    (status !== 'restricted' && capabilityRestrictions.length > 0)
  ) {
    throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)
  }
  let cooldownStartedAt: string | undefined
  if (row.identity_risk_cooldown_started_at) {
    const cooldownStartedAtMs = new Date(String(row.identity_risk_cooldown_started_at)).getTime()
    if (!Number.isFinite(cooldownStartedAtMs)) {
      throw new AppError('ACCOUNT_RECOVERY_STATE_UNAVAILABLE', '账户状态暂时无法核验', 503)
    }
    cooldownStartedAt = new Date(cooldownStartedAtMs).toISOString()
  }
  return {
    capabilityRestrictions,
    ...(cooldownStartedAt ? { cooldownStartedAt } : {}),
    status,
  }
}

async function recoveryRequestRecord(
  req: PayloadRequest,
  reviewId: number,
): Promise<{ requestKey: string }> {
  const database = await authTransactionDatabase(req)
  const records = await database.execute(sql`
    SELECT request_key
    FROM account_recovery_records
    WHERE manual_review_id = ${reviewId}
      AND event_type = 'request_submitted'
      AND realname_template_id IS NOT NULL
      AND order_id IS NOT NULL
      AND payment_notification_id IS NOT NULL
    ORDER BY id ASC
    LIMIT 1
    FOR SHARE
  `)
  const requestKey = String(records.rows?.[0]?.request_key ?? '')
  if (!requestKey) throw invalidEvidence()
  return { requestKey }
}

export async function startRecoveryCooldown(
  req: PayloadRequest,
  input: {
    customerId: number
    expectedCooldownStartedAt?: string
    expectedRestrictions: CustomerCapabilityRestriction[]
    expectedStatus: CustomerAccountStatus
    startedAt: string
  },
): Promise<void> {
  const database = await authTransactionDatabase(req)
  const expectedRestrictionsJson = JSON.stringify(input.expectedRestrictions)
  const updated = await database.execute(sql`
    UPDATE customers
    SET identity_risk_cooldown_started_at = ${input.startedAt}, updated_at = NOW()
    WHERE id = ${input.customerId}
      AND status = ${input.expectedStatus}
      AND capability_restrictions = ${expectedRestrictionsJson}::jsonb
      AND identity_risk_cooldown_started_at IS NOT DISTINCT FROM
        ${input.expectedCooldownStartedAt ?? null}::timestamptz
    RETURNING id
  `)
  if (updated.rows?.[0]?.id === undefined) {
    throw new AppError('ACCOUNT_RECOVERY_STATE_CONFLICT', '账户状态或冷静期已变化，请重新核验', 409)
  }
}

export async function decideAccountRecovery(
  req: PayloadRequest,
  input: {
    decision: AccountRecoveryDecisionInput
    reviewId: number
    reviewerId: number | string
    traceId: string
  },
): Promise<{
  conclusion: 'approved' | 'rejected'
  cooldownEndsAt?: string
  cooldownStartedAt?: string
  customerId: number
  decidedAt: string
  reviewId: number
  revokedSessionCount: number
}> {
  const reviewerId = systemAdminReviewerId(req, input.reviewerId)
  const result = await inAuthTransaction(req, async () => {
    const database = await authTransactionDatabase(req)
    const decidedAt = new Date().toISOString()
    const claimed = await database.execute(sql`
      UPDATE manual_reviews
      SET
        status = 'resolved',
        resolution_note = ${input.decision.note},
        resolved_by_id = ${reviewerId},
        resolved_at = ${decidedAt},
        updated_at = NOW()
      WHERE id = ${input.reviewId}
        AND reason_code = ${RECOVERY_REASON_CODE}
        AND status = 'open'
      RETURNING id, customer_id
    `)
    const claimedRow = claimed.rows?.[0]
    if (!claimedRow) {
      throw new AppError(
        'ACCOUNT_RECOVERY_DECISION_ALREADY_CONSUMED',
        '账户找回审核已处理或不可用',
        409,
      )
    }
    const customerId = positiveId(claimedRow.customer_id)
    const request = await recoveryRequestRecord(req, input.reviewId)
    const state = await loadRecoveryAccountState(req, customerId)

    let cooldownStartedAt: string | undefined
    let cooldownEndsAt: string | undefined
    let revokedSessionCount = 0
    let identities: IdentityRecord[] = []
    let finalStatus = state.status
    let finalRestrictions = state.capabilityRestrictions
    if (input.decision.conclusion === 'approved') {
      if (!['active', 'restricted', 'suspended'].includes(state.status)) {
        throw new AppError('ACCOUNT_RECOVERY_STATE_INVALID', '当前账户状态不允许完成找回', 409)
      }
      if (state.status === 'suspended') {
        const transitioned = await transitionCustomerAccount(req, {
          actor: { id: reviewerId, type: 'admin' },
          changedAt: decidedAt,
          customerId,
          evidence: {
            observedAt: decidedAt,
            reference: `manual-review:${input.reviewId}`,
            source: 'manual_review',
          },
          expectedRestrictions: state.capabilityRestrictions,
          expectedStatus: state.status,
          reason: 'account_recovery_approved',
          restrictions: [],
          status: 'active',
        })
        finalStatus = transitioned.status
        finalRestrictions = transitioned.capabilityRestrictions
      }
      cooldownStartedAt = decidedAt
      cooldownEndsAt = new Date(
        new Date(decidedAt).getTime() + getEnv().IDENTITY_RISK_COOLDOWN_SECONDS * 1_000,
      ).toISOString()
      await startRecoveryCooldown(req, {
        customerId,
        expectedCooldownStartedAt: state.cooldownStartedAt,
        expectedRestrictions: finalRestrictions,
        expectedStatus: finalStatus,
        startedAt: cooldownStartedAt,
      })
      revokedSessionCount = await revokeAllCustomerSessions(
        req,
        customerId,
        'account_recovery_approved',
      )
      identities = await activeCustomerIdentities(req, customerId)
      if (identities.length === 0) {
        throw new AppError(
          'ACCOUNT_RECOVERY_IDENTITIES_MISSING',
          '找回账户没有可告知的旧绑定渠道',
          409,
        )
      }
    }

    await req.payload.create({
      collection: 'accountRecoveryRecords',
      data: {
        conclusion: input.decision.conclusion,
        cooldownEndsAt,
        cooldownStartedAt,
        customer: customerId,
        decisionNote: input.decision.note,
        eventType: 'review_concluded',
        manualReview: input.reviewId,
        occurredAt: decidedAt,
        recordKey: `${request.requestKey}:review_concluded`,
        requestKey: request.requestKey,
        reviewer: reviewerId,
        revokedSessionCount,
      },
      overrideAccess: true,
      req,
    })
    await recordCustomerSecurityEvent(req, customerId, 'account_recovery_decided', {
      conclusion: input.decision.conclusion,
      cooldownEndsAt,
      cooldownStartedAt,
      manualReviewId: input.reviewId,
      revokedSessionCount,
    })
    await recordAuditEvent(req, {
      action: 'customer.account_recovery.decided',
      actor: { id: reviewerId, type: 'admin' },
      metadata: {
        conclusion: input.decision.conclusion,
        cooldownEndsAt,
        cooldownStartedAt,
        manualReviewId: input.reviewId,
        recoveryRequestId: request.requestKey,
        revokedSessionCount,
      },
      targetId: customerId,
    })
    return {
      conclusion: input.decision.conclusion,
      ...(cooldownEndsAt ? { cooldownEndsAt } : {}),
      ...(cooldownStartedAt ? { cooldownStartedAt } : {}),
      customerId,
      decidedAt,
      identities,
      reviewId: input.reviewId,
      revokedSessionCount,
    }
  })
  if (result.conclusion === 'approved') {
    await notifyFormerCustomerIdentities(req, result.customerId, result.identities, input.traceId)
  }
  return {
    conclusion: result.conclusion,
    ...(result.cooldownEndsAt ? { cooldownEndsAt: result.cooldownEndsAt } : {}),
    ...(result.cooldownStartedAt ? { cooldownStartedAt: result.cooldownStartedAt } : {}),
    customerId: result.customerId,
    decidedAt: result.decidedAt,
    reviewId: result.reviewId,
    revokedSessionCount: result.revokedSessionCount,
  }
}
