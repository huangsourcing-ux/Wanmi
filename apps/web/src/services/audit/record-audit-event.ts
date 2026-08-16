import type { PayloadRequest } from 'payload'

import { isAdminUser, isCustomerUser } from '@/access/roles'
import { getTraceId } from '@/lib/request-id'
import { REDACTED_VALUE, sanitizeSensitiveData } from '@/services/privacy/sanitize-sensitive-data'

export const AUDIT_REDACTED_VALUE = REDACTED_VALUE

export type AuditActorType = 'admin' | 'anonymous' | 'customer' | 'provider' | 'system'

export const auditEventDefinitions = {
  'customer.default_profile_type.changed': {
    actorTypes: ['customer'],
    targetType: 'customer',
  },
  'customer.identity.bound': {
    actorTypes: ['customer', 'system'],
    targetType: 'customer-identity',
  },
  'customer.identity.unbound': {
    actorTypes: ['customer', 'system'],
    targetType: 'customer-identity',
  },
  'customer.account_state.changed': {
    actorTypes: ['admin', 'customer', 'system'],
    targetType: 'customer',
  },
  'customer.account_sessions.revoked': {
    actorTypes: ['admin', 'customer', 'system'],
    targetType: 'customer-session',
  },
  'customer.account_recovery.requested': {
    actorTypes: ['anonymous'],
    targetType: 'customer',
  },
  'customer.account_recovery.decided': {
    actorTypes: ['admin'],
    targetType: 'customer',
  },
  'customer.consent.accepted': {
    actorTypes: ['customer'],
    targetType: 'customer',
  },
  'customer.consent.revoked': {
    actorTypes: ['customer'],
    targetType: 'customer',
  },
  'customer.legacy_profile.completed': {
    actorTypes: ['customer'],
    targetType: 'customer',
  },
  'customer.personal_information.exported': {
    actorTypes: ['admin', 'customer'],
    targetType: 'customer',
  },
  'customer.personal_information.viewed': {
    actorTypes: ['admin', 'customer'],
    targetType: 'customer',
  },
  'customer.registered': { actorTypes: ['customer'], targetType: 'customer' },
  'advertising.change': { actorTypes: ['admin'], targetType: 'advertising' },
  'advertising.delete': { actorTypes: ['admin'], targetType: 'advertising' },
  'advertising.maintenance': { actorTypes: ['system'], targetType: 'advertising' },
  'admin.account.changed': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.account.deleted': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.auth.login_failed': { actorTypes: ['anonymous'], targetType: 'admin-auth' },
  'admin.auth.login_succeeded': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.auth.mfa_failed': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.auth.mfa_locked': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.auth.mfa_locked_rejected': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.auth.recovery_code_used': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.invitation.accepted': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.invitation.created': { actorTypes: ['admin'], targetType: 'admin-invitation' },
  'admin.invitation.revoked': { actorTypes: ['admin'], targetType: 'admin-invitation' },
  'admin.mfa.reset_completed': { actorTypes: ['admin'], targetType: 'admin' },
  'admin.session.revoked': { actorTypes: ['admin'], targetType: 'admin-session' },
  'admin.sessions.revoked_all': { actorTypes: ['admin'], targetType: 'admin-session' },
  'content.publish.schedule_cancelled': { actorTypes: ['admin'], targetType: 'content' },
  'content.publish.scheduled': { actorTypes: ['admin'], targetType: 'content' },
  'content.revision.published': { actorTypes: ['admin'], targetType: 'content' },
  'content.status.changed': { actorTypes: ['admin'], targetType: 'content' },
  'form_submission.status_changed': { actorTypes: ['admin'], targetType: 'form-submission' },
  'pricing.rule.created': { actorTypes: ['admin'], targetType: 'price-rule' },
  'pricing.rule.deleted': { actorTypes: ['admin'], targetType: 'price-rule' },
  'pricing.rule.disabled': { actorTypes: ['admin'], targetType: 'price-rule' },
  'pricing.rule.enabled': { actorTypes: ['admin'], targetType: 'price-rule' },
  'pricing.rule.updated': { actorTypes: ['admin'], targetType: 'price-rule' },
  'commerce.invoice_note.recorded': { actorTypes: ['admin'], targetType: 'order' },
  'commerce.job.interrupted_released': { actorTypes: ['system'], targetType: 'payload-job' },
  'commerce.balance_control.updated': { actorTypes: ['admin'], targetType: 'site-setting' },
  'commerce.balance_low.alerted': { actorTypes: ['system'], targetType: 'site-setting' },
  'commerce.payment_notification.replayed': {
    actorTypes: ['admin'],
    targetType: 'payment-notification',
  },
  'commerce.payment.reconciled': { actorTypes: ['admin'], targetType: 'order' },
  'commerce.special_refund.recorded': { actorTypes: ['admin'], targetType: 'order' },
  'commerce.sales_stop.changed': {
    actorTypes: ['admin', 'system'],
    targetType: 'site-setting',
  },
  'commerce.sales_stop.paid_order_held': { actorTypes: ['system'], targetType: 'order' },
  'commerce.sales_stop.refund_selected': { actorTypes: ['admin'], targetType: 'order' },
  'commerce.sales_stop.resume_selected': { actorTypes: ['admin'], targetType: 'order' },
  'commerce.renewal.recorded': {
    actorTypes: ['provider', 'system'],
    targetType: 'renewal',
  },
  'domain.asset.synced': {
    actorTypes: ['customer', 'system'],
    targetType: 'domain-asset',
  },
  'domain.expiry_reminder.recorded': {
    actorTypes: ['system'],
    targetType: 'domain-expiry-reminder',
  },
  'domain.nameserver.change_recorded': {
    actorTypes: ['admin', 'customer', 'system'],
    targetType: 'nameserver-change',
  },
  'operations.monitoring.alerted': {
    actorTypes: ['system'],
    targetType: 'operations-monitoring',
  },
  'provider.operation.recorded': {
    actorTypes: ['admin', 'customer', 'provider', 'system'],
    targetType: 'provider-operation',
  },
  'realname.template.status_changed': {
    actorTypes: ['admin', 'customer', 'provider', 'system'],
    targetType: 'realname-template',
  },
  'realname.template.cleaned': {
    actorTypes: ['system'],
    targetType: 'realname-template',
  },
  'realname.document.deleted': {
    actorTypes: ['admin', 'customer', 'system'],
    targetType: 'realname-document',
  },
  'realname.document.downloaded': {
    actorTypes: ['admin', 'customer'],
    targetType: 'realname-document',
  },
  'realname.document.submitted': {
    actorTypes: ['admin', 'customer', 'provider', 'system'],
    targetType: 'realname-document',
  },
  'realname.document.uploaded': {
    actorTypes: ['admin', 'customer', 'system'],
    targetType: 'realname-document',
  },
  'realname.document.viewed': {
    actorTypes: ['admin', 'customer'],
    targetType: 'realname-document',
  },
  'redirect.create': { actorTypes: ['admin'], targetType: 'redirect' },
  'redirect.delete': { actorTypes: ['admin'], targetType: 'redirect' },
  'redirect.update': { actorTypes: ['admin'], targetType: 'redirect' },
  'system.local_api.read': { actorTypes: ['system'], targetType: 'payload-collection' },
} as const satisfies Record<string, { actorTypes: readonly AuditActorType[]; targetType: string }>

