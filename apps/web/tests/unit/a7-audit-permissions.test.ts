import { describe, expect, it, vi } from 'vitest'

import { recordAuditEvent, type AuditAction } from '@/services/audit/record-audit-event'

describe('D9-A A7 audit permissions', () => {
  it('keeps consent/profile actions customer-only and personal-data actions admin-or-customer', async () => {
    const create = vi.fn()
    const req = {
      headers: new Headers({ 'x-request-id': 'a7-audit-permissions' }),
      payload: { create },
    }
    for (const action of [
      'customer.consent.accepted',
      'customer.consent.revoked',
      'customer.legacy_profile.completed',
    ] satisfies AuditAction[]) {
      await expect(
        recordAuditEvent(req as never, { action, actor: { type: 'system' }, targetId: 42 }),
      ).rejects.toThrow(/does not allow actor type system/u)
      await expect(
        recordAuditEvent(req as never, {
          action,
          actor: { id: 7, type: 'admin' },
          targetId: 42,
        }),
      ).rejects.toThrow(/does not allow actor type admin/u)
    }
    for (const action of [
      'customer.personal_information.exported',
      'customer.personal_information.viewed',
    ] satisfies AuditAction[]) {
      await expect(
        recordAuditEvent(req as never, { action, actor: { type: 'anonymous' }, targetId: 42 }),
      ).rejects.toThrow(/does not allow actor type anonymous/u)
      await expect(
        recordAuditEvent(req as never, { action, actor: { type: 'system' }, targetId: 42 }),
      ).rejects.toThrow(/does not allow actor type system/u)
    }
    expect(create).not.toHaveBeenCalled()
  })
})
