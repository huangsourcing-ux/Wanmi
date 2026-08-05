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
import { ADMIN_GROUPS } from '@/lib/admin-navigation'

export const ManualReviews: CollectionConfig = {
  slug: 'manualReviews',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { group: ADMIN_GROUPS.operations, hidden: systemAdminHidden },
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
  admin: { group: ADMIN_GROUPS.operations, hidden: operationsAdminHidden },
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
  admin: {
    defaultColumns: ['action', 'actorType', 'targetType', 'targetId', 'traceId', 'createdAt'],
    group: ADMIN_GROUPS.operations,
    hidden: auditAdminHidden,
    listSearchableFields: ['action', 'actorId', 'targetType', 'targetId', 'traceId'],
    useAsTitle: 'action',
  },
  defaultSort: '-createdAt',
  indexes: [{ fields: ['actorType', 'actorId', 'createdAt'] }],
  labels: { plural: '审计日志', singular: '审计事件' },
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

export const FirstPartyEvents: CollectionConfig = {
  slug: 'firstPartyEvents',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: {
    defaultColumns: ['event', 'pageType', 'tool', 'tld', 'succeeded', 'createdAt'],
    group: ADMIN_GROUPS.operations,
    hidden: systemAdminHidden,
    useAsTitle: 'event',
  },
  defaultSort: '-createdAt',
  indexes: [{ fields: ['event', 'createdAt'] }, { fields: ['tool', 'createdAt'] }],
  labels: { plural: '第一方事件', singular: '第一方事件' },
  fields: [
    { name: 'schemaVersion', type: 'number', defaultValue: 1, max: 1, min: 1, required: true },
    {
      name: 'event',
      type: 'select',
      options: ['page_viewed', 'tool_submitted', 'tool_completed', 'tool_failed'],
      required: true,
    },
    {
      name: 'pageType',
      type: 'select',
      options: ['home', 'tool_index', 'tool', 'pricing', 'content_index', 'help', 'legal', 'other'],
    },
    {
      name: 'source',
      type: 'select',
      options: ['direct', 'internal', 'search', 'social', 'referral'],
    },
    {
      name: 'deviceCategory',
      type: 'select',
      options: ['mobile', 'tablet', 'desktop'],
    },
    {
      name: 'tool',
      type: 'select',
      options: ['domain-search', 'whois', 'dns', 'ssl-check', 'idn', 'pricing'],
    },
    {
      name: 'inputType',
      type: 'select',
      options: ['full_domain', 'keyword', 'unknown'],
    },
    { name: 'fromLocalHistory', type: 'checkbox' },
    { name: 'tld', type: 'text' },
    {
      name: 'resultCategory',
      type: 'select',
      options: ['ready', 'empty', 'partial', 'degraded'],
    },
    { name: 'succeeded', type: 'checkbox' },
    {
      name: 'durationBucket',
      type: 'select',
      options: ['lt_100ms', '100_299ms', '300_999ms', '1000_2999ms', '3000_9999ms', 'gte_10000ms'],
    },
    {
      name: 'dataSource',
      type: 'select',
      options: ['local', 'cache', 'westdigital', 'whodat', 'dns', 'tls', 'unknown'],
    },
    { name: 'errorCode', type: 'text' },
    { name: 'traceId', type: 'text', index: true, required: true, unique: true },
  ],
}

export const UserFeedback: CollectionConfig = {
  slug: 'userFeedback',
  access: { create: deny, delete: deny, read: operationalReaders, update: systemAdminOnly },
  admin: { group: ADMIN_GROUPS.operations, hidden: operationsAdminHidden },
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
  admin: { group: ADMIN_GROUPS.operations, hidden: systemAdminHidden },
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
