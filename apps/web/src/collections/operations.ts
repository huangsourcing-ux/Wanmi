import type { CollectionConfig } from 'payload'

import {
  adManagerFieldRead,
  auditAdminHidden,
  auditReaders,
  deny,
  operationalReaders,
  operationsAdminHidden,
  ownOrSystem,
  sensitiveFieldRead,
  systemAdminHidden,
  systemAdminOnly,
} from '@/access/roles'

export const ManualReviews: CollectionConfig = {
  slug: 'manualReviews',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { hidden: systemAdminHidden },
  fields: [
    { name: 'order', type: 'relationship', relationTo: 'orders', index: true },
    { name: 'reasonCode', type: 'text', index: true, required: true },
    {
      name: 'status',
      type: 'select',
      options: ['open', 'resolved'],
      defaultValue: 'open',
      required: true,
    },
    { name: 'evidence', type: 'json' },
    { name: 'resolutionNote', type: 'textarea' },
    { name: 'resolvedBy', type: 'relationship', relationTo: 'admins' },
    { name: 'resolvedAt', type: 'date' },
  ],
}

export const Reconciliations: CollectionConfig = {
  slug: 'reconciliations',
  access: { create: deny, delete: deny, read: operationalReaders, update: deny },
  admin: { hidden: operationsAdminHidden },
  fields: [
    {
      name: 'kind',
      type: 'select',
      options: ['wechat', 'westdigital', 'three_way'],
      required: true,
    },
    { name: 'periodStart', type: 'date', required: true },
    { name: 'periodEnd', type: 'date', required: true },
    {
      name: 'status',
      type: 'select',
      options: ['pending', 'matched', 'difference', 'reviewed'],
      required: true,
    },
    { name: 'summary', type: 'json', required: true },
  ],
}

export const AuditLogs: CollectionConfig = {
  slug: 'auditLogs',
  access: { create: deny, delete: deny, read: auditReaders, update: deny },
  admin: { hidden: auditAdminHidden },
  fields: [
    { name: 'action', type: 'text', index: true, required: true },
    {
      name: 'actorType',
      type: 'select',
      options: ['anonymous', 'customer', 'admin', 'system', 'provider'],
      required: true,
    },
    { name: 'actorId', type: 'text' },
    { name: 'targetType', type: 'text', required: true },
    { name: 'targetId', type: 'text' },
    { name: 'traceId', type: 'text', index: true, required: true },
    { name: 'metadata', type: 'json', access: { read: sensitiveFieldRead } },
  ],
}

export const UserFeedback: CollectionConfig = {
  slug: 'userFeedback',
  access: { create: deny, delete: deny, read: operationalReaders, update: systemAdminOnly },
  admin: { hidden: operationsAdminHidden },
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      access: { read: sensitiveFieldRead },
      relationTo: 'customers',
    },
    {
      name: 'category',
      type: 'select',
      options: ['contact', 'feedback', 'request'],
      required: true,
    },
    {
      name: 'message',
      type: 'textarea',
      access: { read: adManagerFieldRead },
      maxLength: 2_000,
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      options: ['new', 'reviewed', 'closed'],
      defaultValue: 'new',
      required: true,
    },
  ],
}

export const CustomerSecurityEvents: CollectionConfig = {
  slug: 'customerSecurityEvents',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { hidden: systemAdminHidden },
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    { name: 'event', type: 'text', required: true },
    { name: 'occurredAt', type: 'date', required: true },
    { name: 'safeMetadata', type: 'json' },
  ],
}
