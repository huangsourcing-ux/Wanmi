import type { CollectionConfig, Field } from 'payload'

import {
  deny,
  ownOrSystem,
  sensitiveFieldRead,
  systemAdminHidden,
  systemAdminOnly,
} from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { AppError } from '@/lib/errors'

const nonnegativeSafeInteger = (name: string, defaultValue?: number): Field => ({
  name,
  type: 'number',
  ...(defaultValue === undefined ? {} : { defaultValue }),
  min: 0,
  required: true,
  validate: (value: null | number | undefined) =>
    value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
      ? true
      : '字段必须是非负安全整数',
})

const appendOnly = (code: string, message: string) => ({
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
})

export const ProviderOperations: CollectionConfig = {
  slug: 'providerOperations',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { group: ADMIN_GROUPS.fulfillment, hidden: systemAdminHidden },
  fields: [
    { name: 'operationKey', type: 'text', index: true, required: true, unique: true },
    { name: 'order', type: 'relationship', relationTo: 'orders', index: true },
    {
      name: 'realnameTemplate',
      type: 'relationship',
      relationTo: 'realnameTemplates',
      index: true,
    },
    {
      name: 'targetType',
      type: 'select',
      options: ['order', 'realname_template', 'domain'],
      required: true,
    },
    { name: 'targetId', type: 'text', index: true, required: true },
    { name: 'provider', type: 'select', options: ['westdigital', 'wechatpay'], required: true },
    {
      name: 'operation',
      type: 'select',
      options: [
        'realname',
        'register',
        'renew',
        'refund',
        'nameserver',
        'query',
        'dns_record_add',
        'dns_record_modify',
        'dns_record_delete',
        'dns_record_batch_delete',
        'dns_record_pause',
        'domain_lock',
        'domain_management_password',
        'domain_contact_update',
        'domain_template_transfer',
      ],
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      options: ['prepared', 'submitted', 'succeeded', 'failed', 'unknown'],
      required: true,
    },
    { name: 'providerRequestId', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'attemptCount', type: 'number', defaultValue: 0, min: 0, required: true },
    { name: 'maxAttempts', type: 'number', defaultValue: 3, min: 1, max: 3, required: true },
    { name: 'lastErrorCode', type: 'text', index: true },
    { name: 'submittedAt', type: 'date' },
    { name: 'lastCheckedAt', type: 'date' },
    { name: 'safeResult', type: 'json' },
  ],
}

export const ProviderWriteBudgets: CollectionConfig = {
  slug: 'providerWriteBudgets',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { group: ADMIN_GROUPS.fulfillment, hidden: systemAdminHidden },
  lockDocuments: false,
  fields: [
    { name: 'scopeKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'provider',
      type: 'select',
      options: ['westdigital', 'wechatpay'],
      required: true,
    },
    {
      name: 'capability',
      type: 'select',
      options: ['register_renew', 'payment', 'refund'],
      required: true,
    },
    nonnegativeSafeInteger('usedOperations', 0),
    nonnegativeSafeInteger('usedAmountFen', 0),
    nonnegativeSafeInteger('configuredOperationLimit', 0),
    nonnegativeSafeInteger('configuredAmountLimitFen', 0),
  ],
}

export const ProviderWriteBudgetDebits: CollectionConfig = {
  slug: 'providerWriteBudgetDebits',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { group: ADMIN_GROUPS.fulfillment, hidden: systemAdminHidden },
  lockDocuments: false,
  fields: [
    { name: 'debitKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'budget',
      type: 'relationship',
      relationTo: 'providerWriteBudgets',
      index: true,
      required: true,
    },
    nonnegativeSafeInteger('operationDelta'),
    nonnegativeSafeInteger('amountFen'),
  ],
}

