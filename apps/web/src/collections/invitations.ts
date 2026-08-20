import type { Access, CollectionConfig, Where } from 'payload'

import { hasRole, isCustomerUser, systemAdminHidden, systemAdminOnly } from '@/access/roles'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import { AppError } from '@/lib/errors'

export const INVITATION_ABUSE_SIGNALS = [
  'same_device_hash',
  'same_realname_subject',
  'same_phone_hash',
  'same_payment_account_hash',
  'abnormal_invitation_growth',
] as const

const deny: Access = () => false

const invitationParticipantOrSystem: Access = ({ req }) => {
  if (hasRole(req.user, ['system_admin'])) return true
  if (!isCustomerUser(req.user)) return false
  const where: Where = {
    or: [
      { inviterCustomer: { equals: req.user.id } },
      { inviteeCustomer: { equals: req.user.id } },
    ],
  }
  return where
}

const inviterOrSystem: Access = ({ req }) => {
  if (hasRole(req.user, ['system_admin'])) return true
  if (!isCustomerUser(req.user)) return false
  return { inviterCustomer: { equals: req.user.id } }
}

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

const hiddenGrowth = { group: ADMIN_GROUPS.operations, hidden: systemAdminHidden }

const positiveSafeInteger = (name: string, maximum = Number.MAX_SAFE_INTEGER) => ({
  name,
  type: 'number' as const,
  max: maximum,
  min: 1,
  required: true,
  validate: (value: null | number | undefined) =>
    value !== null &&
    value !== undefined &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
      ? true
      : '字段必须是正安全整数',
})

export const InvitationRewardRuleVersions: CollectionConfig = {
  slug: 'invitationRewardRuleVersions',
  access: { create: deny, delete: deny, read: systemAdminOnly, update: deny },
  admin: {
    defaultColumns: ['version', 'enabled', 'rewardPoints', 'effectiveAt', 'createdAt'],
    group: ADMIN_GROUPS.operations,
    hidden: systemAdminHidden,
    useAsTitle: 'version',
  },
  defaultSort: '-version',
  hooks: appendOnlyHooks('INVITATION_RULE_APPEND_ONLY', '邀请奖励规则版本只允许追加'),
  indexes: [{ fields: ['version'], unique: true }],
  lockDocuments: false,
  fields: [
    positiveSafeInteger('version'),
    { name: 'schemaVersion', type: 'number', defaultValue: 1, max: 1, min: 1, required: true },
    { name: 'enabled', type: 'checkbox', required: true },
    positiveSafeInteger('rewardPoints'),
    positiveSafeInteger('rewardExpiryDays', 3_650),
    positiveSafeInteger('bindingWindowHours', 24 * 30),
    { name: 'effectiveAt', type: 'date', index: true, required: true },
    { name: 'changedBy', type: 'text', required: true },
    { name: 'changeNote', type: 'textarea', required: true },
  ],
}

export const InvitationRelationships: CollectionConfig = {
  slug: 'invitationRelationships',
  access: {
    create: deny,
    delete: deny,
    read: invitationParticipantOrSystem,
    update: deny,
  },
  admin: hiddenGrowth,
  hooks: appendOnlyHooks('INVITATION_RELATIONSHIP_APPEND_ONLY', '邀请关系只允许追加'),
  indexes: [
    { fields: ['inviterCustomer', 'boundAt'] },
    { fields: ['inviteeCustomer'], unique: true },
  ],
  lockDocuments: false,
  fields: [
    { name: 'relationshipKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'inviterCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'inviteeCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'bindSource',
      type: 'select',
      options: ['registration', 'post_registration', 'legacy_backfill'],
      required: true,
    },
    { name: 'inviteCodeHash', type: 'text', index: true },
    { name: 'bindingDeviceHash', type: 'text', index: true },
    { name: 'boundAt', type: 'date', index: true, required: true },
    { name: 'bindingWindowEndsAt', type: 'date', required: true },
  ],
}

export const InvitationRewardClaims: CollectionConfig = {
  slug: 'invitationRewardClaims',
  access: { create: deny, delete: deny, read: inviterOrSystem, update: deny },
  admin: hiddenGrowth,
  hooks: appendOnlyHooks('INVITATION_REWARD_CLAIM_APPEND_ONLY', '邀请奖励认领只允许追加'),
  indexes: [
    { fields: ['inviteeCustomer'], unique: true },
    { fields: ['sourceOrder'], unique: true },
  ],
  lockDocuments: false,
  fields: [
    { name: 'claimKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'relationship',
      type: 'relationship',
      relationTo: 'invitationRelationships',
      index: true,
      required: true,
      unique: true,
    },
    {
      name: 'inviterCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'inviteeCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'sourceOrder',
      type: 'relationship',
      relationTo: 'orders',
      index: true,
      required: true,
    },
    {
      name: 'ruleVersion',
      type: 'relationship',
      relationTo: 'invitationRewardRuleVersions',
      required: true,
    },
    positiveSafeInteger('ruleVersionNumber'),
    positiveSafeInteger('points'),
    { name: 'expiresAt', type: 'date', required: true },
  ],
}

export const InvitationRewardEvents: CollectionConfig = {
  slug: 'invitationRewardEvents',
  access: { create: deny, delete: deny, read: inviterOrSystem, update: deny },
  admin: hiddenGrowth,
  hooks: appendOnlyHooks('INVITATION_REWARD_EVENT_APPEND_ONLY', '邀请奖励事件只允许追加'),
  indexes: [{ fields: ['claim', 'eventType'], unique: true }],
  lockDocuments: false,
  fields: [
    { name: 'eventKey', type: 'text', index: true, required: true, unique: true },
    {
      name: 'claim',
      type: 'relationship',
      relationTo: 'invitationRewardClaims',
      index: true,
      required: true,
    },
    {
      name: 'inviterCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'inviteeCustomer',
      type: 'relationship',
      relationTo: 'customers',
      index: true,
      required: true,
    },
    {
      name: 'eventType',
      type: 'select',
      options: ['pending', 'withheld', 'available', 'flagged_after_release'],
      required: true,
    },
    {
      name: 'signals',
      type: 'select',
      hasMany: true,
      options: [...INVITATION_ABUSE_SIGNALS],
    },
    {
      name: 'pointsBatch',
      type: 'relationship',
      relationTo: 'pointsBatches',
      index: true,
    },
    { name: 'occurredAt', type: 'date', index: true, required: true },
  ],
}
