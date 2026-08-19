import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionConfig,
} from 'payload'

import {
  deny,
  fundsOperationsAdminHidden,
  fundsOperationsFieldRead,
  fundsOperators,
} from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { ADMIN_HIGH_RISK_OPERATION_TYPES } from '@/lib/domain'
import { AppError } from '@/lib/errors'

function approvalContext(context: Record<string, unknown>): boolean {
  return context.adminApprovalOperation === true
}

export const guardAdminApprovalRequestChange: CollectionBeforeChangeHook = ({ context, data }) => {
  if (!approvalContext(context)) {
    throw new AppError('ADMIN_APPROVAL_SERVICE_REQUIRED', '高风险操作审批只能通过受控服务变更', 403)
  }
  return data
}

export const guardAdminApprovalRequestDelete: CollectionBeforeDeleteHook = () => {
  throw new AppError('ADMIN_APPROVAL_DELETE_FORBIDDEN', '高风险操作审批记录不得删除', 409)
}

const appendOnly = (code: string, message: string) => ({
  beforeChange: [
    (({ data, operation }) => {
      if (operation === 'update') throw new AppError(code, message, 409)
      return data
    }) satisfies CollectionBeforeChangeHook,
  ],
  beforeDelete: [
    (() => {
      throw new AppError(code, message, 409)
    }) satisfies CollectionBeforeDeleteHook,
  ],
})

export const AdminApprovalRequests: CollectionConfig = {
  slug: 'adminApprovalRequests',
  access: { create: deny, delete: deny, read: fundsOperators, update: deny },
  admin: {
    defaultColumns: ['operationType', 'status', 'requestedBy', 'approvedBy', 'createdAt'],
    group: ADMIN_GROUPS.operations,
    hidden: fundsOperationsAdminHidden,
    useAsTitle: 'requestKey',
  },
  defaultSort: '-createdAt',
  hooks: {
    beforeChange: [guardAdminApprovalRequestChange],
    beforeDelete: [guardAdminApprovalRequestDelete],
  },
  indexes: [
    { fields: ['status', 'createdAt'] },
    { fields: ['customer', 'operationType', 'createdAt'] },
    { fields: ['operationType', 'targetId', 'status'] },
  ],
  fields: [
    { name: 'requestKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'operationType',
      type: 'select',
      options: [...ADMIN_HIGH_RISK_OPERATION_TYPES],
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'pending_approval',
      options: ['pending_approval', 'approved', 'executing', 'executed', 'rejected', 'failed'],
      required: true,
    },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    { name: 'targetType', type: 'text', index: true, required: true },
    { name: 'targetId', type: 'text', index: true, required: true },
    { name: 'amountFen', type: 'number', min: 1 },
    {
      name: 'operationData',
      type: 'json',
      access: { read: fundsOperationsFieldRead },
      required: true,
    },
    { name: 'reasonNote', type: 'textarea', required: true },
    {
      name: 'requestedBy',
      type: 'relationship',
      relationTo: 'admins',
      index: true,
      required: true,
    },
    { name: 'approvedBy', type: 'relationship', relationTo: 'admins', index: true },
    { name: 'executedBy', type: 'relationship', relationTo: 'admins', index: true },
    {
      name: 'requiresDifferentApprover',
      type: 'checkbox',
      defaultValue: true,
      required: true,
    },
    { name: 'cooldownSeconds', type: 'number', min: 1, required: true },
    { name: 'approvedAt', type: 'date', index: true },
    { name: 'executionClaimKey', type: 'text', index: true, unique: true },
    { name: 'executionClaimedAt', type: 'date', index: true },
    { name: 'executedAt', type: 'date', index: true },
    { name: 'failedAt', type: 'date', index: true },
    { name: 'failureCode', type: 'text' },
  ],
}

export const AdminAccessEvents: CollectionConfig = {
  slug: 'adminAccessEvents',
  access: { create: deny, delete: deny, read: fundsOperators, update: deny },
  admin: {
    defaultColumns: ['eventType', 'approvalRequest', 'actor', 'createdAt'],
    group: ADMIN_GROUPS.operations,
    hidden: fundsOperationsAdminHidden,
    useAsTitle: 'eventKey',
  },
  defaultSort: '-createdAt',
  hooks: appendOnly('ADMIN_ACCESS_EVENT_APPEND_ONLY', '管理员访问事件只允许追加'),
  indexes: [{ fields: ['approvalRequest', 'createdAt'] }, { fields: ['actor', 'createdAt'] }],
  fields: [
    { name: 'eventKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'eventType',
      type: 'select',
      options: ['requested', 'approved', 'rejected', 'execution_claimed', 'executed', 'failed'],
      required: true,
    },
    {
      name: 'approvalRequest',
      type: 'relationship',
      relationTo: 'adminApprovalRequests',
      index: true,
      required: true,
    },
    { name: 'actor', type: 'relationship', relationTo: 'admins', index: true, required: true },
    { name: 'metadata', type: 'json', access: { read: fundsOperationsFieldRead } },
    { name: 'traceId', type: 'text', index: true, required: true },
  ],
}
