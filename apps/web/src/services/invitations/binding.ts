import { randomBytes } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { isCustomerUser } from '@/access/roles'
import { hmac } from '@/lib/crypto'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { assertCustomerAccountCapability } from '@/services/auth/account-state'
import { clientHashes } from '@/services/auth/client-facts'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

export const LEGACY_INVITATION_CODE_PATTERN = /^[A-Z0-9]{12}$/u
export const INVITATION_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/u
export const DEFAULT_INVITATION_BINDING_WINDOW_HOURS = 72

type InvitationDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

type BindSource = 'post_registration' | 'registration'

type BoundInvitation = {
  boundAt: string
  bindingWindowEndsAt: string
  inviterCustomerId: number
  relationshipId: number | string
}

type BindingRejection =
  | 'already_bound'
  | 'code_disabled'
  | 'code_invalid'
  | 'self_invitation'
  | 'window_expired'

function relationIdentifier(value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && value.trim()) return value
  throw new AppError('INVITATION_BINDING_UNAVAILABLE', '邀请关系暂时无法安全处理', 503)
}

function customerIdentifier(value: unknown): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AppError('INVITATION_BINDING_UNAVAILABLE', '邀请关系暂时无法安全处理', 503)
  }
  return id
}

async function invitationDatabase(req: PayloadRequest): Promise<InvitationDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const database = session?.db as InvitationDatabase | undefined
  if (!database) {
    throw new AppError('INVITATION_BINDING_UNAVAILABLE', '邀请关系暂时无法安全处理', 503)
  }
  return database
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

export function generateInvitationCode(random: (size: number) => Uint8Array = randomBytes): string {
  const entropy = Buffer.from(random(16))
  const code = entropy.toString('base64url')
  if (!INVITATION_CODE_PATTERN.test(code)) {
    throw new AppError('INVITATION_CODE_ENTROPY_UNAVAILABLE', '邀请码暂时无法安全生成', 503)
  }
  return code
}

export function normalizeInvitationCode(value: string): string {
  const normalized = value.trim()
  if (LEGACY_INVITATION_CODE_PATTERN.test(normalized.toUpperCase())) {
    return normalized.toUpperCase()
  }
  if (INVITATION_CODE_PATTERN.test(normalized)) return normalized
  throw new AppError('INVITATION_CODE_INVALID', '邀请码无效', 400)
}

export async function loadInvitationBindingWindowHours(req: PayloadRequest): Promise<number> {
  const result = await (
    await invitationDatabase(req)
  ).execute(sql`
    SELECT binding_window_hours
    FROM invitation_reward_rule_versions
    WHERE effective_at <= NOW()
    ORDER BY effective_at DESC, version DESC
    LIMIT 1
    FOR SHARE
  `)
  const raw = result.rows?.[0]?.binding_window_hours
  if (raw === undefined) return DEFAULT_INVITATION_BINDING_WINDOW_HOURS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 30) {
    throw new AppError('INVITATION_RULE_INVALID', '邀请绑定规则配置无效', 503)
  }
  return value
}

function bindingError(reason: BindingRejection): AppError {
  if (reason === 'already_bound') {
    return new AppError('INVITATION_ALREADY_BOUND', '邀请关系已绑定且不可更改', 409)
  }
  if (reason === 'window_expired') {
    return new AppError('INVITATION_BINDING_WINDOW_EXPIRED', '邀请绑定窗口已结束', 409)
  }
  if (reason === 'code_disabled') {
    return new AppError('INVITATION_CODE_DISABLED', '邀请码已停用', 409)
  }
  if (reason === 'self_invitation') {
    return new AppError('INVITATION_SELF_BIND_FORBIDDEN', '不能绑定自己的邀请码', 409)
  }
  return new AppError('INVITATION_CODE_INVALID', '邀请码无效', 400)
}

