import { randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

import { hasRole, isCustomerUser } from '@/access/roles'
import {
  ACCOUNT_CLOSURE_BLOCKERS,
  type AccountClosureBlocker,
  type CustomerAccountStatus,
  type CustomerCapabilityRestriction,
} from '@/lib/domain'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import type { Customer } from '@/payload-types'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { disableCustomerRealnameTemplates } from '@/services/realname/lifecycle'

import { accountRestrictions, transitionCustomerAccount } from './account-state'
import { authTransactionDatabase, inAuthTransaction } from './atomic'
import { recordCustomerSecurityEvent } from './security-events'
import { authorizeStepUpGrant } from './step-up'

type BaseBlocker = Exclude<
  AccountClosureBlocker,
  'closure_cooldown_active' | `${string}_check_unavailable`
>

type ClosureRequestRecord = {
  blockers: AccountClosureBlocker[]
  cooldownEndsAt: string
  cooldownStartedAt: string
  customerId: number
  reason: string
  requestKey: string
  requestedAt: string
}

type ClosureClaim = {
  capabilityRestrictions: CustomerCapabilityRestriction[]
  customerId: number
  status: CustomerAccountStatus
}

type Database = Awaited<ReturnType<typeof authTransactionDatabase>>

function unavailableBlocker(blocker: BaseBlocker): AccountClosureBlocker {
  return `${blocker}_check_unavailable` as AccountClosureBlocker
}

function positiveId(value: unknown): number {
  const id = Number(value)
  if (Number.isSafeInteger(id) && id > 0) return id
  throw new AppError('ACCOUNT_CLOSURE_STATE_UNAVAILABLE', '账户关闭状态暂时无法核验', 503)
}

function databaseBoolean(value: unknown): boolean {
  if (value === true || value === false) return value
  throw new Error('closure precondition query did not return a boolean')
}

async function domainsHeld(database: Database, customerId: number): Promise<boolean> {
  const result = await database.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM domain_assets
      WHERE customer_id = ${customerId}
    ) AS blocked
  `)
  return databaseBoolean(result.rows?.[0]?.blocked)
}

async function unfinishedOrders(database: Database, customerId: number): Promise<boolean> {
  const result = await database.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM orders
      WHERE customer_id = ${customerId}
        AND status NOT IN ('succeeded', 'refunded', 'cancelled')
    ) AS blocked
  `)
  return databaseBoolean(result.rows?.[0]?.blocked)
}

async function pendingAutomaticRenewals(database: Database, customerId: number): Promise<boolean> {
  const result = await database.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM renewals
      WHERE customer_id = ${customerId}
        AND status IN ('pending', 'manual_review')
    ) AS blocked
  `)
  return databaseBoolean(result.rows?.[0]?.blocked)
}

async function refundOrReconciliationIssue(
  database: Database,
  customerId: number,
): Promise<boolean> {
  const result = await database.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM refunds
      INNER JOIN orders ON orders.id = refunds.order_id
      WHERE orders.customer_id = ${customerId}
        AND refunds.status <> 'succeeded'
      UNION ALL
      SELECT 1
      FROM reconciliations
      INNER JOIN orders
        ON reconciliations.record_key = 'order:' || orders.order_number
        OR reconciliations.summary ->> 'orderNumber' = orders.order_number
      WHERE orders.customer_id = ${customerId}
        AND reconciliations.status IN ('pending', 'difference')
    ) AS blocked
  `)
  return databaseBoolean(result.rows?.[0]?.blocked)
}

