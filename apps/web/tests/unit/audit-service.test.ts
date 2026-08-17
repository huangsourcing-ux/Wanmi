import { describe, expect, it, vi } from 'vitest'

import {
  AUDIT_REDACTED_VALUE,
  auditEventDefinitions,
  recordAuditEvent,
  sanitizeAuditMetadata,
} from '@/services/audit/record-audit-event'

describe('shared audit event service', () => {
  it('keeps the established action identifiers in one typed catalog', () => {
    expect(Object.keys(auditEventDefinitions).sort()).toEqual(
      [
        'advertising.change',
        'advertising.delete',
        'advertising.maintenance',
        'admin.account.changed',
        'admin.account.deleted',
        'admin.auth.login_failed',
        'admin.auth.login_succeeded',
        'admin.auth.mfa_failed',
        'admin.auth.mfa_locked',
        'admin.auth.mfa_locked_rejected',
        'admin.auth.recovery_code_used',
        'admin.invitation.accepted',
        'admin.invitation.created',
        'admin.invitation.revoked',
        'admin.mfa.reset_completed',
        'admin.session.revoked',
        'admin.sessions.revoked_all',
        'content.publish.schedule_cancelled',
        'content.publish.scheduled',
        'content.revision.published',
        'content.status.changed',
        'customer.account_closure.blockers_refreshed',
        'customer.account_closure.executed',
        'customer.account_closure.requested',
        'customer.account_closure.revoked',
        'customer.account_recovery.decided',
        'customer.account_recovery.requested',
        'customer.account_sessions.revoked',
        'customer.account_state.changed',
        'customer.consent.accepted',
        'customer.consent.revoked',
        'customer.default_profile_type.changed',
        'customer.identity.bound',
        'customer.identity.unbound',
        'customer.legacy_profile.completed',
        'customer.personal_information.exported',
        'customer.personal_information.viewed',
        'customer.registered',
        'commerce.balance_control.updated',
        'commerce.balance_low.alerted',
        'commerce.invoice_note.recorded',
        'commerce.job.interrupted_released',
        'commerce.payment_notification.replayed',
        'commerce.payment.reconciled',
        'commerce.renewal.recorded',
        'commerce.sales_stop.changed',
        'commerce.sales_stop.paid_order_held',
        'commerce.sales_stop.refund_selected',
        'commerce.sales_stop.resume_selected',
        'commerce.special_refund.recorded',
        'domain.asset.synced',
        'domain.expiry_reminder.recorded',
        'domain.nameserver.change_recorded',
        'form_submission.status_changed',
        'operations.monitoring.alerted',
        'pricing.rule.created',
        'pricing.rule.deleted',
        'pricing.rule.disabled',
        'pricing.rule.enabled',
        'pricing.rule.updated',
        'provider.operation.recorded',
        'realname.document.deleted',
        'realname.document.downloaded',
        'realname.document.submitted',
        'realname.document.uploaded',
        'realname.document.viewed',
        'realname.template.cleaned',
        'realname.template.status_changed',
        'redirect.create',
        'redirect.delete',
        'redirect.update',
        'system.local_api.read',
        'wallet.ledger_invariant.failed',
      ].sort(),
    )
  })

  it('derives the request actor and target type and threads the mutation request', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1 })
    const req = {
      headers: new Headers({ 'x-request-id': 'audit-trace-0001' }),
      payload: { create },
      user: { collection: 'admins', id: 42 },
    }
    await recordAuditEvent(req as never, {
      action: 'redirect.update',
      metadata: { after: '/help' },
      targetId: 9,
    })

    expect(create).toHaveBeenCalledWith({
      collection: 'auditLogs',
      data: {
        action: 'redirect.update',
        actorId: '42',
        actorType: 'admin',
        metadata: { after: '/help' },
        targetId: '9',
        targetType: 'redirect',
        traceId: 'audit-trace-0001',
      },
      overrideAccess: true,
      req,
    })
  })

  it('supports explicit system attribution and rejects actor mismatches', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1 })
    const req = {
      headers: new Headers({ 'x-request-id': 'audit-trace-0002' }),
      payload: { create },
      user: null,
    }
    await recordAuditEvent(req as never, {
      action: 'system.local_api.read',
      actor: { type: 'system' },
      targetId: 'orders',
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'system',
          targetId: 'orders',
          targetType: 'payload-collection',
        }),
      }),
    )

    await expect(
      recordAuditEvent(req as never, {
        action: 'redirect.create',
        actor: { type: 'anonymous' },
      }),
    ).rejects.toThrow(/does not allow actor type anonymous/)
  })

  it('recursively redacts secret fields and complete Chinese identity values', () => {
    const circular: unknown[] = []
    circular.push(circular)
    const metadata = sanitizeAuditMetadata({
      circular,
      cookie: 'wanmi_admin=raw-cookie',
      identityNumber: '11010519491231002X',
      nested: [
        {
          note: '联系电话 13812345678',
          providerApiSecret: 'provider-secret',
          recoveryCode: 'recovery-code',
          totp: '123456',
        },
      ],
      phone: '13812345678',
      phoneMasked: '138****5678',
      sessionIdHash: 'safe-session-hash',
      tokenHash: 'safe-token-hash',
    })

    expect(metadata).toEqual({
      circular: [AUDIT_REDACTED_VALUE],
      cookie: AUDIT_REDACTED_VALUE,
      identityNumber: AUDIT_REDACTED_VALUE,
      nested: [
        {
          note: `联系电话 ${AUDIT_REDACTED_VALUE}`,
          providerApiSecret: AUDIT_REDACTED_VALUE,
          recoveryCode: AUDIT_REDACTED_VALUE,
          totp: AUDIT_REDACTED_VALUE,
        },
      ],
      phone: AUDIT_REDACTED_VALUE,
      phoneMasked: '138****5678',
      sessionIdHash: 'safe-session-hash',
      tokenHash: 'safe-token-hash',
    })
    const serialized = JSON.stringify(metadata)
    expect(serialized).not.toContain('13812345678')
    expect(serialized).not.toContain('11010519491231002X')
    expect(serialized).not.toContain('provider-secret')
    expect(serialized).not.toContain('recovery-code')
  })
})
