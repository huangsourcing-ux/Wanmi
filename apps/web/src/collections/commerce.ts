import type { CollectionConfig, Field } from 'payload'

import {
  deny,
  ownOrSystem,
  sensitiveFieldRead,
  systemAdminHidden,
  systemAdminOnly,
} from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { ORDER_STATUSES } from '@/lib/domain'

const integerMoney: Field = {
  name: 'amountMinor',
  type: 'number',
  min: 0,
  required: true,
  validate: (value: null | number | undefined) =>
    Number.isSafeInteger(value) ? true : '金额必须是安全整数最小货币单位',
}

export const PriceRules: CollectionConfig = {
  slug: 'priceRules',
  access: {
    create: deny,
    delete: deny,
    read: systemAdminOnly,
    update: deny,
  },
  admin: { group: ADMIN_GROUPS.commerce, hidden: systemAdminHidden, useAsTitle: 'tld' },
  fields: [
    { name: 'tld', type: 'text', index: true, required: true, unique: true },
    { name: 'mode', type: 'select', options: ['fixed', 'percentage'], required: true },
    { ...integerMoney, name: 'fixedAmountMinor' },
    { name: 'percentageBasisPoints', type: 'number', min: 0 },
    { name: 'enabled', type: 'checkbox', defaultValue: false, required: true },
  ],
}

const safeInteger = (name: string, required = true): Extract<Field, { type: 'number' }> => ({
  name,
  type: 'number',
  min: 0,
  required,
  validate: (value: null | number | undefined) =>
    value === null || value === undefined
      ? required
        ? '字段必须是非负安全整数'
        : true
      : Number.isSafeInteger(value) && value >= 0
        ? true
        : '字段必须是非负安全整数',
})

export const PriceSnapshots: CollectionConfig = {
  slug: 'priceSnapshots',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: {
    defaultColumns: ['snapshotRef', 'tld', 'providerObservedAt', 'createdAt'],
    group: ADMIN_GROUPS.commerce,
    hidden: systemAdminHidden,
    listSearchableFields: ['snapshotRef', 'tld', 'calculationHash'],
    useAsTitle: 'snapshotRef',
  },
  defaultSort: '-providerObservedAt',
  indexes: [{ fields: ['tld', 'ruleKey', 'providerObservedAt'] }],
  labels: { plural: '价格计算快照', singular: '价格计算快照' },
  lockDocuments: false,
  fields: [
    { ...safeInteger('schemaVersion'), defaultValue: 1, max: 1, min: 1 },
    { ...safeInteger('calculationVersion'), defaultValue: 1, max: 1, min: 1 },
    {
      name: 'snapshotRef',
      type: 'text',
      index: true,
      required: true,
      unique: true,
      validate: (value: null | string | undefined) =>
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
          ? true
          : '快照引用必须是随机 UUID',
    },
    {
      name: 'calculationHash',
      type: 'text',
      index: true,
      required: true,
      unique: true,
      validate: (value: null | string | undefined) =>
        typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
          ? true
          : '计算哈希必须是 SHA-256 十六进制值',
    },
    { name: 'tld', type: 'text', index: true, required: true },
    { name: 'representativeDomainAscii', type: 'text', required: true },
    { name: 'priceClass', type: 'select', options: ['standard'], required: true },
    { name: 'currency', type: 'select', options: ['CNY'], required: true },
    { name: 'provider', type: 'select', options: ['westdigital_fixture'], required: true },
    { name: 'providerProductId', type: 'text', required: true },
    { name: 'providerRequestId', type: 'text', required: true },
    { name: 'providerObservedAt', type: 'date', index: true, required: true },
    { name: 'providerCacheStatus', type: 'select', options: ['hit', 'miss'], required: true },
    { name: 'providerCacheExpiresAt', type: 'date' },
    { name: 'ruleSource', type: 'select', options: ['wanmi_fixture'], required: true },
    { name: 'ruleKey', type: 'text', index: true, required: true },
    { ...safeInteger('ruleVersion'), defaultValue: 1, max: 1, min: 1 },
    { name: 'ruleMode', type: 'select', options: ['fixed', 'percentage'], required: true },
    safeInteger('ruleFixedAmountMinor', false),
    safeInteger('rulePercentageBasisPoints', false),
    { name: 'roundingMode', type: 'select', options: ['half_up_to_fen'], required: true },
    safeInteger('upstreamRegistrationPriceMinor'),
    safeInteger('upstreamRenewalPriceMinor'),
    safeInteger('registrationPriceMinor'),
    safeInteger('renewalPriceMinor'),
    safeInteger('oneYearTotalMinor'),
    safeInteger('threeYearTotalMinor'),
    {
      name: 'calculationFormula',
      type: 'select',
      options: ['registration_price_plus_annual_renewal_price'],
      required: true,
    },
    { name: 'createdTraceId', type: 'text', index: true, required: true },
  ],
}

