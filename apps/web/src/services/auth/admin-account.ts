import { Forbidden } from 'payload'
import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  PayloadRequest,
} from 'payload'

import { hasRole, isActiveAdminUser } from '@/access/roles'
import { AppError } from '@/lib/errors'
import { adminPasswordSchema } from '@/schemas/auth'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

type AdminShape = {
  email?: string | null
  id: number | string
  roles?: string[] | null
  sessions?: unknown[] | null
  status?: 'active' | 'disabled' | null
}

type SecurityContext = {
  adminAccountOperation?: 'bootstrap' | 'invitation' | 'mfa-reset' | 'security-hook'
  adminMfa?: { recoveryCode?: string; totp?: string }
  adminSecurityChanges?: string[]
  suppressAdminAccountAudit?: boolean
}

const DISABLED_ADMIN_AUTH_OPERATIONS = new Set([
  'forgotPassword',
  'refresh',
  'resetPassword',
  'unlock',
])

function securityContext(req: PayloadRequest): SecurityContext {
  return req.context as SecurityContext
}

function isProvisioningOperation(req: PayloadRequest): boolean {
  return ['bootstrap', 'invitation', 'mfa-reset'].includes(
    securityContext(req).adminAccountOperation ?? '',
  )
}

function isActiveSystemAdmin(admin: AdminShape): boolean {
  return admin.status === 'active' && Boolean(admin.roles?.includes('system_admin'))
}

async function assertAnotherActiveSystemAdmin(req: PayloadRequest, admin: AdminShape) {
  if (!isActiveSystemAdmin(admin)) return
  const activeSystemAdmins = await req.payload.count({
    collection: 'admins',
    overrideAccess: true,
    req,
    where: {
      and: [{ status: { equals: 'active' } }, { roles: { contains: 'system_admin' } }],
    },
  })
  if (activeSystemAdmins.totalDocs <= 1) {
    throw new AppError(
      'LAST_SYSTEM_ADMIN_PROTECTED',
      '不能删除、停用或降级最后一个启用的系统管理员',
      409,
    )
  }
}

export const validateAdminPassword: CollectionBeforeValidateHook = ({ data }) => {
  if (data && typeof data.password === 'string') adminPasswordSchema.parse(data.password)
  return data
}

export const blockAdminDefaultAuthOperations: CollectionBeforeOperationHook = ({
  args,
  operation,
  req,
}) => {
  const customMfaLogin = operation === 'login' && Boolean(securityContext(req).adminMfa)
  if (DISABLED_ADMIN_AUTH_OPERATIONS.has(operation) || (operation === 'login' && !customMfaLogin)) {
    throw new Forbidden(req.t)
  }
  return args
}

export const guardAdminAccountChange: CollectionBeforeChangeHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const context = securityContext(req)
  if (context.adminAccountOperation === 'security-hook') return data

  if (operation === 'create') {
    if (!isProvisioningOperation(req)) {
      throw new AppError(
        'ADMIN_INVITATION_REQUIRED',
        '管理员账号只能通过受控 bootstrap 或一次性邀请创建',
        403,
      )
    }
    return data
  }

  const previous = originalDoc as AdminShape
  const changes: string[] = []
  const passwordChanged = typeof data.password === 'string'
  const emailChanged = typeof data.email === 'string' && data.email !== previous.email
  const rolesChanged = Array.isArray(data.roles)
  const statusChanged = typeof data.status === 'string' && data.status !== previous.status

  if (passwordChanged && !isProvisioningOperation(req)) {
    if (!isActiveAdminUser(req.user) || String(req.user.id) !== String(previous.id)) {
      throw new AppError('ADMIN_PASSWORD_SELF_ONLY', '管理员只能修改自己的密码', 403)
    }
  }
  if (emailChanged && !hasRole(req.user, ['system_admin'])) {
    throw new AppError('ADMIN_ACCOUNT_MANAGEMENT_FORBIDDEN', '仅系统管理员可修改账号邮箱', 403)
  }

  const next: AdminShape = {
    ...previous,
    roles: rolesChanged ? (data.roles as string[]) : previous.roles,
    status: statusChanged ? (data.status as 'active' | 'disabled') : previous.status,
  }
  if (isActiveSystemAdmin(previous) && !isActiveSystemAdmin(next)) {
    await assertAnotherActiveSystemAdmin(req, previous)
  }

  if (passwordChanged) changes.push('password')
  if (emailChanged) changes.push('email')
  if (rolesChanged) changes.push('roles')
  if (statusChanged) changes.push('status')
  context.adminSecurityChanges = changes
  return data
}

export const revokeSessionsAfterAdminChange: CollectionAfterChangeHook = async ({ doc, req }) => {
  const context = securityContext(req)
  if (context.adminAccountOperation === 'security-hook') return doc
  const changes = context.adminSecurityChanges ?? []
  if (!changes.length) return doc

  await req.payload.update({
    collection: 'admins',
    context: { adminAccountOperation: 'security-hook' },
    data: { sessions: [] },
    id: doc.id,
    overrideAccess: true,
    req,
  })

  if (!context.suppressAdminAccountAudit) {
    await recordAuditEvent(req, {
      action: 'admin.account.changed',
      metadata: { changedFields: changes },
      targetId: doc.id,
      targetType: 'admin',
    })
  }
  return { ...doc, sessions: [] }
}

export const guardAdminDelete: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const admin = (await req.payload.findByID({
    collection: 'admins',
    id,
    overrideAccess: true,
    req,
  })) as AdminShape
  await assertAnotherActiveSystemAdmin(req, admin)
  await req.payload.delete({
    collection: 'adminMfaCredentials',
    overrideAccess: true,
    req,
    where: { admin: { equals: id } },
  })
  await req.payload.delete({
    collection: 'adminInvitations',
    overrideAccess: true,
    req,
    where: {
      or: [{ createdBy: { equals: id } }, { targetAdmin: { equals: id } }],
    },
  })
}

export const auditAdminDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  await recordAuditEvent(req, {
    action: 'admin.account.deleted',
    targetId: doc.id,
    targetType: 'admin',
  })
  return doc
}
