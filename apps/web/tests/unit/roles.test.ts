import { describe, expect, it } from 'vitest'

import {
  adManagers,
  analysts,
  contentManagers,
  ownOrSystem,
  sensitiveFieldRead,
  systemAdminOnly,
} from '@/access/roles'
import type { AdminRole } from '@/lib/domain'

function accessUser(collection: 'admins' | 'customers', id: number, roles?: AdminRole[]) {
  return {
    req: {
      user: { collection, id, roles, status: collection === 'admins' ? 'active' : undefined },
    },
  } as never
}

describe('D0 role matrix', () => {
  it.each([
    ['content_editor', true, false, false, false],
    ['ad_operator', false, true, false, false],
    ['analyst', false, false, true, false],
    ['system_admin', true, true, true, true],
  ] as const)('applies %s capabilities', (role, content, ads, analysis, system) => {
    const args = accessUser('admins', 1, [role])
    expect(contentManagers(args)).toBe(content)
    expect(adManagers(args)).toBe(ads)
    expect(analysts(args)).toBe(analysis)
    expect(systemAdminOnly(args)).toBe(system)
    expect(sensitiveFieldRead(args)).toBe(system)
  })

  it('denies anonymous and confines customers to their own rows', () => {
    expect(contentManagers({ req: { user: null } } as never)).toBe(false)
    expect(adManagers(accessUser('customers', 9))).toBe(false)
    expect(ownOrSystem('customer')(accessUser('customers', 9))).toEqual({ customer: { equals: 9 } })
    expect(ownOrSystem('customer')(accessUser('admins', 1, ['system_admin']))).toBe(true)
  })
})
