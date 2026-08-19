import { randomUUID } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { hasAdminOperationScope, isActiveAdminUser } from '@/access/roles'
import type { AdminHighRiskOperationType } from '@/lib/domain'
import { AppError } from '@/lib/errors'
import { getTraceId } from '@/lib/request-id'
import {
  adminApprovalCreateSchema,
  adminApprovalDecisionSchema,
  type AdminApprovalCreateInput,
} from '@/schemas/admin-approvals'
import { recordAuditEvent } from '@/services/audit/record-audit-event'
import { sanitizeSensitiveData } from '@/services/privacy/sanitize-sensitive-data'
import { enqueueTransactionalSecurityNotification } from '@/services/notifications/outbox'

import { loadAdminApprovalPolicy } from './approval-policy'

type ApprovalDatabase = {
  execute(statement: ReturnType<typeof sql>): Promise<{ rows?: Array<Record<string, unknown>> }>
}

export type AdminApprovalRecord = {
  amountFen?: null | number
  approvedAt?: null | string
  approvedBy?: null | number | string | { id: number | string }
  cooldownSeconds: number
  createdAt: string
  customer: number | string | { id: number | string }
  executedAt?: null | string
  executedBy?: null | number | string | { id: number | string }
  id: number | string
  operationData: Record<string, unknown>
  operationType: AdminHighRiskOperationType
  reasonNote: string
  requestedBy: number | string | { id: number | string }
  requestKey: string
  requiresDifferentApprover: boolean
  status: 'approved' | 'executed' | 'executing' | 'failed' | 'pending_approval' | 'rejected'
  targetId: string
  targetType: string
}

const OPERATION_LABELS: Record<AdminHighRiskOperationType, string> = {
  account_recovery: '人工账户找回',
  bulk_customer_asset_operation: '批量用户资产操作',
  domain_management_credential_disposition: '域名管理凭据人工处置',
  high_risk_account_unfreeze: '高风险账户解冻',
  identity_conflict_resolution: '身份冲突处理',
  large_balance_adjustment: '大额余额调整',
  original_refund: '原路退款',
  vip_fraud_correction: 'VIP 欺诈纠错',
}

function relationId(value: number | string | { id: number | string }): number | string {
  return typeof value === 'object' ? value.id : value
}

function numericRelationId(value: number | string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AppError('ADMIN_APPROVAL_RELATION_INVALID', '审批关联标识无效', 409)
  }
  return id
}

function adminActor(req: PayloadRequest): { id: number | string } {
  if (!isActiveAdminUser(req.user) || !hasAdminOperationScope(req.user, 'funds_operations')) {
    throw new AppError('ADMIN_FUNDS_OPERATION_SCOPE_REQUIRED', '需要资金操作权限', 403)
  }
  return req.user
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

async function database(req: PayloadRequest): Promise<ApprovalDatabase> {
  const transactionId = await req.transactionID
  const session = transactionId ? req.payload.db.sessions?.[transactionId] : undefined
  const current = session?.db as ApprovalDatabase | undefined
  if (!current) throw new AppError('ADMIN_APPROVAL_CAS_UNAVAILABLE', '审批事务暂时不可用', 503)
  return current
}

function operationEnvelope(input: AdminApprovalCreateInput): {
  amountFen?: number
  customerId: number
  operationData: Record<string, unknown>
  targetId: string
  targetType: string
} {
  const { customerId, operationType } = input
  const operationData = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) =>
        key !== 'amountFen' &&
        key !== 'customerId' &&
        key !== 'operationType' &&
        key !== 'reasonNote',
    ),
  )
  const target = (() => {
    switch (operationType) {
      case 'large_balance_adjustment':
        return { id: String(input.accountId), type: 'wallet-account' }
      case 'original_refund':
        return { id: String(input.orderId), type: 'order' }
      case 'account_recovery':
      case 'identity_conflict_resolution':
        return { id: String(input.reviewId), type: 'manual-review' }
      case 'vip_fraud_correction':
      case 'high_risk_account_unfreeze':
        return { id: String(customerId), type: 'customer' }
      case 'domain_management_credential_disposition':
        return { id: String(input.assetId), type: 'domain-asset' }
      case 'bulk_customer_asset_operation':
        return { id: input.batchReference, type: 'domain-batch' }
    }
  })()
  const sanitized = sanitizeSensitiveData(operationData)
  if (JSON.stringify(sanitized) !== JSON.stringify(operationData)) {
    throw new AppError(
      'ADMIN_APPROVAL_SENSITIVE_PAYLOAD_FORBIDDEN',
      '审批快照不得包含完整手机号、证件或凭据',
      400,
    )
  }
  return {
    ...(operationType === 'large_balance_adjustment' ? { amountFen: input.amountFen } : {}),
    customerId,
    operationData,
    targetId: target.id,
    targetType: target.type,
  }
}