export const DomainAssets: CollectionConfig = {
  slug: 'domainAssets',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: {
    group: ADMIN_GROUPS.fulfillment,
    hidden: systemAdminHidden,
    useAsTitle: 'domainAscii',
  },
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
    { name: 'tags', type: 'text', hasMany: true, defaultValue: [] },
    {
      name: 'expiryReminderChannels',
      type: 'select',
      defaultValue: ['in_app', 'sms'],
      hasMany: true,
      options: ['in_app', 'sms'],
    },
    {
      name: 'expiryReminderDays',
      type: 'number',
      defaultValue: [30, 7, 1],
      hasMany: true,
      max: 365,
      min: 0,
    },
    {
      name: 'domainLockStatus',
      type: 'select',
      defaultValue: 'unknown',
      index: true,
      options: ['locked', 'unlocked', 'unknown'],
    },
    { name: 'domainLockUpdatedAt', type: 'date', index: true },
    { name: 'lastSyncedAt', type: 'date', required: true },
    {
      name: 'upstreamOwnershipStatus',
      type: 'select',
      defaultValue: 'unknown',
      options: ['confirmed', 'not_owned', 'unknown'],
      required: true,
    },
    {
      name: 'syncReviewStatus',
      type: 'select',
      defaultValue: 'none',
      options: ['none', 'matched', 'pending'],
      required: true,
    },
    {
      name: 'syncVersion',
      type: 'number',
      access: { read: sensitiveFieldRead },
      defaultValue: 0,
      min: 0,
      required: true,
    },
    { name: 'lastOwnershipCheckedAt', type: 'date', index: true },
    { name: 'operationBlockedAt', type: 'date', index: true },
    { name: 'operationBlockReason', type: 'text', access: { read: sensitiveFieldRead } },
    {
      name: 'domainManagementLeaseKey',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
    },
    {
      name: 'domainManagementLeaseExpiresAt',
      type: 'date',
      access: { read: sensitiveFieldRead },
    },
    {
      name: 'dnsMutationLeaseKey',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
    },
    { name: 'dnsMutationLeaseExpiresAt', type: 'date', access: { read: sensitiveFieldRead } },
    { name: 'dnsChangeWindowStartedAt', type: 'date', access: { read: sensitiveFieldRead } },
    {
      name: 'dnsChangeCount',
      type: 'number',
      access: { read: sensitiveFieldRead },
      defaultValue: 0,
      min: 0,
    },
  ],
}

export const DomainExpiryReminders: CollectionConfig = {
  slug: 'domainExpiryReminders',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.fulfillment, hidden: systemAdminHidden },
  defaultSort: '-createdAt',
  indexes: [
    { fields: ['asset', 'expiresAtSnapshot'] },
    {
      fields: ['asset', 'noticeType', 'expiresAtSnapshot'],
    },
  ],
  fields: [
    {
      name: 'reminderKey',
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
    { name: 'channel', type: 'select', options: ['in_app', 'sms'], required: true },
    {
      name: 'noticeType',
      type: 'select',
      defaultValue: 'expiry',
      options: [
        'expiry',
        'automatic_renewal_enabled',
        'automatic_renewal_due',
        'automatic_renewal_balance_insufficient',
        'automatic_renewal_price_changed',
        'automatic_renewal_blocked',
      ],
      required: true,
    },
    { name: 'thresholdDays', type: 'number', min: 0, max: 3_650, required: true },
    { name: 'expiresAtSnapshot', type: 'date', index: true, required: true },
    {
      name: 'mandate',
      type: 'relationship',
      relationTo: 'renewalMandates',
      access: { read: sensitiveFieldRead },
      index: true,
    },
    { name: 'amountFen', type: 'number', min: 1, access: { read: sensitiveFieldRead } },
    { name: 'authorizedMaxAmountFen', type: 'number', min: 1 },
    {
      name: 'status',
      type: 'select',
      index: true,
      options: ['pending', 'sending', 'delivered', 'failed', 'unknown'],
      required: true,
    },
    { name: 'attemptedAt', type: 'date', index: true },
    { name: 'deliveredAt', type: 'date', index: true },
    {
      name: 'failureCategory',
      type: 'select',
      options: [
        'balance_insufficient',
        'template_unapproved',
        'invalid_number',
        'rate_limited',
        'unknown',
      ],
    },
    { name: 'providerCode', type: 'text', access: { read: sensitiveFieldRead } },
    { name: 'providerMessageId', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'providerRequestId', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    {
      name: 'createdTraceId',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
      required: true,
    },
  ],
}

export const RenewalMandates: CollectionConfig = {
  slug: 'renewalMandates',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.fulfillment, hidden: systemAdminHidden },
  defaultSort: '-revision',
  hooks: appendOnly('RENEWAL_MANDATE_APPEND_ONLY', '自动续费授权记录只允许追加'),
  indexes: [
    {
      fields: ['asset', 'revision'],
      unique: true,
    },
    {
      fields: ['customer', 'authorizedAt'],
    },
  ],
  lockDocuments: false,
  fields: [
    { name: 'mandateKey', type: 'text', index: true, required: true },
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
    { name: 'domainAsciiSnapshot', type: 'text', index: true, required: true },
    { name: 'scope', type: 'select', options: ['renew_one_year'], required: true },
    { name: 'maxDebitFen', type: 'number', min: 1, required: true },
    { name: 'currency', type: 'select', options: ['CNY'], required: true },
    { name: 'authorizedAt', type: 'date', index: true, required: true },
    { name: 'validUntil', type: 'date', index: true, required: true },
    { name: 'rulesVersion', type: 'text', required: true },
    { name: 'revision', type: 'number', min: 1, required: true },
    { name: 'eventType', type: 'select', options: ['authorized', 'revoked'], required: true },
    { name: 'revokedAt', type: 'date', index: true },
    { name: 'previousMandate', type: 'relationship', relationTo: 'renewalMandates' },
    { name: 'stepUpGrantId', type: 'text', access: { read: sensitiveFieldRead }, required: true },
    { name: 'previewDigest', type: 'text', access: { read: sensitiveFieldRead }, required: true },
    { name: 'createdTraceId', type: 'text', access: { read: sensitiveFieldRead }, required: true },
  ],
}

