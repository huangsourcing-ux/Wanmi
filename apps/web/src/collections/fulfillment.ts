import type { CollectionConfig } from 'payload'

import { deny, ownOrSystem, sensitiveFieldRead, systemAdminOnly } from '@/access/roles'

export const ProviderOperations: CollectionConfig = {
  slug: 'providerOperations',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  fields: [
    { name: 'operationKey', type: 'text', index: true, required: true, unique: true },
    { name: 'order', type: 'relationship', relationTo: 'orders', index: true, required: true },
    { name: 'provider', type: 'select', options: ['westdigital', 'wechatpay'], required: true },
    {
      name: 'operation',
      type: 'select',
      options: ['register', 'renew', 'refund', 'nameserver', 'query'],
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      options: ['prepared', 'submitted', 'succeeded', 'failed', 'unknown'],
      required: true,
    },
    { name: 'providerRequestId', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'submittedAt', type: 'date' },
    { name: 'lastCheckedAt', type: 'date' },
    { name: 'safeResult', type: 'json' },
  ],
}

export const DomainAssets: CollectionConfig = {
  slug: 'domainAssets',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { useAsTitle: 'domainAscii' },
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'realnameTemplate',
      type: 'relationship',
      relationTo: 'realnameTemplates',
      required: true,
    },
    { name: 'domainAscii', type: 'text', index: true, required: true, unique: true },
    { name: 'registrar', type: 'text', required: true },
    { name: 'registeredAt', type: 'date', required: true },
    { name: 'expiresAt', type: 'date', index: true, required: true },
    {
      name: 'status',
      type: 'select',
      options: ['active', 'expired', 'pending', 'unknown'],
      required: true,
    },
    { name: 'nameservers', type: 'text', hasMany: true, required: true },
    { name: 'lastSyncedAt', type: 'date', required: true },
  ],
}

export const Renewals: CollectionConfig = {
  slug: 'renewals',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  fields: [
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
    { name: 'order', type: 'relationship', relationTo: 'orders', required: true },
    { name: 'years', type: 'number', min: 1, max: 10, required: true },
    {
      name: 'status',
      type: 'select',
      options: ['pending', 'succeeded', 'failed', 'manual_review'],
      required: true,
    },
  ],
}

export const NameserverChanges: CollectionConfig = {
  slug: 'nameserverChanges',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  fields: [
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
    { name: 'requestedNameservers', type: 'text', hasMany: true, required: true },
    {
      name: 'status',
      type: 'select',
      options: ['pending', 'succeeded', 'failed', 'manual_review'],
      required: true,
    },
  ],
}
