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

export const WALLET_TOP_UP_STATUSES = [
  'created',
  'payment_pending',
  'provider_confirmed',
  'credited',
  'refund_pending',
  'refunded',
  'closed',
  'unknown',
] as const

const nonnegativeSafeInteger = (name: string, defaultValue?: number): Field => ({
  name,
  type: 'number',
  ...(defaultValue === undefined ? {} : { defaultValue }),
  max: Number.MAX_SAFE_INTEGER,
  min: 0,
  required: true,
  validate: (value: null | number | undefined) =>
    value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
      ? true
      : '字段必须是非负安全整数',
})

const positiveSafeInteger = (name: string): Field => ({
  name,
  type: 'number',
  max: Number.MAX_SAFE_INTEGER,
  min: 1,
  required: true,
  validate: (value: null | number | undefined) =>
    value !== null && value !== undefined && Number.isSafeInteger(value) && value > 0
      ? true
      : '字段必须是正安全整数',
})

const signedSafeInteger = (name: string, defaultValue?: number): Field => ({
  name,
  type: 'number',
  ...(defaultValue === undefined ? {} : { defaultValue }),
  max: Number.MAX_SAFE_INTEGER,
  min: Number.MIN_SAFE_INTEGER,
  required: true,
  validate: (value: null | number | undefined) =>
    value !== null && value !== undefined && Number.isSafeInteger(value)
      ? true
      : '字段必须是安全整数',
})

export const WalletAccounts: CollectionConfig = {
  slug: 'walletAccounts',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.commerce, hidden: systemAdminHidden },
  indexes: [{ fields: ['customer', 'currency'], unique: true }],
  lockDocuments: false,
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    { name: 'currency', type: 'select', options: ['CNY'], required: true },
    nonnegativeSafeInteger('ledgerVersion', 0),
    signedSafeInteger('postedBalanceCacheFen', 0),
    nonnegativeSafeInteger('heldBalanceCacheFen', 0),
  ],
}

export const WalletTransactions: CollectionConfig = {
  slug: 'walletTransactions',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.commerce, hidden: systemAdminHidden },
  indexes: [{ fields: ['account', 'status'] }],
  lockDocuments: false,
  fields: [
    { name: 'transactionKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'account',
      type: 'relationship',
      relationTo: 'walletAccounts',
      index: true,
      required: true,
    },
    { name: 'type', type: 'select', options: ['credit', 'hold', 'recovery'], required: true },
    {
      name: 'status',
      type: 'select',
      options: ['posted', 'held', 'captured', 'released'],
      index: true,
      required: true,
    },
    positiveSafeInteger('amountFen'),
    { name: 'resolvedAt', type: 'date', index: true },
  ],
}

export const WalletEntries: CollectionConfig = {
  slug: 'walletEntries',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: { group: ADMIN_GROUPS.commerce, hidden: systemAdminHidden },
  defaultSort: '-ledgerSequence',
  hooks: {
    beforeChange: [
      ({ operation }) => {
        if (operation === 'update') {
          throw new AppError('WALLET_ENTRY_APPEND_ONLY', '钱包账本只允许追加', 409)
        }
      },
    ],
    beforeDelete: [
      () => {
        throw new AppError('WALLET_ENTRY_APPEND_ONLY', '钱包账本只允许追加', 409)
      },
    ],
  },
  indexes: [
    { fields: ['account', 'ledgerSequence'], unique: true },
    { fields: ['account', 'createdAt'] },
  ],
  lockDocuments: false,
  fields: [
    { name: 'entryKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'account',
      type: 'relationship',
      relationTo: 'walletAccounts',
      index: true,
      required: true,
    },
    {
      name: 'transaction',
      type: 'relationship',
      relationTo: 'walletTransactions',
      index: true,
      required: true,
    },
    {
      name: 'entryType',
      type: 'select',
      options: ['credit', 'hold', 'capture', 'release', 'recovery'],
      required: true,
    },
    positiveSafeInteger('amountFen'),
    positiveSafeInteger('ledgerSequence'),
    signedSafeInteger('postedBalanceAfterFen'),
    nonnegativeSafeInteger('heldBalanceAfterFen'),
  ],
}

