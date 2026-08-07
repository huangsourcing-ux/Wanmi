import { describe, expect, it } from 'vitest'

import { OPERATIONS_VIEWS, canViewOperationsView } from '@/lib/operations-views'

function admin(role: 'ad_operator' | 'analyst' | 'content_editor' | 'system_admin') {
  return { collection: 'admins', roles: [role], status: 'active' }
}

describe('D3 operations view visibility', () => {
  it.each([
    ['content_editor', ['content', 'tldPricing']],
    ['ad_operator', ['advertising', 'audit', 'feedback']],
    ['analyst', ['advertising', 'dashboard', 'feedback', 'tools']],
    ['system_admin', OPERATIONS_VIEWS.map((view) => view.key).sort()],
  ] as const)('keeps the D1-06 view matrix for %s', (role, expected) => {
    const visible = OPERATIONS_VIEWS.filter((view) => canViewOperationsView(admin(role), view.key))
      .map((view) => view.key)
      .sort()
    expect(visible).toEqual([...expected].sort())
  })

  it('denies anonymous, customer and disabled admin users', () => {
    for (const user of [
      undefined,
      { collection: 'customers', roles: [], status: 'active' },
      { collection: 'admins', roles: ['system_admin'], status: 'disabled' },
    ]) {
      expect(OPERATIONS_VIEWS.some((view) => canViewOperationsView(user as never, view.key))).toBe(
        false,
      )
    }
  })
})
