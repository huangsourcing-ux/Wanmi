import { describe, expect, it, vi } from 'vitest'

import {
  AdminAccessEvents,
  guardAdminApprovalRequestChange,
  guardAdminApprovalRequestDelete,
} from '@/collections/administration'
import {
  NotificationMarketingPreferences,
  NotificationOutboxEvents,
  NotificationProviderReceipts,
  NotificationReadStates,
} from '@/collections/notifications'
import {
  ADMIN_APPROVAL_POLICY_KEY,
  guardApprovalPolicySettingChange,
  guardApprovalPolicySettingDelete,
} from '@/services/admin/approval-policy'

function firstHook(collection: { hooks?: Record<string, unknown> }, name: string) {
  const hooks = collection.hooks?.[name]
  expect(Array.isArray(hooks), `Missing ${name} hook`).toBe(true)
  expect(typeof (hooks as unknown[])[0], `Missing ${name} hook function`).toBe('function')
  return (hooks as unknown[])[0] as (input: unknown) => unknown
}

describe('D9-B-5 append-only and policy collection boundaries', () => {
  it('requires the approval service context for every approval mutation and forbids deletion', () => {
    expect(() =>
      guardAdminApprovalRequestChange({ context: {}, data: { status: 'approved' } } as never),
    ).toThrow(/受控服务/)
    expect(
      guardAdminApprovalRequestChange({
        context: { adminApprovalOperation: true },
        data: { status: 'approved' },
      } as never),
    ).toEqual({ status: 'approved' })
    expect(() => guardAdminApprovalRequestDelete({} as never)).toThrow(/不得删除/)
  })

  it.each([
    ['admin access event', AdminAccessEvents],
    ['notification body', NotificationOutboxEvents],
    ['provider receipt', NotificationProviderReceipts],
    ['read state', NotificationReadStates],
  ])('keeps %s rows append-only through update and delete hooks', (_label, collection) => {
    const beforeChange = firstHook(collection, 'beforeChange')
    const beforeDelete = firstHook(collection, 'beforeDelete')
    expect(() => beforeChange({ data: {}, operation: 'update' })).toThrow()
    expect(() => beforeDelete({})).toThrow()
  })

  it('requires the policy service marker and validates the positive cooldown at the hook', () => {
    expect(() =>
      guardApprovalPolicySettingChange({
        context: {},
        data: { key: ADMIN_APPROVAL_POLICY_KEY, value: {} },
      } as never),
    ).toThrow(/系统配置入口/)
    expect(() =>
      guardApprovalPolicySettingChange({
        context: { adminApprovalPolicyOperation: true },
        data: {
          key: ADMIN_APPROVAL_POLICY_KEY,
          value: {
            cooldownSeconds: 0,
            requiresDifferentApprover: true,
            schemaVersion: 1,
            updatedAt: '2026-08-19T00:00:00.000Z',
            updatedBy: 'fixture',
          },
        },
      } as never),
    ).toThrow()
  })

  it('forbids deleting the high-risk policy document', async () => {
    await expect(
      guardApprovalPolicySettingDelete({
        id: 1,
        req: {
          payload: {
            findByID: vi.fn().mockResolvedValue({ key: ADMIN_APPROVAL_POLICY_KEY }),
          },
        },
      } as never),
    ).rejects.toMatchObject({ code: 'ADMIN_APPROVAL_POLICY_DELETE_FORBIDDEN' })
  })

  it('models preferences with marketing types only', () => {
    const field = NotificationMarketingPreferences.fields.find(
      (candidate) => 'name' in candidate && candidate.name === 'enabledMarketingTypes',
    ) as { options?: unknown[] }
    expect(field.options).toEqual(['product_updates', 'promotions'])
    expect(JSON.stringify(field.options)).not.toContain('admin_high_risk_operation')
  })
})
