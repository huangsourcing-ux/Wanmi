import type { CollectionConfig } from 'payload'

import { deny, ownOrSystem, sensitiveFieldRead, systemAdminHidden } from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { AppError } from '@/lib/errors'

export const DnsRecordChanges: CollectionConfig = {
  slug: 'dnsRecordChanges',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: {
    defaultColumns: ['operation', 'event', 'providerRecordId', 'occurredAt'],
    group: ADMIN_GROUPS.fulfillment,
    hidden: systemAdminHidden,
  },
  defaultSort: '-occurredAt',
  hooks: {
    beforeChange: [
      ({ operation }) => {
        if (operation === 'update') {
          throw new AppError('DNS_RECORD_CHANGE_APPEND_ONLY', 'DNS 解析变更记录只允许追加', 409)
        }
      },
    ],
    beforeDelete: [
      () => {
        throw new AppError('DNS_RECORD_CHANGE_APPEND_ONLY', 'DNS 解析变更记录只允许追加', 409)
      },
    ],
  },
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
      options: ['add', 'modify', 'delete', 'pause', 'resume'],
      required: true,
    },
    {
      name: 'event',
      type: 'select',
      options: ['requested', 'confirmed', 'failed', 'pending_query'],
      required: true,
    },
    { name: 'providerRecordId', type: 'text', index: true },
    { name: 'beforeRecord', type: 'json' },
    { name: 'requestedRecord', type: 'json' },
    { name: 'confirmedRecord', type: 'json' },
    {
      name: 'providerOperation',
      type: 'relationship',
      relationTo: 'providerOperations',
      access: { read: sensitiveFieldRead },
      index: true,
    },
    { name: 'operationKey', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'batchKey', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'errorCode', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'occurredAt', type: 'date', index: true, required: true },
    { name: 'traceId', type: 'text', access: { read: sensitiveFieldRead }, index: true },
  ],
}
