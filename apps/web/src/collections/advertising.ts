import type {
  Access,
  CollectionConfig,
  FieldAccess,
  TextFieldSingleValidation,
  Where,
} from 'payload'

import {
  adManagerFieldRead,
  adManagers,
  advertisingAdminHidden,
  hasRole,
  operationalReaders,
  systemAdminOnly,
} from '@/access/roles'
import {
  AD_CREATIVE_STATUSES,
  AD_DEVICE_SCOPES,
  AD_PAGE_TYPES,
  AD_PLACEMENT_POSITIONS,
  AD_SCHEDULE_STATUSES,
  ADVERTISER_STATUSES,
  PUBLIC_AD_INTERNAL_CONTEXT,
  normalizeAllowedAdHost,
  validateAdTargetSyntax,
} from '@/lib/advertising'
import { ADMIN_GROUPS } from '@/lib/admin-navigation'
import {
  auditAdvertisingChange,
  auditAdvertisingDelete,
  guardAdCreativeChange,
  guardAdPlacementChange,
  guardAdScheduleChange,
  guardAdvertiserChange,
  initializeAdSchedule,
} from '@/services/advertising/manage-advertising'

function publicAdvertisingRead(
  statusField: 'enabled' | 'reviewed' | 'status',
  statusValue: boolean | string,
): Access {
  return (args) => {
    const operational = operationalReaders(args)
    if (operational === true) return true
    const where: Where = { [statusField]: { equals: statusValue } }
    return where
  }
}

const publicCurrentScheduleRead: Access = (args) => {
  if (operationalReaders(args) === true) return true
  const now = new Date().toISOString()
  const where: Where = {
    and: [
      { status: { equals: 'active' } },
      { startsAt: { less_than_equal: now } },
      { endsAt: { greater_than: now } },
    ],
  }
  return where
}

const publicInternalOrAdManagerFieldRead: FieldAccess = ({ req }) =>
  hasRole(req.user, ['ad_operator', 'system_admin']) ||
  req.context?.[PUBLIC_AD_INTERNAL_CONTEXT] === true

const validateAllowedHost = (value: unknown): true | string => {
  try {
    normalizeAllowedAdHost(value)
    return true
  } catch {
    return '填写不含协议、端口或路径的明确公网域名'
  }
}

const validateTargetUrl: TextFieldSingleValidation = (value, { siblingData }) =>
  validateAdTargetSyntax(
    value,
    typeof siblingData === 'object' && siblingData !== null
      ? (siblingData as Record<string, unknown>).targetType
      : undefined,
  )

export const Advertisers: CollectionConfig = {
  slug: 'advertisers',
  access: {
    create: adManagers,
    delete: systemAdminOnly,
    read: publicAdvertisingRead('status', 'active'),
    update: adManagers,
  },
  admin: {
    defaultColumns: ['name', 'status', 'updatedAt'],
    group: ADMIN_GROUPS.advertising,
    hidden: advertisingAdminHidden,
    useAsTitle: 'name',
  },
  fields: [
    { name: 'name', type: 'text', maxLength: 120, required: true },
    {
      name: 'legalName',
      type: 'text',
      access: { read: adManagerFieldRead },
      maxLength: 160,
    },
    {
      name: 'contactName',
      type: 'text',
      access: { read: adManagerFieldRead },
      maxLength: 120,
    },
    { name: 'contactEmail', type: 'email', access: { read: adManagerFieldRead } },
    {
      name: 'contractReference',
      type: 'text',
      access: { read: adManagerFieldRead },
      maxLength: 120,
    },
    {
      name: 'allowedHosts',
      type: 'array',
      access: { read: publicInternalOrAdManagerFieldRead },
      admin: { description: '外部广告目标只允许精确匹配这里配置的 HTTPS 主机；子域名需单独列出。' },
      fields: [{ name: 'host', type: 'text', required: true, validate: validateAllowedHost }],
      maxRows: 20,
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'draft',
      index: true,
      options: [...ADVERTISER_STATUSES],
      required: true,
    },
    { name: 'notes', type: 'textarea', access: { read: adManagerFieldRead }, maxLength: 2_000 },
  ],
  hooks: {
    afterChange: [auditAdvertisingChange('advertisers')],
    afterDelete: [auditAdvertisingDelete('advertisers')],
    beforeChange: [guardAdvertiserChange],
  },
}

export const AdMedia: CollectionConfig = {
  slug: 'adMedia',
  access: {
    create: adManagers,
    delete: systemAdminOnly,
    read: publicAdvertisingRead('reviewed', true),
    update: adManagers,
  },
  admin: {
    defaultColumns: ['alt', 'reviewed', 'filename', 'updatedAt'],
    group: ADMIN_GROUPS.advertising,
    hidden: advertisingAdminHidden,
    useAsTitle: 'alt',
  },
  fields: [
    { name: 'alt', type: 'text', maxLength: 160, required: true },
    { name: 'source', type: 'text', access: { read: adManagerFieldRead }, maxLength: 500 },
    { name: 'reviewed', type: 'checkbox', defaultValue: false, index: true, required: true },
  ],
  hooks: {
    afterChange: [auditAdvertisingChange('adMedia')],
    afterDelete: [auditAdvertisingDelete('adMedia')],
  },
  upload: {
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
  },
}

