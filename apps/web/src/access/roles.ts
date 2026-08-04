import type { Access, FieldAccess } from 'payload'

import type { AdminRole } from '@/lib/domain'

type AccessUser = {
  collection?: string
  id: number | string
  roles?: AdminRole[] | null
}

export const isAdminUser = (user: unknown): user is AccessUser =>
  typeof user === 'object' && user !== null && (user as AccessUser).collection === 'admins'

export const isCustomerUser = (user: unknown): user is AccessUser =>
  typeof user === 'object' && user !== null && (user as AccessUser).collection === 'customers'

export const hasRole = (user: unknown, roles: AdminRole[]): boolean =>
  isAdminUser(user) && Boolean(user.roles?.some((role) => roles.includes(role)))

export const publicRead: Access = () => true
export const authenticated: Access = ({ req }) => Boolean(req.user)
export const systemAdminOnly: Access = ({ req }) => hasRole(req.user, ['system_admin'])
export const contentManagers: Access = ({ req }) =>
  hasRole(req.user, ['content_editor', 'system_admin'])
export const adManagers: Access = ({ req }) => hasRole(req.user, ['ad_operator', 'system_admin'])
export const analysts: Access = ({ req }) => hasRole(req.user, ['analyst', 'system_admin'])
export const deny: Access = () => false

export const sensitiveFieldRead: FieldAccess = ({ req }) => hasRole(req.user, ['system_admin'])
export const systemAdminField: FieldAccess = ({ req }) => hasRole(req.user, ['system_admin'])

export function ownOrSystem(ownerField: string): Access {
  return ({ req }) => {
    if (hasRole(req.user, ['system_admin'])) return true
    if (!isCustomerUser(req.user)) return false
    return { [ownerField]: { equals: req.user.id } }
  }
}

export const publishedOrContentManager: Access = ({ req }) => {
  if (hasRole(req.user, ['content_editor', 'system_admin'])) return true
  return { _status: { equals: 'published' } }
}
