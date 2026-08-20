import type {
  Access,
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionConfig,
} from 'payload'

import { hasRole, isCustomerUser, systemAdminHidden, systemAdminOnly } from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { AppError } from '@/lib/errors'

export const VIP_TIER_EVENT_SOURCES = [
  'natural_achievement',
  'operational_promotion',
  'data_correction',
  'fraud_reversal',
] as const

const deny: Access = () => false

const ownVipRecordOrSystem: Access = ({ req }) => {
  if (hasRole(req.user, ['system_admin'])) return true
  if (!isCustomerUser(req.user)) return false
  return { customer: { equals: req.user.id } }
}

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

const positiveSafeInteger = (name: string) => ({
  name,
  type: 'number' as const,
  max: Number.MAX_SAFE_INTEGER,
  min: 1,
  required: true,
  validate: (value: null | number | undefined) =>
    value !== null && value !== undefined && Number.isSafeInteger(value) && value > 0
      ? true
      : '字段必须是正安全整数',
})

const nonNegativeSafeInteger = (name: string) => ({
  name,
  type: 'number' as const,
  max: Number.MAX_SAFE_INTEGER,
  min: 0,
  required: true,
  validate: (value: null | number | undefined) =>
    value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
      ? true
      : '字段必须是非负安全整数',
})

const hiddenVip = { group: ADMIN_GROUPS.operations, hidden: systemAdminHidden }

export const VipTierRuleVersions: CollectionConfig = {
  slug: 'vipTierRuleVersions',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: {
    defaultColumns: ['version', 'effectiveAt', 'noticePublishedAt', 'createdAt'],
    ...hiddenVip,
    useAsTitle: 'version',
  },
  defaultSort: '-version',
  hooks: appendOnly('VIP_TIER_RULE_APPEND_ONLY', 'VIP 等级规则版本只允许追加'),
  indexes: [{ fields: ['version'], unique: true }, { fields: ['effectiveAt', 'version'] }],
  lockDocuments: false,
  fields: [
    positiveSafeInteger('version'),
    { name: 'schemaVersion', type: 'number', defaultValue: 1, max: 1, min: 1, required: true },
    { name: 'effectiveAt', type: 'date', index: true, required: true },
    { name: 'noticePublishedAt', type: 'date', index: true },
    { name: 'changedBy', type: 'text', required: true },
    { name: 'changeNote', type: 'textarea', required: true },
  ],
}

export const VipTierRuleLevels: CollectionConfig = {
  slug: 'vipTierRuleLevels',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: {
    defaultColumns: ['versionNumber', 'tierRank', 'tierCode', 'displayName', 'thresholdFen'],
    ...hiddenVip,
    useAsTitle: 'displayName',
  },
  defaultSort: 'tierRank',
  hooks: appendOnly('VIP_TIER_RULE_LEVEL_APPEND_ONLY', 'VIP 等级规则明细只允许追加'),
  indexes: [
    { fields: ['ruleVersion', 'tierRank'], unique: true },
    { fields: ['ruleVersion', 'tierCode'], unique: true },
  ],
  lockDocuments: false,
  fields: [
    {
      name: 'ruleVersion',
      type: 'relationship',
      relationTo: 'vipTierRuleVersions',
      index: true,
      required: true,
    },
    positiveSafeInteger('versionNumber'),
    {
      name: 'tierCode',
      type: 'text',
      required: true,
      validate: (value: null | string | undefined) =>
        typeof value === 'string' && /^[a-z][a-z0-9_]{1,31}$/u.test(value)
          ? true
          : '等级代码格式无效',
    },
    positiveSafeInteger('tierRank'),
    {
      name: 'displayName',
      type: 'text',
      maxLength: 64,
      required: true,
      validate: (value: null | string | undefined) =>
        typeof value === 'string' && value.trim().length > 0 ? true : '等级名称不能为空',
    },
    positiveSafeInteger('thresholdFen'),
    { name: 'quotaBenefits', type: 'json', required: true },
    { name: 'serviceContent', type: 'textarea', required: true },
  ],
}

