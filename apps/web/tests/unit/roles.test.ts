import { describe, expect, it } from 'vitest'

import {
  adManagers,
  advertisingAdminHidden,
  analysts,
  auditAdminHidden,
  auditReaders,
  contentAdminHidden,
  contentManagers,
  operationalReaders,
  operationsAdminHidden,
  ownOrSystem,
  sensitiveFieldRead,
  systemAdminHidden,
  systemAdminOnly,
} from '@/access/roles'
import type { AdminRole } from '@/lib/domain'

function adminUser(id: number, roles?: AdminRole[]) {
  return { collection: 'admins' as const, id, roles, status: 'active' as const }
}

function accessUser(collection: 'admins' | 'customers', id: number, roles?: AdminRole[]) {
  const user = collection === 'admins' ? adminUser(id, roles) : { collection, id }
  return { req: { user } } as never
}

describe('D1 administrator role boundaries', () => {
  it.each([
    ['content_editor', true, false, false, false, false],
    ['ad_operator', false, true, false, true, false],
    ['analyst', false, false, true, true, false],
    ['system_admin', true, true, true, true, true],
  ] as const)('applies %s capabilities', (role, content, ads, analysis, operations, system) => {
    const args = accessUser('admins', 1, [role])
    expect(contentManagers(args)).toBe(content)
    expect(adManagers(args)).toBe(ads)
    expect(analysts(args)).toBe(analysis)
    expect(operationalReaders(args)).toBe(operations)
    expect(systemAdminOnly(args)).toBe(system)
    expect(sensitiveFieldRead(args)).toBe(system)
  })

  it('denies anonymous and confines customers to their own rows', () => {
    expect(contentManagers({ req: { user: null } } as never)).toBe(false)
    expect(adManagers(accessUser('customers', 9))).toBe(false)
    expect(ownOrSystem('customer')(accessUser('customers', 9))).toEqual({ customer: { equals: 9 } })
    expect(ownOrSystem('customer')(accessUser('admins', 1, ['system_admin']))).toBe(true)
  })

  it('denies disabled administrators even when their roles remain in the session document', () => {
    const disabled = {
      req: {
        user: {
          collection: 'admins',
          id: 1,
          roles: ['content_editor', 'ad_operator', 'analyst', 'system_admin'],
          status: 'disabled',
        },
      },
    } as never
    expect(contentManagers(disabled)).toBe(false)
    expect(adManagers(disabled)).toBe(false)
    expect(operationalReaders(disabled)).toBe(false)
    expect(systemAdminOnly(disabled)).toBe(false)
  })

  it('limits ad operator audit reads to their own administrator events', () => {
    expect(auditReaders(accessUser('admins', 41, ['ad_operator']))).toEqual({
      and: [{ actorType: { equals: 'admin' } }, { actorId: { equals: '41' } }],
    })
    expect(auditReaders(accessUser('admins', 1, ['analyst']))).toBe(false)
    expect(auditReaders(accessUser('admins', 1, ['system_admin']))).toBe(true)
  })

  it('keeps the default admin UI aligned with each role boundary', () => {
    const content = adminUser(1, ['content_editor'])
    const ads = adminUser(1, ['ad_operator'])
    const analysis = adminUser(1, ['analyst'])
    const system = adminUser(1, ['system_admin'])

    expect(contentAdminHidden({ user: content })).toBe(false)
    expect(advertisingAdminHidden({ user: content })).toBe(true)
    expect(advertisingAdminHidden({ user: ads })).toBe(false)
    expect(operationsAdminHidden({ user: analysis })).toBe(false)
    expect(auditAdminHidden({ user: analysis })).toBe(true)
    expect(auditAdminHidden({ user: ads })).toBe(false)
    expect(systemAdminHidden({ user: system })).toBe(false)
    expect(systemAdminHidden({ user: ads })).toBe(true)
  })
})
