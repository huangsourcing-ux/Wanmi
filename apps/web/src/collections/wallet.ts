import type { CollectionConfig, Field } from 'payload'

import { deny, ownOrSystem, systemAdminHidden } from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { AppError } from '@/lib/errors'

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
    { name: 'type', type: 'select', options: ['credit', 'hold'], required: true },
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
      options: ['credit', 'hold', 'capture', 'release'],
      required: true,
    },
    positiveSafeInteger('amountFen'),
    positiveSafeInteger('ledgerSequence'),
    nonnegativeSafeInteger('postedBalanceAfterFen'),
    nonnegativeSafeInteger('heldBalanceAfterFen'),
  ],
}
