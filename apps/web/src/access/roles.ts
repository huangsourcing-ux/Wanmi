import type { Access, FieldAccess, Where } from 'payload'

import type { AdminRole } from '@/lib/domain'

type AccessUser = {
  collection?: string
  id: number | string
  roles?: AdminRole[] | null
  status?: 'active' | 'disabled' | null
}

export const isAdminUser = (user: unknown): user is AccessUser =>
  typeof user === 'object' && user !== null && (user as AccessUser).collection === 'admins'

export const isActiveAdminUser = (user: unknown): user is AccessUser =>
  isAdminUser(user) && user.status === 'active'

export const isCustomerUser = (user: unknown): user is AccessUser =>
  typeof user === 'object' && user !== null && (user as AccessUser).collection === 'customers'

export const hasRole = (user: unknown, roles: AdminRole[]): boolean =>
  isActiveAdminUser(user) && Boolean(user.roles?.some((role) => roles.includes(role)))

export const publicRead: Access = () => true
export const authenticated: Access = ({ req }) => Boolean(req.user)
export const systemAdminOnly: Access = ({ req }) => hasRole(req.user, ['system_admin'])
export const contentManagers: Access = ({ req }) =>
  hasRole(req.user, ['content_editor', 'system_admin'])
export const adManagers: Access = ({ req }) => hasRole(req.user, ['ad_operator', 'system_admin'])
export const analysts: Access = ({ req }) => hasRole(req.user, ['analyst', 'system_admin'])
export const operationalReaders: Access = ({ req }) =>
  hasRole(req.user, ['ad_operator', 'analyst', 'system_admin'])
export const deny: Access = () => false

export const adminSelfOrSystem: Access = ({ req }) => {
  if (hasRole(req.user, ['system_admin'])) return true
  if (!isActiveAdminUser(req.user)) return false
  return { id: { equals: req.user.id } }
}

export const sensitiveFieldRead: FieldAccess = ({ req }) => hasRole(req.user, ['system_admin'])
export const systemAdminField: FieldAccess = ({ req }) => hasRole(req.user, ['system_admin'])
export const adManagerFieldRead: FieldAccess = ({ req }) =>
  hasRole(req.user, ['ad_operator', 'system_admin'])
export const operationalFieldRead: FieldAccess = ({ req }) =>
  hasRole(req.user, ['ad_operator', 'analyst', 'system_admin'])

export const auditReaders: Access = ({ req }) => {
  if (hasRole(req.user, ['system_admin'])) return true
  if (!hasRole(req.user, ['ad_operator']) || !isActiveAdminUser(req.user)) return false
  const where: Where = {
    and: [{ actorType: { equals: 'admin' } }, { actorId: { equals: String(req.user.id) } }],
  }
  return where
}

export const hiddenUnlessRoles =
  (roles: AdminRole[]) =>
  ({ user }: { user: unknown }): boolean =>
    !hasRole(user, [...roles, 'system_admin'])

export const contentAdminHidden = hiddenUnlessRoles(['content_editor'])
export const advertisingAdminHidden = hiddenUnlessRoles(['ad_operator', 'analyst'])
export const operationsAdminHidden = hiddenUnlessRoles(['ad_operator', 'analyst'])
export const analystAdminHidden = hiddenUnlessRoles(['analyst'])
export const auditAdminHidden = hiddenUnlessRoles(['ad_operator'])
export const systemAdminHidden = hiddenUnlessRoles([])

export function ownOrSystem(ownerField: string): Access {
  return ({ req }) => {
    if (hasRole(req.user, ['system_admin'])) return true
    if (!isCustomerUser(req.user)) return false
    return { [ownerField]: { equals: req.user.id } }
  }
}

export const publishedOrContentManager: Access = ({ req }) => {
  if (hasRole(req.user, ['content_editor', 'system_admin'])) return true
  const where: Where = {
    and: [{ _status: { equals: 'published' } }, { workflowStatus: { equals: 'published' } }],
  }
  return where
}