export const AdCreatives: CollectionConfig = {
  slug: 'adCreatives',
  access: {
    create: adManagers,
    delete: systemAdminOnly,
    read: publicAdvertisingRead('status', 'approved'),
    update: adManagers,
  },
  admin: {
    defaultColumns: ['name', 'advertiser', 'creativeType', 'targetType', 'status', 'updatedAt'],
    group: ADMIN_GROUPS.advertising,
    hidden: advertisingAdminHidden,
    useAsTitle: 'name',
  },
  fields: [
    { name: 'name', type: 'text', maxLength: 120, required: true },
    {
      name: 'advertiser',
      type: 'relationship',
      admin: { allowCreate: false },
      maxDepth: 0,
      relationTo: 'advertisers',
      required: true,
    },
    {
      name: 'creativeType',
      type: 'select',
      defaultValue: 'image',
      options: ['image', 'text'],
      required: true,
    },
    {
      name: 'image',
      type: 'upload',
      admin: { condition: (_, siblingData) => siblingData.creativeType === 'image' },
      maxDepth: 0,
      relationTo: 'adMedia',
    },
    {
      name: 'alt',
      type: 'text',
      admin: { condition: (_, siblingData) => siblingData.creativeType === 'image' },
      maxLength: 160,
    },
    { name: 'headline', type: 'text', maxLength: 120, required: true },
    { name: 'body', type: 'textarea', maxLength: 240 },
    {
      name: 'targetType',
      type: 'select',
      defaultValue: 'internal',
      options: ['internal', 'external'],
      required: true,
    },
    {
      name: 'targetUrl',
      type: 'text',
      access: { read: publicInternalOrAdManagerFieldRead },
      admin: {
        description:
          '站内目标复用 D1-04 路径规范且不允许查询参数；外部目标必须匹配广告主 HTTPS 主机白名单。',
      },
      maxLength: 2_048,
      required: true,
      validate: validateTargetUrl,
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'draft',
      index: true,
      options: [...AD_CREATIVE_STATUSES],
      required: true,
    },
    {
      name: 'reviewNotes',
      type: 'textarea',
      access: { read: adManagerFieldRead },
      maxLength: 1_000,
    },
    {
      name: 'reviewedAt',
      type: 'date',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
    },
    {
      name: 'reviewedBy',
      type: 'text',
      access: { create: () => false, read: adManagerFieldRead, update: () => false },
      admin: { readOnly: true },
    },
  ],
  hooks: {
    afterChange: [auditAdvertisingChange('adCreatives')],
    afterDelete: [auditAdvertisingDelete('adCreatives')],
    beforeChange: [guardAdCreativeChange],
  },
}

export const AdPlacements: CollectionConfig = {
  slug: 'adPlacements',
  access: {
    create: adManagers,
    delete: systemAdminOnly,
    read: publicAdvertisingRead('enabled', true),
    update: adManagers,
  },
  admin: {
    defaultColumns: ['code', 'name', 'position', 'deviceScope', 'enabled', 'updatedAt'],
    group: ADMIN_GROUPS.advertising,
    hidden: advertisingAdminHidden,
    useAsTitle: 'code',
  },
  fields: [
    { name: 'code', type: 'text', index: true, maxLength: 80, required: true, unique: true },
    { name: 'name', type: 'text', maxLength: 120, required: true },
    { name: 'description', type: 'textarea', maxLength: 500, required: true },
    {
      name: 'pageTypes',
      type: 'select',
      hasMany: true,
      options: [...AD_PAGE_TYPES],
      required: true,
    },
    {
      name: 'position',
      type: 'select',
      options: [...AD_PLACEMENT_POSITIONS],
      required: true,
    },
    {
      name: 'deviceScope',
      type: 'select',
      defaultValue: 'all',
      options: [...AD_DEVICE_SCOPES],
      required: true,
    },
    { name: 'width', type: 'number', max: 2_000, min: 48, required: true },
    { name: 'height', type: 'number', max: 2_000, min: 48, required: true },
    { name: 'enabled', type: 'checkbox', defaultValue: false, index: true, required: true },
  ],
  hooks: {
    afterChange: [auditAdvertisingChange('adPlacements')],
    afterDelete: [auditAdvertisingDelete('adPlacements')],
    beforeChange: [guardAdPlacementChange],
  },
}

export const AdSchedules: CollectionConfig = {
  slug: 'adSchedules',
  access: {
    create: adManagers,
    delete: systemAdminOnly,
    read: publicCurrentScheduleRead,
    update: adManagers,
  },
  admin: {
    defaultColumns: ['name', 'placement', 'startsAt', 'endsAt', 'priority', 'status'],
    group: ADMIN_GROUPS.advertising,
    hidden: advertisingAdminHidden,
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'publicId',
      type: 'text',
      access: { create: () => false, update: () => false },
      admin: { readOnly: true },
      index: true,
      required: true,
      unique: true,
    },
    { name: 'name', type: 'text', maxLength: 120, required: true },
    {
      name: 'advertiser',
      type: 'relationship',
      admin: { allowCreate: false },
      maxDepth: 0,
      relationTo: 'advertisers',
      required: true,
    },
    {
      name: 'creative',
      type: 'relationship',
      admin: { allowCreate: false },
      maxDepth: 0,
      relationTo: 'adCreatives',
      required: true,
    },
    {
      name: 'placement',
      type: 'relationship',
      admin: { allowCreate: false },
      maxDepth: 0,
      relationTo: 'adPlacements',
      required: true,
    },
    { name: 'startsAt', type: 'date', index: true, required: true },
    { name: 'endsAt', type: 'date', index: true, required: true },
    { name: 'priority', type: 'number', defaultValue: 0, max: 1_000, min: 0, required: true },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'draft',
      index: true,
      options: [...AD_SCHEDULE_STATUSES],
      required: true,
    },
    { name: 'notes', type: 'textarea', access: { read: adManagerFieldRead }, maxLength: 1_000 },
  ],
  hooks: {
    afterChange: [auditAdvertisingChange('adSchedules')],
    afterDelete: [auditAdvertisingDelete('adSchedules')],
    beforeChange: [guardAdScheduleChange],
    beforeValidate: [initializeAdSchedule],
  },
}