export const WalletTopUpOrders: CollectionConfig = {
  slug: 'walletTopUpOrders',
  access: { create: deny, delete: deny, read: ownOrSystem('customer'), update: deny },
  admin: {
    defaultColumns: ['topUpOrderNumber', 'customer', 'amountFen', 'status', 'createdAt'],
    group: ADMIN_GROUPS.commerce,
    hidden: systemAdminHidden,
    useAsTitle: 'topUpOrderNumber',
  },
  defaultSort: '-createdAt',
  hooks: {
    beforeChange: [
      ({ operation }) => {
        if (operation === 'update') {
          throw new AppError('WALLET_TOP_UP_SERVICE_REQUIRED', '充值单只能通过钱包服务迁移', 409)
        }
      },
    ],
    beforeDelete: [
      () => {
        throw new AppError('WALLET_TOP_UP_APPEND_ONLY', '充值单不得删除', 409)
      },
    ],
  },
  indexes: [{ fields: ['customer', 'createdAt'] }, { fields: ['account', 'status'] }],
  lockDocuments: false,
  fields: [
    { name: 'topUpOrderNumber', type: 'text', index: true, required: true, unique: true },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'account',
      type: 'relationship',
      relationTo: 'walletAccounts',
      index: true,
      required: true,
    },
    positiveSafeInteger('amountFen'),
    { name: 'currency', type: 'select', options: ['CNY'], required: true },
    { name: 'fundingSource', type: 'select', options: ['wechat'], required: true },
    { name: 'paymentChannel', type: 'select', options: ['native', 'h5'] },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'created',
      index: true,
      options: [...WALLET_TOP_UP_STATUSES],
      required: true,
    },
    {
      name: 'wechatTransactionId',
      type: 'text',
      index: true,
      unique: true,
    },
    {
      name: 'payerIdentifierHash',
      type: 'text',
      access: { read: sensitiveFieldRead },
      index: true,
    },
    { name: 'ledgerTransactionKey', type: 'text', index: true, required: true, unique: true },
    { name: 'originalRefundNumber', type: 'text', index: true, unique: true },
    { name: 'paymentExpiresAt', type: 'date' },
    { name: 'providerPaidAt', type: 'date' },
    { name: 'providerConfirmedAt', type: 'date' },
    { name: 'creditedAt', type: 'date' },
    { name: 'refundedAt', type: 'date' },
    { name: 'refundedAmountFen', type: 'number', min: 1, max: Number.MAX_SAFE_INTEGER },
    { name: 'paymentRecoveryKey', type: 'text', index: true, unique: true },
    { name: 'paymentRecoveryType', type: 'select', options: ['provider_refund', 'dispute'] },
    { name: 'paymentRecoveredAt', type: 'date' },
  ],
}

export const WalletPolicyVersions: CollectionConfig = {
  slug: 'walletPolicyVersions',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: {
    defaultColumns: ['version', 'currency', 'effectiveAt', 'changedBy'],
    group: ADMIN_GROUPS.commerce,
    hidden: systemAdminHidden,
    useAsTitle: 'version',
  },
  defaultSort: '-version',
  hooks: {
    beforeChange: [
      ({ operation }) => {
        if (operation === 'update') {
          throw new AppError('WALLET_POLICY_APPEND_ONLY', '钱包资金规则版本只允许追加', 409)
        }
      },
    ],
    beforeDelete: [
      () => {
        throw new AppError('WALLET_POLICY_APPEND_ONLY', '钱包资金规则版本不得删除', 409)
      },
    ],
  },
  lockDocuments: false,
  fields: [
    {
      name: 'version',
      type: 'number',
      index: true,
      max: Number.MAX_SAFE_INTEGER,
      min: 1,
      required: true,
      unique: true,
      validate: (value: null | number | undefined) =>
        value !== null && value !== undefined && Number.isSafeInteger(value) && value > 0
          ? true
          : '字段必须是正安全整数',
    },
    { name: 'schemaVersion', type: 'number', defaultValue: 1, max: 1, min: 1, required: true },
    { name: 'currency', type: 'select', options: ['CNY'], required: true },
    { name: 'balanceExpiration', type: 'select', options: ['never'], required: true },
    positiveSafeInteger('singleTopUpLimitFen'),
    positiveSafeInteger('accountBalanceLimitFen'),
    positiveSafeInteger('singleSpendLimitFen'),
    { name: 'allowNegativeBalanceRecovery', type: 'checkbox', required: true },
    { name: 'allowRestrictedAccountEmergencyRenewal', type: 'checkbox', required: true },
    {
      name: 'financialDayCutTimezone',
      type: 'select',
      options: ['Asia/Shanghai'],
      required: true,
    },
    {
      name: 'statementCalculation',
      type: 'select',
      options: ['ledger_entries_start_inclusive_end_exclusive'],
      required: true,
    },
    { name: 'changedBy', type: 'text', required: true },
    { name: 'changeNote', type: 'textarea', required: true },
    { name: 'effectiveAt', type: 'date', index: true, required: true },
  ],
}
