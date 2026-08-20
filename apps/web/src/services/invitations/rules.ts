import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { hasRole, isActiveAdminUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

type RuleDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

function positiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new AppError('INVITATION_RULE_INVALID', '邀请奖励规则配置无效', 400)
  }
  return value
}

async function database(req: PayloadRequest): Promise<RuleDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as RuleDatabase | undefined
  if (!current) throw new AppError('INVITATION_RULE_UNAVAILABLE', '邀请奖励规则暂时无法配置', 503)
  return current
}

export async function createInvitationRewardRuleVersion(
  req: PayloadRequest,
  input: {
    bindingWindowHours: number
    changeNote: string
    effectiveAt: string
    enabled: boolean
    rewardExpiryDays: number
    rewardPoints: number
  },
): Promise<{ id: number | string; version: number }> {
  if (!isActiveAdminUser(req.user) || !hasRole(req.user, ['system_admin'])) {
    throw new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', '仅系统管理员可配置邀请奖励规则', 403)
  }
  const effectiveAt = new Date(input.effectiveAt)
  if (!Number.isFinite(effectiveAt.getTime()) || !input.changeNote.trim()) {
    throw new AppError('INVITATION_RULE_INVALID', '邀请奖励规则配置无效', 400)
  }
  const bindingWindowHours = positiveInteger(input.bindingWindowHours, 24 * 30)
  const rewardExpiryDays = positiveInteger(input.rewardExpiryDays, 3_650)
  const rewardPoints = positiveInteger(input.rewardPoints, Number.MAX_SAFE_INTEGER)
  const started = await initTransaction(req)
  try {
    const inserted = await (
      await database(req)
    ).execute(sql`
      INSERT INTO invitation_reward_rule_versions (
        version,
        schema_version,
        enabled,
        reward_points,
        reward_expiry_days,
        binding_window_hours,
        effective_at,
        changed_by,
        change_note,
        updated_at,
        created_at
      )
      SELECT
        COALESCE(MAX(version), 0) + 1,
        1,
        ${input.enabled},
        ${rewardPoints},
        ${rewardExpiryDays},
        ${bindingWindowHours},
        ${effectiveAt.toISOString()},
        ${String(req.user.id)},
        ${input.changeNote.trim()},
        NOW(),
        NOW()
      FROM invitation_reward_rule_versions
      RETURNING id, version
    `)
    const row = inserted.rows?.[0]
    if (!row) throw new AppError('INVITATION_RULE_CONFLICT', '邀请奖励规则版本发生并发冲突', 409)
    const id = row.id as number | string
    const version = Number(row.version)
    if ((!id && id !== 0) || !Number.isSafeInteger(version) || version <= 0) {
      throw new AppError('INVITATION_RULE_UNAVAILABLE', '邀请奖励规则暂时无法配置', 503)
    }
    await recordAuditEvent(req, {
      action: 'invitation.reward_rule.created',
      metadata: {
        bindingWindowHours,
        effectiveAt: effectiveAt.toISOString(),
        enabled: input.enabled,
        rewardExpiryDays,
        rewardPoints,
        version,
      },
      targetId: id,
    })
    if (started) await commitTransaction(req)
    return { id, version }
  } catch (error) {
    if (started) await killTransaction(req)
    if (error instanceof AppError) throw error
    throw new AppError('INVITATION_RULE_CONFLICT', '邀请奖励规则版本发生并发冲突', 409)
  }
}