function assertStoredOperationBinding(approval: AdminApprovalRecord): void {
  const parsed = adminApprovalCreateSchema.parse({
    ...approval.operationData,
    ...(approval.operationType === 'large_balance_adjustment'
      ? { amountFen: approval.amountFen }
      : {}),
    customerId: numericRelationId(relationId(approval.customer)),
    operationType: approval.operationType,
    reasonNote: approval.reasonNote,
  })
  const expected = operationEnvelope(parsed)
  const amountMatches =
    expected.amountFen === undefined
      ? approval.amountFen === undefined || approval.amountFen === null
      : expected.amountFen === approval.amountFen
  if (
    !amountMatches ||
    expected.targetId !== approval.targetId ||
    expected.targetType !== approval.targetType
  ) {
    throw new AppError(
      'ADMIN_APPROVAL_SNAPSHOT_MISMATCH',
      '审批操作快照与索引事实不一致，已停止执行',
      409,
    )
  }
}

async function accessEvent(
  req: PayloadRequest,
  input: {
    actorId: number | string
    eventType: 'approved' | 'executed' | 'execution_claimed' | 'failed' | 'rejected' | 'requested'
    metadata?: Record<string, unknown>
    requestId: number | string
    suffix: string
  },
): Promise<void> {
  await req.payload.create({
    collection: 'adminAccessEvents',
    data: {
      actor: numericRelationId(input.actorId),
      approvalRequest: numericRelationId(input.requestId),
      eventKey: `${input.requestId}:${input.eventType}:${input.suffix}`,
      eventType: input.eventType,
      metadata: sanitizeSensitiveData(input.metadata),
      traceId: getTraceId(req.headers),
    },
    overrideAccess: true,
    req,
  })
}

async function storedCreatedAt(req: PayloadRequest, requestId: number | string): Promise<string> {
  const found = await (
    await database(req)
  ).execute(sql`
    SELECT created_at
    FROM admin_approval_requests
    WHERE id = ${requestId}
    FOR SHARE
  `)
  const value = found.rows?.[0]?.created_at
  if (!value || !Number.isFinite(new Date(String(value)).getTime())) {
    throw new AppError('ADMIN_APPROVAL_CREATED_AT_UNAVAILABLE', '审批创建时间不可用', 503)
  }
  return new Date(String(value)).toISOString()
}

export async function createAdminApprovalRequest(req: PayloadRequest, rawInput: unknown) {
  const actor = adminActor(req)
  const input = adminApprovalCreateSchema.parse(rawInput)
  const envelope = operationEnvelope(input)
  const reasonNote = String(sanitizeSensitiveData(input.reasonNote))
  return transaction(req, async () => {
    const policy = await loadAdminApprovalPolicy(req)
    const requestKey = randomUUID()
    const created = (await req.payload.create({
      collection: 'adminApprovalRequests',
      context: { adminApprovalOperation: true },
      data: {
        amountFen: envelope.amountFen,
        cooldownSeconds: policy.cooldownSeconds,
        customer: envelope.customerId,
        operationData: envelope.operationData,
        operationType: input.operationType,
        reasonNote,
        requestedBy: numericRelationId(actor.id),
        requestKey,
        requiresDifferentApprover: policy.requiresDifferentApprover,
        status: 'pending_approval',
        targetId: envelope.targetId,
        targetType: envelope.targetType,
      },
      overrideAccess: true,
      req,
    })) as unknown as AdminApprovalRecord
    const createdAt = await storedCreatedAt(req, created.id)
    await accessEvent(req, {
      actorId: actor.id,
      eventType: 'requested',
      metadata: {
        cooldownSeconds: policy.cooldownSeconds,
        operationType: input.operationType,
        requiresDifferentApprover: policy.requiresDifferentApprover,
        targetId: envelope.targetId,
        targetType: envelope.targetType,
      },
      requestId: created.id,
      suffix: requestKey,
    })
    await enqueueTransactionalSecurityNotification(req, {
      body: `${OPERATION_LABELS[input.operationType]}已于 ${createdAt} 提交。冷静期为 ${policy.cooldownSeconds} 秒；如非本人授权，请立即联系人工支持。`,
      customerId: envelope.customerId,
      domainEventType: 'admin.high_risk_operation.requested',
      eventKey: `admin-approval:${requestKey}:requested`,
      notificationType: 'admin_high_risk_operation_submitted',
      subject: '高风险操作已提交',
      templateKey: 'admin-high-risk-operation-submitted',
      templateVersion: 1,
      traceId: getTraceId(req.headers),
    })
    await recordAuditEvent(req, {
      action: 'admin.high_risk_operation.requested',
      actor: { id: actor.id, type: 'admin' },
      metadata: {
        cooldownSeconds: policy.cooldownSeconds,
        operationType: input.operationType,
        requiresDifferentApprover: policy.requiresDifferentApprover,
        targetId: envelope.targetId,
        targetType: envelope.targetType,
      },
      targetId: created.id,
    })
    return { ...created, createdAt, status: 'pending_approval' as const }
  })
}