export type AuditAction = keyof typeof auditEventDefinitions
export type AuditActor =
  | { id: number | string; type: 'admin' | 'customer' | 'provider' }
  | { type: 'anonymous' | 'system' }

export type AuditEventInput = {
  action: AuditAction
  actor?: AuditActor
  metadata?: Record<string, unknown>
  targetId?: number | string
}

export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  return sanitizeSensitiveData(metadata)
}

function requestActor(req: PayloadRequest): AuditActor {
  if (isAdminUser(req.user)) return { id: req.user.id, type: 'admin' }
  if (isCustomerUser(req.user)) return { id: req.user.id, type: 'customer' }
  if (req.user) throw new Error('Unsupported authenticated audit actor')
  return { type: 'anonymous' }
}

function actorData(actor: AuditActor): { actorId?: string; actorType: AuditActorType } {
  return 'id' in actor
    ? { actorId: String(actor.id), actorType: actor.type }
    : { actorType: actor.type }
}

export async function recordAuditEvent(req: PayloadRequest, input: AuditEventInput): Promise<void> {
  const definition = auditEventDefinitions[input.action]
  const resolvedActor = input.actor ?? requestActor(req)
  if (!(definition.actorTypes as readonly AuditActorType[]).includes(resolvedActor.type)) {
    throw new Error(`Audit action ${input.action} does not allow actor type ${resolvedActor.type}`)
  }
  await req.payload.create({
    collection: 'auditLogs',
    data: {
      action: input.action,
      ...actorData(resolvedActor),
      metadata: sanitizeAuditMetadata(input.metadata),
      targetId: input.targetId === undefined ? undefined : String(input.targetId),
      targetType: definition.targetType,
      traceId: getTraceId(req.headers),
    },
    overrideAccess: true,
    req,
  })
}
