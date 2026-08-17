import type { CollectionConfig } from 'payload'

import { deny, ownOrSystem, sensitiveFieldRead, systemAdminHidden } from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { AppError } from '@/lib/errors'

function appendOnly(code: string, message: string) {
  return {
    beforeChange: [
      ({ operation }: { operation: string }) => {
        if (operation === 'update') throw new AppError(code, message, 409)
      },
    ],
    beforeDelete: [
      () => {
        throw new AppError(code, message, 409)
      },
    ],
  }
}

export const DomainManagementEvents: CollectionConfig = {
  slug: 'domainManagementEvents',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: {
    defaultColumns: ['operation', 'event', 'occurredAt'],
    group: ADMIN_GROUPS.fulfillment,
    hidden: systemAdminHidden,
  },
  defaultSort: '-occurredAt',
  hooks: appendOnly('DOMAIN_MANAGEMENT_EVENT_APPEND_ONLY', '域名管理操作记录只允许追加'),
  indexes: [{ fields: ['asset', 'occurredAt'] }, { fields: ['customer', 'occurredAt'] }],
  lockDocuments: false,
  fields: [
    {
      name: 'eventKey',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
      required: true,
      unique: true,
    },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'asset',
      type: 'relationship',
      relationTo: 'domainAssets',
      index: true,
      required: true,
    },
    {
      name: 'operation',
      type: 'select',
      options: [
        'management_password_read',
        'management_password_modify',
        'contact_information_update',
        'template_transfer',
        'certificate_download',
      ],
      required: true,
    },
    {
      name: 'event',
      type: 'select',
      options: ['requested', 'confirmed', 'failed', 'pending_query'],
      required: true,
    },
    {
      name: 'contactType',
      type: 'select',
      options: ['dom_id', 'admin_id', 'tech_id', 'bill_id'],
    },
    {
      name: 'realnameTemplate',
      type: 'relationship',
      relationTo: 'realnameTemplates',
      index: true,
    },
    {
      name: 'providerOperation',
      type: 'relationship',
      relationTo: 'providerOperations',
      access: { read: sensitiveFieldRead },
      index: true,
    },
    { name: 'operationKey', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'errorCode', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'occurredAt', type: 'date', index: true, required: true },
    { name: 'traceId', type: 'text', access: { read: sensitiveFieldRead }, index: true },
  ],
}

export const DomainAssetSyncEvents: CollectionConfig = {
  slug: 'domainAssetSyncEvents',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: {
    defaultColumns: ['outcome', 'resolutionStatus', 'observedAt'],
    group: ADMIN_GROUPS.fulfillment,
    hidden: systemAdminHidden,
  },
  defaultSort: '-observedAt',
  hooks: appendOnly('DOMAIN_ASSET_SYNC_EVENT_APPEND_ONLY', '域名资产同步记录只允许追加'),
  indexes: [{ fields: ['asset', 'observedAt'] }, { fields: ['resolutionStatus', 'observedAt'] }],
  lockDocuments: false,
  fields: [
    {
      name: 'eventKey',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
      required: true,
      unique: true,
    },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'asset',
      type: 'relationship',
      relationTo: 'domainAssets',
      index: true,
      required: true,
    },
    {
      name: 'outcome',
      type: 'select',
      options: ['matched', 'difference', 'not_owned', 'ownership_unknown'],
      required: true,
    },
    {
      name: 'resolutionStatus',
      type: 'select',
      options: ['not_required', 'pending'],
      required: true,
    },
    { name: 'localFacts', type: 'json' },
    { name: 'upstreamFacts', type: 'json' },
    { name: 'differences', type: 'json' },
    { name: 'providerErrorCode', type: 'text', access: { read: sensitiveFieldRead } },
    { name: 'observedAt', type: 'date', index: true, required: true },
    { name: 'traceId', type: 'text', access: { read: sensitiveFieldRead }, index: true },
  ],
}