async function diagnoseBindingRejection(
  database: InvitationDatabase,
  input: { code: string; inviteeCustomerId: number; windowHours: number },
): Promise<BindingRejection> {
  const diagnosed = await database.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM invitation_relationships
        WHERE invitee_customer_id = ${input.inviteeCustomerId}
      ) AS already_bound,
      inviter.id AS inviter_id,
      inviter.invite_code_disabled_at IS NOT NULL AS code_disabled,
      COALESCE(
        NOW() <= invitee.created_at + make_interval(hours => ${input.windowHours}),
        false
      ) AS window_open
    FROM customers AS invitee
    LEFT JOIN customers AS inviter ON inviter.invite_code = ${input.code}
    WHERE invitee.id = ${input.inviteeCustomerId}
    LIMIT 1
    FOR SHARE OF invitee
  `)
  const row = diagnosed.rows?.[0]
  if (!row) throw new AppError('INVITATION_BINDING_UNAVAILABLE', '邀请关系暂时无法安全处理', 503)
  if (row.already_bound === true) return 'already_bound'
  if (row.inviter_id === null || row.inviter_id === undefined) return 'code_invalid'
  if (String(row.inviter_id) === String(input.inviteeCustomerId)) return 'self_invitation'
  if (row.code_disabled === true) return 'code_disabled'
  if (row.window_open !== true) return 'window_expired'
  throw new AppError('INVITATION_BINDING_CONFLICT', '邀请关系已并发变化，请重试', 409)
}

async function attemptInvitationBinding(
  req: PayloadRequest,
  input: {
    code: string
    deviceHash: string
    inviteeCustomerId: number
    source: BindSource
  },
): Promise<{ bound: BoundInvitation } | { rejected: BindingRejection }> {
  return transaction(req, async () => {
    const database = await invitationDatabase(req)
    const windowHours = await loadInvitationBindingWindowHours(req)
    const relationshipKey = `invitee:${input.inviteeCustomerId}`
    const inserted = await database.execute(sql`
      INSERT INTO invitation_relationships (
        relationship_key,
        inviter_customer_id,
        invitee_customer_id,
        bind_source,
        invite_code_hash,
        binding_device_hash,
        bound_at,
        binding_window_ends_at,
        updated_at,
        created_at
      )
      SELECT
        ${relationshipKey},
        inviter.id,
        invitee.id,
        ${input.source},
        ${hmac(input.code, getEnv().SESSION_PEPPER)},
        ${input.deviceHash},
        NOW(),
        invitee.created_at + make_interval(hours => ${windowHours}),
        NOW(),
        NOW()
      FROM customers AS invitee
      JOIN customers AS inviter
        ON inviter.invite_code = ${input.code}
       AND inviter.invite_code_disabled_at IS NULL
      WHERE invitee.id = ${input.inviteeCustomerId}
        AND inviter.id <> invitee.id
        AND NOW() <= invitee.created_at + make_interval(hours => ${windowHours})
      ON CONFLICT (invitee_customer_id) DO NOTHING
      RETURNING id, inviter_customer_id, bound_at, binding_window_ends_at
    `)
    const row = inserted.rows?.[0]
    if (!row) {
      return {
        rejected: await diagnoseBindingRejection(database, {
          code: input.code,
          inviteeCustomerId: input.inviteeCustomerId,
          windowHours,
        }),
      }
    }
    const inviterCustomerId = customerIdentifier(row.inviter_customer_id)
    const projected = await database.execute(sql`
      UPDATE customers
      SET invited_by_customer_id = ${inviterCustomerId}, updated_at = NOW()
      WHERE id = ${input.inviteeCustomerId}
        AND invited_by_customer_id IS NULL
      RETURNING id
    `)
    if (String(projected.rows?.[0]?.id) !== String(input.inviteeCustomerId)) {
      throw new AppError('INVITATION_BINDING_CONFLICT', '邀请关系已并发变化，请重试', 409)
    }
    const bound: BoundInvitation = {
      boundAt: new Date(String(row.bound_at)).toISOString(),
      bindingWindowEndsAt: new Date(String(row.binding_window_ends_at)).toISOString(),
      inviterCustomerId,
      relationshipId: relationIdentifier(row.id),
    }
    await recordAuditEvent(req, {
      action: 'invitation.relationship.bound',
      actor: { id: input.inviteeCustomerId, type: 'customer' },
      metadata: {
        bindSource: input.source,
        bindingWindowEndsAt: bound.bindingWindowEndsAt,
        inviterCustomerId: String(inviterCustomerId),
      },
      targetId: bound.relationshipId,
    })
    return { bound }
  })
}

export async function bindInvitationAtRegistration(
  req: PayloadRequest,
  input: { code: string; deviceHash: string; inviteeCustomerId: number },
): Promise<BoundInvitation> {
  const result = await attemptInvitationBinding(req, {
    code: normalizeInvitationCode(input.code),
    deviceHash: input.deviceHash,
    inviteeCustomerId: input.inviteeCustomerId,
    source: 'registration',
  })
  if ('rejected' in result) throw bindingError(result.rejected)
  return result.bound
}

export async function bindCustomerInvitation(
  req: PayloadRequest,
  input: { code: string; deviceId: string; headers: Headers },
): Promise<BoundInvitation> {
  if (!isCustomerUser(req.user)) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
  const customerId = customerIdentifier(req.user.id)
  await assertCustomerAccountCapability(req, customerId, 'login')
  const result = await attemptInvitationBinding(req, {
    code: normalizeInvitationCode(input.code),
    deviceHash: clientHashes(input.headers, input.deviceId).deviceHash,
    inviteeCustomerId: customerId,
    source: 'post_registration',
  })
  if ('bound' in result) return result.bound
  await recordAuditEvent(req, {
    action: 'invitation.relationship.binding_rejected',
    actor: { id: customerId, type: 'customer' },
    metadata: { reason: result.rejected },
    targetId: customerId,
  })
  throw bindingError(result.rejected)
}

export async function disableCustomerInvitationCode(req: PayloadRequest): Promise<{
  disabledAt: string
}> {
  if (!isCustomerUser(req.user)) {
    throw new AppError('CUSTOMER_AUTH_REQUIRED', '需要用户身份验证', 401)
  }
  const customerId = customerIdentifier(req.user.id)
  await assertCustomerAccountCapability(req, customerId, 'login')
  return transaction(req, async () => {
    const database = await invitationDatabase(req)
    const updated = await database.execute(sql`
      UPDATE customers
      SET invite_code_disabled_at = COALESCE(invite_code_disabled_at, NOW()), updated_at = NOW()
      WHERE id = ${customerId}
        AND invite_code IS NOT NULL
      RETURNING invite_code_disabled_at
    `)
    const disabledAt = updated.rows?.[0]?.invite_code_disabled_at
    if (!disabledAt) {
      throw new AppError('INVITATION_CODE_UNAVAILABLE', '当前账号没有可停用的邀请码', 409)
    }
    const normalized = new Date(String(disabledAt)).toISOString()
    await recordAuditEvent(req, {
      action: 'invitation.code.disabled',
      actor: { id: customerId, type: 'customer' },
      targetId: customerId,
    })
    return { disabledAt: normalized }
  })
}