async function invoiceProcessing(database: Database, customerId: number): Promise<boolean> {
  const result = await database.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM (
        SELECT DISTINCT ON (order_manual_actions.order_id)
          order_manual_actions.invoice_status
        FROM order_manual_actions
        INNER JOIN orders ON orders.id = order_manual_actions.order_id
        WHERE orders.customer_id = ${customerId}
          AND order_manual_actions.action_type = 'invoice_note'
        ORDER BY
          order_manual_actions.order_id,
          order_manual_actions.recorded_at DESC,
          order_manual_actions.id DESC
      ) AS latest_invoice_actions
      WHERE latest_invoice_actions.invoice_status = 'processing'
    ) AS blocked
  `)
  return databaseBoolean(result.rows?.[0]?.blocked)
}

async function securityFreezeOrDispute(database: Database, customerId: number): Promise<boolean> {
  const result = await database.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM customers
      WHERE id = ${customerId}
        AND (
          status = 'suspended'
          OR capability_restrictions ? 'refund_review'
        )
      UNION ALL
      SELECT 1
      FROM manual_reviews
      WHERE customer_id = ${customerId}
        AND status = 'open'
      UNION ALL
      SELECT 1
      FROM refunds
      INNER JOIN orders ON orders.id = refunds.order_id
      WHERE orders.customer_id = ${customerId}
        AND refunds.failure_category = 'disputed'
        AND refunds.status <> 'succeeded'
    ) AS blocked
  `)
  return databaseBoolean(result.rows?.[0]?.blocked)
}

