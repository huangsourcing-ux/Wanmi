import { sql } from '@payloadcms/db-postgres'
import {
  commitTransaction,
  initTransaction,
  killTransaction,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type PayloadRequest,
} from 'payload'

import { hasAdminOperationScope } from '@/access/roles'
import { AppError } from '@/lib/errors'
import {
  adminApprovalPolicySchema,
  adminApprovalPolicyUpdateSchema,
  type AdminApprovalPolicy,
} from '@/schemas/admin-approvals'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

export const ADMIN_APPROVAL_POLICY_KEY = 'admin.high-risk-approval-policy'

function isApprovalPolicyOperation(context: Record<string, unknown>): boolean {
  return context.adminApprovalPolicyOperation === true
}

export const guardApprovalPolicySettingChange: CollectionBeforeChangeHook = ({
  context,
  data,
  originalDoc,
}) => {
  const key = data.key ?? originalDoc?.key
  if (key === ADMIN_APPROVAL_POLICY_KEY && !isApprovalPolicyOperation(context)) {
    throw new AppError(
      'ADMIN_APPROVAL_POLICY_SERVICE_REQUIRED',
      '高风险审批配置只能通过系统配置入口修改',
      403,
    )
  }
  if (key === ADMIN_APPROVAL_POLICY_KEY) adminApprovalPolicySchema.parse(data.value)
  return data
}

export const guardApprovalPolicySettingDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const setting = await req.payload.findByID({
    collection: 'siteSettings',
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })
  if (setting.key === ADMIN_APPROVAL_POLICY_KEY) {
    throw new AppError('ADMIN_APPROVAL_POLICY_DELETE_FORBIDDEN', '高风险审批配置不得删除', 409)
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
        ): Promise<{ rows?: Array<Record<string, unknown>> }>
      }
    | undefined
  if (!current)
    throw new AppError('ADMIN_APPROVAL_POLICY_CAS_UNAVAILABLE', '审批配置无法原子更新', 503)
  return current
}

export async function loadAdminApprovalPolicy(req: PayloadRequest): Promise<AdminApprovalPolicy> {
  const found = await req.payload.find({
    collection: 'siteSettings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { key: { equals: ADMIN_APPROVAL_POLICY_KEY } },
  })
  const document = found.docs[0]
  const parsed = adminApprovalPolicySchema.safeParse(document?.value)
  if (!document || !parsed.success) {
    throw new AppError('ADMIN_APPROVAL_POLICY_UNAVAILABLE', '高风险审批配置缺失或无效', 503)
  }
  return parsed.data
}

export async function readAdminApprovalPolicy(req: PayloadRequest): Promise<AdminApprovalPolicy> {
  if (!hasAdminOperationScope(req.user, 'system_configuration')) {
    throw new AppError('ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED', '需要系统配置权限', 403)
  }
  return loadAdminApprovalPolicy(req)
}

export async function updateAdminApprovalPolicy(req: PayloadRequest, rawInput: unknown) {
  if (!hasAdminOperationScope(req.user, 'system_configuration')) {
    throw new AppError('ADMIN_SYSTEM_CONFIGURATION_SCOPE_REQUIRED', '需要系统配置权限', 403)
  }
  const input = adminApprovalPolicyUpdateSchema.parse(rawInput)
  const actorId = String(req.user!.id)
  return transaction(req, async () => {
    const current = await req.payload.find({
      collection: 'siteSettings',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { key: { equals: ADMIN_APPROVAL_POLICY_KEY } },
    })
    const previous = current.docs[0]
    const next = adminApprovalPolicySchema.parse({
      cooldownSeconds: input.cooldownSeconds,
      requiresDifferentApprover: input.requiresDifferentApprover,
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: actorId,
    })
    let id: number | string
    if (!previous) {
      const created = await req.payload.create({
        collection: 'siteSettings',
        context: { adminApprovalPolicyOperation: true },
        data: {
          description: '后台高风险操作双人审批、单人冷静延迟与告警配置',
          key: ADMIN_APPROVAL_POLICY_KEY,
          value: next,
        },
        overrideAccess: true,
        req,
      })
      id = created.id
    } else {
      const updated = await (
        await database(req)
      ).execute(sql`
        UPDATE site_settings
        SET value = ${JSON.stringify(next)}::jsonb, updated_at = NOW()
        WHERE id = ${previous.id}
          AND key = ${ADMIN_APPROVAL_POLICY_KEY}
          AND value = ${JSON.stringify(previous.value)}::jsonb
        RETURNING id
      `)
      const updatedId = updated.rows?.[0]?.id
      if (updatedId === undefined) {
        throw new AppError('ADMIN_APPROVAL_POLICY_CONFLICT', '审批配置发生并发变化，请重试', 409)
      }
      id = updatedId as number | string
    }
    await recordAuditEvent(req, {
      action: 'admin.approval_policy.updated',
      actor: { id: actorId, type: 'admin' },
      metadata: {
        after: next,
        before: previous?.value ?? null,
        changeNote: input.changeNote,
      },
      targetId: id,
    })
    return { id, value: next }
  })
}