export const AutomaticRenewalEvents: CollectionConfig = {
  slug: 'automaticRenewalEvents',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.fulfillment, hidden: systemAdminHidden },
  defaultSort: '-occurredAt',
  hooks: appendOnly('AUTOMATIC_RENEWAL_EVENT_APPEND_ONLY', '自动续费执行记录只允许追加'),
  indexes: [
    {
      fields: ['asset', 'expiresAtSnapshot'],
    },
    {
      fields: ['customer', 'occurredAt'],
    },
  ],
  lockDocuments: false,
  fields: [
    { name: 'eventKey', type: 'text', index: true, required: true, unique: true },
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
      name: 'mandate',
      type: 'relationship',
      relationTo: 'renewalMandates',
      index: true,
      required: true,
    },
    { name: 'attemptKey', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'attemptSlotDays', type: 'number', min: 0, max: 365 },
    { name: 'expiresAtSnapshot', type: 'date', index: true, required: true },
    {
      name: 'eventType',
      type: 'select',
      options: [
        'attempt_claimed',
        'balance_insufficient',
        'price_changed',
        'order_queued',
        'skipped_invalid_mandate',
        'skipped_account_restricted',
        'skipped_identity_cooldown',
        'skipped_not_owned',
        'skipped_domain_status',
        'skipped_job_revalidation',
      ],
      required: true,
    },
    { name: 'amountFen', type: 'number', min: 1, access: { read: sensitiveFieldRead } },
    { name: 'authorizedMaxAmountFen', type: 'number', min: 1 },
    { name: 'availableBalanceFen', type: 'number', min: 0 },
    { name: 'order', type: 'relationship', relationTo: 'orders', index: true },
    { name: 'reasonCode', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'occurredAt', type: 'date', index: true, required: true },
    { name: 'traceId', type: 'text', access: { read: sensitiveFieldRead }, index: true },
  ],
}

export const Renewals: CollectionConfig = {
  slug: 'renewals',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.fulfillment, hidden: systemAdminHidden },
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
    {
      name: 'order',
      type: 'relationship',
      relationTo: 'orders',
      index: true,
      required: true,
      unique: true,
    },
    { name: 'years', type: 'number', min: 1, max: 10, required: true },
    { name: 'previousExpiresAt', type: 'date', required: true },
    { name: 'confirmedExpiresAt', type: 'date' },
    { name: 'providerOperationKey', type: 'text', index: true },
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
  admin: { group: ADMIN_GROUPS.fulfillment, hidden: systemAdminHidden },
  fields: [
    {
      name: 'changeKey',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
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
    { name: 'previousNameservers', type: 'text', hasMany: true },
    { name: 'requestedNameservers', type: 'text', hasMany: true, required: true },
    { name: 'confirmedNameservers', type: 'text', hasMany: true },
    { name: 'requestedByType', type: 'select', options: ['customer'] },
    { name: 'requestedById', type: 'text', access: { read: sensitiveFieldRead } },
    { name: 'requestedAt', type: 'date', index: true },
    { name: 'jobQueuedAt', type: 'date', access: { read: sensitiveFieldRead }, index: true },
    { name: 'reviewJobQueuedAt', type: 'date', access: { read: sensitiveFieldRead }, index: true },
    { name: 'lastCheckedAt', type: 'date', index: true },
    { name: 'completedAt', type: 'date', index: true },
    {
      name: 'providerOperation',
      type: 'relationship',
      relationTo: 'providerOperations',
      access: { read: sensitiveFieldRead },
      index: true,
    },
    { name: 'failureCode', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    { name: 'createdTraceId', type: 'text', access: { read: sensitiveFieldRead }, index: true },
    {
      name: 'status',
      type: 'select',
      options: ['pending', 'succeeded', 'failed', 'manual_review'],
      required: true,
    },
  ],
}