export async function getAdminApprovalRequest(
  req: PayloadRequest,
  requestId: number | string,
): Promise<AdminApprovalRecord> {
  try {
    return (await req.payload.findByID({
      collection: 'adminApprovalRequests',
      depth: 0,
      id: requestId,
      overrideAccess: true,
      req,
    })) as unknown as AdminApprovalRecord
  } catch {
    throw new AppError('ADMIN_APPROVAL_NOT_FOUND', '未找到审批请求', 404)
  }
}

export async function decideAdminApprovalRequest(
  req: PayloadRequest,
  requestId: number | string,
  rawInput: unknown,
) {
  const actor = adminActor(req)
  const input = adminApprovalDecisionSchema.parse(rawInput)
  return transaction(req, async () => {
    const current = await getAdminApprovalRequest(req, requestId)
    const requesterId = relationId(current.requestedBy)
    if (
      input.decision === 'approve' &&
      current.requiresDifferentApprover &&
      String(requesterId) === String(actor.id)
    ) {
      throw new AppError(
        'ADMIN_APPROVAL_DIFFERENT_APPROVER_REQUIRED',
        '当前配置要求审批人与发起人不同',
        409,
      )
    }
    const nextStatus = input.decision === 'approve' ? 'approved' : 'rejected'
    const decidedAt = new Date().toISOString()
    const updated = await (
      await database(req)
    ).execute(sql`
      UPDATE admin_approval_requests
      SET
        status = ${nextStatus},
        approved_by_id = ${input.decision === 'approve' ? actor.id : null},
        approved_at = ${input.decision === 'approve' ? decidedAt : null},
        updated_at = NOW()
      WHERE id = ${requestId}
        AND status = 'pending_approval'
        AND (
          requires_different_approver = FALSE OR
          requested_by_id <> ${actor.id} OR
          ${input.decision} = 'reject'
        )
      RETURNING id
    `)
    if (updated.rows?.[0]?.id === undefined) {
      throw new AppError('ADMIN_APPROVAL_DECISION_CONFLICT', '审批请求已处理或状态已变化', 409)
    }
    await accessEvent(req, {
      actorId: actor.id,
      eventType: input.decision === 'approve' ? 'approved' : 'rejected',
      metadata: { note: input.note },
      requestId,
      suffix: randomUUID(),
    })
    await recordAuditEvent(req, {
      action:
        input.decision === 'approve'
          ? 'admin.high_risk_operation.approved'
          : 'admin.high_risk_operation.rejected',
      actor: { id: actor.id, type: 'admin' },
      metadata: { note: input.note, operationType: current.operationType },
      targetId: requestId,
    })
    return { decidedAt, requestId, status: nextStatus }
  })
}

async function claimApprovedExecution(
  req: PayloadRequest,
  input: {
    actorId: number | string
    expectedOperationType: AdminHighRiskOperationType
    now: Date
    requestId: number | string
  },
): Promise<{ approval: AdminApprovalRecord; claimKey: string }> {
  const claimKey = randomUUID()
  const claimed = await transaction(req, async () => {
    const result = await (
      await database(req)
    ).execute(sql`
      UPDATE admin_approval_requests
      SET
        status = 'executing',
        executed_by_id = ${input.actorId},
        execution_claim_key = ${claimKey},
        execution_claimed_at = ${input.now.toISOString()},
        updated_at = NOW()
      WHERE id = ${input.requestId}
        AND operation_type = ${input.expectedOperationType}
        AND status = 'approved'
        AND created_at + cooldown_seconds * INTERVAL '1 second' <= ${input.now.toISOString()}
      RETURNING id
    `)
    if (result.rows?.[0]?.id === undefined) return false
    await accessEvent(req, {
      actorId: input.actorId,
      eventType: 'execution_claimed',
      metadata: { operationType: input.expectedOperationType },
      requestId: input.requestId,
      suffix: claimKey,
    })
    await recordAuditEvent(req, {
      action: 'admin.high_risk_operation.execution_claimed',
      actor: { id: input.actorId, type: 'admin' },
      metadata: { operationType: input.expectedOperationType },
      targetId: input.requestId,
    })
    return true
  })
  if (!claimed) {
    const current = await getAdminApprovalRequest(req, input.requestId)
    if (current.status === 'pending_approval') {
      throw new AppError('ADMIN_APPROVAL_REQUIRED', '高风险操作尚未获批', 409)
    }
    if (current.status === 'approved') {
      const eligibleAt =
        new Date(current.createdAt).getTime() + Number(current.cooldownSeconds) * 1_000
      if (eligibleAt > input.now.getTime()) {
        throw new AppError('ADMIN_APPROVAL_COOLDOWN_ACTIVE', '高风险操作仍在冷静延迟内', 409, {
          retryAfterSeconds: Math.max(1, Math.ceil((eligibleAt - input.now.getTime()) / 1_000)),
        })
      }
    }
    throw new AppError('ADMIN_APPROVAL_EXECUTION_CONFLICT', '审批请求已执行或状态已变化', 409)
  }
  return { approval: await getAdminApprovalRequest(req, input.requestId), claimKey }
}

