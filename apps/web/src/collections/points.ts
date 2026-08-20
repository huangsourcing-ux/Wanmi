import type { CollectionConfig, Field } from 'payload'

import { deny, ownOrSystem, systemAdminHidden } from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { AppError } from '@/lib/errors'

export const TOOL_QUOTA_TARGETS = ['advanced_whois', 'bulk_query', 'ai_domain_analysis'] as const

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

const nonnegativeSafeInteger = (name: string): Field => ({
  name,
  type: 'number',
  defaultValue: 0,
  max: Number.MAX_SAFE_INTEGER,
  min: 0,
  required: true,
  validate: (value: null | number | undefined) =>
    value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
      ? true
      : '字段必须是非负安全整数',
})

function appendOnlyHooks(code: string, message: string): NonNullable<CollectionConfig['hooks']> {
  return {
    beforeChange: [
      ({ operation }) => {
        if (operation === 'update') throw new AppError(code, message, 409)
      },
    ],
    beforeDelete: [
      () => {
        throw new AppError(code, message, 409)
      },
    ],
  }
}

const protectedAccess: CollectionConfig['access'] = {
  create: deny,
  delete: deny,
  read: ownOrSystem('customer'),
  update: deny,
}

const hiddenCommerce = { group: ADMIN_GROUPS.commerce, hidden: systemAdminHidden }

export const PointsAccounts: CollectionConfig = {
  slug: 'pointsAccounts',
  access: protectedAccess,
  admin: hiddenCommerce,
  indexes: [{ fields: ['customer'], unique: true }],
  lockDocuments: false,
  fields: [
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    nonnegativeSafeInteger('ledgerVersion'),
    nonnegativeSafeInteger('quotaLedgerVersion'),
  ],
}

export const PointsBatches: CollectionConfig = {
  slug: 'pointsBatches',
  access: protectedAccess,
  admin: hiddenCommerce,
  defaultSort: 'expiresAt',
  hooks: appendOnlyHooks('POINTS_BATCH_APPEND_ONLY', '米币批次只允许追加'),
  indexes: [{ fields: ['account', 'expiresAt'] }, { fields: ['customer', 'expiresAt'] }],
  lockDocuments: false,
  fields: [
    { name: 'earningKey', type: 'text', index: true, required: true, unique: true },
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
      relationTo: 'pointsAccounts',
      index: true,
      required: true,
    },
    {
      name: 'sourceType',
      type: 'select',
      options: ['order_reward', 'invitation_reward'],
      required: true,
    },
    {
      name: 'sourceCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
    },
    {
      name: 'sourceOrder',
      type: 'relationship',
      relationTo: 'orders',
      index: true,
      required: true,
    },
    positiveSafeInteger('points'),
    { name: 'expiresAt', type: 'date', index: true, required: true },
  ],
}

export const PointsRedemptions: CollectionConfig = {
  slug: 'pointsRedemptions',
  access: protectedAccess,
  admin: hiddenCommerce,
  hooks: appendOnlyHooks('POINTS_REDEMPTION_APPEND_ONLY', '米币兑换记录只允许追加'),
  indexes: [{ fields: ['account', 'createdAt'] }],
  lockDocuments: false,
  fields: [
    { name: 'redemptionKey', type: 'text', index: true, required: true, unique: true },
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
      relationTo: 'pointsAccounts',
      index: true,
      required: true,
    },
    {
      name: 'target',
      type: 'select',
      options: [...TOOL_QUOTA_TARGETS],
      required: true,
    },
    positiveSafeInteger('pointsCost'),
    positiveSafeInteger('quotaUnits'),
  ],
}

export const PointsLedger: CollectionConfig = {
  slug: 'pointsLedger',
  access: protectedAccess,
  admin: hiddenCommerce,
  defaultSort: '-ledgerSequence',
  hooks: appendOnlyHooks('POINTS_LEDGER_APPEND_ONLY', '米币账本只允许追加'),
  indexes: [
    { fields: ['account', 'ledgerSequence'], unique: true },
    { fields: ['batch', 'entryType'] },
    { fields: ['redemption', 'entryType'] },
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
      relationTo: 'pointsAccounts',
      index: true,
      required: true,
    },
    {
      name: 'batch',
      type: 'relationship',
      relationTo: 'pointsBatches',
      index: true,
      required: true,
    },
    {
      name: 'redemption',
      type: 'relationship',
      relationTo: 'pointsRedemptions',
      index: true,
    },
    {
      name: 'entryType',
      type: 'select',
      options: ['pending', 'available', 'held', 'consumed', 'expired', 'reversed'],
      required: true,
    },
    positiveSafeInteger('points'),
    positiveSafeInteger('ledgerSequence'),
  ],
}

export const PointsConsumptionAllocations: CollectionConfig = {
  slug: 'pointsConsumptionAllocations',
  access: protectedAccess,
  admin: hiddenCommerce,
  defaultSort: 'id',
  hooks: appendOnlyHooks('POINTS_ALLOCATION_APPEND_ONLY', '米币消费分配只允许追加'),
  indexes: [{ fields: ['redemption', 'batch'], unique: true }],
  lockDocuments: false,
  fields: [
    { name: 'allocationKey', type: 'text', index: true, required: true, unique: true },
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
      relationTo: 'pointsAccounts',
      index: true,
      required: true,
    },
    {
      name: 'redemption',
      type: 'relationship',
      relationTo: 'pointsRedemptions',
      index: true,
      required: true,
    },
    {
      name: 'batch',
      type: 'relationship',
      relationTo: 'pointsBatches',
      index: true,
      required: true,
    },
    positiveSafeInteger('points'),
  ],
}

export const ToolQuotaLedger: CollectionConfig = {
  slug: 'toolQuotaLedger',
  access: protectedAccess,
  admin: hiddenCommerce,
  defaultSort: '-ledgerSequence',
  hooks: appendOnlyHooks('TOOL_QUOTA_LEDGER_APPEND_ONLY', '工具额度账本只允许追加'),
  indexes: [
    { fields: ['account', 'ledgerSequence'], unique: true },
    { fields: ['account', 'target', 'createdAt'] },
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
      relationTo: 'pointsAccounts',
      index: true,
      required: true,
    },
    {
      name: 'redemption',
      type: 'relationship',
      relationTo: 'pointsRedemptions',
      index: true,
    },
    {
      name: 'target',
      type: 'select',
      options: [...TOOL_QUOTA_TARGETS],
      required: true,
    },
    { name: 'entryType', type: 'select', options: ['grant', 'consume'], required: true },
    positiveSafeInteger('quotaUnits'),
    positiveSafeInteger('ledgerSequence'),
  ],
}