async function positiveBalance(database: Database, customerId: number): Promise<boolean> {
  const relation = await database.execute(sql`
    SELECT to_regclass('wallet_accounts')::text AS relation_name
  `)
  if (!relation.rows?.[0]?.relation_name) return false
  const result = await database.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM wallet_accounts
      WHERE customer_id = ${customerId}
        AND posted_balance - held_balance > 0
    ) AS blocked
  `)
  return databaseBoolean(result.rows?.[0]?.blocked)
}

const PRECONDITION_CHECKS: ReadonlyArray<
  readonly [BaseBlocker, (database: Database, customerId: number) => Promise<boolean>]
> = [
  ['domains_held', domainsHeld],
  ['unfinished_orders', unfinishedOrders],
  ['pending_automatic_renewals', pendingAutomaticRenewals],
  ['refund_or_reconciliation_issue', refundOrReconciliationIssue],
  ['invoice_processing', invoiceProcessing],
  ['security_freeze_or_dispute', securityFreezeOrDispute],
  ['positive_balance', positiveBalance],
]

export async function collectAccountClosureBlockers(
  req: PayloadRequest,
  customerId: number,
): Promise<AccountClosureBlocker[]> {
  const database = await authTransactionDatabase(req)
  const blockers: AccountClosureBlocker[] = []
  for (const [blocker, check] of PRECONDITION_CHECKS) {
    try {
      if (await check(database, customerId)) blockers.push(blocker)
    } catch {
      blockers.push(unavailableBlocker(blocker))
    }
  }
  return blockers
}

function closureBlockers(value: unknown): AccountClosureBlocker[] {
  if (
    !Array.isArray(value) ||
    new Set(value).size !== value.length ||
    !value.every((item): item is AccountClosureBlocker =>
      (ACCOUNT_CLOSURE_BLOCKERS as readonly unknown[]).includes(item),
    )
  ) {
    throw new AppError('ACCOUNT_CLOSURE_STATE_UNAVAILABLE', '账户关闭状态暂时无法核验', 503)
  }
  return value
}

function validTimestamp(value: unknown): string {
  const timestamp = new Date(String(value)).getTime()
  if (!Number.isFinite(timestamp)) {
    throw new AppError('ACCOUNT_CLOSURE_STATE_UNAVAILABLE', '账户关闭状态暂时无法核验', 503)
  }
  return new Date(timestamp).toISOString()
}

async function requestedClosure(
  req: PayloadRequest,
  requestKey: string,
): Promise<ClosureRequestRecord> {
  const database = await authTransactionDatabase(req)
  let row: Record<string, unknown> | undefined
  try {
    const result = await database.execute(sql`
      SELECT
        request_key,
        customer_id,
        requested_at,
        reason,
        current_blockers,
        cooldown_started_at,
        cooldown_ends_at
      FROM account_closure_requests
      WHERE request_key = ${requestKey}
        AND event_type = 'requested'
      LIMIT 1
      FOR SHARE
    `)
    row = result.rows?.[0]
  } catch {
    throw new AppError('ACCOUNT_CLOSURE_STATE_UNAVAILABLE', '账户关闭状态暂时无法核验', 503)
  }
  if (!row) {
    throw new AppError('ACCOUNT_CLOSURE_REQUEST_NOT_FOUND', '未找到有效的账户关闭申请', 404)
  }
  return {
    blockers: closureBlockers(row.current_blockers),
    cooldownEndsAt: validTimestamp(row.cooldown_ends_at),
    cooldownStartedAt: validTimestamp(row.cooldown_started_at),
    customerId: positiveId(row.customer_id),
    reason: String(row.reason),
    requestKey,
    requestedAt: validTimestamp(row.requested_at),
  }
}

function assertCustomerActor(req: PayloadRequest, customerId: number | string): void {
  if (isCustomerUser(req.user) && String(req.user.id) === String(customerId)) return
  throw new AppError('ACCOUNT_CLOSURE_FORBIDDEN', '无权管理该账户关闭申请', 403)
}

function systemAdminId(req: PayloadRequest, actorId: number | string): number {
  const id = Number(actorId)
  if (
    hasRole(req.user, ['system_admin']) &&
    String(req.user?.id) === String(actorId) &&
    Number.isSafeInteger(id) &&
    id > 0
  ) {
    return id
  }
  throw new AppError('ACCOUNT_CLOSURE_EXECUTION_FORBIDDEN', '仅系统管理员可执行账户关闭', 403)
}

async function appendClosureRecord(
  req: PayloadRequest,
  input: ClosureRequestRecord & {
    actorId: number | string
    actorType: 'admin' | 'customer'
    anonymizationResult?: Record<string, unknown>
    blockers: AccountClosureBlocker[]
    dataRetentionResult?: Record<string, unknown>
    eventType: 'blockers_refreshed' | 'executed' | 'requested' | 'revoked'
    executedAt?: string
    identityRebindAllowedAt?: string
    revokedAt?: string
    stepUpGrantId?: number | string
  },
): Promise<void> {
  const recordKey =
    input.eventType === 'requested'
      ? `${input.requestKey}:requested`
      : `${input.requestKey}:${input.eventType}:${randomUUID()}`
  await req.payload.create({
    collection: 'accountClosureRequests',
    data: {
      actorId: String(input.actorId),
      actorType: input.actorType,
      anonymizationResult: input.anonymizationResult,
      cooldownEndsAt: input.cooldownEndsAt,
      cooldownStartedAt: input.cooldownStartedAt,
      currentBlockers: input.blockers,
      customer: input.customerId,
      dataRetentionResult: input.dataRetentionResult,
      eventType: input.eventType,
      executedAt: input.executedAt,
      identityRebindAllowedAt: input.identityRebindAllowedAt,
      reason: input.reason,
      recordKey,
      requestKey: input.requestKey,
      requestedAt: input.requestedAt,
      revokedAt: input.revokedAt,
      stepUpGrant: input.stepUpGrantId === undefined ? undefined : positiveId(input.stepUpGrantId),
    },
    overrideAccess: true,
    req,
  })
}

export async function requestAccountClosure(
  req: PayloadRequest,
  customer: Customer,
  input: { deviceId: string; reason: string; stepUpToken: string },
): Promise<{
  blockers: AccountClosureBlocker[]
  cooldownEndsAt: string
  deletionRequestedAt: string
  requestId: string
  status: 'pending'
}> {
  assertCustomerActor(req, customer.id)
  if (customer.status !== 'active' && customer.status !== 'restricted') {
    throw new AppError('ACCOUNT_STATE_TRANSITION_INVALID', '当前账号状态不可申请注销', 409)
  }
  return inAuthTransaction(req, async () => {
    const grant = await authorizeStepUpGrant(req, {
      customerId: customer.id,
      deviceId: input.deviceId,
      headers: req.headers,
      purpose: 'account_deletion',
      stepUpToken: input.stepUpToken,
    })
    const database = await authTransactionDatabase(req)
    const requestKey = randomUUID()
    const requestedAt = new Date().toISOString()
    const cooldownEndsAt = new Date(
      new Date(requestedAt).getTime() + getEnv().ACCOUNT_CLOSURE_COOLDOWN_SECONDS * 1_000,
    ).toISOString()
    const blockers = await collectAccountClosureBlockers(req, customer.id)
    const claimed = await database.execute(sql`
      UPDATE customers
      SET
        active_account_closure_request_key = ${requestKey},
        account_closure_version = account_closure_version + 1,
        updated_at = NOW()
      WHERE id = ${customer.id}
        AND status IN ('active', 'restricted')
        AND active_account_closure_request_key IS NULL
        AND account_closure_execution_claimed_at IS NULL
      RETURNING id
    `)
    if (claimed.rows?.[0]?.id === undefined) {
      throw new AppError(
        'ACCOUNT_CLOSURE_REQUEST_CONFLICT',
        '账户状态已变化或已有关闭申请，请刷新后重试',
        409,
      )
    }
    const record: ClosureRequestRecord = {
      blockers,
      cooldownEndsAt,
      cooldownStartedAt: requestedAt,
      customerId: customer.id,
      reason: input.reason,
      requestKey,
      requestedAt,
    }
    await appendClosureRecord(req, {
      ...record,
      actorId: customer.id,
      actorType: 'customer',
      eventType: 'requested',
      stepUpGrantId: grant.grantId,
    })
    await recordCustomerSecurityEvent(req, customer.id, 'account_closure_requested', {
      blockerCount: blockers.length,
      cooldownEndsAt,
      requestId: requestKey,
      stepUpGrantId: grant.grantId,
    })
    await recordAuditEvent(req, {
      action: 'customer.account_closure.requested',
      actor: { id: customer.id, type: 'customer' },
      metadata: { blockers, cooldownEndsAt, stepUpGrantId: grant.grantId },
      targetId: requestKey,
    })
    return {
      blockers,
      cooldownEndsAt,
      deletionRequestedAt: requestedAt,
      requestId: requestKey,
      status: 'pending' as const,
    }
  })
}

export async function revokeAccountClosure(
  req: PayloadRequest,
  customer: Customer,
  input: { reason: string; requestId: string },
): Promise<{ requestId: string; revokedAt: string; status: 'revoked' }> {
  assertCustomerActor(req, customer.id)
  return inAuthTransaction(req, async () => {
    const request = await requestedClosure(req, input.requestId)
    if (request.customerId !== customer.id) {
      throw new AppError('ACCOUNT_CLOSURE_FORBIDDEN', '无权管理该账户关闭申请', 403)
    }
    const database = await authTransactionDatabase(req)
    const revokedAt = new Date().toISOString()
    const revoked = await database.execute(sql`
      UPDATE customers
      SET
        active_account_closure_request_key = NULL,
        account_closure_version = account_closure_version + 1,
        updated_at = NOW()
      WHERE id = ${customer.id}
        AND active_account_closure_request_key = ${input.requestId}
        AND account_closure_execution_claimed_at IS NULL
        AND status IN ('active', 'restricted')
      RETURNING id
    `)
    if (revoked.rows?.[0]?.id === undefined) {
      throw new AppError(
        'ACCOUNT_CLOSURE_REVOCATION_ALREADY_CONSUMED',
        '账户关闭申请已撤销、执行或不可用',
        409,
      )
    }
    await appendClosureRecord(req, {
      ...request,
      actorId: customer.id,
      actorType: 'customer',
      blockers: request.blockers,
      eventType: 'revoked',
      reason: input.reason,
      revokedAt,
    })
    await recordCustomerSecurityEvent(req, customer.id, 'account_closure_revoked', {
      requestId: input.requestId,
      revokedAt,
    })
    await recordAuditEvent(req, {
      action: 'customer.account_closure.revoked',
      actor: { id: customer.id, type: 'customer' },
      metadata: { reason: input.reason, revokedAt },
      targetId: input.requestId,
    })
    return { requestId: input.requestId, revokedAt, status: 'revoked' as const }
  })
}

async function claimClosureExecution(
  req: PayloadRequest,
  request: ClosureRequestRecord,
  claimedAt: string,
): Promise<ClosureClaim> {
  const database = await authTransactionDatabase(req)
  const claimed = await database.execute(sql`
    UPDATE customers
    SET
      account_closure_execution_claimed_at = ${claimedAt},
      account_closure_version = account_closure_version + 1,
      updated_at = NOW()
    WHERE id = ${request.customerId}
      AND active_account_closure_request_key = ${request.requestKey}
      AND account_closure_execution_claimed_at IS NULL
      AND status IN ('active', 'restricted')
    RETURNING id, status, capability_restrictions
  `)
  const row = claimed.rows?.[0]
  if (!row) {
    throw new AppError(
      'ACCOUNT_CLOSURE_EXECUTION_ALREADY_CONSUMED',
      '账户关闭申请已撤销、执行或正在处理',
      409,
    )
  }
  const status = String(row.status) as CustomerAccountStatus
  return {
    capabilityRestrictions: accountRestrictions({
      capabilityRestrictions: row.capability_restrictions,
      id: request.customerId,
      status,
    }),
    customerId: positiveId(row.id),
    status,
  }
}

async function releaseExecutionClaim(
  req: PayloadRequest,
  request: ClosureRequestRecord,
): Promise<void> {
  const database = await authTransactionDatabase(req)
  const released = await database.execute(sql`
    UPDATE customers
    SET account_closure_execution_claimed_at = NULL, updated_at = NOW()
    WHERE id = ${request.customerId}
    RETURNING id
  `)
  if (String(released.rows?.[0]?.id) !== String(request.customerId)) {
    throw new AppError('ACCOUNT_CLOSURE_STATE_UNAVAILABLE', '账户关闭状态暂时无法核验', 503)
  }
}

async function releaseCustomerIdentities(
  req: PayloadRequest,
  input: { customerId: number; rebindAllowedAt: string; requestKey: string; releasedAt: string },
): Promise<number> {
  const database = await authTransactionDatabase(req)
  const released = await database.execute(sql`
    UPDATE customer_identities
    SET
      released_identifier_hash = identifier_hash,
      identifier_hash = 'released:' || ${input.requestKey} || ':' || id::text,
      identifier_encrypted = 'released',
      status = 'unbound',
      unbound_at = ${input.releasedAt},
      rebind_allowed_at = ${input.rebindAllowedAt},
      updated_at = NOW()
    WHERE customer_id = ${input.customerId}
      AND status = 'active'
      AND released_identifier_hash IS NULL
      AND rebind_allowed_at IS NULL
    RETURNING id
  `)
  return released.rows?.length ?? 0
}

async function anonymizeClosedCustomer(
  req: PayloadRequest,
  input: { claimedAt: string; customerId: number; requestKey: string },
): Promise<void> {
  const database = await authTransactionDatabase(req)
  const anonymized = await database.execute(sql`
    UPDATE customers
    SET
      phone = ${`closed:${input.customerId}:${input.requestKey}`},
      phone_masked = '已匿名化',
      default_customer_profile_type = NULL,
      invite_code = NULL,
      invited_by_customer_id = NULL,
      active_account_closure_request_key = NULL,
      account_closure_execution_claimed_at = NULL,
      account_closure_version = account_closure_version + 1,
      updated_at = NOW()
    WHERE id = ${input.customerId}
    RETURNING id
  `)
  if (String(anonymized.rows?.[0]?.id) !== String(input.customerId)) {
    throw new AppError('ACCOUNT_CLOSURE_ANONYMIZATION_CONFLICT', '账户匿名化状态已变化', 409)
  }
}

export async function executeAccountClosure(
  req: PayloadRequest,
  input: { actorId: number | string; note: string; requestId: string },
): Promise<
  | { blockers: AccountClosureBlocker[]; requestId: string; status: 'blocked' }
  | {
      executedAt: string
      identityRebindAllowedAt: string
      requestId: string
      status: 'closed'
    }
> {
  const actorId = systemAdminId(req, input.actorId)
  return inAuthTransaction(req, async () => {
    const request = await requestedClosure(req, input.requestId)
    const claimedAt = new Date().toISOString()
    const claim = await claimClosureExecution(req, request, claimedAt)
    const blockers = await collectAccountClosureBlockers(req, request.customerId)
    if (new Date(request.cooldownEndsAt).getTime() > new Date(claimedAt).getTime()) {
      blockers.unshift('closure_cooldown_active')
    }
    if (blockers.length > 0) {
      await releaseExecutionClaim(req, request)
      await appendClosureRecord(req, {
        ...request,
        actorId,
        actorType: 'admin',
        blockers,
        eventType: 'blockers_refreshed',
      })
      await recordAuditEvent(req, {
        action: 'customer.account_closure.blockers_refreshed',
        actor: { id: actorId, type: 'admin' },
        metadata: { blockers, note: input.note },
        targetId: input.requestId,
      })
      return { blockers, requestId: input.requestId, status: 'blocked' as const }
    }

    await transitionCustomerAccount(req, {
      actor: { id: actorId, type: 'admin' },
      changedAt: claimedAt,
      customerId: request.customerId,
      evidence: {
        observedAt: claimedAt,
        reference: `account-closure:${input.requestId}`,
        source: 'customer_request',
      },
      expectedRestrictions: claim.capabilityRestrictions,
      expectedStatus: claim.status,
      reason: 'account_closure_execution_started',
      restrictions: [],
      status: 'closing',
    })
    const disabledTemplateCount = await disableCustomerRealnameTemplates(req, {
      actor: { id: actorId, type: 'admin' },
      customerId: request.customerId,
      startedAt: claimedAt,
    })
    const identityRebindAllowedAt = new Date(
      new Date(claimedAt).getTime() + getEnv().IDENTITY_REBIND_COOLDOWN_SECONDS * 1_000,
    ).toISOString()
    const releasedIdentityCount = await releaseCustomerIdentities(req, {
      customerId: request.customerId,
      rebindAllowedAt: identityRebindAllowedAt,
      releasedAt: claimedAt,
      requestKey: input.requestId,
    })
    await transitionCustomerAccount(req, {
      actor: { id: actorId, type: 'admin' },
      changedAt: claimedAt,
      customerId: request.customerId,
      evidence: {
        observedAt: claimedAt,
        reference: `account-closure:${input.requestId}`,
        source: 'customer_request',
      },
      expectedRestrictions: [],
      expectedStatus: 'closing',
      reason: 'account_closure_preconditions_satisfied',
      restrictions: [],
      status: 'closed',
    })
    await anonymizeClosedCustomer(req, {
      claimedAt,
      customerId: request.customerId,
      requestKey: input.requestId,
    })
    const dataRetentionResult = {
      accountAndTransactionRecords: 'retained_pending_external_legal_schedule',
      consentHistory: 'retained_append_only',
      identityRebindReservationUntil: identityRebindAllowedAt,
      realnamePrimaryAndBackupDeletionDeadlineDays: 30,
    }
    const anonymizationResult = {
      customerProfile: 'anonymized',
      disabledTemplateCount,
      releasedIdentityCount,
      sessions: 'revoked_by_closing_transition',
    }
    await appendClosureRecord(req, {
      ...request,
      actorId,
      actorType: 'admin',
      anonymizationResult,
      blockers: [],
      dataRetentionResult,
      eventType: 'executed',
      executedAt: claimedAt,
      identityRebindAllowedAt,
    })
    await recordCustomerSecurityEvent(req, request.customerId, 'account_closure_executed', {
      disabledTemplateCount,
      identityRebindAllowedAt,
      releasedIdentityCount,
      requestId: input.requestId,
    })
    await recordAuditEvent(req, {
      action: 'customer.account_closure.executed',
      actor: { id: actorId, type: 'admin' },
      metadata: {
        anonymizationResult,
        dataRetentionResult,
        note: input.note,
      },
      targetId: input.requestId,
    })
    return {
      executedAt: claimedAt,
      identityRebindAllowedAt,
      requestId: input.requestId,
      status: 'closed' as const,
    }
  })
}