export const Quotes: CollectionConfig = {
  slug: 'quotes',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.commerce, hidden: systemAdminHidden },
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    { name: 'domainAscii', type: 'text', index: true, required: true },
    { name: 'years', type: 'number', min: 1, max: 10, required: true },
    { ...integerMoney, name: 'upstreamCostMinor', access: { read: sensitiveFieldRead } },
    { ...integerMoney, name: 'userPriceMinor' },
    { name: 'currency', type: 'select', defaultValue: 'CNY', options: ['CNY'], required: true },
    {
      name: 'ruleSnapshot',
      type: 'json',
      access: { read: sensitiveFieldRead },
      required: true,
    },
    { name: 'expiresAt', type: 'date', index: true, required: true },
  ],
}

export const Orders: CollectionConfig = {
  slug: 'orders',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: {
    group: ADMIN_GROUPS.commerce,
    hidden: systemAdminHidden,
    useAsTitle: 'orderNumber',
  },
  fields: [
    { name: 'orderNumber', type: 'text', index: true, required: true, unique: true },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    { name: 'quote', type: 'relationship', relationTo: 'quotes', required: true },
    {
      name: 'realnameTemplate',
      type: 'relationship',
      relationTo: 'realnameTemplates',
      required: true,
    },
    { name: 'domainAscii', type: 'text', index: true, required: true },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'pending_payment',
      index: true,
      options: [...ORDER_STATUSES],
      required: true,
    },
    { ...integerMoney },
    { name: 'currency', type: 'select', defaultValue: 'CNY', options: ['CNY'], required: true },
    {
      name: 'quoteSnapshot',
      type: 'json',
      access: { read: sensitiveFieldRead },
      required: true,
    },
    { name: 'paidAt', type: 'date' },
  ],
}

export const OrderEvents: CollectionConfig = {
  slug: 'orderEvents',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.commerce, hidden: systemAdminHidden },
  fields: [
    { name: 'order', type: 'relationship', relationTo: 'orders', index: true, required: true },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    { name: 'fromStatus', type: 'select', options: [...ORDER_STATUSES] },
    { name: 'toStatus', type: 'select', options: [...ORDER_STATUSES], required: true },
    { name: 'reasonCode', type: 'text', required: true },
    { name: 'note', type: 'textarea', access: { read: sensitiveFieldRead } },
    { name: 'evidence', type: 'json', access: { read: sensitiveFieldRead } },
    {
      name: 'actorType',
      type: 'select',
      options: ['system', 'customer', 'admin', 'provider'],
      required: true,
    },
    { name: 'actorId', type: 'text', access: { read: sensitiveFieldRead } },
  ],
}

export const PaymentNotifications: CollectionConfig = {
  slug: 'paymentNotifications',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: { group: ADMIN_GROUPS.commerce, hidden: systemAdminHidden },
  fields: [
    {
      name: 'wechatTransactionId',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
      required: true,
      unique: true,
    },
    { name: 'merchantOrderNumber', type: 'text', index: true, required: true, unique: true },
    { name: 'signatureVerified', type: 'checkbox', required: true },
    { ...integerMoney },
    { name: 'receivedAt', type: 'date', required: true },
    { name: 'payloadDigest', type: 'text', access: { read: sensitiveFieldRead }, required: true },
  ],
}

export const Refunds: CollectionConfig = {
  slug: 'refunds',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: {
    group: ADMIN_GROUPS.commerce,
    hidden: systemAdminHidden,
    useAsTitle: 'refundNumber',
  },
  fields: [
    { name: 'refundNumber', type: 'text', index: true, required: true, unique: true },
    { name: 'order', type: 'relationship', relationTo: 'orders', index: true, required: true },
    { ...integerMoney },
    {
      name: 'status',
      type: 'select',
      options: ['pending', 'submitted', 'succeeded', 'failed', 'unknown'],
      required: true,
    },
    { name: 'providerRefundId', type: 'text', access: { read: sensitiveFieldRead }, unique: true },
  ],
}
