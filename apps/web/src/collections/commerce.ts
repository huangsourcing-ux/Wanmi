import type { CollectionConfig, Field } from 'payload'

import { deny, ownOrSystem, sensitiveFieldRead, systemAdminOnly } from '@/access/roles'
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
    create: systemAdminOnly,
    delete: systemAdminOnly,
    read: systemAdminOnly,
    update: systemAdminOnly,
  },
  admin: { useAsTitle: 'tld' },
  fields: [
    { name: 'tld', type: 'text', index: true, required: true, unique: true },
    { name: 'mode', type: 'select', options: ['fixed', 'percentage'], required: true },
    { ...integerMoney, name: 'fixedAmountMinor' },
    { name: 'percentageBasisPoints', type: 'number', min: 0 },
    { name: 'enabled', type: 'checkbox', defaultValue: false, required: true },
  ],
}

export const Quotes: CollectionConfig = {
  slug: 'quotes',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
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
    { ...integerMoney, name: 'upstreamCostMinor' },
    { ...integerMoney, name: 'userPriceMinor' },
    { name: 'currency', type: 'select', defaultValue: 'CNY', options: ['CNY'], required: true },
    { name: 'ruleSnapshot', type: 'json', required: true },
    { name: 'expiresAt', type: 'date', index: true, required: true },
  ],
}

export const Orders: CollectionConfig = {
  slug: 'orders',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { useAsTitle: 'orderNumber' },
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
    { name: 'quoteSnapshot', type: 'json', required: true },
    { name: 'paidAt', type: 'date' },
  ],
}

export const OrderEvents: CollectionConfig = {
  slug: 'orderEvents',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
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
    { name: 'note', type: 'textarea' },
    { name: 'evidence', type: 'json' },
    {
      name: 'actorType',
      type: 'select',
      options: ['system', 'customer', 'admin', 'provider'],
      required: true,
    },
    { name: 'actorId', type: 'text' },
  ],
}

export const PaymentNotifications: CollectionConfig = {
  slug: 'paymentNotifications',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
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
  admin: { useAsTitle: 'refundNumber' },
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
