import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

import { hasRole, isCustomerUser } from '@/access/roles'
import {
  CUSTOMER_ACCOUNT_STATUSES,
  CUSTOMER_ACCOUNT_TRANSITIONS,
  CUSTOMER_CAPABILITY_RESTRICTIONS,
  type CustomerAccountStatus,
  type CustomerCapabilityRestriction,
} from '@/lib/domain'
import { AppError } from '@/lib/errors'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

import { authTransactionDatabase, inAuthTransaction } from './atomic'
import { revokeAllCustomerSessions } from './customer-sessions'
import { recordCustomerSecurityEvent } from './security-events'

export type CustomerCapability =
  | 'balance_spend'
  | 'domain_write'
  | 'identity_change'
  | 'login'
  | 'purchase'
  | 'refund'

export type CustomerAccountActor =
  | { id: number | string; type: 'admin' | 'customer' }
  | { type: 'system' }

export type CustomerAccountEvidence = {
  observedAt: string
  reference: string
  source:
    | 'customer_request'
    | 'manual_review'
    | 'registration'
    | 'security_event'
    | 'written_confirmation'
}

export type CustomerAccountSnapshot = {
  capabilityRestrictions?: unknown
  id: number | string
  status?: unknown
}

export type CustomerAccountStateView = {
  capabilityRestrictions: CustomerCapabilityRestriction[]
  changedAt: string
  customerId: number | string
  deletionRequestedAt?: string
  status: CustomerAccountStatus
}

const CAPABILITY_RESTRICTION: Record<CustomerCapability, CustomerCapabilityRestriction> = {
  balance_spend: 'balance_spend_disabled',
  domain_write: 'domain_write_disabled',
  identity_change: 'identity_change_disabled',
  login: 'login_disabled',
  purchase: 'purchase_disabled',
  refund: 'refund_review',
}

const CAPABILITY_ERRORS: Record<CustomerCapabilityRestriction, { code: string; message: string }> =
  {
    balance_spend_disabled: {
      code: 'ACCOUNT_BALANCE_SPEND_DISABLED',
      message: '当前账号不可使用余额支付',
    },
    domain_write_disabled: {
      code: 'ACCOUNT_DOMAIN_WRITE_DISABLED',
      message: '当前账号不可修改域名配置',
    },
    identity_change_disabled: {
      code: 'ACCOUNT_IDENTITY_CHANGE_DISABLED',
      message: '当前账号不可变更登录身份',
    },
    login_disabled: { code: 'ACCOUNT_LOGIN_DISABLED', message: '当前账号不可登录' },
    purchase_disabled: { code: 'ACCOUNT_PURCHASE_DISABLED', message: '当前账号不可购买' },
    refund_review: {
      code: 'ACCOUNT_REFUND_REVIEW_REQUIRED',
      message: '当前账号的退款申请必须进入人工复核',
    },
  }

const STATUS_ERRORS: Record<
  Exclude<CustomerAccountStatus, 'active' | 'restricted'>,
  { code: string; message: string }
> = {
  closed: { code: 'ACCOUNT_CLOSED', message: '账号已关闭' },
  closing: { code: 'ACCOUNT_CLOSING', message: '账号正在关闭，当前操作不可用' },
  pending_registration: {
    code: 'ACCOUNT_PENDING_REGISTRATION',
    message: '账号尚未完成注册',
  },
  suspended: { code: 'ACCOUNT_SUSPENDED', message: '账号已暂停，当前操作不可用' },
}

function isAccountStatus(value: unknown): value is CustomerAccountStatus {
  return (
    typeof value === 'string' && (CUSTOMER_ACCOUNT_STATUSES as readonly string[]).includes(value)
  )
}

function normalizeRestrictions(value: unknown): CustomerCapabilityRestriction[] {
  if (!Array.isArray(value)) {
    throw new AppError('ACCOUNT_RESTRICTIONS_INVALID', '账户能力限制数据无效', 500)
  }
  const restrictions = [...new Set(value)]
  if (
    restrictions.length !== value.length ||
    !restrictions.every(
      (item): item is CustomerCapabilityRestriction =>
        typeof item === 'string' &&
        (CUSTOMER_CAPABILITY_RESTRICTIONS as readonly string[]).includes(item),
    )
  ) {
    throw new AppError('ACCOUNT_RESTRICTIONS_INVALID', '账户能力限制数据无效', 500)
  }
  return restrictions.sort()
}