export const VipSpendEntries: CollectionConfig = {
  slug: 'vipSpendEntries',
  access: { create: deny, delete: deny, read: ownVipRecordOrSystem, update: deny },
  admin: hiddenVip,
  defaultSort: '-occurredAt',
  hooks: appendOnly('VIP_SPEND_ENTRY_APPEND_ONLY', 'VIP 累计消费记录只允许追加'),
  indexes: [{ fields: ['sourceOrder', 'entryType'], unique: true }],
  lockDocuments: false,
  fields: [
    { name: 'entryKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
    },
    { name: 'sourceOrder', type: 'relationship', relationTo: 'orders', index: true },
    {
      name: 'entryType',
      type: 'select',
      options: ['succeeded_order', 'order_reversal', 'data_correction', 'fraud_reversal'],
      required: true,
    },
    { name: 'paymentChannel', type: 'select', options: ['native', 'h5', 'balance'] },
    positiveSafeInteger('amountFen'),
    {
      name: 'approvalRequest',
      type: 'relationship',
      relationTo: 'adminApprovalRequests',
      index: true,
    },
    { name: 'reference', type: 'text', required: true },
    { name: 'occurredAt', type: 'date', index: true, required: true },
  ],
}

export const VipTierEvents: CollectionConfig = {
  slug: 'vipTierEvents',
  access: { create: deny, delete: deny, read: ownVipRecordOrSystem, update: deny },
  admin: {
    defaultColumns: ['customer', 'eventType', 'source', 'tierRank', 'occurredAt'],
    ...hiddenVip,
    useAsTitle: 'eventKey',
  },
  defaultSort: '-occurredAt',
  hooks: appendOnly('VIP_TIER_EVENT_APPEND_ONLY', 'VIP 等级事件只允许追加'),
  indexes: [{ fields: ['customer', 'tierRank', 'occurredAt'] }],
  lockDocuments: false,
  fields: [
    { name: 'eventKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
    },
    {
      name: 'eventType',
      type: 'select',
      options: ['tier_achievement', 'tier_correction'],
      required: true,
    },
    { name: 'source', type: 'select', options: [...VIP_TIER_EVENT_SOURCES], required: true },
    { name: 'triggerOrder', type: 'relationship', relationTo: 'orders', index: true },
    {
      name: 'ruleVersion',
      type: 'relationship',
      relationTo: 'vipTierRuleVersions',
      index: true,
    },
    nonNegativeSafeInteger('ruleVersionNumber'),
    { name: 'tierCode', type: 'text' },
    nonNegativeSafeInteger('tierRank'),
    { name: 'tierNameSnapshot', type: 'text', required: true },
    { name: 'quotaBenefitsSnapshot', type: 'json', required: true },
    { name: 'serviceContentSnapshot', type: 'textarea', required: true },
    nonNegativeSafeInteger('cumulativeSpendFenSnapshot'),
    nonNegativeSafeInteger('previousTierRank'),
    { name: 'reason', type: 'textarea', required: true },
    {
      name: 'approvalRequest',
      type: 'relationship',
      relationTo: 'adminApprovalRequests',
      index: true,
    },
    { name: 'correctionReference', type: 'text' },
    { name: 'occurredAt', type: 'date', index: true, required: true },
  ],
}

export const VipTierAppeals: CollectionConfig = {
  slug: 'vipTierAppeals',
  access: { create: deny, delete: deny, read: ownVipRecordOrSystem, update: deny },
  admin: hiddenVip,
  defaultSort: '-submittedAt',
  hooks: appendOnly('VIP_TIER_APPEAL_APPEND_ONLY', 'VIP 等级纠错申诉只允许追加'),
  indexes: [{ fields: ['customer', 'tierEvent'], unique: true }],
  lockDocuments: false,
  fields: [
    { name: 'appealKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'customer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
    },
    {
      name: 'tierEvent',
      type: 'relationship',
      relationTo: 'vipTierEvents',
      index: true,
      required: true,
    },
    { name: 'statement', type: 'textarea', required: true },
    { name: 'submittedAt', type: 'date', index: true, required: true },
  ],
}