export async function executeAdminApprovalRequest<T>(
  req: PayloadRequest,
  input: {
    expectedOperationType: AdminHighRiskOperationType
    now?: () => Date
    requestId: number | string
  },
  work: (approval: AdminApprovalRecord) => Promise<T>,
): Promise<{ result: T; status: 'executed' }> {
  const actor = adminActor(req)
  const claimed = await claimApprovedExecution(req, {
    actorId: actor.id,
    expectedOperationType: input.expectedOperationType,
    now: (input.now ?? (() => new Date()))(),
    requestId: input.requestId,
  })
  try {
    const result = await transaction(req, async () => {
      assertStoredOperationBinding(claimed.approval)
      const value = await work(claimed.approval)
      const executedAt = new Date().toISOString()
      const updated = await (
        await database(req)
      ).execute(sql`
        UPDATE admin_approval_requests
        SET status = 'executed', executed_at = ${executedAt}, updated_at = NOW()
        WHERE id = ${input.requestId}
          AND status = 'executing'
          AND execution_claim_key = ${claimed.claimKey}
          AND executed_by_id = ${actor.id}
        RETURNING id
      `)
      if (updated.rows?.[0]?.id === undefined) {
        throw new AppError(
          'ADMIN_APPROVAL_EXECUTION_FINALIZE_CONFLICT',
          '审批执行状态无法确认',
          409,
        )
      }
      await accessEvent(req, {
        actorId: actor.id,
        eventType: 'executed',
        metadata: { operationType: input.expectedOperationType },
        requestId: input.requestId,
        suffix: claimed.claimKey,
      })
      await enqueueTransactionalSecurityNotification(req, {
        body: `${OPERATION_LABELS[input.expectedOperationType]}已执行。如非本人授权，请立即联系人工支持。`,
        customerId: Number(relationId(claimed.approval.customer)),
        domainEventType: 'admin.high_risk_operation.executed',
        eventKey: `admin-approval:${claimed.approval.requestKey}:executed`,
        notificationType: 'admin_high_risk_operation_executed',
        subject: '高风险操作已执行',
        templateKey: 'admin-high-risk-operation-executed',
        templateVersion: 2,
        traceId: getTraceId(req.headers),
      })
      await recordAuditEvent(req, {
        action: 'admin.high_risk_operation.executed',
        actor: { id: actor.id, type: 'admin' },
        metadata: { operationType: input.expectedOperationType },
        targetId: input.requestId,
      })
      return value
    })
    return { result, status: 'executed' }
  } catch (error) {
    const failureCode = error instanceof AppError ? error.code : 'ADMIN_OPERATION_EXECUTION_FAILED'
    await transaction(req, async () => {
      const failedAt = new Date().toISOString()
      const updated = await (
        await database(req)
      ).execute(sql`
        UPDATE admin_approval_requests
        SET status = 'failed', failed_at = ${failedAt}, failure_code = ${failureCode}, updated_at = NOW()
        WHERE id = ${input.requestId}
          AND status = 'executing'
          AND execution_claim_key = ${claimed.claimKey}
        RETURNING id
      `)
      if (updated.rows?.[0]?.id !== undefined) {
        await accessEvent(req, {
          actorId: actor.id,
          eventType: 'failed',
          metadata: { failureCode, operationType: input.expectedOperationType },
          requestId: input.requestId,
          suffix: claimed.claimKey,
        })
        await recordAuditEvent(req, {
          action: 'admin.high_risk_operation.failed',
          actor: { id: actor.id, type: 'admin' },
          metadata: { failureCode, operationType: input.expectedOperationType },
          targetId: input.requestId,
        })
      }
    })
    throw error
  }
}

export async function listAdminApprovalRequests(req: PayloadRequest) {
  adminActor(req)
  const requests = await req.payload.find({
    collection: 'adminApprovalRequests',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    req,
    sort: '-createdAt',
  })
  return requests.docs.map((raw) => {
    const request = raw as unknown as AdminApprovalRecord
    return {
      amountFen: request.amountFen ?? null,
      createdAt: request.createdAt,
      id: request.id,
      operationType: request.operationType,
      status: request.status,
      targetId: request.targetId,
      targetType: request.targetType,
    }
  })
}