function restrictionsForInput(value: unknown): CustomerCapabilityRestriction[] {
  try {
    return normalizeRestrictions(value)
  } catch {
    throw new AppError('ACCOUNT_RESTRICTIONS_INVALID', '账户能力限制请求无效', 400)
  }
}

function sameRestrictions(
  left: readonly CustomerCapabilityRestriction[],
  right: readonly CustomerCapabilityRestriction[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertStateRestrictionInvariant(
  status: CustomerAccountStatus,
  restrictions: readonly CustomerCapabilityRestriction[],
): void {
  if (status === 'restricted' ? restrictions.length > 0 : restrictions.length === 0) return
  throw new AppError(
    'ACCOUNT_STATE_RESTRICTIONS_MISMATCH',
    status === 'restricted'
      ? 'restricted 状态必须至少限制一项能力'
      : '只有 restricted 状态可以保存能力限制',
    400,
  )
}

function actorMetadata(actor: CustomerAccountActor): Record<string, unknown> {
  return 'id' in actor ? { id: String(actor.id), type: actor.type } : { type: actor.type }
}

function assertActorAllowed(
  req: PayloadRequest,
  customerId: number | string,
  actor: CustomerAccountActor,
  from: CustomerAccountStatus,
  to: CustomerAccountStatus,
): void {
  if (actor.type === 'system') {
    if (!req.user) return
  } else if (actor.type === 'admin') {
    if (
      req.user?.collection === 'admins' &&
      String(req.user.id) === String(actor.id) &&
      hasRole(req.user, ['system_admin'])
    ) {
      return
    }
  } else if (
    isCustomerUser(req.user) &&
    String(req.user.id) === String(actor.id) &&
    String(req.user.id) === String(customerId) &&
    (from === 'active' || from === 'restricted') &&
    to === 'closing'
  ) {
    return
  }
  throw new AppError('ACCOUNT_STATE_CHANGE_FORBIDDEN', '无权变更该账号状态', 403)
}

function assertTransitionAllowed(
  from: CustomerAccountStatus,
  to: CustomerAccountStatus,
  expectedRestrictions: readonly CustomerCapabilityRestriction[],
  restrictions: readonly CustomerCapabilityRestriction[],
): void {
  if (from === to) {
    if (from === 'restricted' && !sameRestrictions(expectedRestrictions, restrictions)) return
    throw new AppError('ACCOUNT_STATE_CHANGE_NOOP', '账户状态与能力限制没有变化', 409)
  }
  if ((CUSTOMER_ACCOUNT_TRANSITIONS[from] as readonly CustomerAccountStatus[]).includes(to)) return
  throw new AppError('ACCOUNT_STATE_TRANSITION_INVALID', `不允许从 ${from} 变更为 ${to}`, 409)
}

export function accountRestrictions(
  account: CustomerAccountSnapshot,
): CustomerCapabilityRestriction[] {
  return normalizeRestrictions(account.capabilityRestrictions ?? [])
}

export function assertCustomerAccountCapabilityFromSnapshot(
  account: CustomerAccountSnapshot,
  capability: CustomerCapability,
): void {
  if (!isAccountStatus(account.status)) {
    throw new AppError('ACCOUNT_STATE_INVALID', '账户状态数据无效', 403)
  }
  const restrictions = accountRestrictions(account)
  if (account.status !== 'active' && account.status !== 'restricted') {
    const failure = STATUS_ERRORS[account.status]
    throw new AppError(failure.code, failure.message, 403)
  }
  if (
    (account.status === 'active' && restrictions.length > 0) ||
    (account.status === 'restricted' && restrictions.length === 0)
  ) {
    throw new AppError('ACCOUNT_STATE_INVALID', '账户状态与能力限制不一致', 403)
  }
  const restriction = CAPABILITY_RESTRICTION[capability]
  if (!restrictions.includes(restriction)) return
  const failure = CAPABILITY_ERRORS[restriction]
  throw new AppError(failure.code, failure.message, 403)
}

export async function assertCustomerAccountCapability(
  req: PayloadRequest,
  customerId: number | string,
  capability: CustomerCapability,
): Promise<void> {
  let account: CustomerAccountSnapshot
  try {
    account = await req.payload.findByID({
      collection: 'customers',
      depth: 0,
      id: customerId,
      overrideAccess: true,
      req,
    })
  } catch {
    throw new AppError('ACCOUNT_NOT_FOUND', '未找到账号', 404)
  }
  assertCustomerAccountCapabilityFromSnapshot(account, capability)
}

export async function revokeCustomerSessionsForSecurityEvent(
  req: PayloadRequest,
  input: {
    actor: CustomerAccountActor
    customerId: number
    evidence: CustomerAccountEvidence
    reason: string
  },
): Promise<{ revokedCount: number }> {
  assertActorAllowed(req, input.customerId, input.actor, 'active', 'active')
  return inAuthTransaction(req, async () => {
    const revokedCount = await revokeAllCustomerSessions(req, input.customerId, input.reason)
    await recordAuditEvent(req, {
      action: 'customer.account_sessions.revoked',
      actor: input.actor,
      metadata: {
        evidence: input.evidence,
        reason: input.reason,
        revokedCount,
        scope: 'all',
      },
      targetId: input.customerId,
    })
    return { revokedCount }
  })
}

export async function transitionCustomerAccount(
  req: PayloadRequest,
  input: {
    actor: CustomerAccountActor
    changedAt?: string
    customerId: number
    evidence: CustomerAccountEvidence
    expectedRestrictions: CustomerCapabilityRestriction[]
    expectedStatus: CustomerAccountStatus
    reason: string
    restrictions: CustomerCapabilityRestriction[]
    status: CustomerAccountStatus
  },
): Promise<CustomerAccountStateView> {
  const expectedRestrictions = restrictionsForInput(input.expectedRestrictions)
  const restrictions = restrictionsForInput(input.restrictions)
  assertStateRestrictionInvariant(input.expectedStatus, expectedRestrictions)
  assertStateRestrictionInvariant(input.status, restrictions)
  assertTransitionAllowed(input.expectedStatus, input.status, expectedRestrictions, restrictions)
  assertActorAllowed(req, input.customerId, input.actor, input.expectedStatus, input.status)

  return inAuthTransaction(req, async () => {
    const database = await authTransactionDatabase(req)
    const changedAt = input.changedAt ?? new Date().toISOString()
    const expectedRestrictionsJson = JSON.stringify(expectedRestrictions)
    const restrictionsJson = JSON.stringify(restrictions)
    const updated = await database.execute(sql`
      UPDATE customers
      SET
        status = ${input.status},
        capability_restrictions = ${restrictionsJson}::jsonb,
        deletion_requested_at = CASE
          WHEN ${input.status} = 'closing' THEN COALESCE(deletion_requested_at, ${changedAt})
          WHEN ${input.expectedStatus} = 'closing' AND ${input.status} = 'active' THEN NULL
          ELSE deletion_requested_at
        END,
        updated_at = NOW()
      WHERE id = ${input.customerId}
        AND status = ${input.expectedStatus}
        AND capability_restrictions = ${expectedRestrictionsJson}::jsonb
      RETURNING id, status, capability_restrictions, deletion_requested_at
    `)
    const row = updated.rows?.[0]
    if (row?.id === undefined) {
      throw new AppError(
        'ACCOUNT_STATE_TRANSITION_CONFLICT',
        '账户状态或能力限制已变化，请刷新后重试',
        409,
      )
    }
    const metadata = {
      actor: actorMetadata(input.actor),
      changedAt,
      evidence: input.evidence,
      from: {
        capabilityRestrictions: expectedRestrictions,
        status: input.expectedStatus,
      },
      reason: input.reason,
      to: { capabilityRestrictions: restrictions, status: input.status },
    }
    await recordCustomerSecurityEvent(req, input.customerId, 'account_state_changed', metadata)
    await recordAuditEvent(req, {
      action: 'customer.account_state.changed',
      actor: input.actor,
      metadata,
      targetId: input.customerId,
    })

    const loginBlocked =
      (input.status !== 'active' && input.status !== 'restricted') ||
      restrictions.includes('login_disabled')
    if (loginBlocked) {
      await revokeAllCustomerSessions(req, input.customerId, 'account_access_disabled')
      await recordAuditEvent(req, {
        action: 'customer.account_sessions.revoked',
        actor: input.actor,
        metadata: {
          evidence: input.evidence,
          reason: 'account_access_disabled',
          scope: 'all',
        },
        targetId: input.customerId,
      })
    }

    return {
      capabilityRestrictions: restrictions,
      changedAt,
      customerId: input.customerId,
      ...(row.deletion_requested_at
        ? { deletionRequestedAt: new Date(String(row.deletion_requested_at)).toISOString() }
        : {}),
      status: input.status,
    }
  })
}
