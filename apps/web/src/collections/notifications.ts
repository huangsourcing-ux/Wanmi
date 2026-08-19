import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionConfig,
} from 'payload'

import { deny, fundsOperationsAdminHidden, fundsOperators, ownOrSystem } from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { MARKETING_NOTIFICATION_TYPES, TRANSACTIONAL_NOTIFICATION_TYPES } from '@/lib/domain'
import { AppError } from '@/lib/errors'

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

export const NotificationOutboxEvents: CollectionConfig = {
  slug: 'notificationOutboxEvents',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: {
    defaultColumns: ['notificationType', 'category', 'customer', 'templateVersion', 'createdAt'],
    group: ADMIN_GROUPS.operations,
    hidden: fundsOperationsAdminHidden,
    useAsTitle: 'eventKey',
  },
  defaultSort: '-createdAt',
  hooks: appendOnly('NOTIFICATION_OUTBOX_APPEND_ONLY', '通知正文快照只允许追加'),
  indexes: [
    { fields: ['customer', 'notificationType', 'createdAt'] },
    { fields: ['category', 'notificationType', 'createdAt'] },
  ],
  fields: [
    { name: 'eventKey', type: 'text', index: true, required: true, unique: true },
    { name: 'domainEventType', type: 'text', index: true, required: true },
    {
      name: 'category',
      type: 'select',
      options: ['transactional', 'marketing'],
      required: true,
    },
    {
      name: 'notificationType',
      type: 'select',
      options: [...TRANSACTIONAL_NOTIFICATION_TYPES, ...MARKETING_NOTIFICATION_TYPES],
      required: true,
    },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    { name: 'templateKey', type: 'text', required: true },
    { name: 'templateVersion', type: 'number', min: 1, required: true },
    { name: 'subjectSnapshot', type: 'text', required: true },
    { name: 'bodySnapshot', type: 'textarea', required: true },
    { name: 'messageHash', type: 'text', index: true, required: true },
    { name: 'traceId', type: 'text', index: true, required: true },
  ],
}

export const NotificationDeliveries: CollectionConfig = {
  slug: 'notificationDeliveries',
  access: { create: deny, delete: deny, read: deny, update: deny },
  admin: { group: ADMIN_GROUPS.operations, hidden: true },
  indexes: [{ fields: ['status', 'nextAttemptAt'] }, { fields: ['outboxEvent', 'channel'] }],
  fields: [
    { name: 'deliveryKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'outboxEvent',
      type: 'relationship',
      relationTo: 'notificationOutboxEvents',
      index: true,
      required: true,
    },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    { name: 'channel', type: 'select', options: ['sms', 'wechat', 'in_app'], required: true },
    { name: 'recipientEncrypted', type: 'text' },
    { name: 'recipientMasked', type: 'text', required: true },
    { name: 'recipientIdentityHash', type: 'text', index: true, required: true },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'pending',
      options: ['pending', 'sending', 'sent', 'delivered', 'retry_pending', 'dead_letter'],
      required: true,
    },
    { name: 'attemptCount', type: 'number', defaultValue: 0, min: 0, required: true },
    { name: 'maxAttempts', type: 'number', min: 1, required: true },
    { name: 'nextAttemptAt', type: 'date', index: true, required: true },
    { name: 'claimedAt', type: 'date', index: true },
    { name: 'providerRequestId', type: 'text' },
    { name: 'providerMessageId', type: 'text' },
    { name: 'providerCode', type: 'text' },
    { name: 'deliveredAt', type: 'date', index: true },
    { name: 'deadLetteredAt', type: 'date', index: true },
  ],
}

export const NotificationProviderReceipts: CollectionConfig = {
  slug: 'notificationProviderReceipts',
  access: { create: deny, delete: deny, read: fundsOperators, update: deny },
  admin: {
    defaultColumns: ['channel', 'outcome', 'providerCode', 'observedAt'],
    group: ADMIN_GROUPS.operations,
    hidden: fundsOperationsAdminHidden,
    useAsTitle: 'receiptKey',
  },
  hooks: appendOnly('NOTIFICATION_RECEIPT_APPEND_ONLY', '通知 provider 回执只允许追加'),
  fields: [
    { name: 'receiptKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'delivery',
      type: 'relationship',
      relationTo: 'notificationDeliveries',
      index: true,
      required: true,
    },
    { name: 'channel', type: 'select', options: ['sms', 'wechat', 'in_app'], required: true },
    { name: 'attemptNumber', type: 'number', min: 1, required: true },
    {
      name: 'outcome',
      type: 'select',
      options: ['accepted', 'delivered', 'failed', 'unknown'],
      required: true,
    },
    { name: 'providerRequestId', type: 'text' },
    { name: 'providerMessageId', type: 'text' },
    { name: 'providerCode', type: 'text' },
    { name: 'observedAt', type: 'date', index: true, required: true },
  ],
}

export const NotificationReadStates: CollectionConfig = {
  slug: 'notificationReadStates',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.operations, hidden: true },
  hooks: appendOnly('NOTIFICATION_READ_STATE_APPEND_ONLY', '通知已读状态只允许追加'),
  indexes: [{ fields: ['customer', 'readAt'] }],
  fields: [
    { name: 'readKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'outboxEvent',
      type: 'relationship',
      relationTo: 'notificationOutboxEvents',
      index: true,
      required: true,
    },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    { name: 'readAt', type: 'date', index: true, required: true },
  ],
}

export const NotificationMarketingPreferences: CollectionConfig = {
  slug: 'notificationMarketingPreferences',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.operations, hidden: true },
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
      unique: true,
    },
    {
      name: 'enabledMarketingTypes',
      type: 'select',
      hasMany: true,
      options: [...MARKETING_NOTIFICATION_TYPES],
      required: true,
    },
  ],
}
